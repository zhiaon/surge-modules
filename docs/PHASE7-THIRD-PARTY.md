# 第七阶段 · 第三方 GitHub 仓库接入

三种检测方式（Webhook / 手动 / Cron）共用一套引擎，全部产物先进入审核队列，
管理员通过后才写入正式模块表。

```
检测变化 → 识别模块 → 获取内容 → 比较版本 → 创建审核任务
        → Telegram 通知 → 管理员审核 → 正式发布
```

## 一、当前的线上配置

| 项 | 值 |
|---|---|
| 管理后台 | https://son.zhiaon.top/admin |
| 后台账号 | `admin`（密码见密码管理器） |
| Telegram Bot | `@MD_Review_Bot` |
| 已接入仓库 | `zhiaon/Modules`（私有） |

已配置的 Worker Secrets：

| 名称 | 用途 |
|---|---|
| `GITHUB_READ_TOKEN` | 读取仓库与文件（私有仓库必需） |
| `WEBHOOK_SECRET_KEY` | 加密每个仓库的 Webhook Secret（AES-GCM 密钥） |
| `TELEGRAM_BOT_TOKEN` | Bot 发送通知 |
| `TELEGRAM_ADMIN_ID` | 允许在 Telegram 内审核的数字用户 ID |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram 回传校验串（只能含 `A-Za-z0-9_-`） |

## 二、添加第一个第三方仓库

后台 → **第三方仓库** → 添加仓库：

1. 填 `https://github.com/owner/repo` 或直接 `owner/repo`
2. 点「识别」确认解析结果
3. 默认分支留空会自动从 GitHub 读取
4. 选择检测方式（三种可同时开）
5. 设置检查间隔与审核策略

添加后点「立即检查」即可验证。没有 Webhook 的仓库同样能发现变化。

## 三、配置 GitHub Webhook（可选）

仓库 → Settings → Webhooks → Add webhook：

| 字段 | 值 |
|---|---|
| Payload URL | `https://son.zhiaon.top/api/v1/webhook/github/<仓库ID>` |
| Content type | `application/json` |
| Secret | 与后台「第三方仓库 → Secret」中填的一致 |
| 事件 | Just the push event |

仓库 ID 在后台仓库卡片的 Secret 弹窗里直接显示，可一键复制。

**安全说明**：生产环境里没有配置 Secret 的仓库会被拒绝处理（401），
防止任何人伪造 Push 事件。Secret 在数据库中只存密文。

## 四、启用定时抓取

`workers/site/wrangler.toml`：

```toml
[env.production.triggers]
crons = ["0 */6 * * *"]
```

改完需要重新部署。后台「自动检测 → 立即运行」调用的是**同一个函数**，
可以先用它验证行为，不必等 6 小时。

## 五、在 Telegram 中审核

发现新模块或更新时，Bot 会推送一条消息，带 Inline 按钮：

- **✅ 通过审核 / 通过更新** — 立即发布
- **❌ 拒绝发布 / 拒绝更新** — 需要再点一次「确认拒绝」
- 删除事件提供 **保留 / 隐藏 / 下架 / 确认删除** 四个选项

只有 `TELEGRAM_ADMIN_ID` 对应的数字 ID 能操作，其他人点击会被静默忽略。

可用命令：`/pending` 查看待审数量，`/status` 查看仓库状态。

## 六、关键设计约束

**未审核不覆盖线上**：待审核内容只存在 `module_review_tasks.new_content`，
`modules` 表只有在审核通过时才被写入。这是结构保证，不是流程约定。

**旧版本不覆盖新版本**：审核期间如果又出现更新，旧任务会被标记
`superseded`；点通过时还会再校验一次 `content_sha`，不匹配就返回 409。

**删除必须人工确认**：GitHub 上删文件只会创建一条删除任务并置
`is_deleted_upstream=1`，线上模块不受影响，直到管理员选择处理方式。

**去重**：唯一索引 `(repository_id, file_path, content_sha, task_type)`
保证同一变化不会因为三种方式都发现而建出多条任务。

**变化判断**：用 Git blob SHA 与树对比，只有真正变了的文件才下载内容。

## 七、故障排查

| 现象 | 检查 |
|---|---|
| 检查报“无权访问” | `GITHUB_READ_TOKEN` 是否有该仓库读权限 |
| Webhook 返回 401 | Secret 前后台是否一致；是否配置了 `WEBHOOK_SECRET_KEY` |
| Telegram 没收到 | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ADMIN_ID`；后台通知开关 |
| 审核按钮无反应 | 你的 Telegram ID 是否等于 `TELEGRAM_ADMIN_ID` |
| 每次检查都显示全部更新 | 确认 `current_blob_sha` 有值（迁移 0009 已加该列） |

## 八、测试

```bash
node scripts/run-tests.mjs        # 全套 202 项
```

`tests/phase7.test.ts` 覆盖：三方式共用引擎、去重、版本保护、删除保护、
HMAC 验签、Telegram 权限、管理端分派层。
