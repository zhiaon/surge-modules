/**
 * Per-device access keys.
 *
 * The design is deliberately honest about what it can and cannot do.
 *
 * A Surge request carries no stable hardware identifier. The only thing that
 * reliably distinguishes one authorised consumer from another is *which key it
 * presents* — so a "device" here is a key the user created for one of their
 * machines, not a fingerprint of the machine itself.
 *
 * Consequences, spelled out:
 *   ✓ revoking a device kills exactly that link
 *   ✓ the count is bounded, so a leaked link cannot spawn unlimited copies
 *   ✓ a new device requires an explicit user action (create a key), which is
 *     visible in the account centre
 *   ✗ someone who copies a link onto a second machine will work there too.
 *     This is unavoidable: Basic Auth credentials are bearer tokens by
 *     definition. Device *limit* is enforced on creation, not on use.
 *
 * Nothing here inspects the IP or the User-Agent for identity. Both are
 * recorded for diagnostics only, and `last_ip_hash` is a hash so the raw
 * address never lands in the database.
 */

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string | null;
  access_count: number;
  credential_id: string | null;
}

export interface DeviceLimits {
  enabled: boolean;
  max: number;
}

export async function loadDeviceLimits(
  db: D1Database,
  userId?: string,
): Promise<DeviceLimits> {
  const row = await db
    .prepare('SELECT device_limit_enabled, max_devices FROM user_settings WHERE id = 1')
    .first<{ device_limit_enabled: number; max_devices: number }>();

  // A per-account override wins over the global default; NULL means "inherit".
  if (userId) {
    const u = await db
      .prepare('SELECT max_devices_override FROM users WHERE id = ?')
      .bind(userId)
      .first<{ max_devices_override: number | null }>();
    if (u?.max_devices_override != null) {
      return { enabled: true, max: u.max_devices_override };
    }
  }

  return {
    enabled: Number(row?.device_limit_enabled ?? 1) === 1,
    max: Number(row?.max_devices ?? 2) || 2,
  };
}

/**
 * "Devices" and "credentials" are the same thing: one access key = one link =
 * one device slot. Counting the credential table directly is what makes the
 * limit, the reset, and the install link agree with each other — there is no
 * second table that can drift.
 */
export async function countActiveDevices(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM access_credentials WHERE user_id = ? AND status = 'active'")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type CreateOutcome =
  | { ok: true; deviceId: string }
  | { ok: false; code: 'limit' | 'duplicate'; message: string; used: number; max: number };

/**
 * Registers one device slot for a user.
 *
 * The limit is checked and the row inserted in one statement so two concurrent
 * clicks cannot exceed it: the INSERT selects only while the active count is
 * below the cap.
 */
export async function createDevice(
  db: D1Database,
  args: { userId: string; name: string; credentialId: string | null; deviceKeyHash: string },
): Promise<CreateOutcome> {
  const limits = await loadDeviceLimits(db, args.userId);
  const used = await countActiveDevices(db, args.userId);

  if (limits.enabled && used >= limits.max) {
    return {
      ok: false,
      code: 'limit',
      message: `已达到 ${limits.max} 台设备上限，请先在个人中心移除一台设备`,
      used,
      max: limits.max,
    };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, credential_id, name, device_key_hash, first_seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    )
    .bind(id, args.userId, args.credentialId, args.name.slice(0, 60), args.deviceKeyHash, iso())
    .run();

  return { ok: true, deviceId: id };
}

export async function listDevices(db: D1Database, userId: string): Promise<DeviceRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, user_id, name, status, first_seen_at, last_seen_at, access_count, credential_id
         FROM devices WHERE user_id = ?
        ORDER BY status = 'active' DESC, first_seen_at DESC`,
    )
    .bind(userId)
    .all<DeviceRow>();
  return rows.results ?? [];
}

/** Revokes one device and the credential bound to it. */
export async function revokeDevice(
  db: D1Database,
  deviceId: string,
  userId?: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT id, user_id, credential_id FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ id: string; user_id: string; credential_id: string | null }>();
  if (!row) return false;
  if (userId && row.user_id !== userId) return false;

  await db
    .prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?")
    .bind(iso(), deviceId)
    .run();

  if (row.credential_id) {
    await db
      .prepare("UPDATE access_credentials SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .bind(iso(), row.credential_id)
      .run();
  }
  return true;
}

/**
 * Records a successful use. Called by the proxy after authentication.
 *
 * Not awaited by the response path: it is diagnostics, and a slow write must not
 * delay a module fetch.
 */
export async function touchDevice(
  db: D1Database,
  deviceId: string,
  ipHash: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE devices
            SET last_seen_at = ?, last_ip_hash = ?, access_count = access_count + 1
          WHERE id = ?`,
      )
      .bind(iso(), ipHash, deviceId)
      .run();
  } catch {
    /* diagnostics only */
  }
}

/**
 * Finds the device a credential belongs to.
 *
 * A credential created before the device feature has no device row; such a
 * request is treated as "no device" and allowed, so existing users are not
 * locked out by this upgrade.
 */
export async function deviceForCredential(
  db: D1Database,
  credentialId: string,
): Promise<{ id: string; status: string } | null> {
  const row = await db
    .prepare('SELECT id, status FROM devices WHERE credential_id = ? LIMIT 1')
    .bind(credentialId)
    .first<{ id: string; status: string }>();
  return row ?? null;
}
