# Surge Modules

一个独立的 **Surge 模块索引平台**：浏览、搜索、收藏、查看原始配置与版本记录。

> 本平台与 Surge 官方无隶属关系，不是官方产品，也不托管或修改任何模块内容。

当前进度：**第一阶段（项目初始化 / 设计系统 / 首页）已完成**。数据为示例数据，真实后端尚未接入。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端框架 | React 19 + TypeScript 5.9 |
| 构建 | Vite 7 |
| 样式 | Tailwind CSS 4（`@theme` 定义设计 token） |
| 动效 | 原生 CSS transition 为主，framer-motion 仅用于浮层 |
| 图标 | lucide-react |
| 路由 | react-router-dom 7（`createBrowserRouter`） |
| 字体 | `@fontsource-variable/inter`（本地打包，无外部 CDN） |
| 部署 | Cloudflare Workers + Static Assets |
| 数据（规划） | D1（结构化数据）/ KV（缓存与配置）/ R2（按需）/ Cron Triggers / Webhooks |

---

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 开发服务器（默认 http://localhost:5173）
npm run dev

# 3. 类型检查
npm run typecheck

# 4. 生产构建（先类型检查再打包）
npm run build

# 5. 预览构建产物（http://localhost:4173）
npm run preview
```

要求 Node ≥ 20。

> **备注（受限文件系统）**：若 `node_modules` 安装时报 `EPERM: symlink`，改用
> `npm install --no-bin-links`，并用 `node node_modules/vite/bin/vite.js ...` 代替 `npx vite`。
> `vite.config.ts` 已开启 `resolve.preserveSymlinks`，以兼容 `fs.realpath` 行为不规范的沙箱环境。

---

## 目录结构

```
surge-modules/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── common/        Button, IconButton, Badge, Divider, SectionHeading,
│   │   │                  Container, Card, SearchInput, ThemeToggle, Skeleton,
│   │   │                  EmptyState, Modal, BottomSheet
│   │   ├── layout/        RootLayout, SiteHeader, SiteFooter, MobileTabBar, ScrollToTop
│   │   ├── navigation/    Logo, SearchPanel
│   │   ├── motion/        Reveal
│   │   ├── modules/       ModuleCard, CategoryCard, FavoriteButton
│   │   └── feedback/      Toast, SampleDataNotice
│   ├── pages/
│   │   ├── Home/          HomePage + Hero / FeaturedSection / CategorySection /
│   │   │                  RecentUpdates / LibraryPreview+PlatformIntro
│   │   ├── Discover/      DiscoverPage
│   │   ├── Favorites/     FavoritesPage
│   │   ├── Updates/       UpdatesPage
│   │   ├── About/         AboutPage
│   │   ├── ModuleDetail/  ModuleDetailPage
│   │   ├── Admin/         AdminPage（占位）
│   │   └── NotFound.tsx
│   ├── hooks/             useTheme, useAsync, useDebouncedValue, useMediaQuery,
│   │                      useLockBodyScroll, usePageMeta, useEnter
│   ├── lib/               cn, format, icons, openSearch, motionPolicy
│   ├── services/          moduleService, categoryService, favoriteService,
│   │                      analyticsService, moduleQuery, sampleData
│   ├── stores/            favorites（localStorage）
│   ├── config/            site.ts（站点信息唯一来源）
│   ├── types/             index.ts（共享领域类型）
│   ├── styles/            index.css（设计 token + 基础样式 + 动效策略）
│   ├── router.tsx
│   └── main.tsx
├── workers/
│   ├── site/              主站 Worker（静态资源 + /api/v1）
│   └── module-proxy/      反代 Worker（/slug → 自有仓库文件）
├── packages/shared/       两个 Worker 共用契约与校验
├── tests/                 71 项测试 + Workers 运行时 shim
├── scripts/run-tests.mjs  测试运行器
├── database/migrations/   D1 迁移（0001–0004）
├── database/seed-dev.sql  仅本地使用的演示数据
├── docs/                  design-system.md / architecture.md / motion.md
├── wrangler.toml
├── vite.config.ts
└── package.json
```

同一层内部不重复定义结构；所有数据形状来自 `src/types/index.ts`。

---

## 第三阶段：移动端体验与视觉精修

### 修掉的真实问题

| 问题 | 位置 | 处理 |
| --- | --- | --- |
| 详情页在手机上必须滑到底才能安装/复制 | `ModuleDetailPage` | 新增移动端吸底操作栏（收藏 / 复制 / 安装），页面预留等高空间 |
| 操作栏与底部导航重叠 | `ModuleActionBar` / `MobileTabBar` | 引入 `--tabbar-h` token，操作栏定位在 `tabbar-h + safe-area + 8px` 之上 |
| 底栏高度、Toast、页脚各自写死 `pb-4.5rem/5rem` | 多处 | 统一走 `--tabbar-h` 与 `env(safe-area-inset-bottom)` |
| iOS 聚焦搜索框会强制放大页面 | `SearchInput` | `@media (pointer: coarse)` 下输入类元素字号 `max(16px, 1em)` |
| 浅色主题 `--color-faint` 仅 2.88:1，几乎读不清 | `index.css` | `#8B929B → #686F78`（4.66:1） |
| 浅色主题 `--color-accent-soft` 仅 2.85:1 | `index.css` | `#C78D55 → #8E5622`（5.99:1 on white） |
| 深色 `--color-accent-dim` 3.05:1，小号"精选"读不清 | `index.css` | `#7A5637 → #A67A4E`（5.23:1） |
| 浅色 `--color-accent` 4.30:1（大字号临界） | `index.css` | `#A4652F → #8F5A28`（5.26:1） |
| 浅色主题下遮罩仍是 62% 纯黑，像渲染错误 | `Modal` / `BottomSheet` / `SearchPanel` | 新增 `--color-scrim` token，浅色为 32% 暖黑 |
| 主按钮内高光写死白色 | `Button` | 改为 `color-mix(var(--color-canvas))`，随主题翻转 |
| 四处弹层阴影写死 `rgba(0,0,0,0.9)` | Modal / BottomSheet / Toast / SearchPanel | 收进 `--shadow-pop / -sheet / -toast / -raised`，浅色改用低透明度暖影 |
| 任一接口失败时区块直接空白或显示"没有结果" | 首页 4 个区块、发现/收藏/更新、详情 | 新增 `ErrorState`，逐区块独立失败 + 重试，不再把故障说成空数据 |
| 搜索面板声明 `aria-modal` 但 Tab 能走出去 | `SearchPanel` | 新增 `useFocusTrap`，Modal / BottomSheet 一并复用（Modal 内联实现已删除） |
| 搜索结果高亮项不被朗读 | `SearchPanel` | `aria-activedescendant` + `option` 的稳定 `id` |
| 一批 23–36px 的行内链接与 `size="sm"` 按钮 | 多处 | `.tap-target` 伪元素扩展到 44px；`@media (pointer: coarse)` 下 `.btn-sm` 最小 44px 高 |

### 验证方式

```bash
npm run typecheck   # tsc：src 全量 + workers 全量，0 error
npm run build       # tsc + vite build
npm run preview     # http://localhost:4173
```

浏览器实测（390×844 / 768×1024 / 1440×900 三视口，八条路由）：

- 横向溢出：全部 `scrollWidth - clientWidth = 0`
- 非预期不可见元素（`opacity:0` 且有高度）：全部为 0
- `main` 内有效点击区域 < 44×44：全部为 0（行内纯文字链接通过 `.tap-target` 伪元素满足）
- 详情页操作栏与底栏间距 7px，无重叠；操作栏内三个控件均为 44px 高
- 生产包：CSS 56.4 kB（gzip 11.1 kB）/ JS 545.8 kB（gzip 172.6 kB）

### 已知限制

- 浅色主题的 `--color-accent-dim` 对 canvas 为 4.45:1（略低于 4.5），仅用于非正文的小号强调，落在白卡上为 4.85:1。
- 深色 `--color-faint` 为 3.64:1，按设计只用于辅助说明，不承载唯一信息。
- `surge://` 安装链接只能在装有 Surge 的真机唤起，浏览器内无法验证实际跳转。
- 真机 iOS 的 `env(safe-area-inset-*)` 实际取值无法在桌面模拟器里复现，只能验证预留空间存在。

## 已实现功能

**首页**
- 编辑式 Hero（CSS 入场，不依赖动画时钟）、实时统计、搜索入口
- 精选推荐（`isFeatured` 驱动，首项大卡）
- 分类区（桌面 3×2 网格 / 移动全宽横滑轨道，数量由模块数据计算）
- 最近更新（表格式列表，含更新说明）
- 模块库预览 + 平台介绍
- 页脚（链接全部来自配置，未配置的显示为文字而非死链）

**全局**
- 顶部导航（滚动变色、当前页指示、搜索入口、主题切换、GitHub 入口）
- 移动端底部导航（5 项、Safe Area、44px 命中区、收藏徽标）
- 搜索面板（⌘K / `/` 打开、防抖、键盘上下 + Enter + Esc、空态）
- 主题：深色 / 浅色 / 跟随系统，持久化，首帧无闪烁
- 收藏：localStorage 持久化，卡片 / 详情 / 列表 / 徽标实时同步
- Toast 反馈、Skeleton 加载态、EmptyState 空态
- 无障碍：跳转主内容链接、焦点环、`aria-live` 结果计数、语义化标签、图标按钮均有名称

**其他页面**
- `/discover` 关键词 + 分类 + 标签 + 排序，条件写入 URL
- `/favorites` 收藏列表（含添加时间）
- `/updates` 平台公告 + 模块版本时间线
- `/about` 平台范围与路线图
- `/modules/:slug` 原始配置预览、复制原始链接 / 安装链接、`surge:///install-module` 唤起、版本记录
- `/admin` 明确标注未开放（不做假登录框）

---

## 数据来源

| 服务 | 来源 | 说明 |
| --- | --- | --- |
| `moduleService` | `/api/v1/modules*` | 后端不可达时抛 `BackendUnavailableError`，不退回假数据 |
| `categoryService` | `/api/v1/categories` | `moduleCount` 由 SQL COUNT 得出 |
| `favoriteService` | localStorage | 本地收藏，暂无云端同步 |
| `analyticsService` | 本地缓冲 | 尚未接通 `POST /api/v1/analytics` |

页面只要拿不到 API 就渲染错误态，**不会**用示例数据填充。这是刻意的：生产环境静默回退到假数据比报错更糟。

`src/services/sampleData.ts` 已退役为 `database/seed-fixtures.reference.ts`，不参与构建；演示数据只存在于 `database/seed-dev.sql`，仅用于本地。

不展示任何虚构的安装量、下载量、访问量或热度。

---

## 第四阶段：Cloudflare Workers 后端 + D1 + 双 Worker

### 结构

```
workers/site/            主站 Worker：静态资源 + /api/v1/*
workers/module-proxy/    反代 Worker：GET /<slug> → 自有 GitHub 仓库文件
packages/shared/         两个 Worker 共用的契约、HTTP 封装、查询校验、缓存键
database/migrations/     D1 迁移（0001–0004）
database/seed-dev.sql    仅本地使用的演示数据
tests/                   71 项测试（SQL 契约 / 安全单元 / Worker 端到端）
```

### 本地运行

这台机器（iSH）跑不了 workerd，所以有两条路径：

**A. 本机完整链路（推荐，无需 workerd）**

```bash
npm run dev:local        # 建库 + 迁移 + 种子，起 8787（站点+API）与 8788（反代）
```

打开 `http://localhost:8787` 即可，静态资源、SPA 回退、`/api/v1` 全部可用。
它直接 import 两个 Worker 的同一份源码，SQLite 代替 D1，内存 Map 代替 Cache API ——
不是另写一套逻辑，只是换运行时。

**B. 标准 Cloudflare 本地开发（需要能跑 workerd 的机器）**

```bash
npm run db:migrate:local   # 本地 D1 + 迁移
npm run db:seed:dev        # 可选：1 个演示模块
npm run dev                # Vite，仅界面（无 API）
npm run dev:site           # 主站 Worker，8787
npm run dev:proxy          # 反代 Worker，8788
```

> `npm run dev` 只起 Vite，没有 API。此时页面每个区块会显示"后端接口未启动"的错误态与修复指引 —— **不会**退回假数据。看到那句话，说明你开的是纯前端预览，用 `npm run dev:local` 或 `dev:site` 才有数据。

### 部署（需要真实 Cloudflare 账号，本阶段未执行）

```bash
npx wrangler d1 create surge-modules            # 把返回的 id 填进两个 wrangler.toml
npm run db:migrate:remote
npx wrangler secret put RATE_LIMIT_SALT  -c workers/site/wrangler.toml --env production
npx wrangler secret put GITHUB_READ_TOKEN -c workers/module-proxy/wrangler.toml --env production
npm run build
npm run deploy:site
npm run deploy:proxy
```

`GITHUB_READ_TOKEN` 必须是 Fine-grained PAT（或 GitHub App token），权限只给 `Contents: Read`，仓库范围只选自己拥有的仓库。

### 测试

```bash
npm test        # 三套：SQL 契约 14 + 安全单元 20 + Worker 端到端 37
```

覆盖：迁移可执行、公开查询不泄露 `upstream_url`/`source_*`/内部设置、分页上限、搜索转义 `%`、反代只放行登记模块、任意 URL/路径穿越/多段路径/查询串全部拒绝、禁用映射与禁用来源不发上游请求、404/403/429/超时/超大映射为固定错误、缓存命中与 hash 轮换、错误不缓存、Token 不出现在响应或上游 URL、统计白名单与限流。

### 为什么测试不跑 `wrangler dev`

本沙箱的 workerd 二进制加载失败（`__res_init` 符号缺失，musl 构建在 iSH 上跑不起来）。
替代方案：`tests/harness/workers-shim.ts` 提供真实 SQLite 支撑的 D1 接口、可注入的 `fetch`、内存版 Cache API，两个 Worker 的真实处理函数被完整调用。
**没验证到**：workerd 运行时本身、真实边缘缓存、真实 GitHub 请求 —— 需要在正常机器上跑 `wrangler dev` 复核。

详见 [`docs/backend.md`](docs/backend.md)。

---

## 第五阶段：管理后台 + GitHub 同步 + 反代管理

### 进入后台

**http://localhost:8787/admin**

首次打开会提示创建管理员（数据库中无管理员时）。创建后该入口关闭，没有内置默认密码。

> 本地预览已创建：用户名 `admin`，密码 `surge-modules-2026`（仅本地库）。

### 十二个分区

总览 · 模块管理 · 审核中心 · 精选推荐 · 分类管理 · GitHub 数据源 · 反代映射 · 同步任务 · 公告管理 · 统计分析 · 管理员 · 站点设置

### 关键机制

| 机制 | 说明 |
| --- | --- |
| 密码 | PBKDF2-SHA256 21 万次迭代，`pbkdf2$iterations$salt$hash` |
| 会话 | 只存 token 的 SHA-256；HttpOnly Cookie，12h，可撤销 |
| 锁定 | 5 次失败锁 15 分钟 |
| 权限 | 服务端 `PERMISSIONS` 表；editor 无法碰数据源/映射/设置/删除 |
| 字段覆盖 | 管理员编辑写入 `module_overrides`，同步不会覆盖 |
| tombstone | 删除/忽略后写入，同步永不复活 |
| 审核联动 | 批准 = 公开模块 + 启用反代；拒绝 = 双向关闭 |
| 反代删除 | 软删除 + 停用，旧 URL 立刻 404，不退化成开放代理 |

### 同步流程

```
加锁 → 列文件 → 逐个：tombstone 跳过 / 哈希未变跳过 / 更新(跳过已覆盖字段) / 新建(待审+映射停用) → 汇总
```

新模块默认不公开、待审核、反代停用。

### 测试

```bash
npm test    # 100 项：14 SQL + 20 安全 + 38 端到端 + 28 管理端
```

### 本地预览的边界

`scripts/serve.py` 复刻了认证与数据规则，但**不访问 GitHub**：同步与验证返回"本地预览不执行同步"，不假装成功。
真实同步需 `wrangler dev` 或部署后验证（本沙箱 workerd 无法启动）。

详见 [`docs/admin.md`](docs/admin.md)。

---

## 构建与类型检查

```bash
npm run typecheck   # tsc --noEmit，0 error 才算通过
npm run build       # tsc + vite build，产物在 dist/
```

当前状态：`typecheck` 通过，`build` 通过（JS ~550 kB / gzip ~175 kB，主要来自 React + framer-motion + 路由）。

---

## Cloudflare 部署方向

已经实现的：

- `workers/site/`：静态资源 + 8 个 `/api/v1` 端点，SPA 回退
- `workers/module-proxy/`：`GET /<slug>` 反代，白名单映射 + 缓存
- `database/migrations/`：4 个迁移，14 张表，含覆盖/墓碑/审计表
- `packages/shared/`：统一响应格式、查询校验、缓存键

部署步骤（Phase 2 起）：

```bash
npm i -D wrangler
npx wrangler login
npx wrangler d1 create surge-modules          # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply surge-modules --remote
npx wrangler kv namespace create CACHE
npx wrangler secret put GITHUB_TOKEN          # 只放服务端，绝不进仓库
npx wrangler secret put WEBHOOK_SECRET
npm run build && npx wrangler deploy
```

后续阶段才会启用的能力：Cron Trigger（定时同步）、GitHub Webhook 接收、D1 读取 API、KV 缓存、R2 文件存储。

---

## 下一阶段

1. D1 实际建库并导入真实模块；`moduleService` 改为调用 Worker API（页面代码不动）。
2. Worker 实现 `GET /api/modules`、`/api/categories`、`/api/stats`、`/api/announcements`，带 KV 缓存与 ETag。
3. GitHub 多仓库同步：`sync_sources` 配置、Cron 拉取、`content_hash` 去重、`sync_runs` 记录。
4. Webhook 接收仓库 push，触发增量同步（HMAC 校验）。
5. 管理员后台：Cloudflare Access 保护 `/admin`、精选标记、分类与公告维护。
6. 账号体系与云端收藏同步（在本地收藏结构之上扩展，不重写）。
7. 清理：接入真实数据后移除 `sampleData.ts` 与示例数据提示。

---

## 文档

- [`docs/design-system.md`](docs/design-system.md) —— 颜色、字体、间距、组件契约、响应式
- [`docs/architecture.md`](docs/architecture.md) —— 分层、服务契约、路由、部署
- [`docs/motion.md`](docs/motion.md) —— 动效实现与"文档隐藏时动画时钟冻结"的坑

## 许可

私有项目，未授权分发。
