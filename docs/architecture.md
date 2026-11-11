# 架构说明

## 分层

```
pages/          路由级组件，只负责组装与页面元信息
components/     展示组件（common / layout / navigation / modules / motion / feedback）
hooks/          可复用的浏览器能力封装（主题、媒体查询、异步、滚动锁、入场）
services/       数据访问层 —— 页面唯一的取数入口
stores/         本地状态（当前只有收藏）
lib/            纯函数与常量（格式化、图标注册表、cn、动效策略）
config/         站点配置（唯一事实来源）
types/          跨层共享的类型定义
```

依赖方向是单向的：`pages → components → lib`，`pages → services → stores → lib`。
组件**不**直接引用 `services`（只有页面和容器负责取数），服务**不**引用组件。

## 数据访问

| 服务 | 方法 | 现状 |
| --- | --- | --- |
| `moduleService` | `getModules` / `getFeaturedModules` / `getRecentlyUpdated` / `getModuleStats` / `getModuleBySlug` / `getRawConfig` / `getVersions` / `getAnnouncements` | Mock |
| `categoryService` | `getCategories` / `getCategoryBySlug` | Mock |
| `favoriteService` | `getFavorites` / `addFavorite` / `removeFavorite` / `isFavorite` / `count` | 本地 |
| `analyticsService` | `trackPageView` / `trackModuleView` / `trackInstallClick` / `trackCopyClick` / `trackSearch` / `trackFavorite` | Mock（内存环形缓冲） |
| `moduleQuery` | `apply` / `search` | 纯函数，可复用 |

所有 Mock 都实现了**与未来 API 相同的签名**，返回值形状一致（`ListResult<T>` / `Promise<T>`）。切换到 D1 时只改 `services/*` 的实现，页面代码不动。

每个 Mock 模块导出显式标记：`MODULE_SERVICE_IS_MOCK`、`FAVORITE_SERVICE_IS_LOCAL`、`ANALYTICS_SERVICE_IS_MOCK`，同时 `siteConfig.usesSampleData` 控制页面上"示例数据"提示的显示。

## 收藏

`stores/favorites.ts` 用 `useSyncExternalStore` + `localStorage` 实现：

- key：`surge-modules:favorites:v1`
- 结构：`{ moduleId, addedAt }[]`（与未来账号体系内的收藏记录同形）
- 所有卡片、详情页、收藏页、底部导航徽标共享同一份快照，跨标签页通过 `storage` 事件并非必需（同标签内即时同步；跨标签刷新后一致）
- 读取时对损坏数据做容错（非数组、缺字段、JSON 错误 → 视为空）

`favoriteService` 在其上包装异步接口，方便未来替换为云端实现（届时加乐观更新 + 冲突合并）。

## 搜索

两条路径，共用 `moduleQuery` 的打分逻辑：

- 全局面板（`SearchPanel`）：`⌘K` / `/` 打开，输入防抖 120ms，键盘 ↑↓ 选择、Enter 打开、Esc 关闭，最多展示 7 条 + 总数。
- 发现页（`DiscoverPage`）：筛选条件写入 URL（`q` / `category` / `tag` / `sort`），可直接分享与后退。

打分：名称 6、标签 4、作者 3、分类 2、描述 1；多关键词为 AND 语义。排序 `recommended` 时按分数，其余按字段。

## 路由

`createBrowserRouter`，`RootLayout` 承载导航、页脚、底部 tab、搜索面板与滚动复位。

| 路径 | 状态 |
| --- | --- |
| `/` | 完整实现 |
| `/discover` | 完整实现（筛选/排序/空态） |
| `/favorites` | 完整实现（本地收藏） |
| `/updates` | 完整实现（公告 + 模块版本时间线） |
| `/about` | 完整实现（范围说明与路线图） |
| `/modules/:slug` | 完整实现（原始配置、复制、安装链接、版本记录） |
| `/admin` | 占位，明确说明无认证实现 |
| `*` | 404 |

SPA 回退由 Workers 的 `not_found_handling = "single-page-application"` 提供。

## 部署

```
浏览器 ──▶ Cloudflare Worker (surge-modules)
              ├─ /api/*    → Worker 代码（当前仅 /api/health 可用，其余 501）
              └─ 其它路径  → ASSETS 绑定（./dist 静态文件）
```

- 前端与 API 同一域名，无 CORS。
- `run_worker_first = ["/api/*"]`：只有 API 走 Worker 代码，静态资源零额外延迟。
- D1 / KV / R2 绑定在 `wrangler.toml` 中预留（注释状态），Phase 2 创建资源后启用。
- 密钥只通过 `wrangler secret put` 注入：`GITHUB_TOKEN`、`WEBHOOK_SECRET`。

## 为什么不是 Pages

Workers + Static Assets 与 Pages 都能满足要求，选择前者是因为：单一部署单元、`run_worker_first` 精确控制路由、Cron Triggers 与 D1 绑定在同一份配置里，后续接 Webhook 不需要再加一层 Functions 目录约定。

## 目录约定

- 一个文件一个导出主体（页面、组件、服务各一个），便于按需查阅。
- 样式 token 只在 `styles/index.css` 定义，组件内不出现裸色值。
- 新增数据类型先加到 `types/index.ts`，不允许在页面里重复定义结构。
