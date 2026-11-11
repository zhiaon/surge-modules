-- ===========================================================================
-- 0015 — user accounts, email verification, access credentials, devices
--
-- Incremental: nothing existing is dropped or rewritten. The admin tables
-- (`admins`, `admin_sessions`) stay untouched — this is a *separate* identity
-- system for public users, with its own sessions and its own permission checks,
-- so an ordinary user can never reach an admin route by changing a parameter.
--
-- Password storage: PBKDF2-SHA256 (210k iterations) via WebCrypto. Argon2id is
-- not available in the Workers runtime without bundling a WASM implementation;
-- PBKDF2 at this iteration count is the reviewed option this codebase already
-- uses for admins, so users share the same audited path.
--
-- Access credentials are stored as SHA-256 hashes only. The plaintext exists
-- exactly once, in the response that creates it.
-- ===========================================================================

-- ------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  /** lower-cased, trimmed — the value used for uniqueness and lookup */
  email_normalized  TEXT NOT NULL,
  /** original casing for display */
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | pending | banned | deleted
  register_method   TEXT NOT NULL DEFAULT 'free',     -- free | invite | approval
  email_verified_at TEXT,
  registered_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at     TEXT,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username
  ON users(username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email
  ON users(email_normalized) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_users_status ON users(status);

-- ----------------------------------------------------------------- sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at   TEXT,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_usessions_user ON user_sessions(user_id, created_at DESC);

-- ------------------------------------------------------- email verification
CREATE TABLE IF NOT EXISTS email_verifications (
  id           TEXT PRIMARY KEY,
  /** normalized address the code was sent to */
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'register',  -- register | reset_password
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ip_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_emailver_lookup
  ON email_verifications(email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_emailver_expiry ON email_verifications(expires_at);

-- send log: rate limiting and diagnostics. The code itself is never recorded.
CREATE TABLE IF NOT EXISTS email_send_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'register',
  ip_hash    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,             -- success | failed | rate_limited
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_emaillog_email ON email_send_logs(email, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_emaillog_ip ON email_send_logs(ip_hash, created_at DESC);

-- ------------------------------------------------------ access credentials
CREATE TABLE IF NOT EXISTS access_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  /** short fingerprint so the user can tell two keys apart */
  hint          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_used_at  TEXT,
  revoked_at    TEXT,
  expires_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cred_hash ON access_credentials(token_hash);
CREATE INDEX IF NOT EXISTS ix_cred_user ON access_credentials(user_id, status);

-- ------------------------------------------------------------ invitations
CREATE TABLE IF NOT EXISTS invitations (
  code         TEXT PRIMARY KEY,
  created_by   TEXT NOT NULL DEFAULT 'admin',
  max_uses     INTEGER NOT NULL DEFAULT 1,
  used_count   INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  disabled     INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_invitations_state ON invitations(disabled, expires_at);

-- ------------------------------------------------------- registration mode
-- Single-row table of switches; seeded below.
CREATE TABLE IF NOT EXISTS user_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  free_register               INTEGER NOT NULL DEFAULT 1,
  invite_register             INTEGER NOT NULL DEFAULT 0,
  approval_register           INTEGER NOT NULL DEFAULT 0,
  email_code_ttl_seconds      INTEGER NOT NULL DEFAULT 300,
  email_send_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  email_hourly_limit          INTEGER NOT NULL DEFAULT 5,
  email_daily_limit           INTEGER NOT NULL DEFAULT 10,
  ip_hourly_limit             INTEGER NOT NULL DEFAULT 10,
  max_devices                 INTEGER NOT NULL DEFAULT 3,
  /** global switch: require a credential for every module fetch */
  require_credential          INTEGER NOT NULL DEFAULT 0,
  email_domain_blocklist      TEXT NOT NULL DEFAULT '',
  updated_by                  TEXT NOT NULL DEFAULT '',
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT OR IGNORE INTO user_settings (id) VALUES (1);

-- ---------------------------------------------------------------- devices
-- Honest limitation: Surge sends no stable device identifier, so a "device" is
-- a server-issued row the user names and revokes themselves. It bounds the
-- number of credentials a user may hold; it is NOT hardware attestation and the
-- docs say so explicitly.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES access_credentials(id) ON DELETE SET NULL,
  name         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS ix_devices_user ON devices(user_id, status);

-- ------------------------------------------------------------- access logs
CREATE TABLE IF NOT EXISTS module_access_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL DEFAULT '',
  user_id       TEXT,
  credential_id TEXT,
  method        TEXT NOT NULL DEFAULT 'GET',
  user_agent    TEXT NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL DEFAULT '',   -- ok | no_credential | bad_credential | banned | client_blocked | not_found
  ip_hash       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_accesslog_slug ON module_access_logs(slug, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_accesslog_user ON module_access_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_accesslog_result ON module_access_logs(result, created_at DESC);

-- -------------------------------------------------------- security events
CREATE TABLE IF NOT EXISTS security_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,   -- login_failed | register | credential_issued | credential_reset | credential_revoked | ban | unban | policy_change
  user_id    TEXT,
  actor      TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}',
  ip_hash    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_security_kind ON security_events(kind, created_at DESC);

-- ------------------------------------------------------ per-user module perms
-- Empty table = every published module is open to every active user
-- (the default). A row with allowed=0 denies a specific module.
CREATE TABLE IF NOT EXISTS user_module_permissions (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  allowed   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, module_id)
);

-- ------------------------------------------------------------ UA policies
CREATE TABLE IF NOT EXISTS client_access_policies (
  id          TEXT PRIMARY KEY,
  policy_type TEXT NOT NULL,   -- surge_whitelist | browser_blacklist | client_blacklist
  pattern     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_ua_policy ON client_access_policies(policy_type, enabled);

-- Seed the Surge whitelist. Not a guess: Surge identifies itself with a bare
-- "Surge/x.y.z" token and never sends a Mozilla/ prefix. The pattern is editable
-- in the admin panel so a future client version needs no deploy.
INSERT OR IGNORE INTO client_access_policies (id, policy_type, pattern, description) VALUES
  ('ua-surge-1', 'surge_whitelist', '(^|\\s)Surge/\\d+\\.\\d+', 'Surge 客户端 UA（无 Mozilla 前缀）');

INSERT OR IGNORE INTO client_access_policies (id, policy_type, pattern, description) VALUES
  ('ua-browser-1', 'browser_blacklist', 'Mozilla/', '所有浏览器 UA 的前缀'),
  ('ua-browser-2', 'browser_blacklist', 'AppleWebKit/', 'WebKit 内核标识'),
  ('ua-browser-3', 'browser_blacklist', 'Chrome/', 'Chrome / Edge / Opera'),
  ('ua-browser-4', 'browser_blacklist', 'Safari/', 'Safari'),
  ('ua-browser-5', 'browser_blacklist', 'Firefox/', 'Firefox'),
  ('ua-browser-6', 'browser_blacklist', 'Edg/', 'Edge'),
  ('ua-client-1', 'client_blacklist', 'curl/', 'curl'),
  ('ua-client-2', 'client_blacklist', 'Wget/', 'wget'),
  ('ua-client-3', 'client_blacklist', 'python-requests', 'Python requests'),
  ('ua-client-4', 'client_blacklist', 'Go-http-client', 'Go 标准库'),
  ('ua-client-5', 'client_blacklist', 'okhttp/', 'OkHttp'),
  ('ua-client-6', 'client_blacklist', 'PostmanRuntime/', 'Postman'),
  ('ua-client-7', 'client_blacklist', 'axios/', 'axios');
