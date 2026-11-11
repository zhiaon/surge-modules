/**
 * Telegram batch-review UI.
 *
 * A small state machine over a single edited message:
 *
 *   /pending → 队列概览（计数 + 查看列表）
 *   列表页  → 每条一个 ☑/☐ 按钮，全选/取消全选，翻页，批量通过/拒绝
 *   确认页  → 列出将要处理的条目 + 确认/取消
 *   结果页  → 成功/失败/跳过统计
 *
 * Two decisions worth recording:
 *
 *   - **The message is edited in place, never re-sent.** A 12-item queue would
 *     otherwise flood the chat. The message id is persisted in `tg_ui_state`
 *     so a refresh after a restart still updates the same message.
 *   - **Selection lives in D1, not callback_data.** Telegram caps callback data
 *     at 64 bytes; an id set does not fit, and encoding it statelessly would
 *     reset the selection on every page turn. Callback data only ever carries a
 *     verb (`t:<id>`, `pg:2`, `all`, `do:approve`), and every id is re-validated
 *     against the view on submit.
 */

import {
  describeOutcome,
  listPending,
  pendingCounts,
  runBatch,
  type BatchResult,
  type PendingRow,
} from './batch-review';

const MAX_TEXT = 3800;
const PER_PAGE = 8;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- tg client
async function tg(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: { message_id?: number } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    return { ok: Boolean(json.ok), description: json.description, result: json.result };
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : 'Telegram 请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

export const answer = (token: string, id: string, text: string, alert = false) =>
  tg(token, 'answerCallbackQuery', {
    callback_query_id: id,
    text: text.slice(0, 190),
    show_alert: alert,
  });

// ------------------------------------------------------------------ storage
async function getState(
  db: D1Database,
  chatId: string,
): Promise<{ messageId: number | null; page: number }> {
  const row = await db
    .prepare('SELECT message_id, page FROM tg_ui_state WHERE chat_id = ?')
    .bind(chatId)
    .first<{ message_id: number | null; page: number }>();
  return { messageId: row?.message_id ?? null, page: row?.page ?? 1 };
}

async function setState(
  db: D1Database,
  chatId: string,
  patch: { messageId?: number | null; page?: number },
): Promise<void> {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await db
    .prepare(
      `INSERT INTO tg_ui_state (chat_id, message_id, page, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         message_id = COALESCE(excluded.message_id, tg_ui_state.message_id),
         page = excluded.page,
         updated_at = excluded.updated_at`,
    )
    .bind(chatId, patch.messageId ?? null, patch.page ?? 1, now)
    .run();
}

async function getSelection(db: D1Database, chatId: string): Promise<Set<string>> {
  const rows = await db
    .prepare('SELECT review_id FROM tg_review_selection WHERE chat_id = ?')
    .bind(chatId)
    .all<{ review_id: string }>();
  return new Set((rows.results ?? []).map((r) => r.review_id));
}

async function toggleSelection(
  db: D1Database,
  chatId: string,
  reviewId: string,
  queue: string,
): Promise<boolean> {
  const existing = await db
    .prepare('SELECT 1 AS x FROM tg_review_selection WHERE chat_id = ? AND review_id = ?')
    .bind(chatId, reviewId)
    .first<{ x: number }>();
  if (existing) {
    await db
      .prepare('DELETE FROM tg_review_selection WHERE chat_id = ? AND review_id = ?')
      .bind(chatId, reviewId)
      .run();
    return false;
  }
  await db
    .prepare('INSERT INTO tg_review_selection (chat_id, review_id, queue) VALUES (?, ?, ?)')
    .bind(chatId, reviewId, queue)
    .run();
  return true;
}

async function clearSelection(db: D1Database, chatId: string): Promise<void> {
  await db.prepare('DELETE FROM tg_review_selection WHERE chat_id = ?').bind(chatId).run();
}

// ---------------------------------------------------------------- rendering
/** Queue overview: counts + a single "view list" entry point. */
export function renderOverview(counts: {
  total: number;
  newCount: number;
  updateCount: number;
  deleteCount: number;
}): { text: string; keyboard: unknown } {
  const lines = [
    '<b>第三方模块审核中心</b>',
    '',
    `待审核：<b>${counts.total}</b> 项`,
    '',
    `新模块：${counts.newCount} 项`,
    `模块更新：${counts.updateCount} 项`,
  ];
  if (counts.deleteCount > 0) {
    lines.push(`删除待处理：${counts.deleteCount} 项（需逐条选择）`);
  }

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  if (counts.total > 0) {
    keyboard.push([{ text: '📋 查看待审核列表', callback_data: 'pg:1' }]);
    keyboard.push([
      { text: '☑️ 全选当前页', callback_data: 'all' },
      { text: '🔄 刷新', callback_data: 'rf' },
    ]);
    keyboard.push([
      { text: '✅ 批量通过', callback_data: 'do:approve' },
      { text: '❌ 批量拒绝', callback_data: 'do:reject' },
    ]);
  } else {
    keyboard.push([{ text: '🔄 刷新列表', callback_data: 'rf' }]);
  }

  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One page of the list: a checkbox per row + bulk actions. */
export function renderList(args: {
  items: PendingRow[];
  page: number;
  pages: number;
  total: number;
  selected: Set<string>;
  allPageSelected: boolean;
}): { text: string; keyboard: unknown } {
  const { items, page, pages, total, selected, allPageSelected } = args;

  const lines = [
    '<b>待审核列表</b>',
    '',
    `第 ${page} / ${pages} 页 · 共 ${total} 项`,
    `已选择：<b>${selected.size}</b> 项`,
    '',
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const item of items) {
    const on = selected.has(item.id);
    const kind = item.kind === 'new' ? '新' : '更';
    const repo = item.repository || '—';
    const label = `${on ? '☑' : '☐'} [${kind}] ${item.name}`.slice(0, 62);
    keyboard.push([{ text: label, callback_data: `t:${item.id}` }]);
    lines.push(
      `${on ? '☑' : '☐'} <b>${escapeHtml(item.name)}</b> · ${kind === '新' ? '新模块' : '更新'}` +
        (item.version ? ` v${escapeHtml(item.version)}` : '') +
        `\n   <code>${escapeHtml(repo)}</code> · ${escapeHtml(item.created_at.slice(0, 16))}Z`,
    );
  }

  // navigation
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 1) nav.push({ text: '◀ 上一页', callback_data: `pg:${page - 1}` });
  if (page < pages) nav.push({ text: '下一页 ▶', callback_data: `pg:${page + 1}` });
  if (nav.length > 0) keyboard.push(nav);

  keyboard.push([
    {
      text: allPageSelected ? '☐ 取消全选本页' : '☑ 全选本页',
      callback_data: allPageSelected ? 'none' : 'all',
    },
    { text: '🔄 刷新', callback_data: 'rf' },
  ]);
  keyboard.push([
    { text: `✅ 批量通过${selected.size ? ` (${selected.size})` : ''}`, callback_data: 'do:approve' },
    { text: `❌ 批量拒绝${selected.size ? ` (${selected.size})` : ''}`, callback_data: 'do:reject' },
  ]);
  keyboard.push([{ text: '◀ 返回待审核中心', callback_data: 'home' }]);

  return { text: lines.join('\n').slice(0, MAX_TEXT), keyboard: { inline_keyboard: keyboard } };
}

/** Confirmation page listing exactly what will be processed. */
export function renderConfirm(args: {
  action: 'approve' | 'reject';
  rows: PendingRow[];
}): { text: string; keyboard: unknown } {
  const verb = args.action === 'approve' ? '通过' : '拒绝';
  const lines = [
    `<b>确认批量${verb}</b>`,
    '',
    `本次操作：批量${verb}`,
    `已选择：<b>${args.rows.length}</b> 个模块`,
    '',
    '模块列表：',
  ];
  args.rows.slice(0, 20).forEach((row, i) => {
    lines.push(`${i + 1}. ${escapeHtml(row.name)}`);
  });
  if (args.rows.length > 20) lines.push(`…以及另外 ${args.rows.length - 20} 项`);

  if (args.action === 'reject') {
    lines.push('', '拒绝后不进入正式列表；更新类任务会保留当前线上版本。');
  }

  return {
    text: lines.join('\n').slice(0, MAX_TEXT),
    keyboard: {
      inline_keyboard: [
        [
          { text: `✅ 确认${verb}`, callback_data: `yes:${args.action}` },
          { text: '❌ 取消操作', callback_data: 'no' },
        ],
      ],
    },
  };
}

/** Result page. */
export function renderResult(result: BatchResult): { text: string; keyboard: unknown } {
  const verb = result.action === 'approve' ? '通过' : '拒绝';
  const text = [
    '<b>批量审核结果</b>',
    '',
    `操作：批量${verb}`,
    `成功：${result.succeeded} 项`,
    `失败：${result.failed} 项`,
    `跳过：${result.skipped} 项`,
    '',
    result.failed + result.skipped === 0 ? '审核已完成。' : describeOutcome(result).split('\n').slice(-6).join('\n'),
  ].join('\n');

  return {
    text: text.slice(0, MAX_TEXT),
    keyboard: {
      inline_keyboard: [
        [
          { text: '📋 继续审核', callback_data: 'pg:1' },
          { text: '◀ 返回中心', callback_data: 'home' },
        ],
      ],
    },
  };
}

// --------------------------------------------------------------- entrypoints
/** Sends (or edits) the overview. Used by /pending and by 'home'. */
export async function showOverview(
  env: { DB: D1Database },
  token: string,
  chatId: string,
  messageId?: number,
): Promise<number | null> {
  const counts = await pendingCounts(env.DB);
  const { text, keyboard } = renderOverview(counts);
  return postOrEdit(env, token, chatId, messageId, text, keyboard);
}

/** Renders one list page, honouring the stored selection. */
export async function showList(
  env: { DB: D1Database },
  token: string,
  chatId: string,
  page: number,
  messageId?: number,
): Promise<number | null> {
  const data = await listPending(env.DB, { page, perPage: PER_PAGE });
  await env.DB.prepare(
    `DELETE FROM tg_review_selection
      WHERE chat_id = ?
        AND review_id NOT IN (SELECT id FROM v_pending_reviews WHERE status = 'pending')`,
  )
    .bind(chatId)
    .run();
  const selected = await getSelection(env.DB, chatId);
  const ids = new Set(data.items.map((i) => i.id));
  const allPageSelected =
    data.items.length > 0 && data.items.every((i) => selected.has(i.id));
  // drop selections that no longer exist (approved elsewhere / deleted)
  void ids;

  const { text, keyboard } = renderList({
    items: data.items,
    page: data.page,
    pages: data.pages,
    total: data.total,
    selected,
    allPageSelected,
  });

  await setState(env.DB, chatId, { page: data.page, messageId: messageId ?? undefined });
  return postOrEdit(env, token, chatId, messageId, text, keyboard);
}

/** Sends if no message id, otherwise edits in place. */
async function postOrEdit(
  env: { DB: D1Database },
  token: string,
  chatId: string,
  messageId: number | undefined,
  text: string,
  keyboard: unknown,
): Promise<number | null> {
  if (messageId) {
    const edited = await tg(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
    if (edited.ok) return messageId;
    // Editing fails for an unchanged message or one that is too old; fall back
    // to a fresh message so the UI never ends up stuck.
  }
  const sent = await tg(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
  const id = sent.result?.message_id ?? null;
  if (id) await setState(env.DB, chatId, { messageId: id });
  return id;
}

// ---------------------------------------------------------------- callbacks
export interface BatchCallbackDeps {
  decideThirdParty: (id: string) => Promise<{ ok: boolean; message?: string; published?: boolean }>;
  decideFirstParty: (id: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Handles one batch-UI callback.
 *
 * Returns `null` when the payload is not a batch-UI verb, so the caller can
 * fall through to the single-task handlers.
 */
export async function handleBatchCallback(args: {
  env: { DB: D1Database };
  token: string;
  chatId: string;
  messageId: number | undefined;
  callbackId: string;
  data: string;
  operator: string;
  deps: BatchCallbackDeps;
}): Promise<{ handled: boolean; result?: Record<string, unknown> } | null> {
  const { env, token, chatId, messageId, callbackId, data, operator, deps } = args;

  // ---- toggle one row
  if (data.startsWith('t:')) {
    const id = data.slice(2);
    const state = await getState(env.DB, chatId);
    const row = await env.DB.prepare('SELECT queue FROM v_pending_reviews WHERE id = ?')
      .bind(id)
      .first<{ queue: string }>();
    if (!row) {
      await answer(token, callbackId, '该条目已处理');
    } else {
      const on = await toggleSelection(env.DB, chatId, id, row.queue);
      await answer(token, callbackId, on ? '已选择' : '已取消');
    }
    await showList(env, token, chatId, state.page, messageId);
    return { handled: true };
  }

  // ---- page navigation
  if (data.startsWith('pg:')) {
    const page = Number.parseInt(data.slice(3), 10) || 1;
    await answer(token, callbackId, '');
    await showList(env, token, chatId, page, messageId);
    return { handled: true };
  }

  // ---- select all on the current page
  if (data === 'all') {
    const state = await getState(env.DB, chatId);
    const page = await listPending(env.DB, { page: state.page, perPage: PER_PAGE });
    for (const item of page.items) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO tg_review_selection (chat_id, review_id, queue)
         VALUES (?, ?, ?)`,
      )
        .bind(chatId, item.id, item.queue)
        .run();
    }
    await answer(token, callbackId, `已选择本页 ${page.items.length} 项`);
    await showList(env, token, chatId, state.page, messageId);
    return { handled: true };
  }

  // ---- cancel the "select all" state for this page
  if (data === 'none') {
    const state = await getState(env.DB, chatId);
    const page = await listPending(env.DB, { page: state.page, perPage: PER_PAGE });
    for (const item of page.items) {
      await env.DB.prepare(
        'DELETE FROM tg_review_selection WHERE chat_id = ? AND review_id = ?',
      )
        .bind(chatId, item.id)
        .run();
    }
    await answer(token, callbackId, '已取消本页选择');
    await showList(env, token, chatId, state.page, messageId);
    return { handled: true };
  }

  // ---- refresh / back to overview
  if (data === 'rf') {
    await answer(token, callbackId, '已刷新');
    await showOverview(env, token, chatId, messageId);
    return { handled: true };
  }
  if (data === 'home') {
    await answer(token, callbackId, '');
    await showOverview(env, token, chatId, messageId);
    return { handled: true };
  }

  // ---- ask for confirmation
  if (data.startsWith('do:')) {
    const action = data.slice(3) as 'approve' | 'reject';
    if (action !== 'approve' && action !== 'reject') {
      await answer(token, callbackId, '未知操作');
      return { handled: true };
    }
    const selected = [...(await getSelection(env.DB, chatId))];
    if (selected.length === 0) {
      await answer(token, callbackId, '请先选择至少一个模块', true);
      return { handled: true };
    }
    const rows = await env.DB.prepare(
      `SELECT * FROM v_pending_reviews WHERE id IN (${selected.map(() => '?').join(',')})`,
    )
      .bind(...selected)
      .all<PendingRow>();

    const pendingRows = (rows.results ?? []).filter((r) => r.status === 'pending');
    if (pendingRows.length === 0) {
      await clearSelection(env.DB, chatId);
      await answer(token, callbackId, '所选条目都已处理', true);
      await showOverview(env, token, chatId, messageId);
      return { handled: true };
    }

    const { text, keyboard } = renderConfirm({ action, rows: pendingRows });
    await answer(token, callbackId, '');
    await postOrEdit(env, token, chatId, messageId, text, keyboard);
    return { handled: true };
  }

  // ---- cancel from the confirmation page
  if (data === 'no') {
    const state = await getState(env.DB, chatId);
    await answer(token, callbackId, '已取消');
    await showList(env, token, chatId, state.page, messageId);
    return { handled: true };
  }

  // ---- execute the batch
  if (data.startsWith('yes:')) {
    const action = data.slice(4) as 'approve' | 'reject';
    if (action !== 'approve' && action !== 'reject') {
      await answer(token, callbackId, '未知操作');
      return { handled: true };
    }
    const selected = [...(await getSelection(env.DB, chatId))];
    if (selected.length === 0) {
      await answer(token, callbackId, '没有选中任何模块', true);
      await showOverview(env, token, chatId, messageId);
      return { handled: true };
    }

    const result = await runBatch(env.DB, {
      ids: selected,
      action,
      operator,
      source: 'telegram',
      reason: action === 'reject' ? 'Telegram 批量拒绝' : undefined,
      decideThirdParty: deps.decideThirdParty,
      decideFirstParty: deps.decideFirstParty,
    });

    await clearSelection(env.DB, chatId);
    // Selections that survived the batch (already approved elsewhere, or a
    // delete task that cannot be bulk-decided) are dropped too, so the next
    // "confirm" cannot re-submit a stale id.
    await env.DB.prepare(
      `DELETE FROM tg_review_selection
        WHERE chat_id = ?
          AND review_id NOT IN (SELECT id FROM v_pending_reviews WHERE status = 'pending')`,
    )
      .bind(chatId)
      .run();
    const { text, keyboard } = renderResult(result);
    await answer(token, callbackId, `成功 ${result.succeeded} 项`);
    await postOrEdit(env, token, chatId, messageId, text, keyboard);
    return { handled: true, result: { ...result } };
  }

  return null;
}
