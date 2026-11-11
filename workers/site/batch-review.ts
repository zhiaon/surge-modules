/**
 * Batch review across both queues.
 *
 * There are two independent review stores (first-party `review_items`,
 * third-party `module_review_tasks`) with two independent publish paths. This
 * module is the only place that knows how to talk to both, so the Telegram bot
 * and any future batch API share one implementation instead of growing two.
 *
 * Invariants:
 *   - **Never trust a selection.** Every id is re-read from the view; a task
 *     that moved to approved/rejected between rendering and clicking is
 *     reported as `skipped`, not re-applied.
 *   - **Per-item isolation.** One failure never aborts the batch; each item
 *     carries its own outcome and the summary counts all three states.
 *   - **The publish logic is not duplicated.** Delegating to `decideTask` /
 *     `decideFirstParty` means a batch approve produces byte-for-byte the same
 *     side effects as a single approve (mapping, version history, counters).
 */

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

export type ReviewQueue = 'third_party' | 'first_party';

export interface PendingRow {
  id: string;
  queue: ReviewQueue;
  name: string;
  kind: string;
  version: string;
  repository: string;
  repository_url: string;
  raw_url: string;
  status: string;
  created_at: string;
  detection_method: string;
  reviewer: string;
  reviewed_at: string | null;
  repository_id: string | null;
  module_id: string | null;
}

export interface BatchDetail {
  id: string;
  queue: ReviewQueue;
  name: string;
  ok: boolean;
  /** 'applied' | 'skipped' | 'failed' */
  outcome: 'applied' | 'skipped' | 'failed';
  message?: string;
}

export interface BatchResult {
  batchId: string;
  action: 'approve' | 'reject';
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  detail: BatchDetail[];
}

/** Counts for the queue header. Delete tasks are surfaced separately. */
export async function pendingCounts(db: D1Database): Promise<{
  total: number;
  newCount: number;
  updateCount: number;
  deleteCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN status = 'pending' AND kind = 'new' THEN 1 ELSE 0 END) AS n,
         SUM(CASE WHEN status = 'pending' AND kind = 'update' THEN 1 ELSE 0 END) AS u,
         SUM(CASE WHEN status = 'pending' AND kind = 'delete' THEN 1 ELSE 0 END) AS d
       FROM v_pending_reviews`,
    )
    .first<Record<string, number | null>>();
  return {
    total: Number(row?.total ?? 0),
    newCount: Number(row?.n ?? 0),
    updateCount: Number(row?.u ?? 0),
    deleteCount: Number(row?.d ?? 0),
  };
}

/**
 * One page of pending rows.
 *
 * Delete tasks are excluded from the batch list on purpose: they need a
 * keep/hide/unpublish/delete choice per item, which cannot be expressed as a
 * bulk yes/no.
 */
export async function listPending(
  db: D1Database,
  opts: { page?: number; perPage?: number } = {},
): Promise<{ items: PendingRow[]; total: number; page: number; perPage: number; pages: number }> {
  const perPage = Math.min(Math.max(opts.perPage ?? 8, 1), 12);
  const page = Math.max(opts.page ?? 1, 1);

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM v_pending_reviews
        WHERE status = 'pending' AND kind IN ('new','update')`,
    )
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / perPage));

  const rows = await db
    .prepare(
      `SELECT * FROM v_pending_reviews
        WHERE status = 'pending' AND kind IN ('new','update')
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(perPage, (page - 1) * perPage)
    .all<PendingRow>();

  return { items: rows.results ?? [], total, page, perPage, pages };
}

/** Reads a set of ids, filtered to ones that are still pending. */
export async function selectPending(
  db: D1Database,
  ids: string[],
): Promise<PendingRow[]> {
  if (ids.length === 0) return [];
  // D1 caps SQL variables per statement, so chunks of 90 keep well inside the
  // limit for any batch size the API accepts (≤200 ids → ≤3 chunks).
  const unique = [...new Set(ids)];
  const CHUNK = 90;
  const rows: PendingRow[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT * FROM v_pending_reviews WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<PendingRow>();
    rows.push(...(res.results ?? []));
  }
  return rows;
}

/**
 * Executes one batch.
 *
 * `decideThirdParty` and `decideFirstParty` are injected so this file has no
 * import cycle with review.ts / admin.ts and so tests can drive it directly.
 */
export async function runBatch(
  db: D1Database,
  opts: {
    ids: string[];
    action: 'approve' | 'reject';
    operator: string;
    source: 'web' | 'telegram';
    reason?: string;
    decideThirdParty: (taskId: string) => Promise<{ ok: boolean; message?: string; published?: boolean }>;
    decideFirstParty: (reviewId: string) => Promise<{ ok: boolean; message?: string }>;
  },
): Promise<BatchResult> {
  const batchId = crypto.randomUUID();
  const rows = await selectPending(db, opts.ids);

  // ids that were requested but are not in the view at all (deleted, or already
  // resolved) are reported as skipped rather than silently dropped
  const found = new Set(rows.map((r) => r.id));
  const missing = opts.ids.filter((id) => !found.has(id));

  const detail: BatchDetail[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = missing.length;

  for (const id of missing) {
    detail.push({ id, queue: 'third_party', name: '(已不存在)', ok: false, outcome: 'skipped' });
  }

  for (const row of rows) {
    if (row.status !== 'pending') {
      skipped += 1;
      detail.push({
        id: row.id,
        queue: row.queue,
        name: row.name,
        ok: false,
        outcome: 'skipped',
        message: `状态已是 ${row.status}`,
      });
      continue;
    }
    if (row.kind === 'delete') {
      // A delete task cannot be bulk-approved: the four choices are not a yes/no.
      skipped += 1;
      detail.push({
        id: row.id,
        queue: row.queue,
        name: row.name,
        ok: false,
        outcome: 'skipped',
        message: '删除任务需逐条选择处理方式',
      });
      continue;
    }

    try {
      const res =
        row.queue === 'third_party'
          ? await opts.decideThirdParty(row.id)
          : await opts.decideFirstParty(row.id);

      if (res.ok) {
        succeeded += 1;
        detail.push({ id: row.id, queue: row.queue, name: row.name, ok: true, outcome: 'applied' });
      } else {
        failed += 1;
        detail.push({
          id: row.id,
          queue: row.queue,
          name: row.name,
          ok: false,
          outcome: 'failed',
          message: res.message,
        });
      }
    } catch (err) {
      failed += 1;
      detail.push({
        id: row.id,
        queue: row.queue,
        name: row.name,
        ok: false,
        outcome: 'failed',
        message: err instanceof Error ? err.message : '处理异常',
      });
    }
  }

  const result: BatchResult = {
    batchId,
    action: opts.action,
    total: opts.ids.length,
    succeeded,
    failed,
    skipped,
    detail,
  };

  await db
    .prepare(
      `INSERT INTO review_batches
        (id, action, source, operator, total, succeeded, failed, skipped, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      batchId,
      opts.action,
      opts.source,
      opts.operator.slice(0, 80),
      result.total,
      succeeded,
      failed,
      skipped,
      JSON.stringify(detail).slice(0, 20_000),
    )
    .run();

  return result;
}

/** Recent batch history for the admin panel. */
export async function listBatches(
  db: D1Database,
  limit = 20,
): Promise<
  Array<{
    id: string;
    action: string;
    source: string;
    operator: string;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    created_at: string;
  }>
> {
  const rows = await db
    .prepare(
      `SELECT id, action, source, operator, total, succeeded, failed, skipped, created_at
         FROM review_batches ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((r) => ({
    id: String(r.id),
    action: String(r.action),
    source: String(r.source),
    operator: String(r.operator),
    total: Number(r.total ?? 0),
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    skipped: Number(r.skipped ?? 0),
    created_at: String(r.created_at),
  }));
}

/** Human-readable line for one decision outcome. */
export function describeOutcome(r: BatchResult): string {
  const verb = r.action === 'approve' ? '通过' : '拒绝';
  const lines = [
    `操作：批量${verb}`,
    `成功：${r.succeeded} 项`,
    `失败：${r.failed} 项`,
    `跳过：${r.skipped} 项`,
  ];
  const problems = r.detail.filter((d) => !d.ok && d.message).slice(0, 4);
  if (problems.length > 0) {
    lines.push('', '注意：');
    for (const p of problems) lines.push(`· ${p.name}：${p.message}`);
  }
  return lines.join('\n');
}

export { iso };
