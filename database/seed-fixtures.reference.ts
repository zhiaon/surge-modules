import type { Category, Module, ModuleVersion, Announcement } from '@/types';

/**
 * ⚠️ SAMPLE DATA — 单个演示模块。
 *
 * 这里**只有一个**用于验证界面结构的演示条目，不是真实模块集合。
 * 真实模块将在后续阶段通过 D1 + GitHub 同步接入（见 database/migrations）。
 * 除 `src/services/*` 外没有任何代码引用本文件。
 *
 * `rawUrl` 使用 RFC 2606 保留域名 example.com，仅作占位，不可安装。
 */

export const SAMPLE_CATEGORIES: Category[] = [
  {
    id: 'cat-adblock',
    name: '广告拦截',
    slug: 'adblock',
    description: '在请求层拦截网页与 App 内的广告、统计与追踪域名。',
    icon: 'shield',
    sortOrder: 1,
    isVisible: true,
  },
  {
    id: 'cat-rules',
    name: '规则与分流',
    slug: 'rules',
    description: '补充域名规则、策略组与更细粒度的分流判断。',
    icon: 'waypoints',
    sortOrder: 2,
    isVisible: true,
  },
  {
    id: 'cat-scripts',
    name: '脚本增强',
    slug: 'scripts',
    description: '定时任务、自动签到与基于 HTTP 的轻量自动化。',
    icon: 'code',
    sortOrder: 3,
    isVisible: true,
  },
  {
    id: 'cat-clean',
    name: '应用净化',
    slug: 'clean',
    description: '移除开屏广告、信息流推荐与多余的运营弹窗。',
    icon: 'eyeoff',
    sortOrder: 4,
    isVisible: true,
  },
  {
    id: 'cat-privacy',
    name: '隐私防护',
    slug: 'privacy',
    description: '阻断行为上报、设备指纹采集与第三方数据同步。',
    icon: 'sparkles',
    sortOrder: 5,
    isVisible: true,
  },
  {
    id: 'cat-tools',
    name: '网络工具',
    slug: 'tools',
    description: '面板、节点信息、连通性诊断与配置辅助组件。',
    icon: 'terminal',
    sortOrder: 6,
    isVisible: true,
  },
];

/** 占位原始链接：example.com 为文档保留域名，不指向任何真实文件。 */
const DEMO_RAW_URL = 'https://example.com/sgmodule/demo-module.sgmodule';

export const SAMPLE_MODULES: Module[] = [
  {
    id: 'mod-demo',
    slug: 'demo-module',
    name: '演示模块',
    description:
      '用于展示模块卡片、详情页、原始配置与版本记录结构的示例条目。内容为占位规则，不对应任何真实服务，也不建议安装。',
    author: 'demo',
    categoryId: 'cat-adblock',
    tags: ['示例', '占位', 'REJECT'],
    version: '1.2.0',
    updatedAt: '2026-11-08T10:00:00+08:00',
    rawUrl: DEMO_RAW_URL,
    repositoryUrl: undefined,
    isFeatured: true,
    isPublished: true,
  },
];

export const SAMPLE_VERSIONS: ModuleVersion[] = [
  {
    id: 'ver-demo-120',
    moduleId: 'mod-demo',
    version: '1.2.0',
    changelog: '补齐 URL Rewrite 与 MITM 段落，用来检查详情页代码块的长行换行表现。',
    releasedAt: '2026-11-08T10:00:00+08:00',
  },
  {
    id: 'ver-demo-110',
    moduleId: 'mod-demo',
    version: '1.1.0',
    changelog: '新增两组占位域名，验证规则列表在 6 条以内不会撑破卡片。',
    releasedAt: '2026-10-20T09:30:00+08:00',
  },
  {
    id: 'ver-demo-100',
    moduleId: 'mod-demo',
    version: '1.0.0',
    changelog: '首个演示版本，用于打通列表、详情与版本记录之间的导航。',
    releasedAt: '2026-10-02T15:00:00+08:00',
  },
];

export const SAMPLE_ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'ann-1',
    title: '平台进入第一阶段',
    body: '界面、设计系统与数据接口已就位。当前仅保留 1 个演示模块用于验证结构，真实模块将在接入仓库同步后导入。',
    publishedAt: '2026-11-08T10:00:00+08:00',
    pinned: true,
  },
  {
    id: 'ann-2',
    title: '收藏暂存于本地',
    body: '收藏保存在浏览器 localStorage 中，清除站点数据会一并清空；账号与云端同步将在后续阶段提供。',
    publishedAt: '2026-11-08T10:00:00+08:00',
    pinned: false,
  },
];

/** 演示用的 .sgmodule 原文，仅用于详情页代码块展示。 */
export const SAMPLE_RAW_CONFIG: Record<string, string> = {
  'demo-module': `#!name=演示模块
#!desc=仅用于界面展示的占位配置，不对应任何真实服务
#!author=demo
#!category=adblock
#!version=1.2.0

[Rule]
DOMAIN-SUFFIX,ads.example.com,REJECT
DOMAIN-SUFFIX,track.example.net,REJECT
DOMAIN,pagead.example.org,REJECT
DOMAIN-SUFFIX,metrics.example.edu,REJECT

[URL Rewrite]
^https?:\\/\\/api\\.example\\.com\\/v1\\/promo - reject

[MITM]
hostname = %APPEND% api.example.com, m.example.net`,
};

export const DEFAULT_RAW_CONFIG = `#!name=演示模块
#!desc=占位配置

[Rule]
DOMAIN-SUFFIX,example.com,REJECT

[MITM]
hostname = %APPEND% example.com`;
