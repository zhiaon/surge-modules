-- 0007_hooks_and_alerts.sql
-- Phase 6 follow-up: per-source webhook secrets, sync batching, and failure alerts.
--
-- Why per-source secrets: a single shared webhook secret means one leaked value
-- can forge deliveries for every repository. Generating one per source limits
-- the blast radius to a single repo.
--
-- Why `sync_cursor`: a full scan of a large repository exceeds the CPU budget of
-- a single invocation. The cursor records which file the last pass stopped at so
-- the next pass resumes instead of restarting.

PRAGMA foreign_keys = ON;

-- Replacing a shared secret with a per-source one.
ALTER TABLE sources ADD COLUMN webhook_secret TEXT;

-- Where the last sync pass stopped, and how many passes a full sweep needs.
ALTER TABLE sources ADD COLUMN sync_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN sync_total INTEGER NOT NULL DEFAULT 0;

-- Alert bookkeeping: consecutive failures and the last time we notified.
ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_alert_at TEXT;

-- One row per alert so the dashboard can show history, and so a repeated
-- condition is not re-notified on every cron tick.
CREATE TABLE IF NOT EXISTS sync_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'failure',   -- failure | recovered | hook_missing
  message     TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_sync_alerts_open
  ON sync_alerts(acknowledged, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_sync_alerts_source
  ON sync_alerts(source_id, created_at DESC);
