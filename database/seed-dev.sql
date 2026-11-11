-- database/seed-dev.sql
-- LOCAL DEVELOPMENT ONLY.
--
-- Inserts one demo module whose content lives in a repository you control.
-- Never run this against production: it would publish a placeholder module.
--
-- Usage:
--   npm run db:seed:dev
--
-- Replace the owner/repo/branch and file_path with your own before the proxy
-- can actually serve anything.

-- A source row is required before any mapping can exist.
INSERT OR IGNORE INTO sources (id, owner, repo, branch, allow_paths, sync_mode, is_enabled, notes)
VALUES (
  'src-demo',
  'your-github-user',
  'your-modules-repo',
  'main',
  'modules/',
  'manual',
  0,                        -- stays disabled until you edit it by hand
  'Local demo source. Enable after configuring GITHUB_READ_TOKEN.'
);

INSERT OR IGNORE INTO modules (
  id, slug, name, description, author, category_id, version,
  source_id, source_path, upstream_url, repository_url,
  is_featured, is_published, published_at, synced_at
) VALUES (
  'mod-demo',
  'demo-module',
  '演示模块',
  '用于本地验证界面与反代链路的示例条目。内容为占位规则，不对应任何真实服务。',
  'Surge Modules',
  'cat-adblock',
  '1.2.0',
  'src-demo',
  'modules/demo-module.sgmodule',
  'https://raw.githubusercontent.com/your-github-user/your-modules-repo/main/modules/demo-module.sgmodule',
  NULL,
  1,
  1,
  '2026-11-08T10:00:00Z',
  '2026-11-08T10:00:00Z'
);

INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES
  ('mod-demo', '示例'),
  ('mod-demo', '占位');

INSERT OR IGNORE INTO module_versions (id, module_id, version, changelog, released_at)
VALUES
  ('ver-demo-120', 'mod-demo', '1.2.0', '补齐 URL Rewrite 与 MITM 段落，用于检查代码块换行。', '2026-11-08T10:00:00Z'),
  ('ver-demo-110', 'mod-demo', '1.1.0', '新增两组占位域名。', '2026-10-20T09:30:00Z'),
  ('ver-demo-100', 'mod-demo', '1.0.0', '首个演示版本。', '2026-10-02T15:00:00Z');

INSERT OR IGNORE INTO module_proxy_mappings (
  id, module_id, public_slug, source_id, file_path, serve_mode, is_enabled, content_hash
) VALUES (
  'map-demo',
  'mod-demo',
  'demo-module',
  'src-demo',
  'modules/demo-module.sgmodule',
  'raw',
  1,
  'seed-v1'
);

INSERT OR IGNORE INTO announcements (id, title, body, level, is_pinned, is_published, published_at)
VALUES
  ('ann-dev-1', '本地开发数据', '当前数据来自 database/seed-dev.sql，仅用于本地验证。', 'info', 1, 1, '2026-11-08T10:00:00Z');

-- Point public links at the local proxy so copy/install can be exercised offline.
UPDATE site_settings SET value = 'http://localhost:8788', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE key = 'proxy.public_base';
