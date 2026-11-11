/**
 * Admin API for the user system: users, invitations, access credentials.
 *
 * Mounted under /admin/users/*. Every handler assumes `requireAdmin` already ran
 * in admin.ts; `ctx.admin.role` gates the destructive operations, and the router
 * additionally refuses anything that is not `super` for writes — managing who can
 * read modules is an owner-level action, not an editor one.
 *
 * Nothing here ever returns a credential value. Only `hint` (a 4…4 fingerprint)
 * and status/time metadata are exposed; the plaintext exists solely in the
 * response to /api/v1/user/credential at creation time.
 */

import { jsonError, jsonOk, methodNotAllowed } from '../../packages/shared/src/http';
import { maskEmail } from './user-api';
import { newToken, sha256Hex } from './user-auth';
import { countActiveDevices, loadDeviceLimits } from './devices';

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

const bool = (v: unknown): number => (v === true || v === 1 || v === '1' ? 1 : 0);

export interface AdminUsersCtx {
  db: D1Database;
  admin: { id: string; username: string; role: string };
  request: Request;
  url: URL;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > 32 * 1024) return null;
  const text = await request.text().catch(() => '');
  if (!text || text.length > 32 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function audit(
  db: D1Database,
  actor: string,
  kind: string,
  userId: string | null,
  detail: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO security_events (kind, user_id, actor, detail)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(kind, userId, actor.slice(0, 80), JSON.stringify(detail ?? {}).slice(0, 2000))
    .run();
}

// -------------------------------------------------------------------- users
/** GET /users — page, search, status filter. */
export async function listUsers(ctx: AdminUsersCtx): Promise<Response> {
  const q = ctx.url.searchParams;
  const search = str(q.get('q'), 60);
  const status = str(q.get('status'), 20);
  const page = num(q.get('page'), 1, 1, 10_000);
  const perPage = num(q.get('perPage'), 20, 1, 100);

  const where: string[] = ['u.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (search) {
    where.push('(u.username LIKE ? OR u.email_normalized LIKE ?)');
    binds.push(`%${search}%`, `%${search}%`);
  }
  if (status && status !== 'all') {
    where.push('u.status = ?');
    binds.push(status);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  const total = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await ctx.db
    .prepare(
      `SELECT u.id, u.username, u.email, u.status, u.register_method,
              u.email_verified_at, u.registered_at, u.last_login_at, u.max_devices_override,
              (SELECT COUNT(*) FROM access_credentials c
                WHERE c.user_id = u.id AND c.status = 'active') AS active_creds,
              (SELECT MAX(last_used_at) FROM access_credentials c
                WHERE c.user_id = u.id) AS last_used,
              (SELECT COUNT(*) FROM module_access_logs l
                WHERE l.user_id = u.id AND l.result = 'ok') AS access_count
         FROM users u
         ${clause}
        ORDER BY u.registered_at DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, perPage, (page - 1) * perPage)
    .all<Record<string, unknown>>();

  return jsonOk({
    items: (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      emailMasked: maskEmail(String(r.email ?? '')),
      status: r.status,
      registerMethod: r.register_method,
      emailVerified: Boolean(r.email_verified_at),
      registeredAt: r.registered_at,
      lastLoginAt: r.last_login_at,
      activeCredentials: Number(r.active_creds ?? 0),
      lastUsedAt: r.last_used,
      accessCount: Number(r.access_count ?? 0),
      maxDevices: r.max_devices_override === null ? null : Number(r.max_devices_override),
    })),
    total: total?.n ?? 0,
    page,
    perPage,
  });
}

/** PATCH /users/:id — status / password reset. */
export async function updateUser(ctx: AdminUsersCtx, id: string): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const row = await ctx.db
    .prepare('SELECT id, username, status FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; username: string; status: string }>();
  if (!row) return jsonError('not_found', '用户不存在');

  if (body.status !== undefined) {
    const next = str(body.status, 20);
    if (!['active', 'banned', 'pending'].includes(next)) {
      return jsonError('bad_request', '未知状态');
    }
    await ctx.db
      .prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind(next, iso(), id)
      .run();

    // A ban must take effect immediately: kill sessions and credentials in the
    // same breath, otherwise the user keeps reading modules until a token
    // happens to be revoked.
    if (next === 'banned') {
      await ctx.db
        .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(iso(), id)
        .run();
      await ctx.db
        .prepare(
          "UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
        )
        .bind(iso(), id)
        .run();
    }

    await audit(ctx.db, ctx.admin.username, next === 'banned' ? 'user.ban' : 'user.status', id, {
      to: next,
      previous: row.status,
    });
    return jsonOk({ id, status: next });
  }

  return jsonError('bad_request', '没有可更新的字段');
}

/** DELETE /users/:id — soft delete + full lockout. */
export async function deleteUser(ctx: AdminUsersCtx, id: string): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT username FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ username: string }>();
  if (!row) return jsonError('not_found', '用户不存在');

  await ctx.db
    .prepare(
      `UPDATE users SET deleted_at = ?, status = 'deleted', updated_at = ? WHERE id = ?`,
    )
    .bind(iso(), iso(), id)
    .run();
  await ctx.db
    .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(iso(), id)
    .run();
  await ctx.db
    .prepare(
      "UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
    )
    .bind(iso(), id)
    .run();

  await audit(ctx.db, ctx.admin.username, 'user.delete', id, { username: row.username });
  return jsonOk({ id, deleted: true });
}

/** GET /users/:id/activity — credentials, sessions, recent access. */
export async function userActivity(ctx: AdminUsersCtx, id: string): Promise<Response> {
  const [creds, sessions, access, events] = await Promise.all([
    ctx.db
      .prepare(
        `SELECT id, hint, status, created_at, last_used_at, revoked_at, expires_at
           FROM access_credentials WHERE user_id = ?
          ORDER BY created_at DESC LIMIT 20`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    ctx.db
      .prepare(
        `SELECT token_hash, user_agent, created_at, expires_at, revoked_at
           FROM user_sessions WHERE user_id = ?
          ORDER BY created_at DESC LIMIT 20`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    ctx.db
      .prepare(
        `SELECT slug, result, status, created_at, user_agent
           FROM module_access_logs WHERE user_id = ?
          ORDER BY created_at DESC LIMIT 30`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    ctx.db
      .prepare(
        `SELECT kind, actor, detail, created_at FROM security_events
          WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
  ]);

  return jsonOk({
    credentials: (creds.results ?? []).map((c) => ({
      id: c.id,
      hint: c.hint,
      status: c.status,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
      revokedAt: c.revoked_at,
    })),
    sessions: (sessions.results ?? []).map((s) => ({
      id: String(s.token_hash).slice(0, 8),
      userAgent: s.user_agent,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
    })),
    access: access.results ?? [],
    events: events.results ?? [],
  });
}

/** POST /users/:id/revoke — kill all credentials. */
export async function revokeUserCredentials(
  ctx: AdminUsersCtx,
  id: string,
): Promise<Response> {
  const res = await ctx.db
    .prepare(
      "UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
    )
    .bind(iso(), id)
    .run();
  const changed = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  await audit(ctx.db, ctx.admin.username, 'credential.admin_revoke', id, { count: changed });
  return jsonOk({ revoked: changed });
}

// ------------------------------------------------------- per-user devices
/** Lists the devices of one account (admin view). */
export async function getUserDevices(ctx: AdminUsersCtx, userId: string): Promise<Response> {
  // Devices are credentials. Listing one is listing the other.
  const { results } = await ctx.db
    .prepare(
      `SELECT id, hint, status, created_at, last_used_at
         FROM access_credentials WHERE user_id = ?
        ORDER BY status = 'active' DESC, created_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; hint: string; status: string; created_at: string; last_used_at: string | null }>();

  return jsonOk({
    items: (results ?? []).map((c) => ({
      id: c.id,
      name: c.hint,
      status: c.status,
      firstSeenAt: c.created_at,
      lastSeenAt: c.last_used_at,
      accessCount: 0,
    })),
  });
}

/**
 * Creates a device (and its own credential) on behalf of a user.
 *
 * The user-facing app has no such button by design — devices are provisioned
 * here so the operator decides how many links an account may hold. The returned
 * token is shown once; copy it to the user out-of-band.
 */
export async function createUserDevice(ctx: AdminUsersCtx, userId: string): Promise<Response> {
  const body = await readBody(ctx.request);
  const name = str(body?.name, 60) || '管理员开通';

  const user = await ctx.db
    .prepare('SELECT id, username FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(userId)
    .first<{ id: string; username: string }>();
  if (!user) return jsonError('not_found', '用户不存在');

  // One credential = one device slot. The limit is checked against the same
  // table the install link reads from, so the two can never disagree.
  const limits = await loadDeviceLimits(ctx.db, userId);
  const used = await countActiveDevices(ctx.db, userId);
  if (limits.enabled && used >= limits.max) {
    return jsonError(
      'conflict',
      `该用户已有 ${used} 条凭证，达到上限 ${limits.max} 条。请先撤销一条再开通。`,
      { status: 409 },
    );
  }

  const token = newToken(32);
  const tokenHash = await sha256Hex(token);
  const hint = `${token.slice(0, 4)}…${token.slice(-4)}`;
  const credId = crypto.randomUUID();

  await ctx.db
    .prepare(
      `INSERT INTO access_credentials (id, user_id, token_hash, hint, plain_token)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(credId, userId, tokenHash, hint, token)
    .run();

  await audit(ctx.db, ctx.admin.username, 'credential.adminCreate', userId, { name, hint });
  return jsonOk({ deviceId: credId, token, hint, name, used: used + 1, max: limits.max });
}

export async function revokeUserDevice(ctx: AdminUsersCtx, deviceId: string): Promise<Response> {
  // `deviceId` is a credential id: one key, one slot.
  const row = await ctx.db
    .prepare("SELECT id, user_id FROM access_credentials WHERE id = ? AND status = 'active'")
    .bind(deviceId)
    .first<{ id: string; user_id: string }>();
  if (!row) return jsonError('not_found', '凭证不存在或已撤销');

  await ctx.db
    .prepare("UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE id = ?")
    .bind(iso(), deviceId)
    .run();

  await audit(ctx.db, ctx.admin.username, 'credential.adminRevoke', row.user_id, { deviceId });
  return jsonOk({ revoked: true });
}

/** Sets a per-account device cap (null = inherit the global value). */
export async function setUserDeviceLimit(ctx: AdminUsersCtx, userId: string): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const raw = body.maxDevices;
  const max = raw === null || raw === undefined || raw === '' ? null : num(raw, 2, 1, 100);

  const res = await ctx.db
    .prepare('UPDATE users SET max_devices_override = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(max, iso(), userId)
    .run();
  if (((res.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return jsonError('not_found', '用户不存在');
  }

  await audit(ctx.db, ctx.admin.username, 'user.deviceLimit', userId, { max });
  return jsonOk({ userId, maxDevices: max });
}

/** Bulk soft-delete. Partial success is reported, not rolled back. */
export async function deleteUsersBulk(ctx: AdminUsersCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (ids.length === 0) return jsonError('bad_request', '未选择用户');
  if (ids.length > 100) return jsonError('bad_request', '一次最多删除 100 个用户');

  let deleted = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const res = await ctx.db
        .prepare(
          `UPDATE users SET deleted_at = ?, status = 'deleted', updated_at = ?
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(iso(), iso(), id)
        .run();
      if (((res.meta as { changes?: number } | undefined)?.changes ?? 0) > 0) {
        await ctx.db
          .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
          .bind(iso(), id)
          .run();
        await ctx.db
          .prepare("UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'")
          .bind(iso(), id)
          .run();
        deleted += 1;
      } else {
        failed.push(id);
      }
    } catch {
      failed.push(id);
    }
  }

  await audit(ctx.db, ctx.admin.username, 'user.bulkDelete', null, { deleted, failed: failed.length });
  return jsonOk({ deleted, failed });
}

// --------------------------------------------------------- email blacklist
export async function listBlacklist(ctx: AdminUsersCtx): Promise<Response> {
  const { results } = await ctx.db
    .prepare(
      `SELECT email_normalized, reason, created_by, created_at
         FROM email_blacklist ORDER BY created_at DESC LIMIT 200`,
    )
    .all<Record<string, unknown>>();

  return jsonOk({
    items: (results ?? []).map((r) => ({
      email: r.email_normalized,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
}

export async function addToBlacklist(ctx: AdminUsersCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');
  const email = str(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    return jsonError('bad_request', '邮箱格式不正确');
  }

  await ctx.db
    .prepare(
      `INSERT INTO email_blacklist (email_normalized, reason, created_by)
       VALUES (?, ?, ?)
       ON CONFLICT(email_normalized) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by`,
    )
    .bind(email, str(body.reason, 200), ctx.admin.username)
    .run();

  //拉黑立即生效：吊销该地址当前账号的会话与凭证，并冻结账号
  const user = await ctx.db
    .prepare('SELECT id, username, status FROM users WHERE email_normalized = ? AND deleted_at IS NULL')
    .bind(email)
    .first<{ id: string; username: string }>();
  let banned = false;
  if (user) {
    await ctx.db
      .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(iso(), user.id)
      .run();
    await ctx.db
      .prepare("UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'")
      .bind(iso(), user.id)
      .run();
    await ctx.db
      .prepare("UPDATE users SET status = 'banned', updated_at = ? WHERE id = ? AND status != 'deleted'")
      .bind(iso(), user.id)
      .run();
    banned = true;
  }

  await audit(ctx.db, ctx.admin.username, 'email.blacklist', user?.id ?? null, { email, banned });
  return jsonOk({ email, bannedExistingAccount: banned });
}

export async function removeFromBlacklist(ctx: AdminUsersCtx, email: string): Promise<Response> {
  await ctx.db.prepare('DELETE FROM email_blacklist WHERE email_normalized = ?').bind(email).run();
  await audit(ctx.db, ctx.admin.username, 'email.unblacklist', null, { email });
  return jsonOk({ email, removed: true });
}

// ---------------------------------------------------------- device policy
/**
 * Applies a device limit to every account at once.
 *
 * The per-account cap lives in `user_settings` (one row, global), so "for all
 * users" is a single update — there is no per-user column to fan out. The
 * endpoint also returns how many active devices currently exceed the new cap,
 * so the operator can see the impact before users hit it.
 */
export async function setDevicePolicy(ctx: AdminUsersCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const enabled = body.enabled === undefined ? true : bool(body.enabled);
  const max = num(body.max, 2, 1, 100);

  await ctx.db
    .prepare(
      `UPDATE user_settings SET device_limit_enabled = ?, max_devices = ?,
              updated_by = ?, updated_at = ? WHERE id = 1`,
    )
    .bind(enabled ? 1 : 0, max, ctx.admin.username, iso())
    .run();

  // Which accounts are currently over the new limit? Informational only —
  // existing devices are never revoked automatically.
  const over = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT user_id FROM devices WHERE status = 'active'
          GROUP BY user_id HAVING COUNT(*) > ?
       )`,
    )
    .bind(max)
    .first<{ n: number }>();

  await audit(ctx.db, ctx.admin.username, 'device.policy.setAll', null, { enabled, max, over: over?.n ?? 0 });

  return jsonOk({ enabled, max, usersOverLimit: over?.n ?? 0 });
}

// ----------------------------------------------------- registration approval
export async function listApplications(ctx: AdminUsersCtx): Promise<Response> {
  const status = str(ctx.url.searchParams.get('status'), 20) || 'pending';
  const where = status === 'all' ? '' : 'WHERE a.status = ?';
  const binds = status === 'all' ? [] : [status];

  const rows = await ctx.db
    .prepare(
      `SELECT a.id, a.user_id, a.email, a.username, a.status, a.note,
              a.reviewed_by, a.reviewed_at, a.created_at, a.ip_hash,
              u.email_verified_at
         FROM registration_applications a
         LEFT JOIN users u ON u.id = a.user_id
         ${where}
        ORDER BY a.created_at DESC LIMIT 100`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();

  const counts = await ctx.db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM registration_applications GROUP BY status`,
    )
    .all<{ status: string; n: number }>();

  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const c of counts.results ?? []) byStatus[c.status] = c.n;

  return jsonOk({
    items: (rows.results ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      email: String(r.email ?? ''),
      emailMasked: maskEmail(String(r.email ?? '')),
      status: r.status,
      note: r.note,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
      emailVerified: Boolean(r.email_verified_at),
    })),
    counts: byStatus,
  });
}

/**
 * Approves or rejects one application.
 *
 * The status transition is a conditional UPDATE, so a double click (or two
 * admins acting at once) can only apply once. Approving flips the user to
 * `active`; rejecting sets `banned` so the row cannot log in, while keeping it
 * for the audit trail.
 */
export async function decideApplication(ctx: AdminUsersCtx, id: string): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');
  const decision = str(body.decision, 20);
  if (decision !== 'approve' && decision !== 'reject') {
    return jsonError('bad_request', '未知操作');
  }
  const note = str(body.note, 300);

  const app = await ctx.db
    .prepare('SELECT id, user_id, username, status FROM registration_applications WHERE id = ?')
    .bind(id)
    .first<{ id: string; user_id: string | null; username: string; status: string }>();
  if (!app) return jsonError('not_found', '申请不存在');
  if (app.status !== 'pending') {
    return jsonError('conflict', `该申请已处理（${app.status}）`, { status: 409 });
  }

  const claim = await ctx.db
    .prepare(
      `UPDATE registration_applications
          SET status = ?, reviewed_by = ?, reviewed_at = ?, note = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(
      decision === 'approve' ? 'approved' : 'rejected',
      ctx.admin.username,
      iso(),
      note,
      id,
    )
    .run();

  if (((claim.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return jsonError('conflict', '该申请已被处理', { status: 409 });
  }

  if (app.user_id) {
    await ctx.db
      .prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind(decision === 'approve' ? 'active' : 'banned', iso(), app.user_id)
      .run();
  }

  await audit(
    ctx.db,
    ctx.admin.username,
    decision === 'approve' ? 'application.approve' : 'application.reject',
    app.user_id,
    { applicationId: id, username: app.username, note },
  );

  return jsonOk({ id, status: decision === 'approve' ? 'approved' : 'rejected' });
}

// -------------------------------------------------------------- invitations
export async function listInvitations(ctx: AdminUsersCtx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT code, max_uses, used_count, expires_at, disabled, note, created_at
         FROM invitations ORDER BY created_at DESC LIMIT 200`,
    )
    .all<Record<string, unknown>>();

  return jsonOk({
    items: (rows.results ?? []).map((r) => ({
      code: r.code,
      maxUses: Number(r.max_uses ?? 0),
      usedCount: Number(r.used_count ?? 0),
      remaining: Math.max(0, Number(r.max_uses ?? 0) - Number(r.used_count ?? 0)),
      expiresAt: r.expires_at,
      disabled: Number(r.disabled ?? 0) === 1,
      note: r.note,
      createdAt: r.created_at,
    })),
  });
}

export async function createInvitations(ctx: AdminUsersCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const count = num(body.count, 1, 1, 50);
  const maxUses = num(body.maxUses, 1, 1, 1000);
  const note = str(body.note, 100);
  const days = num(body.validDays, 0, 0, 3650);
  const expiresAt = days > 0 ? iso(new Date(Date.now() + days * 86_400_000)) : null;

  const created: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 8 chars from a 32-char alphabet = ~40 bits: not guessable at any rate that
    // matters, and still short enough to type. No sequential ids, ever.
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (const b of bytes) code += alphabet[b % alphabet.length];

    await ctx.db
      .prepare(
        `INSERT INTO invitations (code, created_by, max_uses, expires_at, note)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(code, ctx.admin.username, maxUses, expiresAt, note)
      .run();
    created.push(code);
  }

  await audit(ctx.db, ctx.admin.username, 'invitation.create', null, { count, maxUses, days });
  return jsonOk({ created });
}

export async function updateInvitation(ctx: AdminUsersCtx, code: string): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  if (body.disabled !== undefined) {
    await ctx.db
      .prepare('UPDATE invitations SET disabled = ? WHERE code = ?')
      .bind(bool(body.disabled), code)
      .run();
    await audit(ctx.db, ctx.admin.username, 'invitation.toggle', null, {
      code,
      disabled: bool(body.disabled),
    });
    return jsonOk({ code, disabled: bool(body.disabled) === 1 });
  }

  if (body.maxUses !== undefined) {
    const maxUses = num(body.maxUses, 1, 1, 1000);
    await ctx.db
      .prepare('UPDATE invitations SET max_uses = ? WHERE code = ?')
      .bind(maxUses, code)
      .run();
    return jsonOk({ code, maxUses });
  }

  return jsonError('bad_request', '没有可更新的字段');
}

export async function deleteInvitation(ctx: AdminUsersCtx, code: string): Promise<Response> {
  await ctx.db.prepare('DELETE FROM invitations WHERE code = ?').bind(code).run();
  await audit(ctx.db, ctx.admin.username, 'invitation.delete', null, { code });
  return jsonOk({ code, deleted: true });
}

// --------------------------------------------------------------- dispatcher
export async function handleAdminUsers(
  ctx: AdminUsersCtx,
  path: string,
  method: string,
): Promise<Response> {
  // Reads are open to editors (they need to see who exists); writes are not.
  const isWrite = method !== 'GET';
  if (isWrite && ctx.admin.role !== 'super') {
    return jsonError('forbidden', '只有超级管理员可以修改用户与邀请码');
  }

  if (path === '/list') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listUsers(ctx);
  }

  const devList = path.match(/^\/([\w-]{8,})\/devices$/);
  if (devList) {
    if (method === 'GET') return getUserDevices(ctx, devList[1]);
    if (method === 'POST') {
      if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以开通设备');
      return createUserDevice(ctx, devList[1]);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const devRevoke = path.match(/^\/devices\/([\w-]{8,})$/);
  if (devRevoke) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以撤销设备');
    return revokeUserDevice(ctx, devRevoke[1]);
  }

  if (path === '/bulk-delete') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以删除用户');
    return deleteUsersBulk(ctx);
  }

  const devLimitMatch = path.match(/^\/([\w-]{8,})\/device-limit$/);
  if (devLimitMatch) {
    if (method !== 'PUT' && method !== 'PATCH') return methodNotAllowed(['PUT']);
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以修改设备限制');
    return setUserDeviceLimit(ctx, devLimitMatch[1]);
  }

  if (path === '/blacklist') {
    if (method === 'GET') return listBlacklist(ctx);
    if (method === 'POST') {
      if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以管理黑名单');
      return addToBlacklist(ctx);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const blMatch = path.match(/^\/blacklist\/([^/]+)$/);
  if (blMatch) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以管理黑名单');
    return removeFromBlacklist(ctx, decodeURIComponent(blMatch[1]));
  }

  if (path === '/device-policy') {
    if (method === 'GET') {
      const row = await ctx.db
        .prepare('SELECT device_limit_enabled, max_devices FROM user_settings WHERE id = 1')
        .first<{ device_limit_enabled: number; max_devices: number }>();
      return jsonOk({
        enabled: Number(row?.device_limit_enabled ?? 1) === 1,
        max: Number(row?.max_devices ?? 2),
      });
    }
    if (method === 'PUT' || method === 'POST') {
      if (ctx.admin.role !== 'super') return jsonError('forbidden', '只有超级管理员可以修改设备限制');
      return setDevicePolicy(ctx);
    }
    return methodNotAllowed(['GET', 'PUT']);
  }

  if (path === '/applications') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return listApplications(ctx);
  }

  const appMatch = path.match(/^\/applications\/([\w-]{8,})\/decide$/);
  if (appMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return decideApplication(ctx, appMatch[1]);
  }

  if (path === '/invitations') {
    if (method === 'GET') return listInvitations(ctx);
    if (method === 'POST') return createInvitations(ctx);
    return methodNotAllowed(['GET', 'POST']);
  }

  const invMatch = path.match(/^\/invitations\/([A-Za-z0-9]+)$/);
  if (invMatch) {
    if (method === 'PATCH' || method === 'PUT') return updateInvitation(ctx, invMatch[1]);
    if (method === 'DELETE') return deleteInvitation(ctx, invMatch[1]);
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  const userMatch = path.match(/^\/([\w-]{8,})$/);
  if (userMatch) {
    if (method === 'PATCH' || method === 'PUT') return updateUser(ctx, userMatch[1]);
    if (method === 'DELETE') return deleteUser(ctx, userMatch[1]);
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  const actMatch = path.match(/^\/([\w-]{8,})\/(activity|revoke-credentials)$/);
  if (actMatch) {
    if (actMatch[2] === 'activity') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return userActivity(ctx, actMatch[1]);
    }
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return revokeUserCredentials(ctx, actMatch[1]);
  }

  return jsonError('not_found', '用户接口不存在');
}
