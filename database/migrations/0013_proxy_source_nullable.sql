-- 0013 — allow proxy mappings without a first-party `sources` row
--
-- module_proxy_mappings.source_id was NOT NULL with an ON DELETE RESTRICT FK
-- into sources. Third-party modules have no sources row, so every publish-time
-- mapping insert failed with SQLITE_CONSTRAINT_NOTNULL and the review centre's
-- published modules returned 404 from the proxy (install + copy-raw dead).
--
-- Rebuilds the table with source_id nullable + SET NULL, preserving all rows
-- and the ttl/last_* columns added by earlier out-of-band migrations.
-- The proxy query LEFT JOINs sources and falls back to the mapping's own
-- third_party_repository_id when there is no first-party source.

CREATE TABLE module_proxy_mappings_new (
  id           TEXT PRIMARY KEY,
  module_id    TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  public_slug  TEXT NOT NULL,
  source_id    TEXT REFERENCES sources(id) ON DELETE SET NULL,
  file_path    TEXT NOT NULL,
  serve_mode   TEXT NOT NULL DEFAULT 'raw',
  is_enabled   INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at   TEXT,
  ttl_seconds  INTEGER NOT NULL DEFAULT 300,
  last_fetched_at TEXT,
  last_status  TEXT,
  last_error   TEXT,
  third_party_repository_id TEXT REFERENCES third_party_repositories(id) ON DELETE SET NULL
);

INSERT INTO module_proxy_mappings_new SELECT * FROM module_proxy_mappings;
DROP TABLE module_proxy_mappings;
ALTER TABLE module_proxy_mappings_new RENAME TO module_proxy_mappings;
CREATE UNIQUE INDEX IF NOT EXISTS ux_proxy_slug
  ON module_proxy_mappings(public_slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_proxy_enabled ON module_proxy_mappings(is_enabled);
