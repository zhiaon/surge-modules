/**
 * Admin authentication.
 *
 * Threat model this is built against:
 *   - database leak        → passwords are PBKDF2 hashes, session rows hold only SHA-256 of the token
 *   - stolen cookie        → HttpOnly + SameSite=Lax, short TTL, revocable per session
 *   - credential stuffing  → per-account lockout plus a login rate limit
 *   - privilege escalation → the role is read from the database on every request,
 *                            never from the cookie or the client
 *
 * What is deliberately absent: password reset by email (no mail provider), OAuth
 * login (out of scope), and any "remember me forever" option.
 */

/**
 * Cloudflare Workers' WebCrypto rejects PBKDF2 iteration counts above 100_000
 * (the runtime caps it, and an over-limit call throws). Node has no such limit,
 * which is why this only surfaced on the first production login.
 *
 * 100_000 is the maximum this platform allows. It is still a defensible cost:
 * OWASP's PBKDF2-SHA256 guidance is 600k for high-value accounts, but that is
 * simply not reachable here. Argon2 would be the better primitive and is not
 * available in the Workers runtime either. The compensating controls are the
 * 5-attempt lockout, the 12-character minimum and the login throttle.
 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const SESSION_COOKIE = 'sm_admin';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type AdminRole = 'super' | 'editor';

export interface AdminRow {
  id: string;
  username: string;
  display_name: string;
  role: AdminRole;
  password_hash: string;
  is_active: number;
  failed_attempts: number;
  locked_until: string | null;
}

export interface AdminIdentity {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
}

// ------------------------------------------------------------------- hashing
function b64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += String.fromCharCode(b);
  return btoa(out);
}

function unb64(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2$<iterations>$<salt>$<hash>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const salt = unb64(parts[2]);
  const expected = unb64(parts[3]);
  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(expected, actual);
}

/** Constant-time comparison; a plain === leaks length/prefix timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ------------------------------------------------------------------ sessions
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return b64(digest);
}

export function cookieFor(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // Secure is required in production; localhost over http would drop the cookie
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

/** Reads and validates the session. Returns null for anything not active. */
export async function resolveSession(
  db: D1Database,
  token: string | null,
): Promise<{ admin: AdminIdentity; sessionExpiresAt: string } | null> {
  if (!token) return null;
  const tokenHash = await hashToken(token);

  const row = await db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.role, a.is_active,
              s.expires_at, s.revoked_at
         FROM admin_sessions s
         JOIN admins a ON a.id = s.admin_id
        WHERE s.token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      id: string;
      username: string;
      display_name: string;
      role: AdminRole;
      is_active: number;
      expires_at: string;
      revoked_at: string | null;
    }>();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.is_active !== 1) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  return {
    admin: {
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username,
      role: row.role === 'super' ? 'super' : 'editor',
    },
    sessionExpiresAt: row.expires_at,
  };
}

export function can(role: AdminRole, action: AdminAction): boolean {
  return PERMISSIONS[action].includes(role);
}

export type AdminAction =
  | 'module:write'
  | 'module:delete'
  | 'category:write'
  | 'source:write'
  | 'proxy:write'
  | 'review:decide'
  | 'announcement:write'
  | 'settings:write'
  | 'admin:manage'
  | 'sync:run'
  /** destructive removals that editors must not perform */
  | 'content:delete';

/**
 * Server-side permission table. Every admin handler asks this — the UI hiding a
 * button is a convenience, not a control.
 */
const PERMISSIONS: Record<AdminAction, AdminRole[]> = {
  'module:write': ['super', 'editor'],
  'module:delete': ['super'],
  'category:write': ['super', 'editor'],
  'source:write': ['super'],
  'proxy:write': ['super'],
  'review:decide': ['super', 'editor'],
  'announcement:write': ['super', 'editor'],
  'settings:write': ['super'],
  'admin:manage': ['super'],
  'sync:run': ['super'],
  'content:delete': ['super'],
  // An editor may approve/reject what the detectors found (review:decide) but
  // may not add, reconfigure or delete a repository — that is a super action.
  'thirdparty:write': ['super'],
  'thirdparty:check': ['super', 'editor'],
};
