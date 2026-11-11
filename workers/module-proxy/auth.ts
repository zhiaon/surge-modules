/**
 * Credential checks for the module proxy.
 *
 * Wire format: HTTP Basic Auth.
 *
 *   https://<token>@sgmd.zhiaon.top/<slug>
 *
 * The token may arrive as the *password* (with any/empty username, which is what
 * `https://token@host` produces) or as the *username* (some clients normalise
 * the URL that way). Both are accepted because Surge and the various URL
 * builders disagree on which half a bare `userinfo` becomes.
 *
 * Only the SHA-256 hash exists in D1 — the plaintext is shown to the user once
 * when it is created. Lookup is by hash, so a leaked database yields no usable
 * tokens.
 *
 * This module is deliberately free of any publish/cache logic: it answers one
 * question ("who is this, and may they read this module?") and the caller
 * decides what to do with the answer.
 */

export interface AuthEnv {
  DB: D1Database;
  RATE_LIMIT_SALT?: string;
}

export interface AuthedUser {
  userId: string;
  username: string;
  credentialId: string;
  status: string;
}

export type AuthOutcome =
  | { kind: 'ok'; user: AuthedUser }
  | { kind: 'none' } // no credential presented
  | { kind: 'invalid' } // credential does not resolve
  | { kind: 'revoked' }
  | { kind: 'banned' }
  | { kind: 'no_access' }; // module not permitted for this user

/** Extracts the candidate token from `Authorization: Basic ...`. */
export function basicToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  let decoded: string;
  try {
    // atob is fine here: the value is user-supplied and we never eval it.
    decoded = atob(match[1]);
  } catch {
    return null;
  }

  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  // `https://token@host` → username=token, password=""
  // `https://:token@host` → username="", password=token
  // `https://token:@host` → same as the first
  const candidate = pass.trim() || user.trim();
  if (!candidate || candidate.length < 16 || candidate.length > 200) return null;
  // TEMP diagnostic: shape only, never the value.
  console.log(
    '[basic] hasColon=' + (sep !== -1) + ' userLen=' + user.length + ' passLen=' + pass.length +
    ' candLen=' + candidate.length + ' first=' + candidate.slice(0, 4) + ' last=' + candidate.slice(-4),
  );
  return candidate;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolves a token to a user, then checks account state and per-module access.
 *
 * `slug`-independent checks (token validity, ban) run first so a banned user
 * cannot use module enumeration to probe what exists.
 */
export async function authenticate(
  env: AuthEnv,
  request: Request,
  slug: string,
): Promise<AuthOutcome> {
  const token = basicToken(request);
  if (!token) return { kind: 'none' };

  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT c.id AS credential_id, c.status AS cred_status, c.expires_at,
            u.id AS user_id, u.username, u.status AS user_status
       FROM access_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE c.token_hash = ?
        AND u.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      credential_id: string;
      cred_status: string;
      expires_at: string | null;
      user_id: string;
      username: string;
      user_status: string;
    }>();

  if (!row) return { kind: 'invalid' };
  if (row.cred_status !== 'active') return { kind: 'revoked' };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { kind: 'revoked' };
  if (row.user_status === 'banned' || row.user_status === 'deleted') return { kind: 'banned' };
  if (row.user_status !== 'active') return { kind: 'banned' };

  // Per-module permission: a row with allowed=0 is an explicit deny. No row at
  // all means "open" — the default posture for a published module.
  const perm = await env.DB.prepare(
    `SELECT p.allowed
       FROM user_module_permissions p
       JOIN modules m ON m.id = p.module_id
      WHERE p.user_id = ? AND m.slug = ?
      LIMIT 1`,
  )
    .bind(row.user_id, slug)
    .first<{ allowed: number }>();

  if (perm && perm.allowed === 0) return { kind: 'no_access' };

  // No separate device check: a device IS a credential. Revoking a device
  // revokes its credential, and the status check above already refuses it.
  // Keeping a second table in the path was what let the two disagree.

  return {
    kind: 'ok',
    user: {
      userId: row.user_id,
      username: row.username,
      credentialId: row.credential_id,
      status: row.user_status,
    },
  };
}

/** Updates `last_used_at` and appends one access-log row. Never throws. */
export async function recordAccess(
  env: AuthEnv,
  args: {
    slug: string;
    method: string;
    userAgent: string;
    status: number;
    result: string;
    userId?: string;
    credentialId?: string;
    ip: string;
  },
): Promise<void> {
  try {
    const ipHash = await sha256Hex(`${env.RATE_LIMIT_SALT ?? 'dev-salt'}:${args.ip}`);
    if (args.credentialId && args.result === 'ok') {
      await env.DB.prepare('UPDATE access_credentials SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString().replace(/\.\d+Z$/, 'Z'), args.credentialId)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO module_access_logs
         (slug, user_id, credential_id, method, user_agent, status, result, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        args.slug.slice(0, 200),
        args.userId ?? null,
        args.credentialId ?? null,
        args.method.slice(0, 8),
        args.userAgent.slice(0, 300),
        args.status,
        args.result.slice(0, 40),
        ipHash,
      )
      .run();
  } catch {
    // Logging must never fail a module fetch.
  }
}

/**
 * Credential mode switch. Read from `user_settings.require_credential`:
 *   0 = off        modules are public (current behaviour)
 *   1 = required   a valid credential is mandatory
 */
export async function credentialMode(db: D1Database): Promise<'off' | 'required'> {
  try {
    const row = await db
      .prepare('SELECT require_credential FROM user_settings WHERE id = 1')
      .first<{ require_credential: number }>();
    return Number(row?.require_credential ?? 0) === 1 ? 'required' : 'off';
  } catch {
    // A missing table (fresh DB before migration) means "not configured yet".
    return 'off';
  }
}

/** 401 with a Basic challenge, so a misconfigured client prompts for a key. */
export function unauthorized(message = '需要访问凭证'): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message } }), {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Basic realm="Surge Modules", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

export function forbidden(message = '无权访问该模块'): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message } }), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
