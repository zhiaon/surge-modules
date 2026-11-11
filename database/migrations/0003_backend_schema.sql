-- 0003_backend_schema.sql
-- Phase 4: real backend schema for the site API and the module proxy.
--
-- IMPORTANT: migrations 0001/0002 already created `categories`, `modules`,
-- `module_tags`, `module_versions` and `announcements` with a smaller shape.
-- SQLite cannot add constraints or change a PK in place, and `CREATE TABLE IF
-- NOT EXISTS` would silently keep the old columns — so the tables that need a
-- different shape are rebuilt (create new → copy → drop → rename), and the ones
-- that only gain columns use ALTER TABLE ADD COLUMN.
--
-- Conventions
-- -----------
-- * IDs are TEXT (UUID/ULID) so offline-created rows merge without renumbering.
-- * Timestamps are ISO-8601 UTC text: D1 has no timestamp type and text sorts.
-- * Deletes are soft (`deleted_at`) on anything an admin can restore.
-- * Read precedence: module_overrides > modules (synced) > parse defaults.
--   The sync job only writes synced columns, so an override can never be lost.

PRAGMA foreign_keys = OFF;

-- ================================================================ categories
-- Needs `deleted_at` and unique-on-slug. Rebuild.

-- the 0001 table already has the right columns; it only lacks soft delete
ALTER TABLE categories ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS ix_categories_order
  ON categories(is_visible, sort_order);

-- =================================================================== sources
-- Allowlist of repositories the operator owns. The proxy can only ever resolve
-- to a row here, which is what makes it a non-open proxy.

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  branch         TEXT NOT NULL DEFAULT 'main',
  allow_paths    TEXT NOT NULL DEFAULT '',
  sync_mode      TEXT NOT NULL DEFAULT 'manual',
  is_enabled     INTEGER NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  last_status    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sources_repo
  ON sources(owner, repo, branch) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_sources_enabled ON sources(is_enabled);

-- =================================================================== modules
-- Needs provenance columns, published_at/synced_at, deleted_at, and drops the
-- old free-form source_repo in favour of a real FK.
--
-- `CREATE TABLE ... AS SELECT` copies data but not constraints, so the copy is
-- used only to preserve rows; the typed table is created explicitly instead.

CREATE TABLE modules_new (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  author         TEXT NOT NULL DEFAULT '',
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  version        TEXT NOT NULL DEFAULT '0.0.0',
  source_id      TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_path    TEXT,
  content_hash   TEXT,
  upstream_url   TEXT,
  repository_url TEXT,
  is_featured    INTEGER NOT NULL DEFAULT 0,
  is_published   INTEGER NOT NULL DEFAULT 1,
  published_at   TEXT,
  synced_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at     TEXT
);

INSERT INTO modules_new (
  id, slug, name, description, author, category_id, version,
  source_path, content_hash, upstream_url, repository_url,
  is_featured, is_published, published_at, synced_at, created_at, updated_at
)
SELECT id, slug, name, description, author, category_id, version,
       source_path, content_hash, raw_url, repository_url,
       is_featured, is_published, created_at, created_at, created_at, updated_at
  FROM modules;

DROP TABLE modules;
ALTER TABLE modules_new RENAME TO modules;

CREATE UNIQUE INDEX IF NOT EXISTS ux_modules_slug
  ON modules(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_modules_list
  ON modules(is_published, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_modules_featured
  ON modules(is_featured, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_modules_category
  ON modules(category_id, is_published) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_modules_source ON modules(source_id, source_path);

-- ================================================================ module_tags
CREATE TABLE IF NOT EXISTS module_tags (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (module_id, tag)
);

CREATE INDEX IF NOT EXISTS ix_module_tags_tag ON module_tags(tag);

-- ============================================================ module_versions
-- Adds content_hash / commit info / fetched_at.

CREATE TABLE module_versions_new (
  id           TEXT PRIMARY KEY,
  module_id    TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  content_hash TEXT,
  changelog    TEXT NOT NULL DEFAULT '',
  commit_sha   TEXT,
  commit_url   TEXT,
  released_at  TEXT NOT NULL,
  fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT INTO module_versions_new (id, module_id, version, changelog, released_at, fetched_at, created_at)
SELECT id, module_id, version, changelog, released_at, released_at, released_at
  FROM module_versions;

DROP TABLE module_versions;
ALTER TABLE module_versions_new RENAME TO module_versions;

CREATE UNIQUE INDEX IF NOT EXISTS ux_versions_module_version
  ON module_versions(module_id, version);
CREATE INDEX IF NOT EXISTS ix_versions_recent ON module_versions(released_at DESC);

-- =============================================================== announcements
-- 0001 has id/title/body/published_at/is_pinned; the rest are additive
ALTER TABLE announcements ADD COLUMN level TEXT NOT NULL DEFAULT 'info';
ALTER TABLE announcements ADD COLUMN is_published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcements ADD COLUMN created_at TEXT;
ALTER TABLE announcements ADD COLUMN updated_at TEXT;
ALTER TABLE announcements ADD COLUMN deleted_at TEXT;
UPDATE announcements SET created_at = published_at WHERE created_at IS NULL;
UPDATE announcements SET updated_at = published_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_announcements_live
  ON announcements(is_published, published_at DESC) WHERE deleted_at IS NULL;

-- ============================================================ proxy mappings
CREATE TABLE IF NOT EXISTS module_proxy_mappings (
  id           TEXT PRIMARY KEY,
  module_id    TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  public_slug  TEXT NOT NULL,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  file_path    TEXT NOT NULL,
  serve_mode   TEXT NOT NULL DEFAULT 'raw',
  is_enabled   INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_proxy_slug
  ON module_proxy_mappings(public_slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_proxy_enabled ON module_proxy_mappings(is_enabled);

-- =============================================================== site settings
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  scope      TEXT NOT NULL DEFAULT 'public',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_settings_scope ON site_settings(scope);

-- =================================================================== analytics
CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  subject    TEXT,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_analytics_event_day ON analytics_events(event, day);
CREATE INDEX IF NOT EXISTS ix_analytics_subject ON analytics_events(subject, day);

-- =================================================================== sync jobs
CREATE TABLE IF NOT EXISTS sync_jobs (
  id          TEXT PRIMARY KEY,
  source_id   TEXT REFERENCES sources(id) ON DELETE SET NULL,
  trigger     TEXT NOT NULL DEFAULT 'manual',
  status      TEXT NOT NULL DEFAULT 'queued',
  started_at  TEXT,
  finished_at TEXT,
  scanned     INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_sync_jobs_recent ON sync_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS sync_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  level      TEXT NOT NULL DEFAULT 'info',
  path       TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_sync_logs_job ON sync_logs(job_id, created_at);

-- ================================================================= audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_audit_recent ON audit_logs(created_at DESC);

-- =========================================================== module overrides
CREATE TABLE IF NOT EXISTS module_overrides (
  module_id  TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  value      TEXT,
  updated_by TEXT NOT NULL DEFAULT 'admin',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (module_id, field)
);

-- ============================================================== tombstones
CREATE TABLE IF NOT EXISTS module_tombstones (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'removed',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tombstone_source_path
  ON module_tombstones(source_id, source_path);

-- ============================================================= rate limits
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window)
);

PRAGMA foreign_keys = ON;
