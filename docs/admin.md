# 第五阶段：管理后台、同步与反代管理

## 1. 后台入口与登录

```
/admin              登录、首次初始化、或进入后台
```

只有 `/admin` 一个路由，登录后原地切换到面板 —— 不做 `/admin/login` 这类可被枚举的子路由。

### 首次初始化

数据库里没有管理员时，`POST /api/v1/admin/bootstrap` 会开放，允许创建一个 `super` 账号。
一旦存在管理员，该接口返回 403，无法再通过它提权。

**没有内置默认密码。** 代码里不存在任何硬编码凭据。

### 认证

| 项 | 实现 |
| --- | --- |
| 密码存储 | `pbkdf2$210000$<salt-b64>$<hash-b64>`，PBKDF2-SHA256 |
| 会话令牌 | 32 字节随机数，数据库只存其 SHA-256 |
| Cookie | `sm_admin`，HttpOnly、SameSite=Lax、12 小时、生产环境加 Secure |
| 暴力破解 | 5 次失败锁定 15 分钟（`admins.locked_until`） |
| 账号枚举 | 登录失败对"用户不存在"与"密码错误"返回完全相同的响应 |
| 会话撤销 | `admin_sessions.revoked_at`，退出登录立即写入 |
| 过期 | 每次请求比对 `expires_at`，过期即 401 |

## 2. 权限矩阵

服务端 `workers/site/auth.ts` 的 `PERMISSIONS` 表是唯一事实来源：

| 操作 | super | editor |
| --- | :---: | :---: |
| 编辑/发布模块 | ✓ | ✓ |
| 审核通过/拒绝 | ✓ | ✓ |
| 删除模块 | ✓ | — |
| 分类与公告 | ✓ | ✓ |
| GitHub 数据源 | ✓ | — |
| 反代映射 | ✓ | — |
| 执行同步 | ✓ | — |
| 站点设置 | ✓ | — |
| 管理员管理 | ✓ | — |

前端只是隐藏导航项；直接调用接口同样返回 403（有测试覆盖）。

## 3. 后台分区

| 分区 | 功能 |
| --- | --- |
| 总览 | 模块/数据源/映射计数、最近同步、7 天事件与反代命中 |
| 模块管理 | 搜索、筛选、编辑、公开/隐藏、精选、软删除 |
| 审核中心 | 待审列表、批准（公开 + 启用反代）、拒绝 |
| 精选推荐 | 当前精选，一键取消 |
| 分类管理 | 列表、新建 |
| GitHub 数据源 | 添加、验证可达性、启用/停用、手动同步 |
| 反代映射 | 启用/停用、TTL、刷新缓存、复制链接、删除 |
| 同步任务 | 任务列表、计数、逐文件日志 |
| 公告管理 | 发布、级别、置顶 |
| 统计分析 | 30 天事件与反代每日命中/未命中/错误 |
| 管理员 | 当前账号与权限矩阵 |
| 站点设置 | 公开设置可编辑，内部设置只读展示 |

## 4. GitHub 同步

`workers/site/sync.ts`。

### 流程

```
加锁（sources.sync_lock，10 分钟 TTL）
  → 列出 .sgmodule 文件（树 API，只读 allow_paths 内）
  → 对每个文件：
       tombstone？→ 跳过
       取内容 → SHA-256
       哈希未变？→ unchanged，不写任何行
       已存在？→ 只更新未被 override 的字段 + 写新版本行
       新文件？→ 建模块（未发布 + pending）、建映射（停用）、入审核队列
  → 汇总计数写 sync_jobs
  → 解锁
```

### 幂等与安全

| 要求 | 实现 |
| --- | --- |
| 幂等 | 以 `(source_id, source_path)` 定位；哈希相同即跳过 |
| 并发安全 | `sync_lock` 条件更新；拿不到锁返回 `skipped` 而不是并行跑 |
| 单文件失败不中断 | 每个文件独立 try，失败计数 + 写 `sync_logs` |
| 管理员覆盖优先 | 读取 `module_overrides`，有覆盖的字段不写 |
| tombstone 阻止复活 | 命中 `module_tombstones` 直接跳过 |
| 路径安全 | owner/repo/branch 走 `[\w.-]{1,100}`；path 禁绝对路径、`..`、反斜杠、协议前缀 |
| 大小上限 | 单文件 256 KB，单批 500 文件 |
| 内容不可信 | 只做逐行正则解析 `#!key=value`，不 eval、不渲染 HTML |

### 新模块的默认状态

`is_published = 0`、`review_status = 'pending'`、映射 `is_enabled = 0`。
审核通过时两者同时变更 —— 这是"隐藏模块不能通过 raw 子域名访问"的实现点。

## 5. 反代管理

映射页控制独立 Worker 能服务什么。

| 操作 | 效果 |
| --- | --- |
| 启用 | `is_enabled = 1` |
| 停用 | `is_enabled = 0` + 模块 `is_published = 0`（避免站内出现装不上的链接） |
| 刷新缓存 | 换 `content_hash` → 反代缓存键变化 → 下次请求回源 |
| 删除 | 软删除 + 停用；旧 URL 立刻 404，且不会退化成任意代理 |

公开链接形如 `https://raw.example.com/<slug>`，域名来自 `site_settings.proxy.public_base`。

**必须理解的一点**：如果反代 URL 对公众开放，那么拿到链接的任何人都能读取该模块内容。GitHub 仓库是私有的**不代表**反代内容是私密的。需要访问控制时应另做签名 URL，而不是依赖仓库可见性。

## 6. 缓存与统计

反代缓存键 = `<origin>/__cache/module/<slug>/raw/<content_hash>`。

- 同步检测到哈希变化 → 新版本行 + 映射 `content_hash` 更新 → 键变化 → 自然失效
- 后台「刷新缓存」直接换 revision，不必等下一次同步
- 只有 200 可缓存；4xx/5xx 一律 `no-store`

`proxy_stats` 按 `(day, slug)` 聚合命中/未命中/错误/字节，后台只显示真实聚合值，没有请求就是 0。

统计事件白名单：`page_view` `module_view` `install_click` `copy_click` `search`。
**`install_click` 只表示点击了安装入口**，浏览器无法得知 Surge 内是否安装成功，所以系统里不存在"安装成功次数"这个指标。

## 7. D1 变更（0005）

| 表/列 | 用途 |
| --- | --- |
| `admins` | 管理员，PBKDF2 哈希、锁定计数 |
| `admin_sessions` | 会话，只存 token 的 SHA-256 |
| `review_items` | 审核队列，含 proposed/baseline 快照 |
| `proxy_stats` | 反代每日聚合 |
| `module_proxy_mappings` +4 列 | `ttl_seconds` `last_fetched_at` `last_status` `last_error` |
| `sources` +2 列 | `sync_lock` `sync_lock_at` |
| `modules` +2 列 | `review_status` `sort_weight` |

## 8. 测试

`npm test` 共 100 项：

| 套件 | 数量 | 覆盖 |
| --- | ---: | --- |
| SQL 契约 | 14 | 迁移可执行、约束、软删除、计数 |
| 安全单元 | 20 | slug/路径校验、缓存键、查询钳制、事件白名单 |
| Worker 端到端 | 38 | 公开 API、反代白名单、上游故障映射、缓存轮换 |
| 管理端 | 28 | 未登录拦截、角色权限、密码哈希、锁定、会话撤销、override、tombstone、token 不外泄 |

管理端测试里几条关键断言：

- 未登录访问 7 个管理端点全部 401
- editor 创建数据源 / 写设置 / 删模块全部 403，但能编辑模块
- 数据库里只有 `pbkdf2$...`，不存在明文密码
- 会话表只存 44 字符 base64 摘要，不等于 cookie 原值
- 隐藏模块同时把映射置为停用，且公开 API 立刻 404
- 审计日志与所有响应体都不含 token

## 9. 本地预览的限制

预览服务 `scripts/serve.py` 复刻了同一套认证与数据规则，但**不访问 GitHub**：同步与验证会明确返回"本地预览不执行同步"，而不是假装成功。

真实的同步行为需要通过 `wrangler dev` 或部署后验证 —— 本沙箱的 workerd 无法启动（`__res_init` 缺失）。

## 10. 未完成 / 需人工确认

1. **实时同步 e2e 未在 workerd 下验证**：锁、分页、GitHub 限流退避的逻辑有单元级覆盖，但完整链路需在能跑 workerd 的机器上确认。
2. **Cron 与 Webhook 未接**：`sync_jobs.trigger` 已支持 `cron` / `webhook` 字段，入口与 HMAC 校验留到部署阶段（需要真实 secret）。
3. **管理员增删入口**：没有做"创建管理员"表单，刻意的 —— 避免后台出现凭空提权入口。新增账号需写 D1，密码用同格式哈希。
4. **模块字段覆盖的可视化差异**：当前显示"有 N 个覆盖字段"，未做逐字段 diff 视图。
5. **CSP / HSTS**：属于部署配置，未写入 `wrangler.toml`。
