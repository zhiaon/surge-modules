# 后端架构（第四阶段）

## 1. 拓扑

```
                        ┌──────────────────────────────┐
  iPhone / Surge  ─────▶│  raw.example.com             │  模块反代 Worker
                        │  workers/module-proxy        │  只做一件事：
                        │  GET /<slug>                 │  slug → GitHub 文件
                        └───────────┬──────────────────┘
                                    │ 只读两条查询
                                    ▼
                        ┌──────────────────────────────┐
                        │  D1  surge-modules           │
                        │  sources / modules /         │
                        │  module_proxy_mappings ...   │
                        └───────────▲──────────────────┘
                                    │ 读 + 统计写入
                        ┌───────────┴──────────────────┐
  浏览器  ────────────▶ │  site.example.com            │  主站 Worker
                        │  workers/site                │  /api/v1/*  → API
                        │  [assets] → ./dist           │  其它路径   → 静态资源
                        └──────────────────────────────┘
```

两个 Worker 独立部署、独立配置、独立 secret，仅共享一个 D1 数据库。
主站不包含任何反代逻辑，反代不包含任何页面逻辑。

## 2. Worker 职责

| Worker | 名称 | 入口 | 绑定 | Secrets |
| --- | --- | --- | --- | --- |
| 主站 | `surge-modules-site` | `workers/site/index.ts` | `ASSETS`（静态资源）、`DB`（D1） | `RATE_LIMIT_SALT` |
| 反代 | `surge-modules-proxy` | `workers/module-proxy/index.ts` | `DB`（D1，只读用途） | `GITHUB_READ_TOKEN` |

`RATE_LIMIT_SALT` 只用于把客户端地址哈希成限流桶键；即使泄露也无法逆推地址，但它不该公开。
`GITHUB_READ_TOKEN` 是 Fine-grained PAT 或 GitHub App token，权限仅 `Contents: Read`，仓库范围仅限自己拥有的仓库。

## 3. 路由

### 主站 API（`/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 只返回 `status/env/db` 三个粗粒度字段 |
| GET | `/modules` | 列表：`page` `perPage` `q` `category` `tag` `featured` `sort` |
| GET | `/modules/:slug` | 详情，含最近 50 个版本 |
| GET | `/modules/:slug/versions` | 版本列表，`limit` ≤ 50 |
| GET | `/categories` | 分类 + 真实模块计数 |
| GET | `/announcements` | 已发布公告，置顶优先 |
| GET | `/settings` | 仅 `scope='public'` 的设置 |
| POST | `/analytics` | 匿名事件上报，白名单 + 限流 |

非 `/api/*` 的路径全部交给 `ASSETS`；SPA 回退由 `not_found_handling = "single-page-application"` 提供，刷新详情页不会 404。

### 反代（独立域名）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/<slug>` | 返回该模块的 `.sgmodule` 原文 |
| GET | `/` `/health` | 极简文本，不含版本信息 |

只有一种路由形状。带查询串、多段路径、非 slug 字符一律 400，且在访问数据库之前就被拒绝。

## 4. D1 表结构

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `sources` | 自有 GitHub 仓库白名单 | `(owner,repo,branch)` 唯一（仅未删除行），`allow_paths` 限定可读目录 |
| `modules` | 模块主表 | `slug` 唯一（仅未删除行），`source_id` 外键 |
| `module_tags` | 标签 | `(module_id, tag)` 主键 |
| `module_versions` | 版本与变更 | `(module_id, version)` 唯一，含 `content_hash` / `commit_sha` |
| `categories` | 分类 | `slug` 唯一（仅未删除行） |
| `module_proxy_mappings` | slug → 仓库/分支/路径 | `public_slug` 唯一，`source_id` 外键 `ON DELETE RESTRICT` |
| `announcements` | 公告 | `level` `is_pinned` `is_published` |
| `site_settings` | 设置 | `scope` 区分 `public` / `internal` |
| `analytics_events` | 匿名计数 | 无 IP / UA / cookie 字段 |
| `sync_jobs` / `sync_logs` | 同步任务与日志 | 计数列 `scanned/added/updated/skipped/failed` |
| `audit_logs` | 管理操作审计 | 只记 actor 标签，不记凭证 |
| `module_overrides` | 字段级人工覆盖 | `(module_id, field)` 主键 |
| `module_tombstones` | 忽略/删除记录 | `(source_id, source_path)` 唯一，防同步复活 |
| `rate_limits` | 限流计数 | `(bucket, window)` 主键 |

字段优先级：`module_overrides` > 同步写入的 `modules` 列 > 解析默认值。
同步任务只写"同步列"，覆盖值在 API 读取时应用，所以任何一次同步都不会冲掉人工修改。

软删除统一用 `deleted_at`；所有公开查询都带 `deleted_at IS NULL AND is_published = 1`。

## 5. 反代安全模型

不用"过滤危险输入"，而是让危险输入没有入口：

1. 路由只接受一个裸 slug，正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
2. 查询串一律拒绝——`?ref=`、`?url=`、`?path=` 全部 400，杜绝滑向通用代理。
3. `owner/repo/branch/path` **只**来自 D1 的 `module_proxy_mappings` + `sources`，请求无法提供。
4. `JOIN sources` 且 `is_enabled = 1`，任一环节禁用即 404，且不会发起上游请求。
5. `file_path` 再校验：禁止绝对路径、`..`、反斜杠、协议前缀、控制字符。
6. `allow_paths` 前缀校验，防止越出登记目录。
7. 上游用 GitHub Contents API + `application/vnd.github.raw`；私密仓库的匿名 raw 链接不可用，因此不使用。
8. 响应固定 `text/plain; charset=utf-8` + `nosniff` + `default-src 'none'; sandbox`，模块内容不可能被当成 HTML 执行。
9. 401/403/429/超时/超大 全部映射为固定错误码，文案不含仓库名、堆栈或凭证。
10. 未知 slug、禁用映射、禁用来源统一 404，不可区分——避免探测仓库是否存在。

## 6. 缓存

- 键：`<origin>/__cache/module/<slug>/raw/<revision>`，`revision` 取 `content_hash`。
- slug 与 revision 都是**校验**而非清洗：不符合正则就退化为 `invalid` / `unversioned`，不会产生 `..` 形状的键。
- 只有 200 可缓存（默认 300s，`stale-while-revalidate=60`）；4xx/5xx 一律 `no-store`。
- 内容变化时 `content_hash` 跟着变 → 键变化 → 天然失效，无需主动清缓存。
- 缓存里不含 token、不含上游 URL、不含内部路径。
- 说明：Cloudflare 的 Cache API 是数据中心本地缓存，**不保证全球同步**；命中率取决于访问分布，这是设计接受的。

## 7. 匿名统计

- 白名单 5 个事件：`page_view` `module_view` `install_click` `copy_click` `search`。
- 单次请求最多 10 条事件，body ≤ 1KB，`subject` ≤ 120 字符且只允许 `[a-zA-Z0-9/_.-]`。
- 按 `hash(salt:clientIP:window)` 做固定窗口限流，60 次/分钟；原始地址**不入库**。
- 记录的是"安装入口点击"，**不是**安装成功——安装发生在 Surge 内部，浏览器无法得知。

## 8. 环境隔离

| 环境 | 命令 | D1 | Secrets |
| --- | --- | --- | --- |
| 本地 | `npm run dev:site` / `npm run dev:proxy` | `.wrangler/state` 本地库 | `.dev.vars` |
| 预览 | `--env preview` | 独立 preview 库（需自行创建） | 独立 |
| 生产 | `--env production` | 生产库 | `wrangler secret put` |

本地库与线上库物理隔离；`.dev.vars` 在 `.gitignore` 内。

## 9. 已知限制

1. **本沙箱无法运行 workerd**：`@cloudflare/workerd-linux-arm64` 依赖 musl 的 `__res_init`，iSH 的 libc 不导出该符号。因此：
   - D1 迁移用 `sqlite3` 验证（同一份 SQL）；
   - Worker 行为用 `tests/harness/workers-shim.ts`（真实 SQLite + 可注入 fetch + 内存 Cache API）端到端验证；
   - **未验证**：workerd 自身的运行时行为、真实边缘缓存、真实 GitHub 调用。这些需要在正常机器上跑 `wrangler dev`。
2. `routes` / `database_id` 在配置里是占位值，部署前必须替换，否则 `wrangler deploy` 会失败（这是刻意的，避免误发到错误资源）。
3. 同步任务与后台管理界面属于第五阶段，本阶段只建表、建索引、留下 `sync_jobs` 状态字段。
4. 模块内容不做任何改写，按原文返回；`serve_mode` 字段预留了 `transform` 但未实现。
