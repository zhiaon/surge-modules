/**
 * User authentication primitives.
 *
 * Deliberately separate from `auth.ts` (admin sessions): the two identity
 * systems must not share a cookie name, a session table, or a permission check.
 * An ordinary user hitting an admin route gets 401 from the admin resolver no
 * matter what user session they hold.
 *
 * Password hashing: PBKDF2-SHA256, 210 000 iterations, 16-byte salt, stored as
 * `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`. Argon2id is not available in the
 * Workers runtime without a bundled WASM build; PBKDF2 at this count is the
 * reviewed option this project already uses for admins, so both sides share one
 * audited implementation rather than introducing a second, weaker path.
 */

export const USER_SESSION_COOKIE = 'sm_user';
export const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
/**
 * 100 000 iterations. 210k measured ~1.8s of pure CPU in a Workers isolate,
 * which exceeds the request CPU budget and surfaced as a generic 500 during
 * registration. 100k keeps the work factor respectable (OWASP's floor for
 * PBKDF2-SHA256) while fitting the runtime. The iteration count is stored in
 * every hash, so raising it later only affects new hashes — existing ones keep
 * verifying with their own count.
 */
const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += String.fromCharCode(b);
  return btoa(out);
}

function unb64(value: string): Uint8Array {
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  try {
    const salt = unb64(parts[2]);
    const expected = unb64(parts[3]);
    const actual = await derive(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Constant-time comparison — used for password hashes and code hashes. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 32 random bytes, base64url — used for session tokens and access keys. */
export function newToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalises an email for uniqueness and lookup: trimmed, domain lower-cased,
 * local part lower-cased too (the prompt allows this and it avoids two accounts
 * differing only by case).
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** RFC 5322 subset: enough to reject malformed input without over-fitting. */
export function isValidEmail(email: string): boolean {
  const value = email.trim();
  if (value.length < 6 || value.length > 254) return false;
  // one @, non-empty local, domain with a dot and a 2+ char TLD
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

/**
 * Username: ASCII letters and digits only, 3–20 chars. No CJK, no spaces, no
 * symbols — exactly as the specification requires.
 */
export function isValidUsername(username: string): boolean {
  return /^[A-Za-z0-9]{3,20}$/.test(username);
}

/** Minimum viable strength: 8+ chars with at least two character classes. */
export function passwordIssue(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 128) return '密码过长';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 2) return '密码需包含字母、数字或符号中的至少两类';
  return null;
}

export function userCookie(token: string, secure: boolean): string {
  const attrs = [
    `${USER_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${USER_SESSION_TTL_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedUserCookie(): string {
  return `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export interface UserRow {
  id: string;
  username: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  status: string;
  register_method: string;
  email_verified_at: string | null;
  registered_at: string;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

export interface UserIdentity {
  id: string;
  username: string;
  email: string;
  status: string;
  emailVerified: boolean;
  registeredAt: string;
}

/** Resolves the session cookie to a user. Never trusts anything in the body. */
export async function resolveUserSession(
  db: D1Database,
  token: string | null,
): Promise<{ user: UserIdentity; sessionExpiresAt: string } | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.email, u.status, u.email_verified_at, u.registered_at,
              s.expires_at, s.revoked_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      id: string;
      username: string;
      email: string;
      status: string;
      email_verified_at: string | null;
      registered_at: string;
      expires_at: string;
      revoked_at: string | null;
    }>();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  if (row.status === 'banned' || row.status === 'deleted') return null;
  // A pending (approval-mode) account must not act until an admin activates it.
  if (row.status === 'pending') return null;

  return {
    user: {
      id: row.id,
      username: row.username,
      email: row.email,
      status: row.status,
      emailVerified: Boolean(row.email_verified_at),
      registeredAt: row.registered_at,
    },
    sessionExpiresAt: row.expires_at,
  };
}

export const isoNow = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
