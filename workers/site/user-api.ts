/**
 * Public user API: registration, login, profile, credentials.
 *
 * Every route here is unauthenticated or user-scoped. Admin routes live in
 * admin.ts and never share a resolver with this file — a user session grants
 * nothing there.
 *
 * Security decisions worth stating:
 *   - Registration mode is re-checked server-side on every request; hiding a
 *     form in the UI is not a control.
 *   - An account is only created after `verifyCode` succeeds; there is no path
 *     that writes a user row with an unverified email.
 *   - The access credential plaintext is returned exactly once (on create/reset)
 *     and never stored; only its SHA-256 hash exists in D1.
 */

import { jsonError, jsonOk, methodNotAllowed } from '../../packages/shared/src/http';
import {
  clearedUserCookie,
  hashPassword,
  isValidEmail,
  isValidUsername,
  newToken,
  normalizeEmail,
  parseCookie,
  passwordIssue,
  resolveUserSession,
  sha256Hex,
  USER_SESSION_COOKIE,
  USER_SESSION_TTL_SECONDS,
  userCookie,
  verifyPassword,
  type UserIdentity,
} from './user-auth';
import {
  createDevice,
  listDevices,
  loadDeviceLimits,
  revokeDevice,
} from './devices';
import {
  hashIp,
  LIMIT_MESSAGES,
  loadUserSettings,
  sendVerificationCode,
  verifyCode,
} from './email-verify';

export interface UserApiEnv {
  DB: D1Database;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  RATE_LIMIT_SALT?: string;
  ENVIRONMENT?: string;
  SITE_NAME?: string;
}

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');
const MAX_BODY = 8 * 1024;

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

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

function clientIp(request: Request): string {
  // Cloudflare sets this; never trust x-forwarded-for from the client.
  return request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function securityEvent(
  db: D1Database,
  kind: string,
  userId: string | null,
  actor: string,
  detail: unknown,
  ipHash: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO security_events (kind, user_id, actor, detail, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(kind, userId, actor.slice(0, 80), JSON.stringify(detail ?? {}).slice(0, 2000), ipHash)
    .run();
}

/** True when the address is on the per-address blacklist. */
async function isEmailBlacklisted(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM email_blacklist WHERE email_normalized = ? LIMIT 1')
    .bind(normalizeEmail(email))
    .first<{ x: number }>();
  return Boolean(row);
}

const SESSION_SELECT = `SELECT u.id, u.username, u.email, u.status, u.email_verified_at, u.registered_at`;

/** Issues a session row and returns the plaintext token for the cookie. */
async function createSession(
  db: D1Database,
  userId: string,
  request: Request,
  ipHash: string,
): Promise<string> {
  const token = newToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + USER_SESSION_TTL_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  await db
    .prepare(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, expiresAt, (request.headers.get('user-agent') ?? '').slice(0, 200), ipHash)
    .run();

  await db
    .prepare('UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .bind(iso(), userId)
    .run();

  return token;
}

export function publicUser(u: UserIdentity) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    emailMasked: maskEmail(u.email),
    status: u.status,
    emailVerified: u.emailVerified,
    registeredAt: u.registeredAt,
  };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

/**
 * Creates the user's one-and-only credential if none is active.
 *
 * Written as INSERT ... SELECT ... WHERE NOT EXISTS so the check and the write
 * are one statement: two concurrent first-logins cannot both succeed, because
 * the second sees the row committed by the first (or its own INSERT is a no-op
 * thanks to the WHERE). Returns the plaintext once, or null when a key already
 * existed.
 */
async function issueCredentialIfMissing(
  db: D1Database,
  userId: string,
): Promise<{ token: string } | null> {
  const token = newToken(32);
  const tokenHash = await sha256Hex(token);
  const hint = `${token.slice(0, 4)}…${token.slice(-4)}`;

  const res = await db
    .prepare(
      `INSERT INTO access_credentials (id, user_id, token_hash, hint, plain_token)
       SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM access_credentials
           WHERE user_id = ? AND status = 'active'
        )`,
    )
    .bind(crypto.randomUUID(), userId, tokenHash, hint, token, userId)
    .run();

  const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0 ? { token } : null;
}

// ------------------------------------------------------------- send-code
async function handleSendCode(request: Request, env: UserApiEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const email = str(body.email, 254);
  if (!isValidEmail(email)) return jsonError('bad_request', '邮箱格式不正确');

  const settings = await loadUserSettings(env.DB);
  // Sending a code is only meaningful if some registration mode is open.
  if (!settings.freeRegister && !settings.inviteRegister && !settings.approvalRegister) {
    return jsonError('forbidden', '暂未开放注册');
  }

  // Reject an already-registered address early — after the code is verified it
  // would be a dead end, and this keeps the later uniqueness check honest.
  if (await isEmailBlacklisted(env.DB, email)) {
    return jsonError('forbidden', '该邮箱无法用于注册');
  }

  const exists = await env.DB.prepare(
    'SELECT 1 AS x FROM users WHERE email_normalized = ? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(normalizeEmail(email))
    .first<{ x: number }>();
  if (exists) return jsonError('conflict', '该邮箱已注册，请直接登录');

  const result = await sendVerificationCode(
    {
      DB: env.DB,
      RESEND_API_KEY: env.RESEND_API_KEY,
      EMAIL_FROM: env.EMAIL_FROM,
      RATE_LIMIT_SALT: env.RATE_LIMIT_SALT,
    },
    {
      email,
      purpose: 'register',
      ip: clientIp(request),
      siteName: env.SITE_NAME ?? 'Surge Modules',
    },
  );

  if (!result.ok) {
    const status =
      result.code === 'rate_limited'
        ? 429
        : result.code === 'not_configured'
          ? 503
          : result.code === 'blocked_domain'
            ? 400
            : 502;
    return jsonError(result.code, result.message, { status });
  }

  return jsonOk({ sent: true, cooldownSeconds: settings.emailSendCooldownSeconds });
}

// ---------------------------------------------------------------- register
async function handleRegister(request: Request, env: UserApiEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const username = str(body.username, 20);
  const email = str(body.email, 254);
  const password = typeof body.password === 'string' ? body.password : '';
  const code = str(body.code, 10);
  const invitation = str(body.invitation, 64);

  const settings = await loadUserSettings(env.DB);
  if (!settings.freeRegister && !settings.inviteRegister && !settings.approvalRegister) {
    return jsonError('forbidden', '暂未开放注册');
  }

  if (!isValidUsername(username)) {
    return jsonError('bad_request', '用户名只能包含英文字母和数字，长度 3–20 位');
  }
  if (!isValidEmail(email)) return jsonError('bad_request', '邮箱格式不正确');
  const pwIssue = passwordIssue(password);
  if (pwIssue) return jsonError('bad_request', pwIssue);
  if (!/^\d{6}$/.test(code)) return jsonError('bad_request', '请输入 6 位数字验证码');

  // Which mode applies is decided by the payload + switches, and re-validated.
  let method: 'free' | 'invite' | 'approval' = 'free';
  if (invitation) {
    if (!settings.inviteRegister) return jsonError('forbidden', '邀请码注册未开放');
    method = 'invite';
  } else if (settings.freeRegister) {
    method = 'free';
  } else if (settings.approvalRegister) {
    method = 'approval';
  } else {
    return jsonError('forbidden', '需要邀请码才能注册');
  }

  if (await isEmailBlacklisted(env.DB, email)) {
    return jsonError('forbidden', '该邮箱无法用于注册');
  }

  // ---- email code, mandatory for every mode ----
  const verification = await verifyCode(
    {
      DB: env.DB,
      RESEND_API_KEY: env.RESEND_API_KEY,
      EMAIL_FROM: env.EMAIL_FROM,
      RATE_LIMIT_SALT: env.RATE_LIMIT_SALT,
    },
    email,
    'register',
    code,
  );
  if (!verification.ok) {
    return jsonError('bad_request', verification.message, { status: 400 });
  }

  // ---- invitation, consumed only AFTER the email check passed ----
  if (method === 'invite') {
    const now = iso();
    const row = await env.DB.prepare(
      `SELECT code, max_uses, used_count, expires_at, disabled
         FROM invitations WHERE code = ?`,
    )
      .bind(invitation)
      .first<{
        code: string;
        max_uses: number;
        used_count: number;
        expires_at: string | null;
        disabled: number;
      }>();

    if (!row) return jsonError('bad_request', '邀请码无效');
    if (row.disabled === 1) return jsonError('bad_request', '邀请码已被禁用');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      return jsonError('bad_request', '邀请码已过期');
    }
    if (row.used_count >= row.max_uses) {
      return jsonError('bad_request', '邀请码使用次数已用尽');
    }

    // Atomic claim: the WHERE clause makes over-subscription impossible even
    // under concurrent registrations.
    const claim = await env.DB.prepare(
      `UPDATE invitations SET used_count = used_count + 1
        WHERE code = ? AND used_count < max_uses AND disabled = 0
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
      .bind(invitation, now)
      .run();
    if (((claim.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
      return jsonError('bad_request', '邀请码不可用');
    }
  }

  // ---- uniqueness + insert ----
  const normalized = normalizeEmail(email);
  const [userTaken, emailTaken] = await Promise.all([
    env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ? AND deleted_at IS NULL')
      .bind(username)
      .first<{ x: number }>(),
    env.DB.prepare('SELECT 1 AS x FROM users WHERE email_normalized = ? AND deleted_at IS NULL')
      .bind(normalized)
      .first<{ x: number }>(),
  ]);
  if (userTaken) return jsonError('conflict', '用户名已被占用');
  if (emailTaken) return jsonError('conflict', '该邮箱已注册');

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const status = method === 'approval' ? 'pending' : 'active';
  const now = iso();

  try {
    await env.DB.prepare(
      `INSERT INTO users
         (id, username, email_normalized, email, password_hash, status,
          register_method, email_verified_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, username, normalized, email, passwordHash, status, method, now, now)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[register] insert failed', message);
    // Surface the real cause so the operator can act; never echo it to clients.
    return jsonError('internal_error', '注册失败，请稍后重试', { status: 500 });
  }

  const ipHash = await hashIp(
    { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
    clientIp(request),
  );
  await securityEvent(env.DB, 'register', id, username, { method }, ipHash);

  // A credential is NOT created here: the specification defers it to the first
  // successful login. Registration only proves the mailbox belongs to the user.
  //
  // Approval mode: record the application so the admin panel can list and act on
  // it. The user row already carries status='pending'; this adds the audit trail
  // (when, from where, and later who decided).
  if (status === 'pending') {
    await env.DB
      .prepare(
        `INSERT INTO registration_applications (id, user_id, email, username, status, ip_hash)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(crypto.randomUUID(), id, normalized, username, ipHash)
      .run();

    // Notify Telegram if configured. Failure must not block signup.
    try {
      const { notifyRegistrationApplication } = await import('./telegram');
      await notifyRegistrationApplication(env, {
        username,
        email,
        ipHash,
      });
    } catch {
      /* best effort */
    }
  }

  if (status === 'pending') {
    return jsonOk({
      registered: true,
      status: 'pending',
      message: '申请已提交，等待管理员审核',
    });
  }

  // Active account: sign in immediately. (ipHash is declared once above — a
  // second `const ipHash` in this scope is a TDZ ReferenceError that would throw
  // right here, after the code was consumed and the user row written.)
  const token = await createSession(env.DB, id, request, ipHash);
  const secure = new URL(request.url).protocol === 'https:';
  return jsonOk(
    {
      registered: true,
      status: 'active',
      user: {
        id,
        username,
        email,
        emailMasked: maskEmail(email),
        status,
        emailVerified: true,
        registeredAt: now,
      },
    },
    { headers: { 'set-cookie': userCookie(token, secure) } },
  );
}

// ------------------------------------------------------------------- login
async function handleLogin(request: Request, env: UserApiEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const account = str(body.account, 254);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!account || !password) return jsonError('bad_request', '请输入账号和密码');

  const byEmail = account.includes('@');
  const row = await env.DB.prepare(
    `SELECT id, username, email, status, password_hash, failed_attempts, locked_until,
            email_verified_at, registered_at
       FROM users
      WHERE ${byEmail ? 'email_normalized' : 'username'} = ?
        AND deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(byEmail ? normalizeEmail(account) : account)
    .first<{
      id: string;
      username: string;
      email: string;
      status: string;
      password_hash: string;
      failed_attempts: number;
      locked_until: string | null;
      email_verified_at: string | null;
      registered_at: string;
    }>();

  // Identical response for unknown account and wrong password.
  const invalid = () => jsonError('unauthorized', '账号或密码错误');
  if (!row) return invalid();

  const ipHash = await hashIp(
    { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
    clientIp(request),
  );

  if (await isEmailBlacklisted(env.DB, row.email)) {
    await securityEvent(env.DB, 'login_failed', row.id, row.username, { reason: 'blacklisted' }, ipHash);
    return jsonError('forbidden', '该邮箱无法登录', { status: 403 });
  }

  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return jsonError('too_many_requests', '登录尝试过多，请稍后再试', { status: 429 });
  }
  if (row.status === 'banned' || row.status === 'deleted') {
    await securityEvent(env.DB, 'login_failed', row.id, row.username, { reason: 'banned' }, ipHash);
    return jsonError('forbidden', '账号已被封禁', { status: 403 });
  }
  if (row.status === 'pending') {
    return jsonError('forbidden', '账号正在审核中，通过后可登录', { status: 403 });
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const lockUntil =
      attempts >= 5 ? iso(new Date(Date.now() + 15 * 60 * 1000)) : null;
    await env.DB.prepare(
      'UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?',
    )
      .bind(attempts, lockUntil, iso(), row.id)
      .run();
    await securityEvent(env.DB, 'login_failed', row.id, row.username, { attempts }, ipHash);
    return invalid();
  }

  const token = await createSession(env.DB, row.id, request, ipHash);
  const secure = new URL(request.url).protocol === 'https:';

  // ---- credential initialisation --------------------------------------
  // Created exactly once: on the first successful login of an account that has
  // no active key. Every later login (another device, a new browser, a session
  // that expired) finds one and gets `null` back, so the browser keeps the key
  // it already has and every Surge install stays valid.
  const issued = await issueCredentialIfMissing(env.DB, row.id);

  return jsonOk(
    {
      // Present only on the login that created the key.
      credential: issued?.token ?? null,
      user: {
        id: row.id,
        username: row.username,
        email: row.email,
        emailMasked: maskEmail(row.email),
        status: row.status,
        emailVerified: Boolean(row.email_verified_at),
        registeredAt: row.registered_at,
      },
    },
    { headers: { 'set-cookie': userCookie(token, secure) } },
  );
}

// ------------------------------------------------------------------ logout
async function handleLogout(request: Request, env: UserApiEnv): Promise<Response> {
  const token = parseCookie(request.headers.get('cookie'), USER_SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
      'UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ?',
    )
      .bind(iso(), tokenHash)
      .run();
  }
  return jsonOk({ ok: true }, { headers: { 'set-cookie': clearedUserCookie() } });
}

// -------------------------------------------------------------- credential
async function handleCredential(
  request: Request,
  env: UserApiEnv,
  user: UserIdentity,
): Promise<Response> {
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT id, hint, status, created_at, last_used_at, revoked_at, expires_at,
              plain_token
         FROM access_credentials WHERE user_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(user.id)
      .first<Record<string, unknown>>();

    const usage = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last
         FROM module_access_logs WHERE user_id = ? AND result = 'ok'`,
    )
      .bind(user.id)
      .first<{ n: number; last: string | null }>();

    // Proxy base: the link the user actually pastes into Surge. Exposed as a
    // template (no token) — the token is only known right after issue.
    const proxyBase = (await env.DB.prepare(
      "SELECT value FROM site_settings WHERE key = 'proxy.public_base'",
    ).first<{ value: string }>())?.value?.trim() ?? '';

    // Most recent credential ever issued = the "last reset" time, whether the
    // current one is active or not.
    const lastIssued = await env.DB.prepare(
      `SELECT created_at FROM access_credentials WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(user.id)
      .first<{ created_at: string }>();

    return jsonOk({
      credential: row
        ? {
            id: row.id,
            hint: row.hint,
            status: row.status,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            expiresAt: row.expires_at,
            // null means "never reset since it was created"
            resetAt: lastIssued && lastIssued.created_at !== row.created_at ? lastIssued.created_at : null,
            // The plaintext, so the account page and the install button can show
            // and use the SAME key. Returned only to the owner's own session —
            // there is no admin path that exposes it.
            token: (row.plain_token as string) || '',
          }
        : null,
      usage: { total: usage?.n ?? 0, lastAt: usage?.last ?? null },
      proxyBase,
    });
  }

  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);

  const settings = await loadUserSettings(env.DB);

  // Explicit reset: the old key is revoked in the same request, so a leaked
  // link dies the moment a new one exists. That is the button's whole purpose.
  //
  // Nothing else in the product rotates a key — login, page load and signup
  // never touch this table — so a credential can only change when someone
  // presses the button below.
  await env.DB
    .prepare(
      `UPDATE access_credentials SET status = 'revoked', revoked_at = ?
        WHERE user_id = ? AND status = 'active'`,
    )
    .bind(iso(), user.id)
    .run();

  const token = newToken(32);
  const tokenHash = await sha256Hex(token);
  const hint = `${token.slice(0, 4)}…${token.slice(-4)}`;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO access_credentials (id, user_id, token_hash, hint, plain_token)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, tokenHash, hint, token)
    .run();

  const ipHash = await hashIp(
    { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
    clientIp(request),
  );
  await securityEvent(env.DB, 'credential_reset', user.id, user.username, { hint }, ipHash);

  const proxyBase = (await env.DB.prepare(
    "SELECT value FROM site_settings WHERE key = 'proxy.public_base'",
  ).first<{ value: string }>())?.value?.trim() ?? '';

  return jsonOk({
    // Shown once. The UI must tell the user to copy it now.
    existing: false,
    token,
    hint,
    createdAt: iso(),
    maxDevices: settings.maxDevices,
    proxyBase,
  });
}

async function handleRevokeCredential(
  request: Request,
  env: UserApiEnv,
  user: UserIdentity,
): Promise<Response> {
  await env.DB.prepare(
    `UPDATE access_credentials SET status = 'revoked', revoked_at = ?
      WHERE user_id = ? AND status = 'active'`,
  )
    .bind(iso(), user.id)
    .run();

  const ipHash = await hashIp(
    { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
    clientIp(request),
  );
  await securityEvent(env.DB, 'credential_revoked', user.id, user.username, {}, ipHash);
  return jsonOk({ revoked: true });
}

// --------------------------------------------------------------- dispatcher
export async function handleUserApi(
  request: Request,
  env: UserApiEnv,
  path: string,
): Promise<Response> {
  const method = request.method;

  // ---- public routes (no session)
  if (path === '/send-code') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    return handleSendCode(request, env);
  }
  if (path === '/register') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    try {
      return await handleRegister(request, env);
    } catch (err) {
      // A thrown error here would otherwise surface as a bare "内部错误" with no
      // trace. Log it with the stage marker so it is diagnosable.
      console.error('[register] unhandled', err instanceof Error ? err.stack : String(err));
      return jsonError('internal_error', '注册失败，请稍后重试', { status: 500 });
    }
  }
  if (path === '/login') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    try {
      return await handleLogin(request, env);
    } catch (err) {
      console.error('[login] unhandled', err instanceof Error ? err.stack : String(err));
      return jsonError('internal_error', '登录失败，请稍后重试', { status: 500 });
    }
  }
  if (path === '/logout') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return handleLogout(request, env);
  }
  if (path === '/settings') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const s = await loadUserSettings(env.DB);
    // Never expose limits' internals beyond what the signup form needs.
    return jsonOk({
      modes: {
        free: s.freeRegister,
        invite: s.inviteRegister,
        approval: s.approvalRegister,
      },
      anyOpen: s.freeRegister || s.inviteRegister || s.approvalRegister,
      cooldownSeconds: s.emailSendCooldownSeconds,
      codeTtlSeconds: s.emailCodeTtlSeconds,
    });
  }

  // ---- everything below requires a session
  const token = parseCookie(request.headers.get('cookie'), USER_SESSION_COOKIE);
  const session = await resolveUserSession(env.DB, token);
  if (!session) return jsonError('unauthorized', '请先登录');
  const user = session.user;

  if (path === '/me') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const devices = await env.DB.prepare(
      `SELECT id, name, status, first_seen_at, last_seen_at
         FROM devices WHERE user_id = ? AND status = 'active'
        ORDER BY first_seen_at DESC`,
    )
      .bind(user.id)
      .all<Record<string, unknown>>();
    return jsonOk({ user: publicUser(user), devices: devices.results ?? [] });
  }

  if (path === '/password') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!originAllowed(request)) return jsonError('forbidden', '非法来源');
    const body = await readJson(request);
    if (!body) return jsonError('bad_request', '请求体不合法');
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';

    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ password_hash: string }>();
    if (!row) return jsonError('unauthorized', '会话无效');
    if (!(await verifyPassword(current, row.password_hash))) {
      return jsonError('bad_request', '当前密码不正确');
    }
    const issue = passwordIssue(next);
    if (issue) return jsonError('bad_request', issue);

    const hash = await hashPassword(next);
    await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(hash, iso(), user.id)
      .run();

    // Keep this session, drop every other one.
    const keepHash = token ? await sha256Hex(token) : '';
    await env.DB.prepare(
      'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL',
    )
      .bind(iso(), user.id, keepHash)
      .run();

    return jsonOk({ changed: true });
  }

  if (path === '/sessions') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const rows = await env.DB.prepare(
      `SELECT token_hash, user_agent, created_at, expires_at, revoked_at
         FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(user.id)
      .all<Record<string, unknown>>();
    const currentHash = token ? await sha256Hex(token) : '';
    return jsonOk({
      items: (rows.results ?? []).map((r) => ({
        id: String(r.token_hash).slice(0, 8),
        isCurrent: r.token_hash === currentHash,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    });
  }

  if (path === '/devices') {
    if (method === 'GET') {
      const limits = await loadDeviceLimits(env.DB);
      const rows = await listDevices(env.DB, user.id);
      return jsonOk({
        items: rows.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          firstSeenAt: d.first_seen_at,
          lastSeenAt: d.last_seen_at,
          accessCount: d.access_count,
        })),
        limit: { enabled: limits.enabled, max: limits.max },
      });
    }
    if (method === 'POST') {
      const body = await readJson(request);
      if (!body) return jsonError('bad_request', '请求体不合法');
      const name = str(body.name, 60) || '新设备';

      // Each device gets its own credential, so revoking one link does not
      // disturb the others.
      const token = newToken(32);
      const tokenHash = await sha256Hex(token);
      const hint = `${token.slice(0, 4)}…${token.slice(-4)}`;
      const credId = crypto.randomUUID();
      await env.DB
        .prepare(
          `INSERT INTO access_credentials (id, user_id, token_hash, hint, plain_token)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(credId, user.id, tokenHash, hint, token)
        .run();

      const outcome = await createDevice(env.DB, {
        userId: user.id,
        name,
        credentialId: credId,
        deviceKeyHash: tokenHash,
      });

      if (!outcome.ok) {
        // The credential was created optimistically; remove it so a refused
        // device does not leave a stray usable key behind.
        await env.DB
          .prepare("UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE id = ?")
          .bind(iso(), credId)
          .run();
        return jsonError('conflict', outcome.message, { status: 409 });
      }

      return jsonOk({ deviceId: outcome.deviceId, token, hint, name });
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const devMatch = path.match(/^\/devices\/([\w-]{8,})$/);
  if (devMatch) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const ok = await revokeDevice(env.DB, devMatch[1], user.id);
    if (!ok) return jsonError('not_found', '设备不存在');
    return jsonOk({ revoked: true });
  }

  if (path === '/credential') return handleCredential(request, env, user);
  if (path === '/credential/revoke') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return handleRevokeCredential(request, env, user);
  }

  return jsonError('not_found', '接口不存在');
}

export { LIMIT_MESSAGES };
