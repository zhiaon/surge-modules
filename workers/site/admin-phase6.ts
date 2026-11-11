/**
 * Phase-6 admin additions.
 *
 * Kept in its own module so `admin.ts` stays readable: these are the CRUD
 * operations and maintenance endpoints that phase 5 did not need (create module,
 * edit/delete category, edit/delete source, edit/delete announcement, backups,
 * update logs, operation logs).
 *
 * Rules that apply to every handler here:
 *   - the caller's role is checked by the router before dispatch
 *   - every mutation writes `operation_logs` (business) alongside the security
 *     trail, because the two pages answer different questions
 *   - nothing reads or writes a credential
 */

import { jsonError, jsonOk, methodNotAllowed } from '../../packages/shared/src/http';
import type { AdminIdentity } from './auth';
import { applyHooks, planHooks } from './hooks';

export interface Ctx {
  db: D1Database;
  admin: AdminIdentity;
  request: Request;
  /** public origin, used to build the webhook callback URL */
  publicOrigin?: string;
  githubToken?: string;
}

const MAX_BODY = 256 * 1024;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number.parseInt(request.headers.get('content-length') ?? '0', 10) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function logOp(
  db: D1Database,
  actor: string,
  action: string,
  target: string | null,
  result: 'ok' | 'failed',
  detail?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO operation_logs (actor, action, target, result, detail) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      actor,
      action,
      target,
      result,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
    )
    .run();
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ------------------------------------------------------------- create module
export async function createModule(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const name = String(body.name ?? '').trim().slice(0, 80);
  if (!name) return jsonError('bad_request', '名称不能为空');

  // An explicit slug is validated exactly as given — silently lowercasing it
  // would let "UPPER" become "upper" and mask a client bug.
  const rawSlug = body.slug === undefined ? '' : String(body.slug).trim();
  const slug = rawSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  if (!SLUG_RE.test(slug)) {
    return jsonError('bad_request', 'slug 只能是小写字母、数字和单个连字符');
  }

  const exists = await ctx.db
    .prepare('SELECT id FROM modules WHERE slug = ? AND deleted_at IS NULL')
    .bind(slug)
    .first<{ id: string }>();
  if (exists) return jsonError('bad_request', `slug「${slug}」已被占用`);

  const id = `mod-${slug}`;
  const version = String(body.version ?? '1.0.0').slice(0, 20);
  const categoryId = String(body.category_id ?? '') || null;
  const sourceId = String(body.source_id ?? '') || null;
  const sourcePath = String(body.source_path ?? '').slice(0, 300) || null;
  const published = body.is_published ? 1 : 0;

  await ctx.db
    .prepare(
      `INSERT INTO modules
         (id, slug, name, description, author, category_id, version, source_id,
          source_path, is_featured, is_published, review_status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`,
    )
    .bind(
      id,
      slug,
      name,
      String(body.description ?? '').slice(0, 400),
      String(body.author ?? '').slice(0, 60),
      categoryId,
      version,
      sourceId,
      sourcePath,
      body.is_featured ? 1 : 0,
      published,
      published ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : null,
    )
    .run();

  if (Array.isArray(body.tags)) {
    for (const tag of (body.tags as unknown[])
      .map((t) => String(t).trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 12)) {
      await ctx.db
        .prepare('INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)')
        .bind(id, tag)
        .run();
    }
  }

  await ctx.db
    .prepare(
      `INSERT INTO module_versions (id, module_id, version, changelog, released_at)
       VALUES (?, ?, ?, '手工创建', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    )
    .bind(`${id}-manual`, id, version)
    .run();

  await logOp(ctx.db, ctx.admin.username, 'module.create', id, 'ok', { slug, name });
  return jsonOk({ id, slug });
}

// ----------------------------------------------------------- delete category
export async function deleteCategory(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!row) return jsonError('not_found', '分类不存在');

  // refuse rather than orphan: a category with modules must be emptied first
  const used = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM modules WHERE category_id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0) {
    return jsonError('bad_request', `该分类下还有 ${used?.n} 个模块，请先移动或删除它们`);
  }

  await ctx.db
    .prepare(`UPDATE categories SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .bind(id)
    .run();

  await logOp(ctx.db, ctx.admin.username, 'category.delete', id, 'ok', { name: row.name });
  return jsonOk({ id, deleted: true });
}

// ------------------------------------------------------------------- sources
export async function deleteSource(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT id, owner, repo FROM sources WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; owner: string; repo: string }>();
  if (!row) return jsonError('not_found', '数据源不存在');

  const modules = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM modules WHERE source_id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ n: number }>();
  if ((modules?.n ?? 0) > 0) {
    return jsonError('bad_request', `该仓库下还有 ${modules?.n} 个模块，请先删除模块或改用其他数据源`);
  }

  // mappings reference the source with ON DELETE RESTRICT, so they must go first
  await ctx.db
    .prepare(
      `UPDATE module_proxy_mappings SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0
        WHERE source_id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .run();
  await ctx.db
    .prepare(
      `UPDATE sources SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0 WHERE id = ?`,
    )
    .bind(id)
    .run();

  await logOp(ctx.db, ctx.admin.username, 'source.delete', id, 'ok', {
    repo: `${row.owner}/${row.repo}`,
  });
  return jsonOk({ id, deleted: true });
}

// ------------------------------------------------------------- announcements
export async function deleteAnnouncement(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT id, title FROM announcements WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; title: string }>();
  if (!row) return jsonError('not_found', '公告不存在');

  await ctx.db
    .prepare(`UPDATE announcements SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .bind(id)
    .run();

  await logOp(ctx.db, ctx.admin.username, 'announcement.delete', id, 'ok', { title: row.title });
  return jsonOk({ id, deleted: true });
}

// --------------------------------------------------------------- update logs
export async function listUpdateLogs(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, version, title, body, kind, is_published, published_at
         FROM update_logs WHERE deleted_at IS NULL
        ORDER BY published_at DESC LIMIT 100`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

export async function upsertUpdateLog(ctx: Ctx, id: string | null): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const title = String(body.title ?? '').trim().slice(0, 120);
  if (!title) return jsonError('bad_request', '标题不能为空');

  const kind = ['feature', 'fix', 'security', 'chore'].includes(String(body.kind))
    ? String(body.kind)
    : 'feature';

  if (id) {
    await ctx.db
      .prepare(
        `UPDATE update_logs SET version = ?, title = ?, body = ?, kind = ?, is_published = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(
        String(body.version ?? '').slice(0, 20),
        title,
        String(body.body ?? '').slice(0, 4000),
        kind,
        body.is_published === false ? 0 : 1,
        id,
      )
      .run();
    await logOp(ctx.db, ctx.admin.username, 'update_log.update', id, 'ok', { title });
    return jsonOk({ id });
  }

  const newId = crypto.randomUUID();
  await ctx.db
    .prepare(
      `INSERT INTO update_logs (id, version, title, body, kind, is_published, published_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    )
    .bind(
      newId,
      String(body.version ?? '').slice(0, 20),
      title,
      String(body.body ?? '').slice(0, 4000),
      kind,
      body.is_published === false ? 0 : 1,
    )
    .run();
  await logOp(ctx.db, ctx.admin.username, 'update_log.create', newId, 'ok', { title });
  return jsonOk({ id: newId });
}

export async function deleteUpdateLog(ctx: Ctx, id: string): Promise<Response> {
  await ctx.db
    .prepare(`UPDATE update_logs SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .bind(id)
    .run();
  await logOp(ctx.db, ctx.admin.username, 'update_log.delete', id, 'ok');
  return jsonOk({ id, deleted: true });
}

// -------------------------------------------------------------------- backups
/**
 * Tables included in a content backup. Deliberately excludes:
 *   admins, admin_sessions, rate_limits, operation_logs, audit_logs
 * — credentials and security trails do not belong in a downloadable file.
 */
const BACKUP_TABLES = [
  'modules',
  'module_tags',
  'module_versions',
  'categories',
  'sources',
  'module_proxy_mappings',
  'announcements',
  'update_logs',
  'site_settings',
  'module_overrides',
] as const;

/** Columns removed from every exported row, whatever the table. */
const REDACTED = new Set([
  'password_hash',
  'token_hash',
  'github_token',
  'secret',
  'webhook_secret',
  'api_key',
]);

export async function createBackup(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const label = String(body?.label ?? '').slice(0, 80);

  const snapshot: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of BACKUP_TABLES) {
    try {
      const { results } = await ctx.db
        .prepare(`SELECT * FROM ${table}`)
        .all<Record<string, unknown>>();
      const rows = (results ?? []).map((row) => {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (!REDACTED.has(k)) clean[k] = v;
        }
        return clean;
      });
      snapshot[table] = rows;
      counts[table] = rows.length;
    } catch {
      // a table missing from an older schema must not fail the whole backup
      snapshot[table] = [];
      counts[table] = 0;
    }
  }

  const payload = JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    tables: snapshot,
  });

  const id = crypto.randomUUID();
  await ctx.db
    .prepare(
      `INSERT INTO backups (id, label, scope, payload, bytes, row_counts, created_by)
       VALUES (?, ?, 'content', ?, ?, ?, ?)`,
    )
    .bind(id, label || '未命名备份', payload, payload.length, JSON.stringify(counts), ctx.admin.username)
    .run();

  await logOp(ctx.db, ctx.admin.username, 'backup.create', id, 'ok', counts);
  return jsonOk({ id, bytes: payload.length, rowCounts: counts });
}

export async function listBackups(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, label, scope, bytes, row_counts, created_by, created_at
         FROM backups ORDER BY created_at DESC LIMIT 50`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

/** Streams the snapshot as a downloadable file. */
export async function downloadBackup(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT payload, label, created_at FROM backups WHERE id = ?')
    .bind(id)
    .first<{ payload: string; label: string; created_at: string }>();
  if (!row) return jsonError('not_found', '备份不存在');

  const stamp = row.created_at.replace(/[:.]/g, '-');
  const filename = `surge-modules-${stamp}.json`;

  await logOp(ctx.db, ctx.admin.username, 'backup.download', id, 'ok');

  return new Response(row.payload, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function deleteBackup(ctx: Ctx, id: string): Promise<Response> {
  await ctx.db.prepare('DELETE FROM backups WHERE id = ?').bind(id).run();
  await logOp(ctx.db, ctx.admin.username, 'backup.delete', id, 'ok');
  return jsonOk({ id, deleted: true });
}

/**
 * Restore.
 *
 * Two-phase on purpose: the caller must first POST with `dryRun: true`, read the
 * row counts that would be written, then repeat with `confirm: "<backup id>"`.
 * A restore that silently overwrites tables is exactly the operation that needs
 * a second, explicit step.
 */
export async function restoreBackup(ctx: Ctx, id: string): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const row = await ctx.db.prepare('SELECT payload FROM backups WHERE id = ?').bind(id).first<{
    payload: string;
  }>();
  if (!row) return jsonError('not_found', '备份不存在');

  let parsed: { tables?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(row.payload) as { tables?: Record<string, unknown[]> };
  } catch {
    return jsonError('bad_request', '备份文件已损坏');
  }
  const tables = parsed.tables ?? {};

  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) counts[table] = tables[table]?.length ?? 0;

  if (body.dryRun === true) {
    return jsonOk({ dryRun: true, wouldWrite: counts });
  }

  if (String(body.confirm ?? '') !== id) {
    return jsonError('bad_request', '恢复需要显式确认：先以 dryRun 查看影响，再传 confirm=<备份 ID>');
  }

  // Upsert rather than truncate: a restore must not delete modules the operator
  // added after the snapshot was taken.
  let written = 0;
  for (const table of BACKUP_TABLES) {
    const rows = tables[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue;
      const rowObj = raw as Record<string, unknown>;
      const cols = Object.keys(rowObj).filter((c) => !REDACTED.has(c));
      if (cols.length === 0) continue;

      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      try {
        await ctx.db
          .prepare(sql)
          .bind(...cols.map((c) => rowObj[c]))
          .run();
        written += 1;
      } catch {
        // a single bad row must not abort the restore; the count reports it
      }
    }
  }

  await logOp(ctx.db, ctx.admin.username, 'backup.restore', id, 'ok', { written });
  return jsonOk({ restored: true, written });
}

// ---------------------------------------------------------- operation logs
export async function listOperationLogs(ctx: Ctx, url: URL): Promise<Response> {
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100),
  );
  const rows = await ctx.db
    .prepare(
      `SELECT actor, action, target, result, detail, created_at
         FROM operation_logs ORDER BY id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Record<string, unknown>>();

  // belt-and-braces: never let a credential-shaped string reach the browser
  const items = (rows.results ?? []).map((row) => {
    const copy = { ...row };
    if (typeof copy.detail === 'string') {
      copy.detail = copy.detail
        .replace(/ghp_[A-Za-z0-9]{20,}/g, '[redacted]')
        .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]');
    }
    return copy;
  });

  return jsonOk({ items });
}

// ---------------------------------------------------------------- config I/O
export async function exportConfig(ctx: Ctx): Promise<Response> {
  const [settings, categories] = await Promise.all([
    ctx.db
      .prepare("SELECT key, value, value_type FROM site_settings WHERE scope = 'public'")
      .all<Record<string, unknown>>(),
    ctx.db
      .prepare(
        'SELECT id, name, slug, description, icon, sort_order, is_visible FROM categories WHERE deleted_at IS NULL',
      )
      .all<Record<string, unknown>>(),
  ]);

  await logOp(ctx.db, ctx.admin.username, 'config.export', null, 'ok');
  return jsonOk({
    version: 1,
    settings: settings.results ?? [],
    categories: categories.results ?? [],
  });
}

export async function importConfig(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  let settingsWritten = 0;
  if (Array.isArray(body.settings)) {
    for (const entry of (body.settings as unknown[]).slice(0, 200)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { key, value } = entry as { key?: unknown; value?: unknown };
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      await ctx.db
        .prepare(
          `UPDATE site_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE key = ?`,
        )
        .bind(value.slice(0, 500), key)
        .run();
      settingsWritten += 1;
    }
  }

  await logOp(ctx.db, ctx.admin.username, 'config.import', null, 'ok', { settingsWritten });
  return jsonOk({ settingsWritten });
}


// ------------------------------------------------------------------- alerts
export async function listAlerts(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT a.id, a.kind, a.message, a.acknowledged, a.created_at,
              s.owner || '/' || s.repo AS source
         FROM sync_alerts a
         LEFT JOIN sources s ON s.id = a.source_id
        ORDER BY a.acknowledged ASC, a.id DESC LIMIT 50`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

export async function acknowledgeAlert(ctx: Ctx, id: string): Promise<Response> {
  await ctx.db
    .prepare('UPDATE sync_alerts SET acknowledged = 1 WHERE id = ?')
    .bind(id)
    .run();
  await logOp(ctx.db, ctx.admin.username, 'alert.acknowledge', id, 'ok');
  return jsonOk({ id, acknowledged: true });
}

// -------------------------------------------------------------------- hooks
export async function inspectHooks(ctx: Ctx): Promise<Response> {
  const plans = await planHooks({
    DB: ctx.db,
    GITHUB_READ_TOKEN: ctx.githubToken,
    PUBLIC_ORIGIN: ctx.publicOrigin,
  });
  return jsonOk({ plans, publicOrigin: ctx.publicOrigin ?? '' });
}

export async function syncHooks(ctx: Ctx, sourceId: string): Promise<Response> {
  const results = await applyHooks(
    {
      DB: ctx.db,
      GITHUB_READ_TOKEN: ctx.githubToken,
      PUBLIC_ORIGIN: ctx.publicOrigin,
    },
    sourceId,
  );
  await logOp(ctx.db, ctx.admin.username, 'hook.apply', sourceId, 'ok', results);
  return jsonOk({ results });
}

/** Router fragment: returns null when the path is not one of these routes. */
export async function handlePhase6(
  ctx: Ctx,
  path: string,
  method: string,
  url: URL,
): Promise<Response | null> {
  if (path === '/modules' && method === 'POST') return createModule(ctx);

  const catDelete = path.match(/^\/categories\/([\w-]+)\/delete$/);
  if (catDelete && method === 'POST') return deleteCategory(ctx, catDelete[1]);

  const srcDelete = path.match(/^\/sources\/([\w-]+)\/delete$/);
  if (srcDelete && method === 'POST') return deleteSource(ctx, srcDelete[1]);

  const annDelete = path.match(/^\/announcements\/([\w-]+)\/delete$/);
  if (annDelete && method === 'POST') return deleteAnnouncement(ctx, annDelete[1]);

  if (path === '/update-logs') {
    if (method === 'GET') return listUpdateLogs(ctx);
    if (method === 'POST') return upsertUpdateLog(ctx, null);
    return methodNotAllowed(['GET', 'POST']);
  }

  const updMatch = path.match(/^\/update-logs\/([\w-]+)$/);
  if (updMatch) {
    if (method === 'PATCH') return upsertUpdateLog(ctx, updMatch[1]);
    if (method === 'DELETE') return deleteUpdateLog(ctx, updMatch[1]);
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (path === '/backups') {
    if (method === 'GET') return listBackups(ctx);
    if (method === 'POST') return createBackup(ctx);
    return methodNotAllowed(['GET', 'POST']);
  }

  const bkDownload = path.match(/^\/backups\/([\w-]+)\/download$/);
  if (bkDownload && method === 'GET') return downloadBackup(ctx, bkDownload[1]);

  const bkRestore = path.match(/^\/backups\/([\w-]+)\/restore$/);
  if (bkRestore && method === 'POST') return restoreBackup(ctx, bkRestore[1]);

  const bkDelete = path.match(/^\/backups\/([\w-]+)$/);
  if (bkDelete && method === 'DELETE') return deleteBackup(ctx, bkDelete[1]);

  if (path === '/operation-logs') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listOperationLogs(ctx, url);
  }

  if (path === '/alerts') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listAlerts(ctx);
  }

  const ackMatch = path.match(/^\/alerts\/([\w-]+)\/ack$/);
  if (ackMatch && method === 'POST') return acknowledgeAlert(ctx, ackMatch[1]);

  if (path === '/hooks') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return inspectHooks(ctx);
  }

  const hookApply = path.match(/^\/hooks\/([\w-]+)\/apply$/);
  if (hookApply && method === 'POST') return syncHooks(ctx, hookApply[1]);

  if (path === '/config/export') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return exportConfig(ctx);
  }

  if (path === '/config/import') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return importConfig(ctx);
  }

  return null;
}
