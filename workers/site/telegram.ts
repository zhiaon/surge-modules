/**
 * Telegram Bot: review notifications and in-chat approval.
 *
 * Two rules shape this file:
 *
 *   1. **Identity is a numeric ID from a Worker Secret, never a username.** A
 *      username can be changed or squatted; the ID cannot. Anything arriving in
 *      a callback_query or message is compared against TELEGRAM_ADMIN_ID (or the
 *      `third_party.telegram_admin_id` setting), and a mismatch is rejected
 *      before any handler runs — the callback payload alone is never trusted.
 *
 *   2. **One notification per task.** `notify_status` is claimed with a
 *      conditional UPDATE before sending, so a retried webhook or a duplicate
 *      scan cannot spam the admin with the same pending item. A genuine send
 *      failure is recorded as `failed` and can be re-sent from the admin UI.
 *
 * The bot token never leaves the Worker: no handler returns it, and it is only
 * ever placed in the URL of an outgoing api.telegram.org call.
 */

import { handleBatchCallback, showOverview, answer as answerCb } from './tg-batch-ui';

const TG_API = 'https://api.telegram.org';
const MAX_TEXT = 3800;

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

export interface TelegramEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ID?: string;
}

// ------------------------------------------------------------------- client
interface TgResult {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
    chat?: { id: number | string };
    text?: string;
  };
}

async function tgCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TgResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as TgResult;
    if (!res.ok || !json.ok) {
      return { ok: false, description: json.description ?? `HTTP ${res.status}` };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : 'Telegram 请求失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Resolves the allowed admin ID: Worker Secret wins, D1 setting is the fallback. */
async function resolvedAdminId(env: TelegramEnv): Promise<string> {
  if (env.TELEGRAM_ADMIN_ID?.trim()) return env.TELEGRAM_ADMIN_ID.trim();
  const row = await env.DB.prepare(
    "SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'",
  ).first<{ value: string }>();
  return (row?.value ?? '').trim();
}

async function settingOn(env: TelegramEnv, key: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM site_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  // absent means "on" — the migration seeds these, so a missing row is a fresh
  // install where silence would be the wrong default
  return (row?.value ?? '1') !== '0';
}

/** True only for the configured admin. Everything else is refused silently. */
export async function isAdminTelegram(
  env: TelegramEnv,
  fromId: number | string | undefined,
): Promise<boolean> {
  if (fromId === undefined || fromId === null) return false;
  const allowed = await resolvedAdminId(env);
  if (!allowed) return false;
  return String(fromId) === allowed;
}

// ---------------------------------------------------------------- rendering
interface TaskContext {
  id: string;
  task_type: string;
  detection_method: string;
  file_path: string;
  branch: string;
  old_version: string;
  new_version: string;
  commit_sha: string;
  repository_name: string | null;
  owner: string | null;
  repository: string | null;
  new_content: string;
}

async function loadTaskContext(
  env: TelegramEnv,
  taskId: string,
): Promise<TaskContext | null> {
  return env.DB.prepare(
    `SELECT t.id, t.task_type, t.detection_method, t.file_path, t.branch,
            t.old_version, t.new_version, t.commit_sha, t.new_content,
            r.name AS repository_name, r.owner, r.repository
       FROM module_review_tasks t
       LEFT JOIN third_party_repositories r ON r.id = t.repository_id
      WHERE t.id = ?`,
  )
    .bind(taskId)
    .first<TaskContext>();
}

const METHOD_LABEL: Record<string, string> = {
  webhook: 'Webhook 实时推送',
  manual: '后台手动检查',
  cron: 'Cron 定时抓取',
};

const TYPE_LABEL: Record<string, string> = {
  new: '新模块',
  update: '模块更新',
  delete: '文件删除',
};

function moduleNameFrom(filePath: string, content: string): string {
  const m = content.match(/^#!\s*name\s*=\s*(.+)$/im);
  if (m) return m[1].trim().slice(0, 80);
  return (filePath.split('/').pop() ?? filePath).replace(/\.sgmodule$/i, '');
}

function moduleDescFrom(content: string): string {
  const m = content.match(/^#!\s*desc(?:ription)?\s*=\s*(.+)$/im);
  return m ? m[1].trim().replace(/^V?\d+(\.\d+)*[:：]\s*/i, '').slice(0, 200) : '';
}

function moduleAuthorFrom(content: string): string {
  const m = content.match(/^#!\s*author\s*=\s*(.+)$/im);
  return m ? m[1].trim().slice(0, 60) : '';
}

/** Builds the message + inline keyboard for a pending task. */
export function buildTaskMessage(task: TaskContext): {
  text: string;
  keyboard: unknown;
} {
  const name = moduleNameFrom(task.file_path, task.new_content ?? '');
  const desc = moduleDescFrom(task.new_content ?? '');
  const author = moduleAuthorFrom(task.new_content ?? '');
  const repoFull = `${task.owner ?? '?'}/${task.repository ?? '?'}`;
  const githubUrl = `https://github.com/${repoFull}/blob/${task.branch || 'main'}/${task.file_path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  const title =
    task.task_type === 'new'
      ? '发现第三方新模块，等待审核'
      : task.task_type === 'update'
        ? '发现第三方模块更新，等待审核'
        : '第三方仓库删除了模块文件，需要处理';

  const lines: string[] = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    `<b>模块</b>：${escapeHtml(name)}`,
  ];
  if (desc) lines.push(`<b>描述</b>：${escapeHtml(desc)}`);
  if (author) lines.push(`<b>作者</b>：${escapeHtml(author)}`);
  lines.push(`<b>来源</b>：${escapeHtml(task.repository_name ?? repoFull)}`);
  lines.push(`<b>仓库</b>：<code>${escapeHtml(repoFull)}</code>`);
  lines.push(`<b>分支</b>：<code>${escapeHtml(task.branch || 'main')}</code>`);
  lines.push(`<b>路径</b>：<code>${escapeHtml(task.file_path)}</code>`);

  if (task.task_type === 'update') {
    lines.push(`<b>当前线上版本</b>：<code>${escapeHtml(task.old_version || '—')}</code>`);
    lines.push(`<b>待审核版本</b>：<code>${escapeHtml(task.new_version || '—')}</code>`);
  } else if (task.task_type === 'new') {
    lines.push(`<b>版本</b>：<code>${escapeHtml(task.new_version || '—')}</code>`);
  }

  if (task.commit_sha) {
    lines.push(`<b>Commit</b>：<code>${escapeHtml(task.commit_sha.slice(0, 10))}</code>`);
  }
  lines.push(`<b>检测方式</b>：${escapeHtml(METHOD_LABEL[task.detection_method] ?? task.detection_method)}`);
  lines.push(`<b>任务类型</b>：${escapeHtml(TYPE_LABEL[task.task_type] ?? task.task_type)}`);

  const text = lines.join('\n').slice(0, MAX_TEXT);

  // Callback data is limited to 64 bytes by Telegram, so it carries only the
  // action and the task id — the task state is re-read from D1 on every click.
  const rows: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> = [];
  const siteUrl = 'https://son.zhiaon.top/admin';

  if (task.task_type === 'delete') {
    rows.push([
      { text: '保留线上模块', callback_data: `d:k:${task.id}` },
      { text: '隐藏模块', callback_data: `d:h:${task.id}` },
    ]);
    rows.push([
      { text: '下架模块', callback_data: `d:u:${task.id}` },
      { text: '确认删除', callback_data: `d:x:${task.id}` },
    ]);
  } else {
    rows.push([
      { text: task.task_type === 'update' ? '✅ 通过更新' : '✅ 通过审核', callback_data: `a:${task.id}` },
      { text: task.task_type === 'update' ? '❌ 拒绝更新' : '❌ 拒绝发布', callback_data: `r:${task.id}` },
    ]);
  }

  rows.push([
    { text: '查看详情', url: `${siteUrl}?review=${encodeURIComponent(task.id)}` },
    { text: '查看 GitHub', url: githubUrl },
  ]);

  return { text, keyboard: { inline_keyboard: rows } };
}

// ------------------------------------------------------------------ notify
/**
 * Sends the pending-review message exactly once per task.
 *
 * The claim UPDATE runs first: `notify_status` moves pending/failed → sending
 * only for the caller that wins, so two concurrent detections cannot both post.
 */
export async function notifyReviewTask(
  env: TelegramEnv,
  taskId: string,
  kind: 'new' | 'update' | 'delete',
): Promise<{ sent: boolean; error?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: false, error: '未配置 TELEGRAM_BOT_TOKEN' };

  const gateKey =
    kind === 'new'
      ? 'third_party.notify_new'
      : kind === 'update'
        ? 'third_party.notify_update'
        : 'third_party.notify_delete';
  if (!(await settingOn(env, gateKey))) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'skipped', updated_at = ? WHERE id = ?`,
    )
      .bind(iso(), taskId)
      .run();
    return { sent: false, error: '该类型通知已关闭' };
  }

  const adminId = await resolvedAdminId(env);
  if (!adminId) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'failed',
              notify_error = '未配置 TELEGRAM_ADMIN_ID', updated_at = ? WHERE id = ?`,
    )
      .bind(iso(), taskId)
      .run();
    return { sent: false, error: '未配置 TELEGRAM_ADMIN_ID' };
  }

  // claim: only one sender wins
  const claim = await env.DB.prepare(
    `UPDATE module_review_tasks SET notify_status = 'sending', updated_at = ?
      WHERE id = ? AND notify_status IN ('pending', 'failed')`,
  )
    .bind(iso(), taskId)
    .run();
  if (((claim.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return { sent: false, error: '该任务已通知过' };
  }

  const task = await loadTaskContext(env, taskId);
  if (!task) return { sent: false, error: '任务不存在' };

  const { text, keyboard } = buildTaskMessage(task);
  const res = await tgCall(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: adminId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });

  if (!res.ok) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'failed', notify_error = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind((res.description ?? '发送失败').slice(0, 300), iso(), taskId)
      .run();
    return { sent: false, error: res.description };
  }

  await env.DB.prepare(
    `UPDATE module_review_tasks SET notify_status = 'sent', notify_error = '',
            notify_message_id = ?, notified_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(String(res.result?.message_id ?? ''), iso(), iso(), taskId)
    .run();

  return { sent: true };
}

/** Posts the outcome back to the chat after a decision. */
/**
 * Announces a first-party (GitHub 数据源) module that is waiting for review.
 *
 * The first-party queue had no Telegram path: a synced repository could queue
 * new modules and nobody would know until somebody opened the admin panel. The
 * message links into the same review centre so both queues are handled in one
 * place.
 */
export async function notifyFirstPartyPending(
  env: TelegramEnv,
  item: {
    name: string;
    version: string;
    sourcePath: string;
    repository: string;
    repositoryUrl: string;
    rawUrl: string;
    kind: 'new' | 'update';
    /** shown as "v1.2 → v1.3" on updates */
    previousVersion?: string;
  },
): Promise<{ sent: boolean; error?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: false, error: '未配置 Bot Token' };
  // Respect the per-kind switches so an operator can silence new releases but
  // keep update alerts (or the reverse).
  const toggle = item.kind === 'new' ? 'third_party.notify_new' : 'third_party.notify_update';
  if (!(await settingOn(env, toggle))) {
    return { sent: false, error: '通知已关闭' };
  }
  const adminId = await resolvedAdminId(env);
  if (!adminId) return { sent: false, error: '未配置管理员 ID' };

  const title =
    item.kind === 'new' ? '数据源发现新模块，等待审核' : '数据源模块有更新，等待审核';
  const text = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    `模块：<b>${escapeHtml(item.name)}</b>`,
    item.kind === 'update' && item.previousVersion
      ? `版本：<code>${escapeHtml(item.previousVersion)}</code> → <code>${escapeHtml(item.version)}</code>`
      : `版本：<code>${escapeHtml(item.version)}</code>`,
    `来源：${escapeHtml(item.repository)}`,
    `路径：<code>${escapeHtml(item.sourcePath)}</code>`,
    '',
    '这在「模块审核」队列里，用 /pending 可以批量处理。',
  ].join('\n');

  const res = await tgCall(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: adminId,
    text: text.slice(0, MAX_TEXT),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 打开审核中心', callback_data: 'pg:1' },
          { text: 'GitHub', url: item.repositoryUrl },
        ],
      ],
    },
  });

  return res.ok ? { sent: true } : { sent: false, error: res.description };
}

/**
 * Announces a new approval-mode registration.
 *
 * No password, session or code is included — only what an admin needs to decide:
 * who, from which network hash, and when. The buttons open the admin panel; the
 * decision itself happens there because the panel already enforces role checks
 * and writes the audit trail.
 */
export async function notifyRegistrationApplication(
  env: TelegramEnv,
  app: { username: string; email: string; ipHash: string },
): Promise<{ sent: boolean; error?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: false, error: '未配置 Bot Token' };
  const adminId = await resolvedAdminId(env);
  if (!adminId) return { sent: false, error: '未配置管理员 ID' };

  const masked = app.email.replace(/^(..).*(@.*)$/, '$1***$2');
  const res = await tgCall(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: adminId,
    text: [
      '<b>新的注册申请</b>',
      '',
      `用户名：<b>${escapeHtml(app.username)}</b>`,
      `邮箱：<code>${escapeHtml(masked)}</code>`,
      `来源：<code>${escapeHtml(app.ipHash.slice(0, 12))}…</code>`,
      '',
      '在后台「用户与邀请码 → 审核申请」里通过或拒绝。',
    ].join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return res.ok ? { sent: true } : { sent: false, error: res.description };
}

export async function notifyAudit(
  env: TelegramEnv,
  outcome: 'approved' | 'rejected',
  task: { id: string; task_type: string; file_path: string; new_version?: string },
  operator: string,
  reason: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (!(await settingOn(env, 'third_party.notify_reviewed'))) return;
  const adminId = await resolvedAdminId(env);
  if (!adminId) return;

  const name = (task.file_path.split('/').pop() ?? task.file_path).replace(/\.sgmodule$/i, '');
  const head = outcome === 'approved' ? '✅ 已通过审核' : '🚫 已拒绝';
  const lines = [
    `<b>${head}</b>`,
    '',
    `模块：<code>${escapeHtml(name)}</code>`,
    `类型：${escapeHtml(TYPE_LABEL[task.task_type] ?? task.task_type)}`,
    task.new_version ? `版本：<code>${escapeHtml(task.new_version)}</code>` : '',
    `操作人：${escapeHtml(operator)}`,
    reason ? `原因：${escapeHtml(reason)}` : '',
    `时间：${escapeHtml(iso().replace('T', ' ').replace('Z', ' UTC'))}`,
  ].filter(Boolean);

  await tgCall(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: adminId,
    text: lines.join('\n').slice(0, MAX_TEXT),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/** Generic operational message (check failure, webhook error, cron problem). */
export async function notifyOps(
  env: TelegramEnv,
  title: string,
  body: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (!(await settingOn(env, 'third_party.notify_failure'))) return;
  const adminId = await resolvedAdminId(env);
  if (!adminId) return;
  await tgCall(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: adminId,
    text: `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body).slice(0, 2600)}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

// ------------------------------------------------------------------ updates
async function answerCallback(
  token: string,
  callbackId: string,
  text: string,
  alert = false,
): Promise<void> {
  await tgCall(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text.slice(0, 190),
    show_alert: alert,
  });
}

/**
 * Persistent bottom-left menu button. Telegram pins it to the input bar, so
 * every chat opens with one-tap access to the four commands — no typing.
 * is_persistent keeps it from collapsing after each use.
 */
function buildMainMenu() {
  return {
    keyboard: [
      [{ text: '/pending' }, { text: '/repos' }],
      [{ text: '/checkall' }, { text: '/status' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '菜单 · 命令',
  };
}

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number }; text?: string };
    data?: string;
  };
}

// ------------------------------------------------------------------ handler
/**
 * Processes one Telegram update.
 *
 * Every branch re-verifies:
 *   - the sender is the configured admin (by numeric id)
 *   - the task exists and is still actionable (decideTask enforces this again)
 *   - destructive choices (delete / reject) require a second confirmation click
 */
export async function handleTelegramWebhook(
  env: TelegramEnv & { WEBHOOK_SECRET_KEY?: string },
  update: TelegramUpdate,
  deps: {
    decide: (input: {
      taskId: string;
      decision: 'approve' | 'reject';
      operator: string;
      source: 'telegram';
      reason?: string;
      note?: string;
    }) => Promise<{ ok: boolean; message?: string; status?: string }>;
    /**
     * Runs the scheduler (same function the Cron trigger and the admin button
     * call). Returned summary is what gets posted back to the chat.
     */
    /** Approves/rejects one first-party (GitHub 数据源) review item. */
    decideFirstParty?: (reviewId: string) => Promise<{ ok: boolean; message?: string }>;
    runScheduler?: () => Promise<{
      ran: boolean;
      reason?: string;
      reposChecked: number;
      newModules: number;
      updatedModules: number;
      deletedModules: number;
      failed: number;
      durationMs: number;
    }>;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: 500, body: { ok: false, error: 'bot token missing' } };

  const cq = update.callback_query;
  if (cq) {
    const adminOk = await isAdminTelegram(env, cq.from?.id);
    if (!adminOk) {
      // Silent refusal: a stranger pressing a forwarded button learns nothing.
      await answerCallback(token, cq.id, '无权操作');
      return { status: 200, body: { ok: true, ignored: 'not_admin' } };
    }

    const data = cq.data ?? '';

    // ---- batch UI (multi-select, paging, confirm, execute) ----------------
    // Verbs: t:<id> | pg:<n> | all | none | rf | home | do:<action> | yes:<action> | no
    if (/^(t:|pg:|do:|yes:)/.test(data) || ['all', 'none', 'rf', 'home', 'no'].includes(data)) {
      const chatIdStr = String(cq.message?.chat.id ?? cq.from.id);
      const handled = await handleBatchCallback({
        env: { DB: env.DB },
        token,
        chatId: chatIdStr,
        messageId: cq.message?.message_id,
        callbackId: cq.id,
        data,
        operator: `telegram:${cq.from.id}`,
        deps: {
          decideThirdParty: async (id) => {
            const r = await deps.decide({
              taskId: id,
              decision: 'approve',
              operator: `telegram:${cq.from.id}`,
              source: 'telegram',
            });
            return r.ok ? { ok: true } : { ok: false, message: r.message };
          },
          decideFirstParty: deps.decideFirstParty ?? (async () => ({ ok: false, message: '未配置' })),
        },
      });
      if (handled) return { status: 200, body: { ok: true, batch: true, ...handled.result } };
    }

    const [action, arg, taskId] = data.split(':');
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    const originalText = cq.message?.text ?? '';

    // confirmation step for destructive actions
    if (action === 'c' && arg && taskId) {
      const confirmKind = arg; // 'r' reject | 'x' delete
      const result = await deps.decide({
        taskId,
        decision: 'reject',
        operator: `telegram:${cq.from.id}`,
        source: 'telegram',
        reason: confirmKind === 'x' ? '确认删除' : 'Telegram 内拒绝',
        note: confirmKind === 'x' ? 'delete' : '',
      });

      // On success the review receipt (notifyAudit) is the single record of the
      // decision — it carries the module, version, operator, reason and time.
      // Appending "已拒绝" to this message as well produced two conflicting
      // copies; the callback answer is only used to surface a real failure.
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, '该任务已处理');
      } else {
        await answerCallback(token, cq.id, '');
        // drop the buttons so the same task cannot be acted on twice
        if (chatId && messageId) {
          await tgCall(token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }

    if (action === 'a') {
      const result = await deps.decide({
        taskId: taskId ?? arg,
        decision: 'approve',
        operator: `telegram:${cq.from.id}`,
        source: 'telegram',
      });
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, '该任务已处理');
      } else {
        // The receipt message is the record; just retire the buttons here.
        await answerCallback(token, cq.id, '');
        if (chatId && messageId) {
          await tgCall(token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }

    if (action === 'r') {
      // first press: ask for confirmation, do not decide yet
      await tgCall(token, 'editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '确认拒绝', callback_data: `c:r:${taskId ?? arg}` },
              { text: '取消', callback_data: `n:${taskId ?? arg}` },
            ],
          ],
        },
      });
      await answerCallback(token, cq.id, '请再次确认拒绝');
      return { status: 200, body: { ok: true, awaitingConfirm: true } };
    }

    if (action === 'n') {
      // cancel: restore the original keyboard by re-deriving it
      const task = await loadTaskContext(env, taskId ?? arg);
      if (task) {
        const built = buildTaskMessage(task);
        await tgCall(token, 'editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: built.keyboard,
        });
      }
      await answerCallback(token, cq.id, '已取消');
      return { status: 200, body: { ok: true, cancelled: true } };
    }

    // delete-task decisions: d:<k|h|u|x>:<taskId>
    if (action === 'd') {
      const choice = arg; // k keep, h hide, u unpublish, x delete
      const id = taskId;
      if (!id) {
        await answerCallback(token, cq.id, '任务标识缺失');
        return { status: 200, body: { ok: false } };
      }

      if (choice === 'x') {
        // destructive: require an explicit confirm
        await tgCall(token, 'editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '确认删除模块', callback_data: `c:x:${id}` },
                { text: '取消', callback_data: `n:${id}` },
              ],
            ],
          },
        });
        await answerCallback(token, cq.id, '删除不可撤销，请确认');
        return { status: 200, body: { ok: true, awaitingConfirm: true } };
      }

      const noteMap: Record<string, string> = {
        k: 'keep',
        h: 'hide',
        u: 'unpublish',
      };
      const result = await deps.decide({
        taskId: id,
        decision: 'approve',
        operator: `telegram:${cq.from.id}`,
        source: 'telegram',
        note: noteMap[choice] ?? 'hide',
      });
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, '该任务已处理');
      } else {
        await answerCallback(token, cq.id, '');
        if (chatId && messageId) {
          await tgCall(token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }

    await answerCallback(token, cq.id, '未知操作');
    return { status: 200, body: { ok: true, ignored: 'unknown_action' } };
  }

  // plain message: only respond to the admin, and only with a short help reply
  const msg = update.message;
  if (msg) {
    const adminOk = await isAdminTelegram(env, msg.from?.id);
    if (!adminOk) return { status: 200, body: { ok: true, ignored: 'not_admin' } };

    const text = (msg.text ?? '').trim();
    if (text === '/start' || text === '/help' || text === '/menu') {
      await tgCall(token, 'sendMessage', {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text:
          '<b>Surge Modules 管理机器人</b>\n\n' +
          '第三方仓库发现新模块或更新时，会自动推送待审核消息到这里。\n' +
          '消息里的按钮可以直接通过或拒绝，无需打开网站。\n\n' +
          '<b>命令</b>\n' +
          '/menu — 本菜单\n' +
          '/pending — 待审核队列 + 批量通过/拒绝\n' +
          '/repos — 已接入的仓库与检查状态\n' +
          '/checkall — 立即检查全部仓库\n' +
          '/status — 平台状态',
        parse_mode: 'HTML',
        reply_markup: buildMainMenu(),
      });
      return { status: 200, body: { ok: true, replied: 'help' } };
    }

    if (text === '/pending') {
      await showOverview({ DB: env.DB }, token, String(msg.chat?.id ?? msg.from?.id));
      return { status: 200, body: { ok: true, replied: 'pending' } };
    }

    if (text === '/repos') {
      const rows = await env.DB.prepare(
        `SELECT name, owner, repository, default_branch, enabled,
                last_check_status, last_checked_at, discovered_modules,
                pending_new, pending_updates
           FROM third_party_repositories
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 20`,
      ).all<Record<string, string | number | null>>();

      const repos = rows.results ?? [];
      if (repos.length === 0) {
        await tgCall(token, 'sendMessage', {
          chat_id: msg.chat?.id ?? msg.from?.id,
          text: '还没有接入任何第三方仓库。在后台「第三方仓库 → 添加仓库」里接入。',
        });
        return { status: 200, body: { ok: true, replied: 'repos' } };
      }

      const lines = ['<b>已接入仓库</b>', ''];
      for (const r of repos) {
        const status =
          r.last_check_status === 'failed'
            ? '🔴'
            : r.last_check_status === 'partial'
              ? '🟡'
              : r.last_check_status === 'ok'
                ? '🟢'
                : '⚪️';
        lines.push(
          `${status} <b>${escapeHtml(String(r.name))}</b>${r.enabled ? '' : '（已停用）'}\n` +
            `<code>${escapeHtml(String(r.owner))}/${escapeHtml(String(r.repository))}</code> · ${escapeHtml(String(r.default_branch))}\n` +
            `模块 ${r.discovered_modules} · 待审 新${r.pending_new}/更${r.pending_updates}` +
            (r.last_checked_at ? ` · 检查于 ${escapeHtml(String(r.last_checked_at).slice(0, 16))}Z` : ''),
        );
      }
      await tgCall(token, 'sendMessage', {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text: lines.join('\n').slice(0, 3800),
        parse_mode: 'HTML',
        reply_markup: buildMainMenu(),
      });
      return { status: 200, body: { ok: true, replied: 'repos' } };
    }

    if (text === '/checkall') {
      if (!deps.runScheduler) {
        await tgCall(token, 'sendMessage', {
          chat_id: msg.chat?.id ?? msg.from?.id,
          text: '当前部署未启用手动调度。',
        });
        return { status: 200, body: { ok: true, unavailable: true } };
      }
      const m = await tgCall(token, 'sendMessage', {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text: '⏳ 正在检查全部仓库…（同步执行，最长约 1 分钟）',
      });
      const mid = m.result?.message_id;
      const result = await deps.runScheduler();
      if (!result.ran) {
        await tgCall(token, 'editMessageText', {
          chat_id: msg.chat?.id ?? msg.from?.id,
          message_id: mid,
          text: `未执行：${escapeHtml(result.reason ?? '没有到期的仓库')}`,
        });
        return { status: 200, body: { ok: true, skipped: result.reason } };
      }
      await tgCall(token, 'editMessageText', {
        chat_id: msg.chat?.id ?? msg.from?.id,
        message_id: mid,
        text:
          '<b>检查完成</b>\n\n' +
          `仓库 ${result.reposChecked} · 新增 <b>${result.newModules}</b> · 更新 <b>${result.updatedModules}</b> · 删除 ${result.deletedModules}\n` +
          `失败 ${result.failed} · 耗时 ${result.durationMs} ms\n\n` +
          (result.newModules + result.updatedModules > 0
            ? '发现的变化已生成待审核任务，用 /pending 查看。'
            : '没有发现新的变化。'),
        parse_mode: 'HTML',
      });
      return { status: 200, body: { ok: true, replied: 'checkall', result } };
    }

    if (text === '/status') {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS on_,
                SUM(CASE WHEN last_check_status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM third_party_repositories WHERE deleted_at IS NULL`,
      ).first<{ total: number; on_: number; failed: number }>();
      await tgCall(token, 'sendMessage', {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text:
          `<b>第三方仓库</b>\n总数 ${row?.total ?? 0} · 启用 ${row?.on_ ?? 0}\n` +
          `最近失败 ${row?.failed ?? 0}\nBot 已连接。`,
        parse_mode: 'HTML',
        reply_markup: buildMainMenu(),
      });
      return { status: 200, body: { ok: true, replied: 'status' } };
    }
  }

  return { status: 200, body: { ok: true, ignored: true } };
}
