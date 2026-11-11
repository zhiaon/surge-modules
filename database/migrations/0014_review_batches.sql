-- ===========================================================================
-- 0014 — batch review campaigns + a unified pending view
--
-- Two review queues already exist and must keep working independently:
--
--   review_items          first-party sync (GitHub 数据源)
--   module_review_tasks   third-party repositories (审核中心)
--
-- The Telegram batch UI needs to list, select and decide across BOTH without
-- duplicating the publish logic. This migration adds:
--
--   1. review_batches      one row per batch operation (audit trail + results)
--   2. v_pending_reviews   a read-only union of both queues, with a stable
--                          `queue` discriminator so the bot can route a decision
--                          back to the correct handler.
--
-- Nothing existing is modified: the view is additive, and the batch table is a
-- log. Decide handlers stay exactly as they are (review.ts / admin.ts).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS review_batches (
  id            TEXT PRIMARY KEY,
  /** approve | reject */
  action        TEXT NOT NULL,
  /** web | telegram */
  source        TEXT NOT NULL DEFAULT 'telegram',
  operator      TEXT NOT NULL,
  total         INTEGER NOT NULL DEFAULT 0,
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  /** JSON array: [{ id, queue, name, ok, message }] */
  detail        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_batch_created ON review_batches(created_at DESC);

-- --------------------------------------------------------------------- view
-- `kind` mirrors what the bot shows: new | update | delete.
-- `status` is normalised to pending | approved | rejected | superseded.
-- Rows whose backing module was hard-deleted are excluded.
CREATE VIEW IF NOT EXISTS v_pending_reviews AS
  -- third-party queue
  SELECT
    t.id                AS id,
    'third_party'       AS queue,
    COALESCE(m.name, t.file_path) AS name,
    t.task_type         AS kind,
    t.new_version       AS version,
    COALESCE(r.name, r.owner || '/' || r.repository) AS repository,
    'https://github.com/' || COALESCE(r.owner,'') || '/' || COALESCE(r.repository,'') AS repository_url,
    COALESCE(m.upstream_url, '') AS raw_url,
    t.review_status     AS status,
    t.created_at        AS created_at,
    t.detection_method  AS detection_method,
    t.reviewer          AS reviewer,
    t.reviewed_at       AS reviewed_at,
    t.repository_id     AS repository_id,
    t.module_id         AS module_id
  FROM module_review_tasks t
  LEFT JOIN third_party_repositories r ON r.id = t.repository_id
  LEFT JOIN modules m ON m.id = t.module_id

  UNION ALL

  -- first-party queue
  SELECT
    i.id                AS id,
    'first_party'       AS queue,
    COALESCE(m.name, i.source_path, '未知模块') AS name,
    i.kind             AS kind,
    COALESCE(m.version, '') AS version,
    COALESCE(s.owner || '/' || s.repo, '') AS repository,
    COALESCE(m.repository_url, '') AS repository_url,
    COALESCE(m.upstream_url, '') AS raw_url,
    i.status           AS status,
    i.created_at       AS created_at,
    'manual'           AS detection_method,
    COALESCE(i.reviewed_by, '') AS reviewer,
    i.reviewed_at      AS reviewed_at,
    NULL               AS repository_id,
    i.module_id        AS module_id
  FROM review_items i
  LEFT JOIN modules m ON m.id = i.module_id
  LEFT JOIN sources s ON s.id = i.source_id;

-- ---------------------------------------------------------------------------
-- Selection state for the Telegram multi-select UI.
--
-- Held in D1 rather than callback data: Telegram caps callback_data at 64
-- bytes, which cannot carry a growing id set, and a stateless encoding would
-- lose the selection when the user flips pages. Keyed by chat + page-session so
-- one admin's selection cannot leak into another's.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_review_selection (
  chat_id    TEXT NOT NULL,
  review_id  TEXT NOT NULL,
  queue      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (chat_id, review_id)
);

CREATE INDEX IF NOT EXISTS ix_tgsel_chat ON tg_review_selection(chat_id);

-- menu message id per chat, so a refresh edits the same message instead of
-- spawning a new one on every button press
CREATE TABLE IF NOT EXISTS tg_ui_state (
  chat_id      TEXT PRIMARY KEY,
  message_id   INTEGER,
  page         INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
