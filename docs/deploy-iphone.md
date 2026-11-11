# 部署指南（iPhone 全程可操作）

本文件假设你**只有 iPhone**，没有任何电脑。

目标：

| 站点 | 域名 | 类型 |
| --- | --- | --- |
| 主站 + 管理后台 | `https://son.zhiaon.top` | Worker + Static Assets |
| 模块反代 | `https://sgmd.zhiaon.top` | 独立 Worker |

两者共用同一个 D1 数据库，但**是两个完全独立的 Worker**。

---

## 0. 前置检查

在开始前，确认你手上有：

- [ ] Cloudflare 账号（`ycccchi@gmail.com`）
- [ ] `zhiaon.top` 的 DNS 已托管在 Cloudflare
- [ ] GitHub 账号（`zhiaon`），`Modules` 仓库存在
- [ ] GitHub Token（已确认使用 Classic 全权限 token）

---

## 1. 创建 D1 数据库

### 方式 A：Cloudflare 控制台（推荐，iPhone 最简单）

1. 打开 https://dash.cloudflare.com
2. 左侧菜单 → **Workers & Pages** → **D1 SQL Database**
3. 点 **Create** → **Create database**
4. 名称填：`surge-modules`
5. 点 **Create**

创建后会看到 **Database ID**，长这样：

```
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**把这个 ID 记下来**（复制到备忘录），下一步要用。

> 不要用「Create from template」，那个会建表但结构和我们的 migration 冲突。

### 方式 B：命令行（如果你能在别处跑）

```bash
npx wrangler d1 create surge-modules
```

---

## 2. 执行数据库迁移

### 方式 A：控制台 SQL 编辑器

1. D1 → 点进 `surge-modules`
2. 上方标签切到 **Console**
3. 依次粘贴以下文件**全部内容**并点 **Execute**（按顺序！）：

```
database/migrations/0001_init.sql
database/migrations/0002_seed_reference.sql
database/migrations/0003_backend_schema.sql
database/migrations/0004_seed_settings.sql
database/migrations/0005_admin_and_review.sql
database/migrations/0006_phase6.sql
```

每执行完一个，执行下面的验证：

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

完成后应该有 **24 张表**：

```
admin_sessions  admins  announcements  audit_logs  backups
categories  module_overrides  module_proxy_mappings  module_tags
module_tombstones  module_versions  module_visits  modules
operation_logs  proxy_stats  rate_limits  review_items
site_settings  sources  sync_jobs  sync_logs  update_logs
sync_runs  sync_sources
```

> `sync_runs` 和 `sync_sources` 是第一阶段遗留的，保留不影响。

### 方式 B：GitHub Actions

部署 workflow 里勾选 `run_migrations`，它会跑 `wrangler d1 migrations apply`。

---

## 3. 填入 database_id

把 `workers/site/wrangler.toml` 和 `workers/module-proxy/wrangler.toml` 里的

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

替换成第 1 步拿到的真实 ID（两个文件都要改，值相同）。

**在 iPhone 上改文件的方法**：

1. GitHub App 或 Safari 打开仓库
2. 点进文件 → 右上角铅笔图标 → 编辑
3. 找到那一行，替换
4. 底部 **Commit changes**

---

## 4. 创建 Cloudflare API Token（给 GitHub Actions 用）

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Token**
3. 选 **Custom token** → **Get started**
4. 填写：
   - **Token name**：`surge-modules-deploy`
   - **Permissions**：
     - `Account` → `Workers Scripts` → **Edit**
     - `Account` → `D1` → **Edit**
     - `Zone` → `Workers Routes` → **Edit**
     - `Zone` → `DNS` → **Edit**（自定义域名需要）
   - **Account Resources**：Include → 你的账号
   - **Zone Resources**：Include → Specific zone → `zhiaon.top`
5. **Continue to summary** → **Create Token**
6. 复制那串 token（只显示一次）

同时记下 **Account ID**（在 Dashboard 右侧栏，或 URL 里的 32 位十六进制）。

---

## 5. 写入 GitHub Secrets

1. 打开 `github.com/zhiaon/<源码仓库>` → **Settings**
2. 左侧 **Secrets and variables** → **Actions**
3. **New repository secret**，添加两条：

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 第 4 步的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID |

---

## 6. 给反代 Worker 写 GitHub Token

这一步**不在 GitHub 里做**，直接写进 Cloudflare：

1. https://dash.cloudflare.com → **Workers & Pages**
2. 先完成第 7 步的首次部署，Worker 才会出现在列表
3. 点进 `surge-modules-proxy`
4. **Settings** → **Variables and Secrets**
5. **Add** → 类型选 **Secret**
6. Name: `GITHUB_READ_TOKEN`
7. Value: 你的 GitHub Token
8. **Save**

再给主站加一个：

1. 点进 `surge-modules-site` → **Settings** → **Variables and Secrets**
2. **Add** → **Secret**
3. Name: `RATE_LIMIT_SALT`
4. Value: 随便一串随机字符，比如 `a8f3k2m9x7q1w5e0r4t6y8u2i4o6p8`
5. **Save**

> 主站**不需要** GitHub Token。它只读 D1，不碰 GitHub。

---

## 7. 首次部署

### 方式 A：GitHub Actions（推荐）

1. 仓库 → **Actions** → 左侧 **Deploy**
2. 右侧 **Run workflow**
3. 选择：
   - `target`: `both`
   - `run_migrations`: 如果第 2 步已在控制台跑过，保持 `false`
4. **Run workflow**

等待约 2-3 分钟。看日志确认两个 Worker 都成功。

### 方式 B：控制台手动创建（Actions 失败时）

**主站**：

1. **Workers & Pages** → **Create** → **Worker**
2. 名称 `surge-modules-site`
3. 先随便部署一个 Hello World（之后会被覆盖）
4. 部署后在 **Settings** 里：
   - **Bindings** → Add → D1 Database → Variable name `DB` → 选 `surge-modules`
   - **Domains & Routes** → Add → Custom domain → `son.zhiaon.top`

**反代**：同上，名称 `surge-modules-proxy`，域名 `sgmd.zhiaon.top`。

手动方式只创建了骨架，**代码仍需 Actions 或命令行推送**。

---

## 8. 绑定域名

如果用了 `custom_domain = true`，Cloudflare 会自动创建 DNS 记录和证书。

手动检查：

1. 打开 `zhiaon.top` 的 **DNS** 页面
2. 应该看到两条记录：

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| AAAA/CNAME | `son` | 自动生成 | 🟠 Proxied |
| AAAA/CNAME | `sgmd` | 自动生成 | 🟠 Proxied |

3. 如果没有，手动加：
   - **Add record** → Type `CNAME` → Name `son` → Target `surge-modules-site.<account>.workers.dev` → **Proxied 开启**
   - 同样为 `sgmd` 指向 `surge-modules-proxy.<account>.workers.dev`

> 注意：`workers_dev = false` 只关闭 workers.dev 的**对外访问**，DNS 里的 CNAME 目标仍然有效，Cloudflare 内部会解析。

---

## 9. 验证

按顺序检查，任一项失败就停下排查：

```bash
# 1. 主站健康
curl https://son.zhiaon.top/api/v1/health
# 期望：{"ok":true,"data":{"status":"ok","env":"production","db":true}}

# 2. 公开 API
curl https://son.zhiaon.top/api/v1/categories
# 期望：6 个分类

# 3. 反代健康
curl https://sgmd.zhiaon.top/health
# 期望：ok

# 4. workers.dev 应已关闭
curl -I https://surge-modules-site.<account>.workers.dev/
# 期望：404 或 530，不是 200
```

用 Safari 打开：

- `https://son.zhiaon.top` → 首页正常
- `https://son.zhiaon.top/admin` → 出现「创建第一个管理员」
- `https://sgmd.zhiaon.top/dns-lite` → 返回模块原文

---

## 10. 创建管理员账号

1. 打开 `https://son.zhiaon.top/admin`
2. 如果显示「创建第一个管理员」，填用户名和密码（≥12 位）
3. 点「创建并登录」

> 这个入口只在数据库里没有管理员时出现。创建后立即关闭。

---

## 11. 导入你的模块

管理员登录后：

1. 后台 → **GitHub 数据源**
2. 点 **添加**
3. 填：
   - Owner: `zhiaon`
   - Repo: `Modules`
   - Branch: `main`
   - 允许目录：留空（仓库根）
4. **保存**
5. 点该数据源的 **验证** → 应显示「仓库与分支可访问」
6. 点 **同步**

同步完成后：

- 后台 → **审核中心** 会看到待审模块
- 逐个 **批准** → 模块公开 + 反代启用

---

## 12. 添加到 iPhone 主屏幕

1. Safari 打开 `https://son.zhiaon.top`
2. 底部 **分享** 按钮
3. 下滑找到 **添加到主屏幕**
4. 名称填 `Surge Modules`
5. **添加**

之后可以从主屏幕直接打开，全屏显示（无 Safari 地址栏）。

---

## 常见问题

### 部署后访问 522 / 521

DNS 还没生效或证书未签发。等 5-10 分钟。仍然不行就去 **SSL/TLS** 确认模式是 **Full** 而不是 **Flexible**。

### 页面能开但 API 500

D1 没绑定。检查 Worker → Settings → Bindings 里有没有 `DB`。

### 后台登录后立刻掉线

`Secure` Cookie 需要 HTTPS。如果你在 http 下测试，Cookie 会被丢弃。用正式域名访问。

### 反代返回「未配置读取凭据」

没在 Cloudflare 里设 `GITHUB_READ_TOKEN`。见第 6 步。

### 同步报「仓库或分支不存在」

Token 没有该仓库权限，或 owner/repo 拼错。先用「验证」按钮确认。

### workers.dev 仍然可访问

`workers_dev = false` 需要重新部署才生效。执行一次 `npm run deploy:site`。

如果控制台仍显示 workers.dev 地址，去 **Settings → Domains & Routes** 手动点 **Disable** 那个 workers.dev 条目。

---

## 回滚

### 代码回滚

1. Workers & Pages → 点进 Worker
2. **Deployments** 标签
3. 找到上一个正常版本 → 右侧 **⋯** → **Rollback**

### 数据回滚

后台 → **备份恢复** → 选一个备份 → **恢复**（需要输入 ID 确认）。
