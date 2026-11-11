/**
 * GitHub sync engine.
 *
 * This is the part that must never damage data, so every rule is explicit:
 *
 *  - **Source of truth is the repository.** The scan reads only the configured
 *    owner/repo/branch/paths, validated before any request is built.
 *  - **Idempotent.** A file is identified by `(source_id, source_path)`. If the
 *    content hash matches, nothing is written and the run counts it as
 *    `unchanged`; running twice produces zero new rows.
 *  - **Admin wins.** `module_overrides` is applied by the API at read time, and
 *    this job never writes a field that has an override.
 *  - **Tombstones win.** A path in `module_tombstones` is skipped, so a deleted
 *    or ignored module cannot be resurrected by a resync.
 *  - **Per-file isolation.** A parse or fetch failure increments `failed` and
 *    logs the path; it never aborts the batch.
 *  - **Mutual exclusion.** The source row carries a lock so two runs cannot
 *    interleave and produce duplicate versions.
 *  - **Untrusted content.** Module text is parsed with a line scanner only — no
 *    eval, no HTML, no template rendering.
 */

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 500;
const FETCH_TIMEOUT_MS = 15_000;
const LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Files processed per invocation.
 *
 * A full pass over a large repository can exceed the CPU budget of a single
 * Worker invocation. Processing a bounded batch and recording a cursor keeps
 * each run short; the next trigger resumes where this one stopped.
 *
 * 6 is deliberately small: with ~2 HTTP calls per file (list is shared), 6 files
 * plus writes stays well inside the limit even on a cold start.
 */
const BATCH_SIZE = 6;

/** Consecutive failures before an alert row is written. */
const ALERT_THRESHOLD = 2;

export interface SyncEnv {
  DB: D1Database;
  GITHUB_READ_TOKEN?: string;
  /** optional: when present, new pending modules are announced to Telegram */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ID?: string;
}

export interface SyncResult {
  jobId: string;
  status: 'ok' | 'failed' | 'skipped';
  scanned: number;
  added: number;
  updated: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  message: string;
  /** true when this run processed only part of the repository */
  partial?: boolean;
  /** total files discovered in the repository */
  totalFiles?: number;
  /** how many were processed in this pass */
  processed?: number;
}

interface SourceRow {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  allow_paths: string;
  is_enabled: number;
  sync_lock: string | null;
  sync_lock_at: string | null;
  sync_cursor: number;
  sync_total: number;
  consecutive_failures: number;
}

// ------------------------------------------------------------------ guards
const SEGMENT_RE = /^[\w.-]{1,100}$/;

function safeSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && value !== '.' && value !== '..';
}

function safePath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('..')) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  return /^[\w./@+-]+$/.test(path);
}

function allowedByPrefix(filePath: string, allowPaths: string): boolean {
  const prefixes = allowPaths
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+/, '');
    return filePath === clean || filePath.startsWith(clean.endsWith('/') ? clean : `${clean}/`);
  });
}

// --------------------------------------------------------------- parsing
export interface ParsedMeta {
  name: string;
  description: string;
  author: string;
  category: string;
  version: string;
  icon: string;
  homepage: string;
  openUrl: string;
}

/**
 * Reads the `#!key=value` header block. Everything after the first 60 lines is
 * config body and is not parsed for metadata.
 */
export function parseModuleMeta(text: string, fallbackName: string): ParsedMeta {
  const meta: Record<string, string> = {};
  const lines = text.split('\n').slice(0, 60);
  for (const line of lines) {
    const m = line.match(/^#!([\w-]+)\s*=\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }

  const desc = (meta.desc ?? meta.description ?? '')
    // a leading "V1.2:" is a version prefix, not part of the description
    .replace(/^V?\d+(\.\d+)*[:：]\s*/i, '')
    .slice(0, 400);

  const versionFromDesc = (meta.desc ?? '').match(/^V?(\d+\.\d+(?:\.\d+)?)/i)?.[1];

  return {
    name: (meta.name ?? fallbackName).slice(0, 80),
    description: desc,
    author: (meta.author ?? '').slice(0, 60),
    category: (meta.category ?? '').slice(0, 40),
    version: (meta.version ?? versionFromDesc ?? '1.0.0').replace(/^v/i, '').slice(0, 20),
    icon: (meta.icon ?? '').slice(0, 200),
    homepage: (meta.homepage ?? '').slice(0, 200),
    openUrl: (meta['openurl'] ?? '').slice(0, 200),
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Category mapping from the module's own `#!category` plus name keywords. */
export function categorySlugFor(meta: ParsedMeta, name: string): string {
  const hay = `${meta.category} ${name}`;
  if (/去广告|广告|拦截/.test(hay)) return 'adblock';
  if (/分流|规则|dns|DNS/.test(hay)) return 'rules';
  if (/脚本|script/i.test(hay)) return 'scripts';
  if (/净化|清理/.test(hay)) return 'clean';
  if (/隐私|防护/.test(hay)) return 'privacy';
  return 'tools';
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------------------- fetching
async function ghFetch(
  path: string,
  token: string,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'surge-modules-sync',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Lists candidate files. Returns null when the repo/branch is unreachable. */
async function listFiles(
  source: SourceRow,
  token: string,
): Promise<{ files: string[] } | { error: string }> {
  if (!safeSegment(source.owner) || !safeSegment(source.repo) || !safeSegment(source.branch)) {
    return { error: '仓库标识不合法' };
  }

  const res = await ghFetch(
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(source.branch)}?recursive=1`,
    token,
  );

  if (res.status === 404) return { error: '仓库或分支不存在，或当前凭据无权访问' };
  if (res.status === 401) return { error: '凭据无效' };
  if (res.status === 403 || res.status === 429) {
    const retry = res.headers.get('retry-after') ?? '60';
    return { error: `GitHub 限流，建议 ${retry}s 后重试` };
  }
  if (!res.ok) return { error: `GitHub 返回 ${res.status}` };

  const body = (await res.json()) as { tree?: Array<{ path: string; type: string; size?: number }> };
  const files = (body.tree ?? [])
    .filter((n) => n.type === 'blob')
    .filter((n) => n.path.endsWith('.sgmodule'))
    .filter((n) => safePath(n.path))
    .filter((n) => allowedByPrefix(n.path, source.allow_paths))
    .map((n) => n.path)
    .slice(0, MAX_FILES);

  return { files };
}

async function fetchFile(
  source: SourceRow,
  path: string,
  token: string,
): Promise<{ text: string } | { error: string }> {
  if (!safePath(path)) return { error: '路径不合法' };

  const res = await ghFetch(
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(source.branch)}`,
    token,
    'application/vnd.github.raw',
  );

  if (res.status === 404) return { error: '文件不存在' };
  if (res.status === 403) return { error: '无权读取该文件' };
  if (res.status === 429) return { error: 'GitHub 限流' };
  if (!res.ok) return { error: `GitHub 返回 ${res.status}` };

  const declared = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_FILE_BYTES) return { error: '文件超过大小上限' };

  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) return { error: '文件超过大小上限' };

  return { text };
}

// -------------------------------------------------------------------- lock
async function acquireLock(db: D1Database, sourceId: string, token: string): Promise<boolean> {
  const now = Date.now();
  const stale = new Date(now - LOCK_TTL_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  const iso = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');

  // claim only if free, or if the previous holder is past its TTL
  const res = await db
    .prepare(
      `UPDATE sources SET sync_lock = ?, sync_lock_at = ?
        WHERE id = ?
          AND (sync_lock IS NULL OR sync_lock_at IS NULL OR sync_lock_at < ?)`,
    )
    .bind(token, iso, sourceId, stale)
    .run();

  const changed = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changed > 0;
}

async function releaseLock(db: D1Database, sourceId: string, token: string): Promise<void> {
  await db
    .prepare('UPDATE sources SET sync_lock = NULL, sync_lock_at = NULL WHERE id = ? AND sync_lock = ?')
    .bind(sourceId, token)
    .run();
}

// -------------------------------------------------------------------- sync
export async function syncSource(
  env: SyncEnv,
  sourceId: string,
  trigger: 'manual' | 'cron' | 'webhook',
): Promise<SyncResult> {
  const { DB } = env;
  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const empty = {
    jobId,
    scanned: 0,
    added: 0,
    updated: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };

  const source = await DB.prepare(
    `SELECT id, owner, repo, branch, allow_paths, is_enabled, sync_lock, sync_lock_at,
            sync_cursor, sync_total, consecutive_failures
       FROM sources WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(sourceId)
    .first<SourceRow>();

  if (!source) {
    return { ...empty, status: 'failed', message: '数据源不存在' };
  }
  // A disabled source is a deliberate no-op, so it must not be reported as a
  // failure — and it must not need GitHub credentials to decide that.
  if (source.is_enabled !== 1) {
    return { ...empty, status: 'skipped', message: '数据源已停用' };
  }

  if (!env.GITHUB_READ_TOKEN) {
    await DB.prepare(
      `INSERT INTO sync_jobs (id, source_id, trigger, status, started_at, finished_at, error)
       VALUES (?, ?, ?, 'failed', ?, ?, '未配置 GITHUB_READ_TOKEN')`,
    )
      .bind(jobId, sourceId, trigger, startedAt, startedAt)
      .run();
    return { ...empty, status: 'failed', message: '未配置 GITHUB_READ_TOKEN' };
  }

  const lockToken = crypto.randomUUID();
  if (!(await acquireLock(DB, sourceId, lockToken))) {
    return { ...empty, status: 'skipped', message: '该数据源已有同步任务在运行' };
  }

  await DB.prepare(
    `INSERT INTO sync_jobs (id, source_id, trigger, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
  )
    .bind(jobId, sourceId, trigger, startedAt)
    .run();

  const log = async (level: string, path: string | null, message: string) => {
    await DB.prepare(
      'INSERT INTO sync_logs (job_id, level, path, message) VALUES (?, ?, ?, ?)',
    )
      .bind(jobId, level, path, message.slice(0, 500))
      .run();
  };

  let scanned = 0;
  let added = 0;
  let updated = 0;
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const listing = await listFiles(source, env.GITHUB_READ_TOKEN);
    if ('error' in listing) {
      await log('error', null, listing.error);
      throw new Error(listing.error);
    }

    // tombstones and existing rows, loaded once
    const tombstones = new Set(
      (
        await DB.prepare('SELECT source_path FROM module_tombstones WHERE source_id = ?')
          .bind(sourceId)
          .all<{ source_path: string }>()
      ).results?.map((r) => r.source_path) ?? [],
    );

    const existing = new Map(
      (
        await DB.prepare(
          `SELECT id, slug, source_path, content_hash FROM modules
            WHERE source_id = ? AND deleted_at IS NULL`,
        )
          .bind(sourceId)
          .all<{ id: string; slug: string; source_path: string; content_hash: string | null }>()
      ).results?.map((r) => [r.source_path, r]) ?? [],
    );

    // admin overrides, so a synced field is never written over one
    const overrides = new Map<string, Set<string>>();
    for (const row of (
      await DB.prepare(
        `SELECT o.module_id, o.field FROM module_overrides o
           JOIN modules m ON m.id = o.module_id WHERE m.source_id = ?`,
      )
        .bind(sourceId)
        .all<{ module_id: string; field: string }>()
    ).results ?? []) {
      if (!overrides.has(row.module_id)) overrides.set(row.module_id, new Set());
      overrides.get(row.module_id)!.add(row.field);
    }

    const usedSlugs = new Set(
      (
        await DB.prepare('SELECT slug FROM modules WHERE deleted_at IS NULL')
          .all<{ slug: string }>()
      ).results?.map((r) => r.slug) ?? [],
    );

    // ---- batching
    // `sync_total` records how many files the repository had on the pass that
    // started the sweep; a change in count means the list shifted, so restart
    // from zero rather than resume at a now-meaningless offset.
    const totalFiles = listing.files.length;
    const countChanged = source.sync_total !== totalFiles;
    const cursor = countChanged ? 0 : source.sync_cursor;
    const batch = listing.files.slice(cursor, cursor + BATCH_SIZE);
    const nextCursor = cursor + batch.length;
    const partial = nextCursor < totalFiles;

    await DB.prepare('UPDATE sources SET sync_total = ?, sync_cursor = ? WHERE id = ?')
      .bind(totalFiles, partial ? nextCursor : 0, sourceId)
      .run();

    for (const path of batch) {
      scanned += 1;

      if (tombstones.has(path)) {
        skipped += 1;
        await log('info', path, '已忽略（tombstone）');
        continue;
      }

      const fetched = await fetchFile(source, path, env.GITHUB_READ_TOKEN);
      if ('error' in fetched) {
        failed += 1;
        await log('error', path, fetched.error);
        continue; // one bad file must not abort the batch
      }

      const hash = await sha256(fetched.text);
      const prev = existing.get(path);

      if (prev && prev.content_hash === hash) {
        unchanged += 1;
        continue;
      }

      const fallbackName = path.split('/').pop()!.replace(/\.sgmodule$/, '');
      const meta = parseModuleMeta(fetched.text, fallbackName);
      const categorySlug = categorySlugFor(meta, meta.name);
      const category = await DB.prepare('SELECT id FROM categories WHERE slug = ? AND deleted_at IS NULL')
        .bind(categorySlug)
        .first<{ id: string }>();

      if (prev) {
        // update only the columns the sync owns
        const ov = overrides.get(prev.id) ?? new Set<string>();
        const sets: string[] = [];
        const binds: unknown[] = [];

        const maybe = (field: string, value: unknown) => {
          if (ov.has(field)) return;
          sets.push(`${field} = ?`);
          binds.push(value);
        };

        maybe('name', meta.name);
        maybe('description', meta.description);
        maybe('author', meta.author || source.owner);
        maybe('category_id', category?.id ?? null);
        maybe('version', meta.version);

        sets.push('content_hash = ?', 'synced_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\')');
        binds.push(hash);

        await DB.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`)
          .bind(...binds, prev.id)
          .run();

        // a new version row only when the hash changed
        await DB.prepare(
          `INSERT OR IGNORE INTO module_versions
             (id, module_id, version, content_hash, changelog, released_at)
           VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        )
          .bind(`${prev.id}-${hash.slice(0, 12)}`, prev.id, meta.version, hash,
                meta.description.slice(0, 200))
          .run();

        updated += 1;
        changed += 1;
        await log('info', path, `更新 ${prev.slug} → v${meta.version}`);

        // Same notification path as new modules. Before this, an update landed
        // silently — the operator only found out by opening the panel.
        if (env.TELEGRAM_BOT_TOKEN) {
          try {
            const { notifyFirstPartyPending } = await import('./telegram');
            await notifyFirstPartyPending(env, {
              name: meta.name,
              version: meta.version,
              sourcePath: path,
              repository: `${source.owner}/${source.repo}`,
              repositoryUrl: `https://github.com/${source.owner}/${source.repo}`,
              rawUrl: `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${path
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`,
              kind: 'update',
              previousVersion: prev.version,
            });
          } catch {
            /* notification is best-effort */
          }
        }
        continue;
      }

      // new module
      let slug = slugify(meta.name);
      if (slug.length < 3) slug = slugify(fallbackName);
      if (usedSlugs.has(slug)) {
        const alt = slugify(`${slug}-${fallbackName}`);
        if (usedSlugs.has(alt)) {
          skipped += 1;
          await log('warn', path, `slug 冲突（${slug}），跳过`);
          continue;
        }
        slug = alt;
      }
      usedSlugs.add(slug);

      const moduleId = `mod-${slug}`;
      await DB.prepare(
        `INSERT INTO modules
           (id, slug, name, description, author, category_id, version,
            source_id, source_path, content_hash, is_featured, is_published,
            review_status, published_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      )
        .bind(
          moduleId,
          slug,
          meta.name,
          meta.description,
          meta.author || source.owner,
          category?.id ?? null,
          meta.version,
          sourceId,
          path,
          hash,
        )
        .run();

      for (const tag of deriveTags(meta, meta.name)) {
        await DB.prepare('INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)')
          .bind(moduleId, tag)
          .run();
      }

      await DB.prepare(
        `INSERT INTO module_versions (id, module_id, version, content_hash, changelog, released_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      )
        .bind(`${moduleId}-${hash.slice(0, 12)}`, moduleId, meta.version, hash,
              meta.description.slice(0, 200))
        .run();

      // New modules start unpublished and pending review; the mapping exists but
      // stays disabled until an admin approves, so the raw URL is not live yet.
      await DB.prepare(
        `INSERT INTO module_proxy_mappings
           (id, module_id, public_slug, source_id, file_path, serve_mode,
            is_enabled, content_hash)
         VALUES (?, ?, ?, ?, ?, 'raw', 0, ?)`,
      )
        .bind(`map-${slug}`, moduleId, slug, sourceId, path, hash)
        .run();

      // queue for review
      await DB.prepare(
        `INSERT INTO review_items (id, module_id, kind, status, source_id, source_path, proposed, baseline)
         VALUES (?, ?, 'new', 'pending', ?, ?, ?, '{}')`,
      )
        .bind(
          crypto.randomUUID(),
          moduleId,
          sourceId,
          path,
          JSON.stringify({ name: meta.name, version: meta.version, category: categorySlug }),
        )
        .run();

      added += 1;
      await log('info', path, `新增 ${slug}（待审核）`);

      // Announce to Telegram when configured. The first-party queue had no
      // notification path at all, so a synced repo could sit pending for days
      // unnoticed. Failure here must never fail the sync.
      if (env.TELEGRAM_BOT_TOKEN) {
        try {
          const { notifyFirstPartyPending } = await import('./telegram');
          await notifyFirstPartyPending(env, {
            name: meta.name,
            version: meta.version,
            sourcePath: path,
            repository: `${source.owner}/${source.repo}`,
            repositoryUrl: `https://github.com/${source.owner}/${source.repo}`,
            rawUrl: `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${path
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`,
            kind: 'new',
          });
        } catch {
          /* notification is best-effort */
        }
      }
    }

    await DB.prepare(
      `UPDATE sync_jobs SET status = 'ok', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              scanned = ?, added = ?, updated = ?, skipped = ?, failed = ?
        WHERE id = ?`,
    )
      .bind(scanned, added, updated, skipped, failed, jobId)
      .run();

    await DB.prepare(
      `UPDATE sources SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              last_status = ?, consecutive_failures = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
      .bind(failed > 0 ? 'partial' : 'ok', sourceId)
      .run();

    // a source that was failing and just succeeded earns a recovery note, so the
    // dashboard can close the loop instead of leaving a stale red banner
    if (source.consecutive_failures >= ALERT_THRESHOLD) {
      await DB.prepare(
        `INSERT INTO sync_alerts (source_id, kind, message) VALUES (?, 'recovered', ?)`,
      )
        .bind(sourceId, `同步恢复：${source.owner}/${source.repo}`)
        .run();
    }

    if (partial) {
      await log(
        'info',
        null,
        `分批处理：${nextCursor}/${totalFiles}，下次从第 ${nextCursor} 个文件继续`,
      );
    }

    return {
      jobId,
      status: 'ok',
      scanned,
      added,
      updated,
      changed,
      unchanged,
      skipped,
      failed,
      partial,
      totalFiles,
      processed: batch.length,
      message: partial
        ? `本批 ${batch.length}/${totalFiles} 个文件：新增 ${added}，更新 ${updated}，未变 ${unchanged}，失败 ${failed}`
        : `扫描 ${scanned}，新增 ${added}，更新 ${updated}，未变 ${unchanged}，失败 ${failed}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log('error', null, message);
    await DB.prepare(
      `UPDATE sync_jobs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              scanned = ?, added = ?, updated = ?, skipped = ?, failed = ?, error = ?
        WHERE id = ?`,
    )
      .bind(scanned, added, updated, skipped, failed + 1, message.slice(0, 500), jobId)
      .run();

    await DB.prepare(
      `UPDATE sources SET last_status = 'failed',
              consecutive_failures = consecutive_failures + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
      .bind(sourceId)
      .run();

    // Only alert once the threshold is crossed, and never twice for the same
    // streak: the admin page reads open alerts, so duplicates would just be noise.
    const after = await DB.prepare(
      'SELECT consecutive_failures FROM sources WHERE id = ?',
    )
      .bind(sourceId)
      .first<{ consecutive_failures: number }>();

    if ((after?.consecutive_failures ?? 0) === ALERT_THRESHOLD) {
      await DB.prepare(
        `INSERT INTO sync_alerts (source_id, kind, message) VALUES (?, 'failure', ?)`,
      )
        .bind(
          sourceId,
          `同步连续失败 ${ALERT_THRESHOLD} 次：${message.slice(0, 200)}`,
        )
        .run();
    }

    return {
      jobId,
      status: 'failed',
      scanned,
      added,
      updated,
      changed,
      unchanged,
      skipped,
      failed: failed + 1,
      message,
    };
  } finally {
    await releaseLock(DB, sourceId, lockToken);
  }
}

function deriveTags(meta: ParsedMeta, name: string): string[] {
  const tags = new Set<string>();
  if (meta.category) tags.add(meta.category.slice(0, 20));
  if (/dns/i.test(name)) tags.add('DNS');
  if (/去广告|广告/.test(name)) tags.add('去广告');
  if (/解锁|流媒体/.test(name)) tags.add('流媒体');
  if (/面板|IP|流量/.test(name)) tags.add('面板');
  if (/缓存|刷新/.test(name)) tags.add('工具');
  return [...tags].slice(0, 6);
}
