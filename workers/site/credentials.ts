/**
 * Credential resolution.
 *
 * Three values can come from two places: a Worker Secret (set at deploy time,
 * the original mechanism) or an encrypted row in `site_settings` written from
 * the admin panel. This module is the single place that decides which wins, so
 * no handler has to guess.
 *
 * Precedence: panel value → Worker Secret. A panel value is an explicit,
 * deliberate act by the operator, and it must take effect without a redeploy;
 * the secret remains the fallback so an untouched deployment behaves exactly as
 * before.
 *
 * Storage format for panel values: `enc:v1:<base64(iv|ciphertext)>`, AES-GCM
 * with WEBHOOK_SECRET_KEY. A row that does not start with `enc:` is treated as
 * unset — a plaintext credential in D1 would be worse than no credential.
 */

import { decryptSecret, encryptSecret } from './third-party';

export type CredentialName = 'github_read_token' | 'telegram_bot_token' | 'webhook_secret_key';

const KEY_PREFIX = 'secret.';
const ENC_PREFIX = 'enc:v1:';

interface CredentialTable {
  DB: D1Database;
  /** used both as the fallback value and as the encryption key */
  WEBHOOK_SECRET_KEY?: string;
}

/** Reads the raw stored row (may be empty or legacy plaintext). */
async function readStored(db: D1Database, name: CredentialName): Promise<string> {
  const row = await db
    .prepare('SELECT value, value_type FROM site_settings WHERE key = ?')
    .bind(`${KEY_PREFIX}${name}`)
    .first<{ value: string; value_type: string }>();
  if (!row) return '';
  if (row.value_type !== 'encrypted' || !row.value.startsWith(ENC_PREFIX)) return '';
  return row.value;
}

/**
 * Resolves a credential.
 *
 * `encKey` defaults to the worker secret; it is a parameter so the settings
 * panel can pass the *already resolved* key when it is itself rotating that key.
 */
export async function resolveCredential(
  env: CredentialTable,
  name: CredentialName,
  fallback?: string,
  encKey?: string,
): Promise<string> {
  const stored = await readStored(env.DB, name);
  if (stored) {
    // `??` and `||` cannot be mixed without parentheses; the intent is:
    // explicit key, else the stored one, else the deploy-time secret.
    const key =
      encKey ?? ((await resolveCredential(env, 'webhook_secret_key')) || env.WEBHOOK_SECRET_KEY);
    if (key) {
      const plain = await decryptSecret(stored.slice(ENC_PREFIX.length), key);
      if (plain) return plain;
    }
    // A row exists but cannot be decrypted (key was rotated). Fall through to
    // the secret rather than leaving the platform with no token at all.
  }
  return (fallback ?? '').trim();
}

/** Encrypts and stores a credential. Empty string clears the override. */
export async function saveCredential(
  env: CredentialTable,
  name: CredentialName,
  plain: string,
  encKey: string,
): Promise<void> {
  const value = plain.trim();
  if (!value) {
    await env.DB.prepare(
      `UPDATE site_settings SET value = '', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE key = ?`,
    )
      .bind(`${KEY_PREFIX}${name}`)
      .run();
    return;
  }

  const enc = `${ENC_PREFIX}${await encryptSecret(value, encKey)}`;
  await env.DB.prepare(
    `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
     VALUES (?, ?, 'encrypted', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       value_type = 'encrypted', updated_at = excluded.updated_at`,
  )
    .bind(`${KEY_PREFIX}${name}`, enc)
    .run();
}

/**
 * Resolves every credential once, for a request that needs several of them.
 *
 * The encryption key has to be resolved first (it can itself be stored), and a
 * panel-set key is used to decrypt the other two — that is the order a rotation
 * needs: save the new key, then re-save the tokens encrypted under it.
 */
export interface ResolvedCredentials {
  githubReadToken: string;
  telegramBotToken: string;
  telegramAdminId: string;
  encryptionKey: string;
}

export async function resolveAll(
  env: {
    DB: D1Database;
    GITHUB_READ_TOKEN?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_ADMIN_ID?: string;
    WEBHOOK_SECRET_KEY?: string;
  },
): Promise<ResolvedCredentials> {
  // The encryption key can only come from the Worker Secret: a key used to
  // decrypt itself would be circular, and storing it beside the ciphertext
  // would defeat the point.
  const encryptionKey = (env.WEBHOOK_SECRET_KEY ?? '').trim();

  const [githubReadToken, telegramBotToken, telegramAdminId] = await Promise.all([
    resolveCredential(env, 'github_read_token', env.GITHUB_READ_TOKEN, encryptionKey),
    resolveCredential(env, 'telegram_bot_token', env.TELEGRAM_BOT_TOKEN, encryptionKey),
    // The admin id is not secret; it stays a plain setting.
    (async () => {
      const row = await env.DB.prepare(
        "SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'",
      ).first<{ value: string }>();
      return (env.TELEGRAM_ADMIN_ID ?? '').trim() || (row?.value ?? '').trim();
    })(),
  ]);

  return { githubReadToken, telegramBotToken, telegramAdminId, encryptionKey };
}

/** Status for the settings panel — never returns the value itself. */
export async function credentialStatus(
  env: { DB: D1Database; WEBHOOK_SECRET_KEY?: string },
  name: CredentialName,
): Promise<{ fromPanel: boolean; hasFallback: boolean; usable: boolean; hint: string }> {
  const stored = await readStored(env.DB, name);
  const key = (env.WEBHOOK_SECRET_KEY ?? '').trim();
  let usable = false;
  let hint = '';
  if (stored && key) {
    const plain = await decryptSecret(stored.slice(ENC_PREFIX.length), key);
    if (plain) {
      usable = true;
      // A short fingerprint so the admin can tell two tokens apart without the
      // value being recoverable from the response.
      hint = plain.length > 12 ? `${plain.slice(0, 4)}…${plain.slice(-4)}` : '已设置';
    }
  }
  return { fromPanel: Boolean(stored), hasFallback: false, usable, hint };
}
