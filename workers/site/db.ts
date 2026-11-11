/**
 * D1 read layer for the public site API.
 *
 * Rules enforced here, not in the handlers:
 *  - every query filters `deleted_at IS NULL` and `is_published = 1`
 *  - `modules.upstream_url`, `sources.*`, `module_proxy_mappings.file_path` and
 *    `site_settings.scope='internal'` are never selected into a public shape
 *  - the raw URL handed to clients is the proxy URL, built from settings
 */

import type {
  PageMeta,
  PublicAnnouncement,
  PublicCategory,
  PublicModule,
  PublicModuleDetail,
  PublicModuleVersion,
  PublicSettings,
} from '../../packages/shared/src/contract';
import { likeEscape, tokenize } from '../../packages/shared/src/query';
import type { ModuleListQuery } from '../../packages/shared/src/contract';

interface ModuleRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  version: string;
  updated_at: string;
  created_at: string;
  repository_url: string | null;
  is_featured: number;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
}

export interface SettingsMap {
  contactTelegram: string;
  siteName: string;
  tagline: string;
  description: string;
  locale: string;
  version: string;
  perPageDefault: number;
  perPageMax: number;
  proxyBase: string;
}

const SETTING_KEYS: Record<keyof SettingsMap, string> = {
  contactTelegram: 'contact.telegram',
  siteName: 'site.name',
  tagline: 'site.tagline',
  description: 'site.description',
  locale: 'site.locale',
  version: 'site.version',
  perPageDefault: 'modules.per_page_default',
  perPageMax: 'modules.per_page_max',
  proxyBase: 'proxy.public_base',
};

const DEFAULTS: SettingsMap = {
  contactTelegram: '',
  siteName: 'Surge Modules',
  tagline: '',
  description: '',
  locale: 'zh-CN',
  version: '0.0.0',
  perPageDefault: 20,
  perPageMax: 60,
  proxyBase: '',
};

export async function loadSettings(db: D1Database): Promise<SettingsMap> {
  const { results } = await db
    .prepare("SELECT key, value, value_type FROM site_settings WHERE scope = 'public'")
    .all<{ key: string; value: string; value_type: string }>();

  const byKey = new Map<string, { value: string; type: string }>();
  for (const row of results ?? []) byKey.set(row.key, { value: row.value, type: row.value_type });

  const out: SettingsMap = { ...DEFAULTS };
  for (const [field, key] of Object.entries(SETTING_KEYS) as [keyof SettingsMap, string][]) {
    const hit = byKey.get(key);
    if (!hit) continue;
    if (field === 'perPageDefault' || field === 'perPageMax') {
      const n = Number.parseInt(hit.value, 10);
      if (Number.isFinite(n) && n > 0) out[field] = n;
    } else {
      out[field] = hit.value;
    }
  }
  return out;
}

export function toPublicSettings(s: SettingsMap): PublicSettings {
  return {
    contactTelegram: s.contactTelegram,
    siteName: s.siteName,
    tagline: s.tagline,
    description: s.description,
    locale: s.locale,
    version: s.version,
    perPageDefault: s.perPageDefault,
    perPageMax: s.perPageMax,
    proxyBase: s.proxyBase,
  };
}

/** Builds the public raw URL. Empty proxy base ⇒ empty string, never a guess. */
export function proxyUrlFor(settings: SettingsMap, slug: string): string {
  const base = settings.proxyBase.trim();
  if (!base) return '';
  return `${base.replace(/\/+$/, '')}/${slug}`;
}

function rowToModule(row: ModuleRow, settings: SettingsMap, tags: string[]): PublicModule {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    author: row.author,
    category:
      row.category_id && row.category_name && row.category_slug
        ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
        : null,
    tags,
    version: row.version,
    updatedAt: row.updated_at,
    rawUrl: proxyUrlFor(settings, row.slug),
    repositoryUrl: row.repository_url,
    isFeatured: row.is_featured === 1,
  };
}

const MODULE_SELECT = `
  SELECT m.id, m.slug, m.name, m.description, m.author, m.version,
         m.updated_at, m.created_at, m.repository_url, m.is_featured,
         m.category_id, c.name AS category_name, c.slug AS category_slug
    FROM modules m
    LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
   WHERE m.deleted_at IS NULL AND m.is_published = 1
`;

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT module_id, tag FROM module_tags WHERE module_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ module_id: string; tag: string }>();
  for (const row of results ?? []) {
    const list = out.get(row.module_id) ?? [];
    list.push(row.tag);
    out.set(row.module_id, list);
  }
  return out;
}

export interface ModuleListResult {
  items: PublicModule[];
  meta: PageMeta;
}

export async function listModules(
  db: D1Database,
  settings: SettingsMap,
  query: ModuleListQuery,
): Promise<ModuleListResult> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (query.category) {
    where.push('c.slug = ?');
    binds.push(query.category);
  }
  if (query.featured !== null) {
    where.push('m.is_featured = ?');
    binds.push(query.featured ? 1 : 0);
  }
  if (query.tag) {
    where.push(
      'EXISTS (SELECT 1 FROM module_tags t WHERE t.module_id = m.id AND LOWER(t.tag) = LOWER(?))',
    );
    binds.push(query.tag);
  }

  // keyword search: every token must match name / author / description / tag
  for (const token of tokenize(query.search)) {
    where.push(
      `(m.name LIKE ? ESCAPE '\\' OR m.author LIKE ? ESCAPE '\\'
        OR m.description LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM module_tags t2 WHERE t2.module_id = m.id
                   AND t2.tag LIKE ? ESCAPE '\\'))`,
    );
    const pattern = `%${likeEscape(token)}%`;
    binds.push(pattern, pattern, pattern, pattern);
  }

  const whereSql = where.length > 0 ? ` AND ${where.join(' AND ')}` : '';

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM modules m
         LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
        WHERE m.deleted_at IS NULL AND m.is_published = 1${whereSql}`,
    )
    .bind(...binds)
    .first<{ n: number }>();

  const total = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.perPage));
  const page = Math.min(query.page, totalPages);

  const orderSql =
    query.sort === 'name'
      ? 'm.name COLLATE NOCASE ASC'
      : query.sort === 'created'
        ? 'm.created_at DESC'
        : query.sort === 'featured'
          ? 'm.is_featured DESC, m.updated_at DESC'
          : 'm.updated_at DESC';

  const { results } = await db
    .prepare(`${MODULE_SELECT}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .bind(...binds, query.perPage, (page - 1) * query.perPage)
    .all<ModuleRow>();

  const rows = results ?? [];
  const tagMap = await tagsFor(
    db,
    rows.map((r) => r.id),
  );

  return {
    items: rows.map((r) => rowToModule(r, settings, tagMap.get(r.id) ?? [])),
    meta: { page, perPage: query.perPage, total, totalPages },
  };
}

export async function getModuleBySlug(
  db: D1Database,
  settings: SettingsMap,
  slug: string,
): Promise<PublicModuleDetail | null> {
  const row = await db
    .prepare(`${MODULE_SELECT} AND m.slug = ? LIMIT 1`)
    .bind(slug)
    .first<ModuleRow>();
  if (!row) return null;

  const tagMap = await tagsFor(db, [row.id]);
  const base = rowToModule(row, settings, tagMap.get(row.id) ?? []);

  const { results: versionRows } = await db
    .prepare(
      `SELECT version, changelog, released_at, commit_sha, commit_url
         FROM module_versions WHERE module_id = ?
        ORDER BY released_at DESC LIMIT 50`,
    )
    .bind(row.id)
    .all<{
      version: string;
      changelog: string;
      released_at: string;
      commit_sha: string | null;
      commit_url: string | null;
    }>();

  const versions: PublicModuleVersion[] = (versionRows ?? []).map((v) => ({
    version: v.version,
    changelog: v.changelog,
    releasedAt: v.released_at,
    commitSha: v.commit_sha,
    commitUrl: v.commit_url,
  }));

  return { ...base, versions, createdAt: row.created_at };
}

export async function listVersions(
  db: D1Database,
  slug: string,
  limit: number,
): Promise<PublicModuleVersion[] | null> {
  const moduleRow = await db
    .prepare(
      'SELECT id FROM modules WHERE slug = ? AND deleted_at IS NULL AND is_published = 1 LIMIT 1',
    )
    .bind(slug)
    .first<{ id: string }>();
  if (!moduleRow) return null;

  const { results } = await db
    .prepare(
      `SELECT version, changelog, released_at, commit_sha, commit_url
         FROM module_versions WHERE module_id = ?
        ORDER BY released_at DESC LIMIT ?`,
    )
    .bind(moduleRow.id, limit)
    .all<{
      version: string;
      changelog: string;
      released_at: string;
      commit_sha: string | null;
      commit_url: string | null;
    }>();

  return (results ?? []).map((v) => ({
    version: v.version,
    changelog: v.changelog,
    releasedAt: v.released_at,
    commitSha: v.commit_sha,
    commitUrl: v.commit_url,
  }));
}

export async function listCategories(db: D1Database): Promise<PublicCategory[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order,
              (SELECT COUNT(*) FROM modules m
                WHERE m.category_id = c.id AND m.deleted_at IS NULL AND m.is_published = 1) AS module_count
         FROM categories c
        WHERE c.deleted_at IS NULL AND c.is_visible = 1
        ORDER BY c.sort_order ASC, c.name ASC`,
    )
    .all<{
      id: string;
      name: string;
      slug: string;
      description: string;
      icon: string | null;
      sort_order: number;
      module_count: number;
    }>();

  return (results ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    icon: c.icon,
    sortOrder: c.sort_order,
    moduleCount: c.module_count,
  }));
}

export async function listAnnouncements(db: D1Database): Promise<PublicAnnouncement[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, body, level, is_pinned, published_at
         FROM announcements
        WHERE deleted_at IS NULL AND is_published = 1
        ORDER BY is_pinned DESC, published_at DESC
        LIMIT 20`,
    )
    .all<{
      id: string;
      title: string;
      body: string;
      level: string;
      is_pinned: number;
      published_at: string;
    }>();

  return (results ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    level: (a.level === 'warning' || a.level === 'critical' ? a.level : 'info') as
      | 'info'
      | 'warning'
      | 'critical',
    isPinned: a.is_pinned === 1,
    publishedAt: a.published_at,
  }));
}
