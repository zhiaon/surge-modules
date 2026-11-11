-- 0001_init.sql
-- Initial D1 schema for Surge Modules.
-- Phase 1 ships the frontend against sample data; this migration defines the
-- shape the Phase 2 API will read from. Nothing here is wired up yet.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_visible  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modules (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  author         TEXT NOT NULL,
  category_id    TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  version        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  raw_url        TEXT NOT NULL,
  repository_url TEXT,
  is_featured    INTEGER NOT NULL DEFAULT 0,
  is_published   INTEGER NOT NULL DEFAULT 1,
  -- provenance for the sync pipeline
  source_repo    TEXT,
  source_path    TEXT,
  content_hash   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_modules_category ON modules(category_id);
CREATE INDEX IF NOT EXISTS idx_modules_updated  ON modules(is_published, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_modules_featured ON modules(is_featured, updated_at DESC);

CREATE TABLE IF NOT EXISTS module_tags (
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (module_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_module_tags_tag ON module_tags(tag);

CREATE TABLE IF NOT EXISTS module_versions (
  id          TEXT PRIMARY KEY,
  module_id   TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  changelog   TEXT NOT NULL DEFAULT '',
  released_at TEXT NOT NULL,
  UNIQUE (module_id, version)
);

CREATE INDEX IF NOT EXISTS idx_versions_module ON module_versions(module_id, released_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  is_pinned    INTEGER NOT NULL DEFAULT 0
);

-- one row per watched GitHub repository
CREATE TABLE IF NOT EXISTS sync_sources (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT 'main',
  path_prefix   TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_status   TEXT,
  UNIQUE (owner, repo, branch)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,          -- running | ok | failed
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs(source_id, started_at DESC);
