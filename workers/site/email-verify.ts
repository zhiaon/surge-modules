/**
 * Email verification codes, sent through Resend.
 *
 * Non-negotiables from the specification, all enforced here:
 *   - 6 digits from `crypto.getRandomValues`, never Math.random
 *   - only the SHA-256 hash is stored; the plaintext lives in the outgoing mail
 *   - one-time use via an atomic conditional UPDATE
 *   - 5 attempts max, then the code dies
 *   - superseded by a newer code for the same email+purpose
 *   - cooldown 60s, 5/hour, 10/day per email; 10/hour per IP
 *   - when Resend is not configured, sending FAILS LOUDLY — it never pretends
 */

import { normalizeEmail, sha256Hex, timingSafeEqual } from './user-auth';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_TEXT = 500;

export interface EmailEnv {
  DB: D1Database;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** server-side salt; keeps stored hashes useless if the DB leaks */
  RATE_LIMIT_SALT?: string;
  ENVIRONMENT?: string;
}

export interface UserSettings {
  freeRegister: boolean;
  inviteRegister: boolean;
  approvalRegister: boolean;
  emailCodeTtlSeconds: number;
  emailSendCooldownSeconds: number;
  emailHourlyLimit: number;
  emailDailyLimit: number;
  ipHourlyLimit: number;
  maxDevices: number;
  requireCredential: boolean;
  emailDomainBlocklist: string[];
  updatedBy: string;
  updatedAt: string;
}

export async function loadUserSettings(db: D1Database): Promise<UserSettings> {
  const row = await db.prepare('SELECT * FROM user_settings WHERE id = 1').first<Record<string, unknown>>();
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    freeRegister: Number(row?.free_register ?? 1) === 1,
    inviteRegister: Number(row?.invite_register ?? 0) === 1,
    approvalRegister: Number(row?.approval_register ?? 0) === 1,
    emailCodeTtlSeconds: num(row?.email_code_ttl_seconds, 300),
    emailSendCooldownSeconds: num(row?.email_send_cooldown_seconds, 60),
    emailHourlyLimit: num(row?.email_hourly_limit, 5),
    emailDailyLimit: num(row?.email_daily_limit, 10),
    ipHourlyLimit: num(row?.ip_hourly_limit, 10),
    maxDevices: num(row?.max_devices, 3),
    requireCredential: Number(row?.require_credential ?? 0) === 1,
    emailDomainBlocklist: String(row?.email_domain_blocklist ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    updatedBy: String(row?.updated_by ?? ''),
    updatedAt: String(row?.updated_at ?? ''),
  };
}

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

/** Cryptographically secure 6-digit code. */
function generateCode(): string {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  // modulo bias is irrelevant at this range for a 6-digit code, but the
  // rejection-free form is simpler: take 6 digits from independent bytes
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += String(b % 10);
  void buf;
  return out;
}

export async function hashIp(env: EmailEnv, ip: string): Promise<string> {
  return sha256Hex(`${env.RATE_LIMIT_SALT ?? 'dev-salt'}:${ip}`);
}

// ------------------------------------------------------------------- Resend
export interface SendResult {
  ok: boolean;
  errorCode?: string;
}

function renderEmail(code: string, ttlSeconds: number, siteName: string): {
  subject: string;
  text: string;
  html: string;
} {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const subject = `${siteName} 邮箱验证码`;
  const text = [
    `你正在注册 ${siteName}，验证码是：`,
    '',
    `    ${code}`,
    '',
    `${minutes} 分钟内有效，只能使用一次。`,
    '如非本人操作，请忽略这封邮件。',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0d12;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#151a23;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px">
    <p style="margin:0 0 6px;font-size:13px;color:#737f90">${siteName}</p>
    <h1 style="margin:0 0 18px;font-size:19px;color:#f1f5f9;font-weight:600">邮箱验证码</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#a1aab8">你正在注册，请输入下面的验证码完成验证：</p>
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;letter-spacing:.32em;color:#8b9cff;background:#0d1017;border-radius:12px;padding:16px 0;text-align:center">${code}</div>
    <p style="margin:18px 0 0;font-size:13px;line-height:1.7;color:#737f90">${minutes} 分钟内有效，只能使用一次。<br>如非本人操作，请忽略这封邮件。</p>
  </div></body></html>`;
  return { subject, text, html };
}

async function sendViaResend(
  env: EmailEnv,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<SendResult> {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!key) return { ok: false, errorCode: 'no_api_key' };
  if (!from) return { ok: false, errorCode: 'no_from_address' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never surface Resend's body to the client; it can contain the domain and
      // validation details. Keep only a coarse code for the operator.
      const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
      const code = String(body.name ?? body.message ?? `http_${res.status}`).slice(0, 80);
      return { ok: false, errorCode: code };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      errorCode: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- rate limit
interface LimitVerdict {
  allowed: boolean;
  reason?: 'cooldown' | 'hourly' | 'daily' | 'ip_hourly';
}

async function checkSendLimits(
  env: EmailEnv,
  email: string,
  ipHash: string,
  settings: UserSettings,
): Promise<LimitVerdict> {
  const now = Date.now();
  const hourAgo = iso(new Date(now - 3600_000));
  const dayAgo = iso(new Date(now - 86_400_000));

  const last = await env.DB.prepare(
    `SELECT created_at FROM email_send_logs
      WHERE email = ? AND status = 'success'
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ created_at: string }>();

  if (last) {
    const elapsed = (now - Date.parse(last.created_at)) / 1000;
    if (elapsed < settings.emailSendCooldownSeconds) return { allowed: false, reason: 'cooldown' };
  }

  const hourly = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_send_logs
      WHERE email = ? AND status = 'success' AND created_at >= ?`,
  )
    .bind(email, hourAgo)
    .first<{ n: number }>();
  if ((hourly?.n ?? 0) >= settings.emailHourlyLimit) {
    return { allowed: false, reason: 'hourly' };
  }

  const daily = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_send_logs
      WHERE email = ? AND status = 'success' AND created_at >= ?`,
  )
    .bind(email, dayAgo)
    .first<{ n: number }>();
  if ((daily?.n ?? 0) >= settings.emailDailyLimit) {
    return { allowed: false, reason: 'daily' };
  }

  const byIp = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_send_logs
      WHERE ip_hash = ? AND status = 'success' AND created_at >= ?`,
  )
    .bind(ipHash, hourAgo)
    .first<{ n: number }>();
  if ((byIp?.n ?? 0) >= settings.ipHourlyLimit) {
    return { allowed: false, reason: 'ip_hourly' };
  }

  return { allowed: true };
}

export const LIMIT_MESSAGES: Record<string, string> = {
  cooldown: '发送过于频繁，请等待冷却结束',
  hourly: '该邮箱 1 小时内发送次数已达上限',
  daily: '该邮箱 24 小时内发送次数已达上限',
  ip_hourly: '当前网络发送次数过多，请稍后再试',
};

// -------------------------------------------------------------------- send
export interface SendCodeInput {
  email: string;
  purpose: 'register' | 'reset_password';
  ip: string;
  siteName: string;
}

export type SendCodeOutcome =
  | { ok: true }
  | { ok: false; code: 'invalid_email' | 'blocked_domain' | 'rate_limited' | 'not_configured' | 'send_failed'; message: string };

/**
 * Creates a code, persists its hash, then sends it.
 *
 * Order matters: the row is written *before* the send so a slow provider cannot
 * produce two valid codes for one request; if the send fails the row is marked
 * used so it can never be redeemed.
 */
export async function sendVerificationCode(
  env: EmailEnv,
  input: SendCodeInput,
): Promise<SendCodeOutcome> {
  const email = normalizeEmail(input.email);
  const settings = await loadUserSettings(env.DB);
  const ipHash = await hashIp(env, input.ip);

  const domain = email.split('@')[1] ?? '';
  if (settings.emailDomainBlocklist.includes(domain)) {
    return { ok: false, code: 'blocked_domain', message: '该邮箱域名不被支持' };
  }

  const verdict = await checkSendLimits(env, email, ipHash, settings);
  if (!verdict.allowed) {
    await env.DB.prepare(
      `INSERT INTO email_send_logs (email, purpose, ip_hash, status, error_code)
       VALUES (?, ?, ?, 'rate_limited', ?)`,
    )
      .bind(email, input.purpose, ipHash, verdict.reason ?? '')
      .run();
    return {
      ok: false,
      code: 'rate_limited',
      message: LIMIT_MESSAGES[verdict.reason ?? 'cooldown'] ?? '发送过于频繁',
    };
  }

  const code = generateCode();
  const codeHash = await sha256Hex(`${env.RATE_LIMIT_SALT ?? 'dev-salt'}:${email}:${code}`);
  const expiresAt = iso(new Date(Date.now() + settings.emailCodeTtlSeconds * 1000));

  // A new code invalidates every older unused code for this email+purpose.
  await env.DB.prepare(
    `UPDATE email_verifications SET used_at = ?
      WHERE email = ? AND purpose = ? AND used_at IS NULL`,
  )
    .bind(iso(), email, input.purpose)
    .run();

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_verifications
       (id, email, code_hash, purpose, max_attempts, expires_at, ip_hash)
     VALUES (?, ?, ?, ?, 5, ?, ?)`,
  )
    .bind(id, email, codeHash, input.purpose, expiresAt, ipHash)
    .run();

  const rendered = renderEmail(code, settings.emailCodeTtlSeconds, input.siteName);
  const result = await sendViaResend(
    env,
    email,
    rendered.subject,
    rendered.text,
    rendered.html,
  );

  if (!result.ok) {
    // Burn the code: it was never delivered, so it must not be redeemable.
    await env.DB.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?')
      .bind(iso(), id)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_send_logs (email, purpose, ip_hash, status, error_code)
       VALUES (?, ?, ?, 'failed', ?)`,
    )
      .bind(email, input.purpose, ipHash, (result.errorCode ?? '').slice(0, MAX_TEXT))
      .run();

    if (result.errorCode === 'no_api_key' || result.errorCode === 'no_from_address') {
      return {
        ok: false,
        code: 'not_configured',
        message: '邮件服务未配置，暂时无法发送验证码',
      };
    }
    return { ok: false, code: 'send_failed', message: '验证码发送失败，请稍后重试' };
  }

  await env.DB.prepare(
    `INSERT INTO email_send_logs (email, purpose, ip_hash, status) VALUES (?, ?, ?, 'success')`,
  )
    .bind(email, input.purpose, ipHash)
    .run();

  return { ok: true };
}

// ------------------------------------------------------------------- verify
export type VerifyOutcome =
  | { ok: true }
  | {
      ok: false;
      code: 'not_found' | 'expired' | 'too_many_attempts' | 'already_used' | 'mismatch';
      message: string;
    };

/**
 * Verifies a code and burns it atomically.
 *
 * The final UPDATE is conditional on `used_at IS NULL`, so two concurrent
 * requests with the same correct code cannot both succeed.
 */
export async function verifyCode(
  env: EmailEnv,
  emailRaw: string,
  purpose: 'register' | 'reset_password',
  code: string,
): Promise<VerifyOutcome> {
  const email = normalizeEmail(emailRaw);

  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, max_attempts, expires_at, used_at
       FROM email_verifications
      WHERE email = ? AND purpose = ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, purpose)
    .first<{
      id: string;
      code_hash: string;
      attempts: number;
      max_attempts: number;
      expires_at: string;
      used_at: string | null;
    }>();

  if (!row) return { ok: false, code: 'not_found', message: '请先获取验证码' };
  if (row.used_at) return { ok: false, code: 'already_used', message: '验证码已使用，请重新获取' };
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, code: 'expired', message: '验证码已过期，请重新获取' };
  }
  if (row.attempts >= row.max_attempts) {
    return { ok: false, code: 'too_many_attempts', message: '尝试次数过多，请重新获取验证码' };
  }

  const expected = row.code_hash;
  const actual = await sha256Hex(`${env.RATE_LIMIT_SALT ?? 'dev-salt'}:${email}:${code.trim()}`);
  const match = timingSafeEqual(
    Uint8Array.from(expected.match(/.{2}/g)?.map((h) => Number.parseInt(h, 16)) ?? []),
    Uint8Array.from(actual.match(/.{2}/g)?.map((h) => Number.parseInt(h, 16)) ?? []),
  );

  if (!match) {
    await env.DB.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?')
      .bind(row.id)
      .run();
    const left = Math.max(0, row.max_attempts - row.attempts - 1);
    return {
      ok: false,
      code: 'mismatch',
      message: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : '尝试次数已用尽，请重新获取验证码',
    };
  }

  const burn = await env.DB.prepare(
    'UPDATE email_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL',
  )
    .bind(iso(), row.id)
    .run();

  if (((burn.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return { ok: false, code: 'already_used', message: '验证码已使用，请重新获取' };
  }

  return { ok: true };
}
