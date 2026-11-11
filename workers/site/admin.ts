/**
 * Admin API router.
 *
 * All routes live under /api/v1/admin and every one of them runs `requireAdmin`
 * before touching data. The router also enforces:
 *   - CSRF via SameSite=Lax plus an explicit `Origin` check on writes
 *   - per-action role checks from auth.ts (server-side, not UI)
 *   - audit logging for anything that changes state
 */

import { jsonError, jsonOk, methodNotAllowed } from '../../packages/shared/src/http';
import { readJsonCapped } from './third-party';
import { syncSource } from './sync';
import { runBatch } from './batch-review';
import { decideTask } from './review';
import { handlePhase6 } from './admin-phase6';
import { handleAdminUsers } from './admin-users';
import {
  createRepo,
  decideReview as decideThirdPartyReview,
  deleteRepo,
  getReview,
  getSettings as getThirdPartySettings,
  listRepos,
  listReviews,
  previewPush,
  repoLogs,
  repoModules,
  getCredentials,
  saveCredentials,
  testTelegram,
  resendNotification,
  runSchedulerNow,
  setWebhookSecret,
  triggerCheck,
  updateRepo,
  updateSettings as updateThirdPartySettings,
  verifyRepo,
  type ThirdPartyCtx,
} from './admin-third-party';
import {
  can,
  clearedCookie,
  cookieFor,
  hashPassword,
  hashToken,
  newSessionToken,
  parseCookie,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
  type AdminAction,
  type AdminIdentity,
} from './auth';

export interface AdminEnv {
  DB: D1Database;
  ENVIRONMENT?: string;
  /** read-only GitHub token, used by the webhook registration panel */
  GITHUB_READ_TOKEN?: string;
  /* ---- 第七阶段：第三方仓库 + Telegram ---- */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ID?: string;
  /** base64 32-byte key; encrypts per-repository webhook secrets at rest */
  WEBHOOK_SECRET_KEY?: string;
}

interface Ctx {
  db: D1Database;
  admin: AdminIdentity;
  env: AdminEnv;
  request: Request;
}

const MAX_BODY = 64 * 1024;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Writes must come from the same origin; SameSite alone is not enough. */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetch may omit it in some runtimes
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function audit(
  db: D1Database,
  admin: AdminIdentity,
  action: string,
  target: string | null,
  detail: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (actor, action, target, detail)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      admin.username,
      action,
      target,
      typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}).slice(0, 2000),
    )
    .run();
}

type AuthResult =
  | { ok: true; admin: AdminIdentity }
  | { ok: false; response: Response };

/** Resolves the session or produces the 401 response. */
async function requireAdmin(request: Request, env: AdminEnv): Promise<AuthResult> {
  const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const session = await resolveSession(env.DB, token);
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', '未登录或会话已过期') };
  }
  return { ok: true, admin: session.admin };
}

function forbid(admin: AdminIdentity, action: AdminAction): Response | null {
  if (can(admin.role, action)) return null;
  return jsonError('forbidden', `当前角色无权执行此操作（${action}）`);
}

/**
 * First-admin bootstrap.
 *
 * The only condition is "no admin exists yet". Restricting it to localhost made
 * a deployed instance impossible to initialise — there is no other way in.
 *
 * Safety comes from the state, not the origin: once one admin exists the endpoint
 * is permanently closed, and the response for a second attempt does not reveal
 * whether the username was taken. The window is also rate-limited through the
 * same login throttle, and an operator is expected to create the account
 * immediately after deploying.
 */
async function bootstrapState(db: D1Database): Promise<{ allowed: boolean; reason: string }> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) {
    return { allowed: false, reason: '管理员已存在，无法再初始化' };
  }
  return { allowed: true, reason: '' };
}

// ------------------------------------------------------------------- handlers
async function login(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const username = String(body.username ?? '').trim().slice(0, 64);
  const password = String(body.password ?? '');
  if (!username || !password) return jsonError('bad_request', '请输入用户名和密码');

  const row = await env.DB.prepare(
    `SELECT id, username, display_name, role, password_hash, is_active,
            failed_attempts, locked_until
       FROM admins WHERE username = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(username)
    .first<{
      id: string;
      username: string;
      display_name: string;
      role: string;
      password_hash: string;
      is_active: number;
      failed_attempts: number;
      locked_until: string | null;
    }>();

  // Same response for unknown user and wrong password: no account enumeration.
  const invalid = () => jsonError('unauthorized', '用户名或密码错误');

  if (!row) return invalid();
  if (row.is_active !== 1) return invalid();
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return jsonError('too_many_requests', '账号已临时锁定，请稍后再试');
  }

  const okPassword = await verifyPassword(password, row.password_hash);
  if (!okPassword) {
    const attempts = row.failed_attempts + 1;
    // 5 failures ⇒ 15 minute lock; counts reset on success
    const lockUntil =
      attempts >= 5
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
        : null;
    await env.DB.prepare(
      `UPDATE admins SET failed_attempts = ?, locked_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
      .bind(attempts, lockUntil, row.id)
      .run();
    return invalid();
  }

  await env.DB.prepare(
    `UPDATE admins SET failed_attempts = 0, locked_until = NULL,
            last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
  )
    .bind(row.id)
    .run();

  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, user_agent, client_hint)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      tokenHash,
      row.id,
      expiresAt,
      (request.headers.get('user-agent') ?? '').slice(0, 200),
      // country/region hint only; the full address is never stored
      request.headers.get('cf-ipcountry') ?? null,
    )
    .run();

  const secure = new URL(request.url).protocol === 'https:';
  return jsonOk(
    {
      admin: {
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        role: row.role,
      },
      expiresAt,
    },
    { headers: { 'set-cookie': cookieFor(token, secure) } },
  );
}

async function logout(ctx: Ctx): Promise<Response> {
  const token = parseCookie(ctx.request.headers.get('cookie'), SESSION_COOKIE);
  if (token) {
    const tokenHash = await hashToken(token);
    await ctx.db
      .prepare(
        `UPDATE admin_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE token_hash = ?`,
      )
      .bind(tokenHash)
      .run();
  }
  return jsonOk({ ok: true }, { headers: { 'set-cookie': clearedCookie() } });
}

async function bootstrap(request: Request, env: AdminEnv): Promise<Response> {
  const state = await bootstrapState(env.DB);
  if (!state.allowed) {
    return jsonError('forbidden', state.reason);
  }
  const body = await readJson(request);
  if (!body) return jsonError('bad_request', '请求体不合法');
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return jsonError('bad_request', '用户名需为 3–32 位字母、数字、下划线或点');
  }
  if (password.length < 12) {
    return jsonError('bad_request', '密码至少 12 位');
  }

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO admins (id, username, display_name, role, password_hash)
     VALUES (?, ?, ?, 'super', ?)`,
  )
    .bind(id, username, username, hash)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor, action, target, detail) VALUES (?, 'admin.bootstrap', ?, '{}')`,
  )
    .bind(username, id)
    .run();

  return jsonOk({ id, username, role: 'super' });
}

// ------------------------------------------------------------------ dashboard
async function dashboard(ctx: Ctx): Promise<Response> {
  const { db } = ctx;

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL) AS total,
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 1) AS published,
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 0) AS hidden,
         (SELECT COUNT(*) FROM review_items WHERE status = 'pending') AS pending,
         (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL) AS sources,
         (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL AND is_enabled = 1) AS sources_on,
         (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL) AS mappings,
         (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL AND is_enabled = 1) AS mappings_on`,
    )
    .first<Record<string, number>>();

  const lastSync = await db
    .prepare(
      `SELECT id, status, trigger, started_at, finished_at,
              scanned, added, updated, skipped, failed, error
         FROM sync_jobs ORDER BY created_at DESC LIMIT 5`,
    )
    .all<Record<string, unknown>>();

  const failures = await db
    .prepare(`SELECT COUNT(*) AS n FROM sync_jobs WHERE status = 'failed'`)
    .first<{ n: number }>();

  // last 7 days of analytics, grouped by event
  const analytics = await db
    .prepare(
      `SELECT event, COUNT(*) AS n FROM analytics_events
        WHERE day >= date('now', '-7 day') GROUP BY event ORDER BY n DESC`,
    )
    .all<{ event: string; n: number }>();

  const proxy = await db
    .prepare(
      `SELECT SUM(hits) AS hits, SUM(misses) AS misses, SUM(errors) AS errors
         FROM proxy_stats WHERE day >= date('now', '-7 day')`,
    )
    .first<{ hits: number | null; misses: number | null; errors: number | null }>();

  return jsonOk({
    counts: counts ?? {},
    syncFailures: failures?.n ?? 0,
    recentSyncs: lastSync.results ?? [],
    analytics: analytics.results ?? [],
    proxy: {
      hits: proxy?.hits ?? 0,
      misses: proxy?.misses ?? 0,
      errors: proxy?.errors ?? 0,
    },
  });
}

// -------------------------------------------------------------------- modules
async function listModules(ctx: Ctx, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  const status = url.searchParams.get('status') ?? '';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('perPage') ?? '25', 10) || 25),
  );

  const where: string[] = ['m.deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (q) {
    where.push('(m.name LIKE ? OR m.slug LIKE ? OR m.author LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (status === 'published') where.push('m.is_published = 1');
  else if (status === 'hidden') where.push('m.is_published = 0');
  else if (status === 'featured') where.push('m.is_featured = 1');

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const total = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM modules m ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await ctx.db
    .prepare(
      `SELECT m.id, m.slug, m.name, m.author, m.version, m.is_published,
              m.is_featured, m.review_status, m.updated_at, m.source_id,
              c.name AS category_name,
              (SELECT COUNT(*) FROM module_overrides o WHERE o.module_id = m.id) AS overrides,
              (SELECT COUNT(*) FROM module_proxy_mappings p
                WHERE p.module_id = m.id AND p.deleted_at IS NULL) AS mappings
         FROM modules m
         LEFT JOIN categories c ON c.id = m.category_id
        ${whereSql}
        ORDER BY m.updated_at DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, perPage, (page - 1) * perPage)
    .all<Record<string, unknown>>();

  return jsonOk(
    { items: rows.results ?? [] },
    { meta: { page, perPage, total: total?.n ?? 0, totalPages: Math.ceil((total?.n ?? 0) / perPage) } },
  );
}

async function getModule(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare(
      `SELECT m.*, c.name AS category_name, c.slug AS category_slug
         FROM modules m LEFT JOIN categories c ON c.id = m.category_id
        WHERE m.id = ? AND m.deleted_at IS NULL`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return jsonError('not_found', '模块不存在');

  const tags = await ctx.db
    .prepare('SELECT tag FROM module_tags WHERE module_id = ?')
    .bind(id)
    .all<{ tag: string }>();

  const overrides = await ctx.db
    .prepare('SELECT field, value, updated_at FROM module_overrides WHERE module_id = ?')
    .bind(id)
    .all<Record<string, unknown>>();

  const versions = await ctx.db
    .prepare(
      `SELECT version, changelog, content_hash, released_at
         FROM module_versions WHERE module_id = ? ORDER BY released_at DESC LIMIT 20`,
    )
    .bind(id)
    .all<Record<string, unknown>>();

  const mapping = await ctx.db
    .prepare(
      `SELECT id, public_slug, file_path, is_enabled, content_hash, ttl_seconds,
              last_fetched_at, last_status, last_error, source_id
         FROM module_proxy_mappings
        WHERE module_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  return jsonOk({
    module: row,
    tags: (tags.results ?? []).map((t) => t.tag),
    overrides: overrides.results ?? [],
    versions: versions.results ?? [],
    mapping: mapping ?? null,
  });
}

async function updateModule(ctx: Ctx, id: string): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const existing = await ctx.db
    .prepare('SELECT id FROM modules WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonError('not_found', '模块不存在');

  // Every field an admin writes is recorded as an override, so the sync job
  // (which only touches the synced columns) can never overwrite it.
  const overridable = [
    'name',
    'description',
    'author',
    'category_id',
    'version',
    'is_featured',
    'is_published',
    'sort_weight',
  ] as const;

  const applied: string[] = [];
  for (const field of overridable) {
    if (!(field in body)) continue;
    const raw = body[field];
    const value =
      field === 'is_featured' || field === 'is_published' || field === 'sort_weight'
        ? String(typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw) || 0)
        : String(raw ?? '');

    await ctx.db
      .prepare(
        `INSERT INTO module_overrides (module_id, field, value, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(module_id, field) DO UPDATE SET
           value = excluded.value, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      )
      .bind(id, field, value, ctx.admin.username)
      .run();

    // numeric flags live in integer columns
    if (field === 'sort_weight') {
      await ctx.db
        .prepare('UPDATE modules SET sort_weight = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE id = ?')
        .bind(Number(value) || 0, id)
        .run();
    } else if (field === 'is_featured' || field === 'is_published') {
      await ctx.db
        .prepare(`UPDATE modules SET ${field} = ? WHERE id = ?`)
        .bind(Number(value) ? 1 : 0, id)
        .run();
    } else {
      await ctx.db
        .prepare(`UPDATE modules SET ${field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
        .bind(value, id)
        .run();
    }
    applied.push(field);
  }

  if (Array.isArray(body.tags)) {
    const tags = (body.tags as unknown[])
      .map((t) => String(t).trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 12);
    await ctx.db.prepare('DELETE FROM module_tags WHERE module_id = ?').bind(id).run();
    for (const tag of tags) {
      await ctx.db
        .prepare('INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)')
        .bind(id, tag)
        .run();
    }
    applied.push('tags');
  }

  await audit(ctx.db, ctx.admin, 'module.update', id, { fields: applied });
  return jsonOk({ id, applied });
}

async function setModuleVisibility(ctx: Ctx, id: string, action: string): Promise<Response> {
  const map: Record<string, { sql: string; audit: string }> = {
    publish: { sql: 'is_published = 1', audit: 'module.publish' },
    hide: { sql: 'is_published = 0', audit: 'module.hide' },
    feature: { sql: 'is_featured = 1', audit: 'module.feature' },
    unfeature: { sql: 'is_featured = 0', audit: 'module.unfeature' },
  };
  const op = map[action];
  if (!op) return jsonError('bad_request', '未知操作');

  await ctx.db
    .prepare(`UPDATE modules SET ${op.sql}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .bind(id)
    .run();

  // A hidden module must not stay reachable through the proxy.
  if (action === 'hide') {
    await ctx.db
      .prepare('UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?')
      .bind(id)
      .run();
  }

  // Republishing must restore proxy reachability: hide flips is_enabled to 0,
  // and publish only touched modules — so a publish after hide left the module
  // listed on the site while its install link 404'd at the proxy.
  if (action === 'publish') {
    await ctx.db
      .prepare(
        'UPDATE module_proxy_mappings SET is_enabled = 1 WHERE module_id = ? AND deleted_at IS NULL',
      )
      .bind(id)
      .run();
  }

  await audit(ctx.db, ctx.admin, op.audit, id, {});
  return jsonOk({ id, action });
}

async function softDeleteModule(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT slug, source_id, source_path FROM modules WHERE id = ?')
    .bind(id)
    .first<{ slug: string; source_id: string | null; source_path: string | null }>();
  if (!row) return jsonError('not_found', '模块不存在');

  await ctx.db
    .prepare(
      `UPDATE modules SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_published = 0
        WHERE id = ?`,
    )
    .bind(id)
    .run();
  // the public slug must stop resolving immediately
  await ctx.db
    .prepare('UPDATE module_proxy_mappings SET is_enabled = 0, deleted_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE module_id = ?')
    .bind(id)
    .run();

  // tombstone so a resync cannot bring it back
  if (row.source_id && row.source_path) {
    await ctx.db
      .prepare(
        `INSERT INTO module_tombstones (id, source_id, source_path, reason)
         VALUES (?, ?, ?, 'removed')
         ON CONFLICT(source_id, source_path) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), row.source_id, row.source_path)
      .run();
  }

  await audit(ctx.db, ctx.admin, 'module.delete', id, { slug: row.slug });
  return jsonOk({ id, deleted: true });
}

// --------------------------------------------------------------- proxy admin
async function listMappings(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT p.id, p.public_slug, p.file_path, p.is_enabled, p.content_hash,
              p.ttl_seconds, p.last_fetched_at, p.last_status, p.last_error,
              p.source_id, s.owner, s.repo, s.branch, s.is_enabled AS source_enabled,
              m.name AS module_name, m.is_published,
              (SELECT SUM(hits) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS hits,
              (SELECT SUM(misses) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS misses,
              (SELECT SUM(errors) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS errors
         FROM module_proxy_mappings p
         JOIN sources s ON s.id = p.source_id
         LEFT JOIN modules m ON m.id = p.module_id
        WHERE p.deleted_at IS NULL
        ORDER BY p.public_slug`,
    )
    .all<Record<string, unknown>>();

  const base = await ctx.db
    .prepare("SELECT value FROM site_settings WHERE key = 'proxy.public_base'")
    .first<{ value: string }>();

  return jsonOk({
    items: rows.results ?? [],
    publicBase: base?.value ?? '',
  });
}

async function updateMapping(ctx: Ctx, id: string): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const row = await ctx.db
    .prepare('SELECT id, public_slug FROM module_proxy_mappings WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; public_slug: string }>();
  if (!row) return jsonError('not_found', '映射不存在');

  const sets: string[] = [];
  const binds: unknown[] = [];

  if ('is_enabled' in body) {
    sets.push('is_enabled = ?');
    binds.push(body.is_enabled ? 1 : 0);
  }
  if ('ttl_seconds' in body) {
    const ttl = Math.min(86_400, Math.max(30, Number(body.ttl_seconds) || 300));
    sets.push('ttl_seconds = ?');
    binds.push(ttl);
  }
  if (typeof body.file_path === 'string') {
    const path = body.file_path.trim();
    // same validation the proxy applies at serve time
    if (!/^[\w./@+-]+$/.test(path) || path.includes('..') || path.startsWith('/')) {
      return jsonError('bad_request', '文件路径不合法');
    }
    sets.push('file_path = ?');
    binds.push(path);
  }

  if (sets.length === 0) return jsonError('bad_request', '没有可更新的字段');

  await ctx.db
    .prepare(
      `UPDATE module_proxy_mappings SET ${sets.join(', ')},
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
    .bind(...binds, id)
    .run();

  // Disabling a mapping must also unpublish its module, otherwise the site still
  // advertises an install link that cannot work.
  if ('is_enabled' in body && !body.is_enabled) {
    await ctx.db
      .prepare(
        `UPDATE modules SET is_published = 0
          WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)`,
      )
      .bind(id)
      .run();
  }

  await audit(ctx.db, ctx.admin, 'proxy.update', row.public_slug, body);
  return jsonOk({ id: row.public_slug });
}

async function deleteMapping(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT public_slug FROM module_proxy_mappings WHERE id = ?')
    .bind(id)
    .first<{ public_slug: string }>();
  if (!row) return jsonError('not_found', '映射不存在');

  // Soft delete + disable: the proxy query filters both, so the old URL turns
  // into a 404 immediately and can never fall back to a generic fetch.
  await ctx.db
    .prepare(
      `UPDATE module_proxy_mappings
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0
        WHERE id = ?`,
    )
    .bind(id)
    .run();
  await ctx.db
    .prepare('UPDATE modules SET is_published = 0 WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)')
    .bind(id)
    .run();

  await audit(ctx.db, ctx.admin, 'proxy.delete', row.public_slug, {});
  return jsonOk({ deleted: row.public_slug });
}

/** Bumps the revision so the proxy cache key rotates. */
async function refreshMapping(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT public_slug FROM module_proxy_mappings WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ public_slug: string }>();
  if (!row) return jsonError('not_found', '映射不存在');

  const revision = crypto.randomUUID().slice(0, 12);
  await ctx.db
    .prepare(
      `UPDATE module_proxy_mappings
          SET content_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
    .bind(revision, id)
    .run();

  await audit(ctx.db, ctx.admin, 'proxy.refresh', row.public_slug, { revision });
  return jsonOk({ slug: row.public_slug, revision });
}


// ------------------------------------------------------------------ sources
async function listSources(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT s.id, s.owner, s.repo, s.branch, s.allow_paths, s.sync_mode,
              s.is_enabled, s.notes, s.last_synced_at, s.last_status,
              s.sync_lock IS NOT NULL AS locked,
              (SELECT COUNT(*) FROM modules m WHERE m.source_id = s.id AND m.deleted_at IS NULL) AS modules,
              (SELECT COUNT(*) FROM sync_jobs j WHERE j.source_id = s.id AND j.status = 'failed') AS failures
         FROM sources s WHERE s.deleted_at IS NULL ORDER BY s.owner, s.repo`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

async function upsertSource(ctx: Ctx, id: string | null): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const owner = String(body.owner ?? '').trim();
  const repo = String(body.repo ?? '').trim();
  const branch = String(body.branch ?? 'main').trim() || 'main';
  const allowPaths = String(body.allow_paths ?? '').trim();

  for (const [label, value] of [
    ['owner', owner],
    ['repo', repo],
    ['branch', branch],
  ] as const) {
    if (!/^[\w.-]{1,100}$/.test(value) || value === '.' || value === '..') {
      return jsonError('bad_request', `${label} 不合法`);
    }
  }
  // paths are a comma list of directory prefixes, never absolute, never traversal
  if (allowPaths) {
    for (const p of allowPaths.split(',')) {
      const clean = p.trim();
      if (!clean) continue;
      if (clean.startsWith('/') || clean.includes('..')) {
        return jsonError('bad_request', 'allow_paths 不能是绝对路径或包含 ..');
      }
    }
  }

  const enabled = body.is_enabled ? 1 : 0;
  const syncMode = ['manual', 'cron', 'webhook'].includes(String(body.sync_mode))
    ? String(body.sync_mode)
    : 'manual';

  if (id) {
    await ctx.db
      .prepare(
        `UPDATE sources SET owner = ?, repo = ?, branch = ?, allow_paths = ?,
                sync_mode = ?, is_enabled = ?, notes = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(owner, repo, branch, allowPaths, syncMode, enabled, String(body.notes ?? '').slice(0, 300), id)
      .run();
    await audit(ctx.db, ctx.admin, 'source.update', id, { owner, repo, branch, enabled });
    return jsonOk({ id });
  }

  const newId = `src-${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  await ctx.db
    .prepare(
      `INSERT INTO sources (id, owner, repo, branch, allow_paths, sync_mode, is_enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner, repo = excluded.repo, branch = excluded.branch,
         allow_paths = excluded.allow_paths, sync_mode = excluded.sync_mode,
         is_enabled = excluded.is_enabled, notes = excluded.notes,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    )
    .bind(newId, owner, repo, branch, allowPaths, syncMode, enabled, String(body.notes ?? '').slice(0, 300))
    .run();
  await audit(ctx.db, ctx.admin, 'source.create', newId, { owner, repo });
  return jsonOk({ id: newId });
}

/** Confirms the repository and branch are readable with the configured token. */
async function verifySource(ctx: Ctx, id: string): Promise<Response> {
  const source = await ctx.db
    .prepare('SELECT owner, repo, branch FROM sources WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ owner: string; repo: string; branch: string }>();
  if (!source) return jsonError('not_found', '数据源不存在');

  const token = (ctx.env as { GITHUB_READ_TOKEN?: string }).GITHUB_READ_TOKEN;
  if (!token) return jsonOk({ ok: false, reason: '未配置 GITHUB_READ_TOKEN' });

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/branches/${encodeURIComponent(source.branch)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'surge-modules-verify',
      },
    },
  );

  // never echo the token or the raw response body
  const result =
    res.status === 200
      ? { ok: true, reason: '仓库与分支可访问' }
      : res.status === 404
        ? { ok: false, reason: '仓库/分支不存在，或凭据无权访问' }
        : res.status === 401
          ? { ok: false, reason: '凭据无效' }
          : res.status === 403 || res.status === 429
            ? { ok: false, reason: 'GitHub 限流或权限不足' }
            : { ok: false, reason: `GitHub 返回 ${res.status}` };

  await ctx.db
    .prepare(`UPDATE sources SET last_status = ? WHERE id = ?`)
    .bind(result.ok ? 'verified' : 'error', id)
    .run();
  await audit(ctx.db, ctx.admin, 'source.verify', id, { ok: result.ok });
  return jsonOk(result);
}

// --------------------------------------------------------------------- sync
async function runSync(ctx: Ctx, sourceId: string | 'all'): Promise<Response> {
  // Telegram credentials must travel with the sync: without them the new-module
  // and update notifications are silently skipped (the helper returns early
  // when there is no token), which is how "no notification arrived" happened.
  const env = {
    DB: ctx.db,
    GITHUB_READ_TOKEN: (ctx.env as { GITHUB_READ_TOKEN?: string }).GITHUB_READ_TOKEN,
    TELEGRAM_BOT_TOKEN: (ctx.env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_ID: (ctx.env as { TELEGRAM_ADMIN_ID?: string }).TELEGRAM_ADMIN_ID,
  };
  const denied = forbid(ctx.admin, 'sync:run');
  if (denied) return denied;

  const ids =
    sourceId === 'all'
      ? (
          await ctx.db
            .prepare('SELECT id FROM sources WHERE deleted_at IS NULL AND is_enabled = 1')
            .all<{ id: string }>()
        ).results?.map((r) => r.id) ?? []
      : [sourceId];

  if (ids.length === 0) return jsonOk({ results: [], message: '没有启用的数据源' });

  const results = [];
  // sequential on purpose: parallel runs would contend for the same lock and
  // multiply GitHub API usage for no benefit at this scale
  for (const id of ids) {
    results.push({ sourceId: id, ...(await syncSource(env, id, 'manual')) });
  }

  await audit(ctx.db, ctx.admin, 'sync.run', sourceId, { sources: ids.length });
  return jsonOk({ results });
}

async function listSyncJobs(ctx: Ctx, url: URL): Promise<Response> {
  const sourceId = url.searchParams.get('source');
  const rows = sourceId
    ? await ctx.db
        .prepare(
          `SELECT id, source_id, trigger, status, started_at, finished_at,
                  scanned, added, updated, skipped, failed, error
             FROM sync_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(sourceId)
        .all<Record<string, unknown>>()
    : await ctx.db
        .prepare(
          `SELECT id, source_id, trigger, status, started_at, finished_at,
                  scanned, added, updated, failed, error
             FROM sync_jobs ORDER BY created_at DESC LIMIT 50`,
        )
        .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

async function syncJobLogs(ctx: Ctx, jobId: string): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT level, path, message, created_at FROM sync_logs
        WHERE job_id = ? ORDER BY id LIMIT 500`,
    )
    .bind(jobId)
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

// ------------------------------------------------------------------- review
async function listReview(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT r.id, r.kind, r.status, r.source_path, r.proposed, r.baseline,
              r.note, r.created_at, m.name AS module_name, m.slug,
              s.owner || '/' || s.repo AS source_repo
         FROM review_items r
         LEFT JOIN modules m ON m.id = r.module_id
         LEFT JOIN sources s ON s.id = r.source_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC LIMIT 100`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

/**
 * First-party review decision, callable without an HTTP session.
 *
 * Extracted so the Telegram batch UI can approve a `review_items` row through
 * exactly the same code path the admin panel uses. `ctx` still carries an
 * identity for the audit trail.
 */
export async function decideFirstPartyReview(
  db: D1Database,
  id: string,
  decision: 'approve' | 'reject',
  operator = 'system',
): Promise<{ ok: boolean; message?: string }> {
  const item = await db
    .prepare(
      `SELECT id, module_id, kind, proposed FROM review_items
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .first<{ id: string; module_id: string | null; kind: string; proposed: string }>();
  if (!item) return { ok: false, message: '审核项不存在或已处理' };

  const status = decision === 'approve' ? 'approved' : 'rejected';
  await db
    .prepare(
      `UPDATE review_items SET status = ?, reviewed_by = NULL,
              reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(status, id)
    .run();

  if (item.module_id) {
    if (decision === 'approve') {
      await db
        .prepare(
          `UPDATE modules SET review_status = 'approved', is_published = 1,
                  published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE id = ?`,
        )
        .bind(item.module_id)
        .run();
      await db
        .prepare(
          'UPDATE module_proxy_mappings SET is_enabled = 1 WHERE module_id = ? AND deleted_at IS NULL',
        )
        .bind(item.module_id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE modules SET review_status = 'rejected', is_published = 0 WHERE id = ?`,
        )
        .bind(item.module_id)
        .run();
      await db
        .prepare('UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?')
        .bind(item.module_id)
        .run();
    }
  }

  await audit(db, { username: operator } as AdminIdentity, `review.${decision}`, id, {
    moduleId: item.module_id,
    via: 'batch',
  });
  return { ok: true };
}

async function decideReview(ctx: Ctx, id: string, decision: string): Promise<Response> {
  if (decision !== 'approve' && decision !== 'reject') {
    return jsonError('bad_request', '未知决定');
  }

  const item = await ctx.db
    .prepare(
      `SELECT id, module_id, kind, proposed FROM review_items
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .first<{ id: string; module_id: string | null; kind: string; proposed: string }>();
  if (!item) return jsonError('not_found', '审核项不存在或已处理');

  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db
    .prepare(
      `UPDATE review_items SET status = ?, reviewed_by = ?,
              reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`,
    )
    .bind(status, ctx.admin.id, id)
    .run();

  if (item.module_id) {
    if (decision === 'approve') {
      // publish the module and switch its mapping on: the two must move together,
      // otherwise a hidden module would still resolve through the raw subdomain
      await ctx.db
        .prepare(
          `UPDATE modules SET review_status = 'approved', is_published = 1,
                  published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE id = ?`,
        )
        .bind(item.module_id)
        .run();
      await ctx.db
        .prepare('UPDATE module_proxy_mappings SET is_enabled = 1 WHERE module_id = ? AND deleted_at IS NULL')
        .bind(item.module_id)
        .run();
    } else {
      await ctx.db
        .prepare(
          `UPDATE modules SET review_status = 'rejected', is_published = 0
            WHERE id = ?`,
        )
        .bind(item.module_id)
        .run();
      await ctx.db
        .prepare('UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?')
        .bind(item.module_id)
        .run();
    }
  }

  await audit(ctx.db, ctx.admin, `review.${decision}`, id, { moduleId: item.module_id });
  return jsonOk({ id, status });
}

// -------------------------------------------------------------- categories
async function listCategoriesAdmin(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order,
              c.is_visible, c.deleted_at,
              (SELECT COUNT(*) FROM modules m WHERE m.category_id = c.id
                 AND m.deleted_at IS NULL) AS module_count
         FROM categories c WHERE c.deleted_at IS NULL
        ORDER BY c.sort_order, c.name`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

async function upsertCategory(ctx: Ctx, id: string | null): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const name = String(body.name ?? '').trim().slice(0, 40);
  const slug = String(body.slug ?? '').trim().toLowerCase();
  if (!name) return jsonError('bad_request', '名称不能为空');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return jsonError('bad_request', 'slug 只能是小写字母、数字和单个连字符');
  }

  const sortOrder = Number(body.sort_order) || 0;
  const visible = body.is_visible === false ? 0 : 1;

  if (id) {
    await ctx.db
      .prepare(
        `UPDATE categories SET name = ?, slug = ?, description = ?, icon = ?,
                sort_order = ?, is_visible = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(name, slug, String(body.description ?? '').slice(0, 200),
            String(body.icon ?? '').slice(0, 40), sortOrder, visible, id)
      .run();
    await audit(ctx.db, ctx.admin, 'category.update', id, { name, slug });
    return jsonOk({ id });
  }

  const newId = `cat-${slug}`;
  await ctx.db
    .prepare(
      `INSERT INTO categories (id, name, slug, description, icon, sort_order, is_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId, name, slug, String(body.description ?? '').slice(0, 200),
          String(body.icon ?? '').slice(0, 40), sortOrder, visible)
    .run();
  await audit(ctx.db, ctx.admin, 'category.create', newId, { name, slug });
  return jsonOk({ id: newId });
}

/**
 * Deletes a category.
 *
 * Modules are never deleted with it — the foreign key nulls `category_id`, so a
 * module just becomes uncategorised. Refuses while modules still point at it, so
 * content cannot silently fall out of the catalogue's navigation.
 */
async function deleteCategory(ctx: Ctx, id: string): Promise<Response> {
  const used = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM modules WHERE category_id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ n: number }>();

  if ((used?.n ?? 0) > 0) {
    return jsonError('conflict', `该分类下还有 ${used?.n} 个模块，请先移走或改分类`, {
      status: 409,
    });
  }

  const res = await ctx.db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  if (((res.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return jsonError('not_found', '分类不存在');
  }

  await audit(ctx.db, ctx.admin, 'category.delete', id, {});
  return jsonOk({ deleted: true });
}

// ------------------------------------------------------------ announcements
async function listAnnouncementsAdmin(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, title, body, level, is_pinned, is_published, published_at
         FROM announcements WHERE deleted_at IS NULL
        ORDER BY is_pinned DESC, published_at DESC LIMIT 100`,
    )
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

async function upsertAnnouncement(ctx: Ctx, id: string | null): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');
  const title = String(body.title ?? '').trim().slice(0, 80);
  if (!title) return jsonError('bad_request', '标题不能为空');
  const level = ['info', 'warning', 'critical'].includes(String(body.level))
    ? String(body.level)
    : 'info';

  if (id) {
    await ctx.db
      .prepare(
        `UPDATE announcements SET title = ?, body = ?, level = ?, is_pinned = ?,
                is_published = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(title, String(body.body ?? '').slice(0, 1000), level,
            body.is_pinned ? 1 : 0, body.is_published === false ? 0 : 1, id)
      .run();
    await audit(ctx.db, ctx.admin, 'announcement.update', id, { title });
    return jsonOk({ id });
  }

  const newId = crypto.randomUUID();
  await ctx.db
    .prepare(
      `INSERT INTO announcements (id, title, body, level, is_pinned, is_published, published_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    )
    .bind(newId, title, String(body.body ?? '').slice(0, 1000), level,
          body.is_pinned ? 1 : 0, body.is_published === false ? 0 : 1)
    .run();
  await audit(ctx.db, ctx.admin, 'announcement.create', newId, { title });
  return jsonOk({ id: newId });
}

// -------------------------------------------------------------- settings
async function getSettingsAdmin(ctx: Ctx): Promise<Response> {
  const rows = await ctx.db
    .prepare('SELECT key, value, value_type, scope FROM site_settings ORDER BY scope, key')
    .all<Record<string, unknown>>();
  return jsonOk({ items: rows.results ?? [] });
}

async function updateSettings(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request);
  const items = body?.items;
  if (!Array.isArray(items)) return jsonError('bad_request', '请求体不合法');

  for (const entry of items.slice(0, 50)) {
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
  }

  await audit(ctx.db, ctx.admin, 'settings.update', null, { count: items.length });
  return jsonOk({ updated: items.length });
}

// ---------------------------------------------------------------- analytics
async function analyticsSummary(ctx: Ctx): Promise<Response> {
  const byEvent = await ctx.db
    .prepare(
      `SELECT event, day, COUNT(*) AS n FROM analytics_events
        WHERE day >= date('now','-30 day') GROUP BY event, day ORDER BY day DESC`,
    )
    .all<Record<string, unknown>>();

  const proxy = await ctx.db
    .prepare(
      `SELECT day, SUM(hits) AS hits, SUM(misses) AS misses, SUM(errors) AS errors
         FROM proxy_stats WHERE day >= date('now','-30 day') GROUP BY day ORDER BY day DESC`,
    )
    .all<Record<string, unknown>>();

  return jsonOk({ events: byEvent.results ?? [], proxy: proxy.results ?? [] });
}

// -------------------------------------------------------------------- router
export async function handleAdmin(request: Request, env: AdminEnv, path: string): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // ---- public-ish: login + bootstrap
  if (path === '/login') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    return login(request, env);
  }
  if (path === '/bootstrap') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    return bootstrap(request, env);
  }
  if (path === '/session') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;
    return jsonOk({ admin: auth.admin });
  }

  // ---- everything below needs a session
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const ctx: Ctx = { db: env.DB, admin: auth.admin, env, request };

  if (path === '/logout') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return logout(ctx);
  }

  if (method !== 'GET' && !originAllowed(request)) {
    return jsonError('forbidden', '非法来源');
  }

  // ============================================ 用户体系：账号 / 邀请码
  // Accepts both /users and /user prefixes so an older bundle (which asked for
  // /admin/user/...) still reaches the handlers instead of falling through to
  // 404. The prefix is stripped exactly once before the dispatcher runs.
  const userMount = path.startsWith('/users/') || path === '/users'
    ? '/users'
    : path.startsWith('/user/') || path === '/user'
      ? '/user'
      : null;
  if (userMount) {
    return handleAdminUsers(
      {
        db: ctx.db,
        admin: ctx.admin,
        request: ctx.request,
        url: new URL(ctx.request.url),
      },
      path.slice(userMount.length) || '/',
      method,
    );
  }

  // ==================================================== 第七阶段：第三方仓库
  if (path === '/third-party' || path.startsWith('/third-party/')) {
    return handleThirdParty(ctx, path.slice('/third-party'.length) || '/', method);
  }

  if (path === '/dashboard') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return dashboard(ctx);
  }

  // ---- phase-6 routes (create/edit/delete, backups, logs, config I/O)
  //
  // The role check MUST run before the handler. Checking after dispatch would
  // mean the write already happened by the time a 403 is returned, which is a
  // privilege-escalation hole rather than a cosmetic bug.
  const PHASE6_GUARD: Array<[RegExp, AdminAction]> = [
    [/^\/modules$/, 'module:write'],
    // deletion is its own permission: editors may edit, not destroy
    [/^\/categories\/[\w-]+\/delete$/, 'content:delete'],
    [/^\/sources\/[\w-]+\/delete$/, 'content:delete'],
    [/^\/announcements\/[\w-]+\/delete$/, 'content:delete'],
    [/^\/update-logs/, 'announcement:write'],
    [/^\/backups/, 'settings:write'],
    [/^\/config\/import$/, 'settings:write'],
    [/^\/operation-logs$/, 'module:write'],
  ];

  const isPhase6Path =
    path === '/modules' ||
    path.startsWith('/categories/') ||
    path.startsWith('/sources/') ||
    path.startsWith('/announcements/') ||
    path.startsWith('/update-logs') ||
    path.startsWith('/backups') ||
    path.startsWith('/operation-logs') ||
    path.startsWith('/config/');

  if (isPhase6Path && method !== 'GET') {
    for (const [re, action] of PHASE6_GUARD) {
      if (!re.test(path)) continue;
      const denied = forbid(ctx.admin, action);
      if (denied) return denied;
      break;
    }
  }

  const phase6 = await handlePhase6(
    {
      db: ctx.db,
      admin: ctx.admin,
      request,
      publicOrigin: new URL(request.url).origin,
      githubToken: (ctx.env as { GITHUB_READ_TOKEN?: string }).GITHUB_READ_TOKEN,
    },
    path,
    method,
    url,
  );
  if (phase6) return phase6;

  if (path === '/modules') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listModules(ctx, url);
  }

  const moduleMatch = path.match(/^\/modules\/([\w-]+)$/);
  if (moduleMatch) {
    const id = moduleMatch[1];
    if (method === 'GET') return getModule(ctx, id);
    if (method === 'PATCH') {
      const denied = forbid(ctx.admin, 'module:write');
      if (denied) return denied;
      return updateModule(ctx, id);
    }
    if (method === 'DELETE') {
      const denied = forbid(ctx.admin, 'module:delete');
      if (denied) return denied;
      return softDeleteModule(ctx, id);
    }
    return methodNotAllowed(['GET', 'PATCH', 'DELETE']);
  }

  const actionMatch = path.match(/^\/modules\/([\w-]+)\/(publish|hide|feature|unfeature)$/);
  if (actionMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = forbid(ctx.admin, 'module:write');
    if (denied) return denied;
    return setModuleVisibility(ctx, actionMatch[1], actionMatch[2]);
  }

  if (path === '/mappings') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listMappings(ctx);
  }

  const mappingMatch = path.match(/^\/mappings\/([\w-]+)$/);
  if (mappingMatch) {
    const id = mappingMatch[1];
    const denied = forbid(ctx.admin, 'proxy:write');
    if (method === 'PATCH') {
      if (denied) return denied;
      return updateMapping(ctx, id);
    }
    if (method === 'DELETE') {
      if (denied) return denied;
      return deleteMapping(ctx, id);
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  const refreshMatch = path.match(/^\/mappings\/([\w-]+)\/refresh$/);
  if (refreshMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = forbid(ctx.admin, 'proxy:write');
    if (denied) return denied;
    return refreshMapping(ctx, refreshMatch[1]);
  }

  if (path === '/sources') {
    if (method === 'GET') return listSources(ctx);
    if (method === 'POST') {
      const denied = forbid(ctx.admin, 'source:write');
      if (denied) return denied;
      return upsertSource(ctx, null);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const sourceMatch = path.match(/^\/sources\/([\w-]+)$/);
  if (sourceMatch) {
    if (method === 'PATCH') {
      const denied = forbid(ctx.admin, 'source:write');
      if (denied) return denied;
      return upsertSource(ctx, sourceMatch[1]);
    }
    return methodNotAllowed(['PATCH']);
  }

  const verifyMatch = path.match(/^\/sources\/([\w-]+)\/verify$/);
  if (verifyMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = forbid(ctx.admin, 'source:write');
    if (denied) return denied;
    return verifySource(ctx, verifyMatch[1]);
  }

  const syncMatch = path.match(/^\/sync\/([\w-]+)$/);
  if (syncMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return runSync(ctx, syncMatch[1]);
  }

  if (path === '/sync-jobs') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listSyncJobs(ctx, url);
  }

  const logsMatch = path.match(/^\/sync-jobs\/([\w-]+)\/logs$/);
  if (logsMatch) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return syncJobLogs(ctx, logsMatch[1]);
  }

  if (path === '/review') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listReview(ctx);
  }

  const reviewMatch = path.match(/^\/review\/([\w-]+)\/(approve|reject)$/);
  if (reviewMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = forbid(ctx.admin, 'review:decide');
    if (denied) return denied;
    return decideReview(ctx, reviewMatch[1], reviewMatch[2]);
  }

  if (path === '/categories') {
    if (method === 'GET') return listCategoriesAdmin(ctx);
    if (method === 'POST') {
      const denied = forbid(ctx.admin, 'category:write');
      if (denied) return denied;
      return upsertCategory(ctx, null);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const catMatch = path.match(/^\/categories\/([\w-]+)$/);
  if (catMatch) {
    if (method === 'DELETE') {
      const denied = forbid(ctx.admin, 'category:write');
      if (denied) return denied;
      return deleteCategory(ctx, catMatch[1]);
    }
    if (method !== 'PATCH') return methodNotAllowed(['PATCH', 'DELETE']);
    const denied = forbid(ctx.admin, 'category:write');
    if (denied) return denied;
    return upsertCategory(ctx, catMatch[1]);
  }

  if (path === '/announcements') {
    if (method === 'GET') return listAnnouncementsAdmin(ctx);
    if (method === 'POST') {
      const denied = forbid(ctx.admin, 'announcement:write');
      if (denied) return denied;
      return upsertAnnouncement(ctx, null);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const annMatch = path.match(/^\/announcements\/([\w-]+)$/);
  if (annMatch) {
    if (method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const denied = forbid(ctx.admin, 'announcement:write');
    if (denied) return denied;
    return upsertAnnouncement(ctx, annMatch[1]);
  }

  if (path === '/settings') {
    if (method === 'GET') return getSettingsAdmin(ctx);
    if (method === 'PATCH') {
      const denied = forbid(ctx.admin, 'settings:write');
      if (denied) return denied;
      return updateSettings(ctx);
    }
    return methodNotAllowed(['GET', 'PATCH']);
  }

  if (path === '/analytics') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return analyticsSummary(ctx);
  }

  if (path === '/audit') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const rows = await ctx.db
      .prepare(
        `SELECT actor, action, target, detail, created_at FROM audit_logs
          ORDER BY id DESC LIMIT 100`,
      )
      .all<Record<string, unknown>>();
    return jsonOk({ items: rows.results ?? [] });
  }

  return jsonError('not_found', '管理接口不存在');
}

/**
 * Third-party repository routes.
 *
 * Split out of the main switch because there are 18 endpoints here, but every
 * one of them still goes through the same session check (`ctx` is only built
 * after requireAdmin) and the same role table.
 */
async function handleThirdParty(
  ctx: Ctx,
  path: string,
  method: string,
): Promise<Response> {
  const tp: ThirdPartyCtx = {
    db: ctx.db,
    env: {
      DB: ctx.db,
      GITHUB_READ_TOKEN: ctx.env.GITHUB_READ_TOKEN,
      TELEGRAM_BOT_TOKEN: ctx.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_ADMIN_ID: ctx.env.TELEGRAM_ADMIN_ID,
      WEBHOOK_SECRET_KEY: ctx.env.WEBHOOK_SECRET_KEY,
      ENVIRONMENT: ctx.env.ENVIRONMENT,
    },
    admin: ctx.admin,
    request: ctx.request,
    url: new URL(ctx.request.url),
  };

  const write = () => forbid(ctx.admin, 'thirdparty:write');
  const check = () => forbid(ctx.admin, 'thirdparty:check');
  const review = () => forbid(ctx.admin, 'review:decide');

  // ---- repositories
  if (path === '/repositories' || path === '/repositories/') {
    if (method === 'GET') return listRepos(tp);
    if (method === 'POST') {
      const denied = write();
      if (denied) return denied;
      return createRepo(tp);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const repoMatch = path.match(/^\/repositories\/([\w-]+)$/);
  if (repoMatch) {
    if (method === 'PATCH' || method === 'PUT') {
      const denied = write();
      if (denied) return denied;
      return updateRepo(tp, repoMatch[1]);
    }
    if (method === 'DELETE') {
      const denied = write();
      if (denied) return denied;
      return deleteRepo(tp, repoMatch[1]);
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  const repoSub = path.match(/^\/repositories\/([\w-]+)\/([\w-]+)$/);
  if (repoSub) {
    const id = repoSub[1];
    const action = repoSub[2];
    if (action === 'verify') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      const denied = write();
      if (denied) return denied;
      return verifyRepo(tp, id);
    }
    if (action === 'check') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      const denied = check();
      if (denied) return denied;
      return triggerCheck(tp, id);
    }
    if (action === 'logs') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return repoLogs(tp, id);
    }
    if (action === 'modules') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return repoModules(tp, id);
    }
    if (action === 'preview') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      const denied = check();
      if (denied) return denied;
      return previewPush(tp, id);
    }
    if (action === 'secret') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      const denied = write();
      if (denied) return denied;
      return setWebhookSecret(tp, id);
    }
    return jsonError('not_found', '接口不存在');
  }

  // ---- editable credentials (super admin only)
  if (path === '/credentials') {
    if (method === 'GET') return getCredentials(tp);
    if (method === 'PUT' || method === 'PATCH') {
      const denied = write();
      if (denied) return denied;
      return saveCredentials(tp);
    }
    return methodNotAllowed(['GET', 'PUT']);
  }

  if (path === '/credentials/test-telegram') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = write();
    if (denied) return denied;
    return testTelegram(tp);
  }

  // ---- global settings
  if (path === '/settings') {
    if (method === 'GET') return getThirdPartySettings(tp);
    if (method === 'PUT' || method === 'PATCH') {
      const denied = forbid(ctx.admin, 'settings:write');
      if (denied) return denied;
      return updateThirdPartySettings(tp);
    }
    return methodNotAllowed(['GET', 'PUT']);
  }

  // ---- scheduler
  if (path === '/scheduler/run') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = forbid(ctx.admin, 'sync:run');
    if (denied) return denied;
    return runSchedulerNow(tp);
  }

  // ---- reviews
  if (path === '/reviews' || path === '/reviews/') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listReviews(tp);
  }

  // ---- bulk decision. Shares the Telegram batch engine (`runBatch`) so the
  // web panel and the bot can never diverge on what "approve these 12" means:
  // delete tasks are refused (they need a per-item choice), already-resolved
  // rows are reported as skipped, and every outcome is returned individually.
  if (path === '/reviews/batch') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const denied = review();
    if (denied) return denied;
    const capped = await readJsonCapped(ctx.request, 128 * 1024);
    const body: Record<string, unknown> = 'error' in capped ? {} : (capped.data as Record<string, unknown>);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : [];
    if (ids.length === 0) return jsonError('bad_request', '缺少审核任务 id 列表');
    if (ids.length > 200) return jsonError('bad_request', '单次批量最多 200 条');
    const action = body.action === 'reject' ? 'reject' : 'approve';
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined;
    const result = await runBatch(ctx.env.DB, {
      ids,
      action,
      operator: ctx.admin.username,
      source: 'web',
      reason,
      decideThirdParty: async (taskId: string) => {
        const r = await decideTask(ctx.env, {
          taskId,
          decision: action === 'approve' ? 'approve' : 'reject',
          operator: ctx.admin.username,
          source: 'web',
          reason,
        });
        return r.ok
          ? { ok: true, published: r.published, message: r.status }
          : { ok: false, message: r.message };
      },
      decideFirstParty: (reviewId: string) =>
        decideFirstPartyReview(ctx.env.DB, reviewId, action === 'approve' ? 'approve' : 'reject', ctx.admin.username),
    });
    return jsonOk(result);
  }

  const reviewId = path.match(/^\/reviews\/([\w-]+)$/);
  if (reviewId) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return getReview(tp, reviewId[1]);
  }

  const reviewAct = path.match(/^\/reviews\/([\w-]+)\/([\w-]+)$/);
  if (reviewAct) {
    const denied = review();
    if (denied) return denied;
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const id = reviewAct[1];
    const action = reviewAct[2];
    if (action === 'decide' || action === 'approve' || action === 'reject') {
      // normalize the shorthand endpoints onto the single decide handler so the
      // publish logic can never diverge between them
      if (action !== 'decide') {
        const original = ctx.request;
        const body = action === 'approve' ? { decision: 'approve' } : { decision: 'reject' };
        const patched = new Request(original.url, {
          method: 'POST',
          headers: original.headers,
          body: JSON.stringify(body),
        });
        return decideThirdPartyReview({ ...tp, request: patched }, id);
      }
      return decideThirdPartyReview(tp, id);
    }
    if (action === 'resend') {
      return resendNotification(tp, id);
    }
    return jsonError('not_found', '接口不存在');
  }

  return jsonError('not_found', '第三方接口不存在');
}
