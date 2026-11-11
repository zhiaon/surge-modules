-- 0004_seed_settings.sql
-- Public site settings + default categories.
--
-- Module rows are intentionally NOT seeded: the public site must not ship fake
-- catalogue entries. Use the demo fixture only in local development
-- (`database/seed-dev.sql`).

INSERT OR IGNORE INTO site_settings (key, value, value_type, scope) VALUES
  ('site.name',              'Surge Modules',  'string',  'public'),
  ('site.tagline',           '让 Surge 模块发现更简单。', 'string', 'public'),
  ('site.description',       '一个独立的 Surge 模块索引平台：浏览、搜索、收藏与分发模块。', 'string', 'public'),
  ('site.locale',            'zh-CN',          'string',  'public'),
  ('site.version',           '0.1.0',          'string',  'public'),
  ('modules.per_page_default', '20',           'number',  'public'),
  ('modules.per_page_max',   '60',             'number',  'public'),
  ('proxy.public_base',      '',               'string',  'public'),
  -- internal settings are never returned by /api/v1/settings
  ('proxy.cache_ttl_seconds', '300',           'number',  'internal'),
  ('proxy.max_bytes',         '262144',        'number',  'internal'),
  ('analytics.enabled',       '1',             'boolean', 'internal');

INSERT OR IGNORE INTO categories (id, name, slug, description, icon, sort_order, is_visible) VALUES
  ('cat-adblock', '广告拦截',  'adblock', '在请求层拦截网页与 App 内的广告、统计与追踪域名。', 'shield',    1, 1),
  ('cat-rules',   '规则与分流', 'rules',   '补充域名规则、策略组与更细粒度的分流判断。',       'waypoints', 2, 1),
  ('cat-scripts', '脚本增强',  'scripts', '定时任务、自动签到与基于 HTTP 的轻量自动化。',     'code',      3, 1),
  ('cat-clean',   '应用净化',  'clean',   '移除开屏广告、信息流推荐与多余的运营弹窗。',       'eyeoff',    4, 1),
  ('cat-privacy', '隐私防护',  'privacy', '阻断行为上报、设备指纹采集与第三方数据同步。',     'sparkles',  5, 1),
  ('cat-tools',   '网络工具',  'tools',   '面板、节点信息、连通性诊断与配置辅助组件。',       'terminal',  6, 1);
