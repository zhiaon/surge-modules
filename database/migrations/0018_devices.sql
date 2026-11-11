-- ===========================================================================
-- 0018 — device authorisation
--
-- Honest scope, stated up front because the brief demands it: Surge does not
-- send a stable device identifier. There is no hardware ID, no keychain token,
-- nothing that survives a reinstall and cannot be copied. Any "device binding"
-- built on IP or User-Agent is theatre — one is unstable across Wi-Fi/cellular
-- and the other is trivially spoofed.
--
-- So this is a *distinct key per authorised consumer*, not device attestation:
--
--   * each row owns its own access credential
--   * the user pastes a different link on each of their devices
--   * the count is bounded, so a leaked link cannot be redeployed infinitely
--   * revoking one link kills exactly one device
--
-- What it does NOT do: stop someone from pasting the same link on two machines.
-- That is impossible with this protocol, and pretending otherwise would be
-- worse than the limitation itself.
-- ===========================================================================

ALTER TABLE devices ADD COLUMN device_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN last_ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_devices_key ON devices(device_key_hash);

-- Per-user device policy. Defaults follow the brief: 2 devices, limit on.
ALTER TABLE user_settings ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 2;
ALTER TABLE user_settings ADD COLUMN device_limit_enabled INTEGER NOT NULL DEFAULT 1;

-- The proxy needs to know which device a request came from, so it can refuse a
-- revoked one. Stored on the access log for the admin device view.
ALTER TABLE module_access_logs ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS ix_accesslog_device ON module_access_logs(device_id, created_at DESC);
