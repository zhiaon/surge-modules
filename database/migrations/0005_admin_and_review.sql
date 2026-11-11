-- 0005_admin_and_review.sql
-- Phase 5: admin accounts, sessions, review queue, proxy telemetry.
--
-- Security posture
-- ----------------
-- * `admins.password_hash` stores a PBKDF2-SHA256 derived key, never a password.
--   The salt and iteration count travel with the hash so the cost can be raised
--   later without invalidating existing rows.
-- * Sessions are opaque random tokens; only their SHA-256 is stored, so a
--   database leak does not hand over usable session cookies.
-- * `admins.invited_by` / `audit_logs.actor` are labels, never credentials.
-- * No column anywhere is meant to hold a GitHub token.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------- admins
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  -- 'super' can manage admins and settings; 'editor' can manage content
  role          TEXT NOT NULL DEFAULT 'editor',
  -- format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- brute-force protection
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_admins_username
  ON admins(username) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
  -- sha256 of the cookie value; the raw token never touches the database
  token_hash   TEXT PRIMARY KEY,
  admin_id     TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  user_agent   TEXT,
  -- coarse network label only; no full IP is stored
  client_hint  TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_admin ON admin_sessions(admin_id, expires_at);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON admin_sessions(expires_at);

-- ------------------------------------------------------------ review queue
-- One row per pending change. `kind` distinguishes a brand-new module from an
-- edit to an already published one, because the two need different handling.
CREATE TABLE IF NOT EXISTS review_items (
  id           TEXT PRIMARY KEY,
  module_id    TEXT REFERENCES modules(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'new',        -- new | update | proxy
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  source_id    TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_path  TEXT,
  -- JSON snapshot of the proposed values, for diffing against the live row
  proposed     TEXT NOT NULL DEFAULT '{}',
  -- JSON snapshot of what is live right now, so a diff survives later edits
  baseline     TEXT NOT NULL DEFAULT '{}',
  note         TEXT NOT NULL DEFAULT '',
  reviewed_by  TEXT REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_review_pending
  ON review_items(status, created_at DESC);

-- ------------------------------------------------------- proxy telemetry
-- Aggregated per day so the dashboard can show real hit/miss counts without
-- storing a row per request.
CREATE TABLE IF NOT EXISTS proxy_stats (
  day        TEXT NOT NULL,
  slug       TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  misses     INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slug)
);

CREATE INDEX IF NOT EXISTS ix_proxy_stats_day ON proxy_stats(day);

-- Per-mapping operational status, shown in the proxy admin page.
ALTER TABLE module_proxy_mappings ADD COLUMN ttl_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE module_proxy_mappings ADD COLUMN last_fetched_at TEXT;
ALTER TABLE module_proxy_mappings ADD COLUMN last_status TEXT;
ALTER TABLE module_proxy_mappings ADD COLUMN last_error TEXT;

-- Sync locking: a job claims its source so two runs cannot overlap.
ALTER TABLE sources ADD COLUMN sync_lock TEXT;
ALTER TABLE sources ADD COLUMN sync_lock_at TEXT;

-- Module review/publish intent, kept separate from `is_published` so an admin
-- can pre-approve a module that is not live yet.
ALTER TABLE modules ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE modules ADD COLUMN sort_weight INTEGER NOT NULL DEFAULT 0;
