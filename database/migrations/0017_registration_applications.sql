-- 0017 — registration applications (approval-mode audit trail)
--
-- Approval mode already created a `users` row with status='pending'; what was
-- missing is the application record: when it arrived, from which IP hash, and
-- who decided it. Keeping it separate from `users` means a rejected applicant
-- leaves a decision trail without polluting the user table with dead rows.

CREATE TABLE IF NOT EXISTS registration_applications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  username     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  note         TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT '',
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_regapp_status
  ON registration_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_regapp_user
  ON registration_applications(user_id);
