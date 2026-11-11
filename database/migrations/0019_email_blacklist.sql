-- 0019 — per-address email blacklist
--
-- Two behaviours demanded by the operator:
--   * a blacklisted address cannot register
--   * a blacklisted address cannot log in either
--
-- This is distinct from the existing domain blocklist (which rejects a whole
-- provider like mailinator.com at send-time). A single-address ban is for
-- individual abuse, and it must also lock out someone who already has an
-- account — so the check runs at login, not just registration.

CREATE TABLE IF NOT EXISTS email_blacklist (
  email_normalized TEXT PRIMARY KEY,
  reason           TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT 'admin',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
