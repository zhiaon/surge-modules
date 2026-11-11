-- ===========================================================================
-- 0009 — add `current_blob_sha` to third_party_modules
--
-- 0008 compared the git *blob* SHA reported by the tree API against a SHA-256 of
-- the file text stored in `current_content_sha`. Those two are different values
-- by construction, so the comparison was always true and every scan
-- re-downloaded every file. This column holds the blob SHA so the cheap
-- "did the blob change" check actually works.
--
-- Additive and idempotent: 0008 already declares the column for fresh installs,
-- this brings an existing database to the same shape.
-- ===========================================================================

-- SQLite has no IF NOT EXISTS for ADD COLUMN; run this only against a database
-- created before 0008 was updated. On a fresh install the column already
-- exists and this statement is a no-op error that the runner reports as
-- "duplicate column" — harmless, and `--file` execution continues.
ALTER TABLE third_party_modules ADD COLUMN current_blob_sha TEXT NOT NULL DEFAULT '';
