-- ===========================================================================
-- 0008 — 第七阶段：第三方 GitHub 仓库接入系统
--
-- 六张表 + 设置，覆盖三种检测方式（Webhook / 手动 / Cron）的统一流程：
--   检测变化 → 识别模块 → 获取内容 → 比较版本 → 创建审核任务
--   → Telegram 通知 → 管理员审核 → 正式发布
--
-- 三方式共用的关键约束（写在表结构里而不是只写在代码里）：
--   * 审核任务必须携带 repository_id + file_path + commit_sha + content_sha，
--     唯一索引据此去重，同一变化不会被三种方式各建一条任务。
--   * 线上模块（modules）只有在审核通过时才被写入；待审核内容只存在
--     module_review_tasks.new_content 里，所以“未审核不得覆盖线上”是结构保证。
--   * webhook secret 只存密文（AES-GCM，密钥来自 Worker Secret），
--     表中没有明文列可写。
-- ===========================================================================

-- ------------------------------------------------- 第三方仓库
CREATE TABLE IF NOT EXISTS third_party_repositories (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner             TEXT NOT NULL,
  repository        TEXT NOT NULL,
  repository_url    TEXT NOT NULL DEFAULT '',
  default_branch    TEXT NOT NULL DEFAULT 'main',
  description       TEXT NOT NULL DEFAULT '',
  category_id       TEXT REFERENCES categories(id) ON DELETE SET NULL,
  notes             TEXT NOT NULL DEFAULT '',

  -- 三种检测方式各自独立开关：没有 Webhook 的仓库仍然可以手动 + 定时检测
  enabled           INTEGER NOT NULL DEFAULT 1,
  webhook_enabled   INTEGER NOT NULL DEFAULT 1,
  cron_enabled      INTEGER NOT NULL DEFAULT 1,
  manual_check_enabled INTEGER NOT NULL DEFAULT 1,

  -- webhook 密文：iv(12B) + ciphertext，base64；明文永不落库
  webhook_secret_enc TEXT,
  -- 明文前缀提示（如 "whsec_…3f2a"），仅用于后台辨认，不参与验签
  webhook_secret_hint TEXT NOT NULL DEFAULT '',

  -- 自动检测
  check_interval_hours INTEGER NOT NULL DEFAULT 6,
  last_checked_at   TEXT,
  next_check_at     TEXT,
  last_check_status TEXT,                       -- ok | partial | failed | running
  last_check_error  TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- 审核策略：新模块 / 更新是否自动进入待审核（false = 直接忽略不建任务）
  auto_review_new   INTEGER NOT NULL DEFAULT 1,
  auto_review_update INTEGER NOT NULL DEFAULT 1,

  -- 本次检测到的统计（后台列表直接读，不必聚合日志表）
  discovered_modules INTEGER NOT NULL DEFAULT 0,
  pending_new       INTEGER NOT NULL DEFAULT 0,
  pending_updates   INTEGER NOT NULL DEFAULT 0,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tpr_repo_branch
  ON third_party_repositories(owner, repository, default_branch) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tpr_due
  ON third_party_repositories(cron_enabled, enabled, next_check_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tpr_status ON third_party_repositories(last_check_status);

-- ------------------------------------------------- 第三方模块（已发布的正式记录）
-- 这一张表是“线上事实”：只有审核通过后才会写进来。
-- modules 表保留跨来源的模块身份，third_party_modules 记录其在某个仓库中的
-- 具体路径与当前内容。
CREATE TABLE IF NOT EXISTS third_party_modules (
  id                TEXT PRIMARY KEY,
  repository_id     TEXT NOT NULL REFERENCES third_party_repositories(id) ON DELETE CASCADE,
  module_id         TEXT REFERENCES modules(id) ON DELETE SET NULL,

  module_name       TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  branch            TEXT NOT NULL,
  module_description TEXT NOT NULL DEFAULT '',
  author            TEXT NOT NULL DEFAULT '',

  current_version   TEXT NOT NULL DEFAULT '0.0.0',
  current_content   TEXT NOT NULL DEFAULT '',
  -- SHA-256 of current_content. Used to decide "is this the same file content",
  -- independent of how the content was fetched.
  current_content_sha TEXT NOT NULL DEFAULT '',
  source_commit_sha TEXT NOT NULL DEFAULT '',

  published         INTEGER NOT NULL DEFAULT 0,
  is_deleted_upstream INTEGER NOT NULL DEFAULT 0,
  last_seen_at      TEXT,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 模块身份 = 仓库 + 分支 + 路径。不能只用文件名，否则不同仓库同名模块会被合并。
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpm_identity
  ON third_party_modules(repository_id, branch, file_path);
CREATE INDEX IF NOT EXISTS ix_tpm_module ON third_party_modules(module_id);
CREATE INDEX IF NOT EXISTS ix_tpm_repo ON third_party_modules(repository_id, published);

-- ------------------------------------------------- 审核任务
CREATE TABLE IF NOT EXISTS module_review_tasks (
  id                TEXT PRIMARY KEY,
  module_id         TEXT REFERENCES modules(id) ON DELETE SET NULL,
  third_party_module_id TEXT REFERENCES third_party_modules(id) ON DELETE SET NULL,
  repository_id     TEXT NOT NULL REFERENCES third_party_repositories(id) ON DELETE CASCADE,

  task_type         TEXT NOT NULL,              -- new | update | delete
  detection_method  TEXT NOT NULL,              -- webhook | manual | cron

  file_path         TEXT NOT NULL,
  branch            TEXT NOT NULL DEFAULT '',
  old_version       TEXT NOT NULL DEFAULT '',
  new_version       TEXT NOT NULL DEFAULT '',
  old_content       TEXT NOT NULL DEFAULT '',
  new_content       TEXT NOT NULL DEFAULT '',
  content_sha       TEXT NOT NULL DEFAULT '',
  commit_sha        TEXT NOT NULL DEFAULT '',

  review_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | superseded | on_hold
  rejection_reason  TEXT NOT NULL DEFAULT '',
  reviewer          TEXT,
  reviewed_at       TEXT,

  -- 管理员可在审核时改这些字段，null 表示沿用解析结果
  override_name     TEXT,
  override_description TEXT,
  override_category_id TEXT,
  override_icon     TEXT,
  override_featured INTEGER,

  note              TEXT NOT NULL DEFAULT '',

  -- 审核期间又出现新版本：标记过期，防止旧版本覆盖新版本
  superseded_by     TEXT,

  -- Telegram 通知状态，失败可重发；同一任务只发一次
  notify_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  notify_error      TEXT NOT NULL DEFAULT '',
  notify_message_id TEXT,
  notified_at       TEXT,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 去重核心：同一仓库 + 同一文件 + 同一内容 SHA + 同一任务类型，
-- 在 pending 状态下只能有一条。三种检测方式撞车时第二条会被
-- INSERT OR IGNORE 静默丢弃（见 workers/site/third-party.ts）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_mrt_dedupe
  ON module_review_tasks(repository_id, file_path, content_sha, task_type)
  WHERE review_status IN ('pending', 'on_hold');

CREATE INDEX IF NOT EXISTS ix_mrt_pending
  ON module_review_tasks(review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mrt_repo ON module_review_tasks(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mrt_module ON module_review_tasks(module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mrt_notify
  ON module_review_tasks(notify_status) WHERE notify_status = 'failed';

-- ------------------------------------------------- 模块版本历史
CREATE TABLE IF NOT EXISTS module_version_history (
  id            TEXT PRIMARY KEY,
  module_id     TEXT REFERENCES modules(id) ON DELETE SET NULL,
  third_party_module_id TEXT REFERENCES third_party_modules(id) ON DELETE SET NULL,
  version       TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  content_sha   TEXT NOT NULL DEFAULT '',
  commit_sha    TEXT NOT NULL DEFAULT '',
  source_url    TEXT NOT NULL DEFAULT '',
  published_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reviewed_by   TEXT,
  review_task_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_mvh_module
  ON module_version_history(module_id, published_at DESC);

-- ------------------------------------------------- 检查日志
CREATE TABLE IF NOT EXISTS repository_check_logs (
  id                TEXT PRIMARY KEY,
  repository_id     TEXT NOT NULL REFERENCES third_party_repositories(id) ON DELETE CASCADE,
  detection_method  TEXT NOT NULL,
  check_status      TEXT NOT NULL,              -- ok | partial | failed
  new_modules_count     INTEGER NOT NULL DEFAULT 0,
  updated_modules_count INTEGER NOT NULL DEFAULT 0,
  deleted_modules_count INTEGER NOT NULL DEFAULT 0,
  unchanged_modules_count INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  files_scanned     INTEGER NOT NULL DEFAULT 0,
  branch            TEXT NOT NULL DEFAULT '',
  error_message     TEXT NOT NULL DEFAULT '',
  detail            TEXT NOT NULL DEFAULT '[]', -- JSON: per-file result list
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_rcl_repo
  ON repository_check_logs(repository_id, started_at DESC);

-- ------------------------------------------------- Webhook 事件
CREATE TABLE IF NOT EXISTS github_webhook_events (
  id                TEXT PRIMARY KEY,
  repository_id     TEXT REFERENCES third_party_repositories(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,              -- X-GitHub-Delivery
  event_type        TEXT NOT NULL,              -- push | ping | ...
  commit_sha        TEXT NOT NULL DEFAULT '',
  payload_summary   TEXT NOT NULL DEFAULT '',
  processing_status TEXT NOT NULL DEFAULT 'received', -- received | processed | duplicate | failed | ignored
  error_message     TEXT NOT NULL DEFAULT '',
  received_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  processed_at      TEXT
);

-- 事件去重：同一次投递（X-GitHub-Delivery）只处理一次
CREATE UNIQUE INDEX IF NOT EXISTS ux_gwe_event ON github_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS ix_gwe_repo
  ON github_webhook_events(repository_id, received_at DESC);

-- ------------------------------------------------- 审核操作日志
CREATE TABLE IF NOT EXISTS module_audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT,
  action        TEXT NOT NULL,
  operator      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'web',   -- web | telegram | system
  details       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_mal_task ON module_audit_logs(task_id, created_at DESC);

-- ------------------------------------------------- 默认设置
-- 全局自动检测默认每 6 小时（规格 4.7 的建议值），全部可在后台改。
INSERT INTO site_settings (key, value, value_type, scope) VALUES
  ('third_party.auto_enabled',        '1',   'boolean', 'admin'),
  ('third_party.default_interval',    '6',   'number',  'admin'),
  ('third_party.cron_expression',     '0 */6 * * *', 'string', 'admin'),
  ('third_party.max_repos_per_run',   '10',  'number',  'admin'),
  ('third_party.max_files_per_run',   '80',  'number',  'admin'),
  ('third_party.max_run_seconds',     '50',  'number',  'admin'),
  ('third_party.max_retries',         '2',   'number',  'admin'),
  ('third_party.notify_on_check',     '1',   'boolean', 'admin'),
  ('third_party.notify_new',          '1',   'boolean', 'admin'),
  ('third_party.notify_update',       '1',   'boolean', 'admin'),
  ('third_party.notify_delete',       '1',   'boolean', 'admin'),
  ('third_party.notify_failure',      '1',   'boolean', 'admin'),
  ('third_party.notify_reviewed',     '1',   'boolean', 'admin'),
  ('third_party.telegram_admin_id',   '',    'string',  'admin')
ON CONFLICT(key) DO NOTHING;
