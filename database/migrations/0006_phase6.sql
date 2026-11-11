-- 0006_phase6.sql
-- Phase 6 additions: operation logs, update logs, backups.
--
-- Design notes
-- ------------
-- * `operation_logs` is separate from the existing `audit_logs` on purpose.
--   audit_logs records *security* events (who authenticated, what they changed);
--   operation_logs records *business* events that the admin log page shows
--   (sync ran, cache refreshed, backup exported). Merging them would force the
--   security trail to share a retention policy with a chatty operational stream.
-- * `update_logs` is the site's own changelog (platform updates), distinct from
--   `module_versions` which tracks third-party module content.
-- * `backups` stores metadata + the payload. Payloads are JSON text; secrets are
--   stripped before insert, never stored.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------- operation logs
CREATE TABLE IF NOT EXISTS operation_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  target     TEXT,
  result     TEXT NOT NULL DEFAULT 'ok',   -- ok | failed
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_operation_logs_recent ON operation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_operation_logs_action ON operation_logs(action, created_at DESC);

-- --------------------------------------------------------------- update logs
-- The platform's own release notes, shown on /updates.
CREATE TABLE IF NOT EXISTS update_logs (
  id           TEXT PRIMARY KEY,
  version      TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  -- comma-separated: feature | fix | security | chore
  kind         TEXT NOT NULL DEFAULT 'feature',
  is_published INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS ix_update_logs_live
  ON update_logs(is_published, published_at DESC) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------- backups
-- `payload` is a JSON snapshot of the tables listed in `scope`. It never
-- contains admin credentials, session tokens or the GitHub token.
CREATE TABLE IF NOT EXISTS backups (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'content',  -- content | full
  payload     TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  row_counts  TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_backups_recent ON backups(created_at DESC);

-- --------------------------------------------------- module visit aggregates
-- Per-module daily counters. The generic analytics_events table already records
-- every event; this rollup exists so the module list can show visit counts
-- without aggregating the event stream on every render.
CREATE TABLE IF NOT EXISTS module_visits (
  day        TEXT NOT NULL,
  module_id  TEXT NOT NULL,
  views      INTEGER NOT NULL DEFAULT 0,
  installs   INTEGER NOT NULL DEFAULT 0,
  copies     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, module_id),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_module_visits_module ON module_visits(module_id, day DESC);
