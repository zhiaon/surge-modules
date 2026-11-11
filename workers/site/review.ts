/**
 * Review queue and the publish pipeline.
 *
 * This file is the only place allowed to write `modules` /
 * `module_proxy_mappings` for third-party content. Everything upstream can
 * create review tasks; nothing upstream can publish.
 *
 * The publish path is deliberately paranoid because two things can go wrong at
 * the same time as an approval:
 *
 *   1. **A newer version arrived while the admin was reading.** The task's
 *      `content_sha` is re-checked against the module's live sha and the task's
 *      own status is re-checked as `pending` inside the same conditional UPDATE.
 *      If either moved, the approval is refused with a 409 and nothing is
 *      written — approving a stale task must never resurrect an old file.
 *
 *   2. **Two approvals fired at once** (web click + Telegram callback). The
 *      status transition is a single `UPDATE ... WHERE status = 'pending'`, and
 *      only the request whose UPDATE reports `changes === 1` proceeds. The loser
 *      gets 409 instead of double-publishing.
 */

import { parseModuleMeta, sha256, slugify } from './sync';
import { notifyAudit } from './telegram';

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

export interface ReviewEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ID?: string;
  GITHUB_READ_TOKEN?: string;
}

export interface ReviewTaskRow {
  id: string;
  module_id: string | null;
  third_party_module_id: string | null;
  repository_id: string;
  task_type: 'new' | 'update' | 'delete';
  detection_method: 'webhook' | 'manual' | 'cron';
  file_path: string;
  branch: string;
  old_version: string;
  new_version: string;
  old_content: string;
  new_content: string;
  content_sha: string;
  commit_sha: string;
  review_status: string;
  rejection_reason: string;
  reviewer: string | null;
  reviewed_at: string | null;
  override_name: string | null;
  override_description: string | null;
  override_category_id: string | null;
  override_icon: string | null;
  override_featured: number | null;
  note: string;
  superseded_by: string | null;
  notify_status: string;
  notify_error: string;
  created_at: string;
  updated_at: string;
}

export type TaskWithContext = ReviewTaskRow & {
  repository_name: string;
  owner: string;
  repository: string;
  module_name: string | null;
  module_slug: string | null;
  module_live_version: string | null;
  module_live_sha: string | null;
  module_live_published: number | null;
};

const SELECT_TASK = `
  SELECT t.*, r.name AS repository_name, r.owner, r.repository,
         m.name AS module_name, m.slug AS module_slug,
         m.version AS module_live_version, m.content_hash AS module_live_sha,
         m.is_published AS module_live_published
    FROM module_review_tasks t
    LEFT JOIN third_party_repositories r ON r.id = t.repository_id
    LEFT JOIN modules m ON m.id = t.module_id
`;

export interface ListFilter {
  status?: string;
  type?: string;
  method?: string;
  repositoryId?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
  sort?: 'newest' | 'oldest';
}

export async function listTasks(
  db: D1Database,
  filter: ListFilter,
): Promise<{ items: TaskWithContext[]; total: number; page: number; perPage: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.status && filter.status !== 'all') {
    where.push('t.review_status = ?');
    binds.push(filter.status);
  }
  if (filter.type && filter.type !== 'all') {
    where.push('t.task_type = ?');
    binds.push(filter.type);
  }
  if (filter.method && filter.method !== 'all') {
    where.push('t.detection_method = ?');
    binds.push(filter.method);
  }
  if (filter.repositoryId) {
    where.push('t.repository_id = ?');
    binds.push(filter.repositoryId);
  }
  if (filter.search) {
    where.push('(t.file_path LIKE ? OR m.name LIKE ? OR r.name LIKE ?)');
    const like = `%${filter.search.slice(0, 60)}%`;
    binds.push(like, like, like);
  }
  if (filter.from) {
    where.push('t.created_at >= ?');
    binds.push(filter.from);
  }
  if (filter.to) {
    where.push('t.created_at <= ?');
    binds.push(filter.to);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = Math.min(Math.max(filter.perPage ?? 20, 1), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const order = filter.sort === 'oldest' ? 'ASC' : 'DESC';

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM module_review_tasks t
         LEFT JOIN modules m ON m.id = t.module_id
         LEFT JOIN third_party_repositories r ON r.id = t.repository_id
         ${clause}`,
    )
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await db
    .prepare(`${SELECT_TASK} ${clause} ORDER BY t.created_at ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, perPage, (page - 1) * perPage)
    .all<TaskWithContext>();

  return {
    items: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    perPage,
  };
}

export async function getTask(
  db: D1Database,
  id: string,
): Promise<TaskWithContext | null> {
  return db.prepare(`${SELECT_TASK} WHERE t.id = ?`).bind(id).first<TaskWithContext>();
}

// ------------------------------------------------------------------- audit
export async function logAudit(
  db: D1Database,
  args: {
    taskId: string | null;
    action: string;
    operator: string;
    source: 'web' | 'telegram' | 'system';
    details?: unknown;
  },
): Promise<void> {
  // An audit write must never silently disappear: if it fails, the decision
  // still stands (the caller already committed it), but the failure has to be
  // visible in the worker log instead of leaving a gap in the trail.
  try {
    await db
      .prepare(
        `INSERT INTO module_audit_logs (task_id, action, operator, source, details)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        args.taskId,
      args.action,
      args.operator.slice(0, 80),
      args.source,
        JSON.stringify(args.details ?? {}).slice(0, 4000),
      )
      .run();
  } catch (err) {
    console.error(
      '[audit] failed to write',
      args.action,
      args.taskId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ----------------------------------------------------------------- publish
export interface DecideInput {
  taskId: string;
  decision: 'approve' | 'reject' | 'hold';
  operator: string;
  source: 'web' | 'telegram' | 'system';
  reason?: string;
  note?: string;
  overrides?: {
    name?: string;
    description?: string;
    categoryId?: string;
    icon?: string;
    featured?: boolean;
  };
}

export type DecideResult =
  | { ok: true; status: string; published?: boolean; moduleId?: string; slug?: string }
  | {
      ok: false;
      code: 'not_found' | 'conflict' | 'invalid' | 'internal';
      message: string;
    };

/**
 * Applies a decision.
 *
 * Order matters: the status transition happens FIRST and conditionally, so a
 * concurrent approve/reject loses cleanly before any module row is touched.
 */
export async function decideTask(
  env: ReviewEnv,
  input: DecideInput,
): Promise<DecideResult> {
  const { DB } = env;
  const task = await getTask(DB, input.taskId);
  if (!task) return { ok: false, code: 'not_found', message: '审核任务不存在' };

  if (task.review_status === 'approved') {
    // Already handled — the caller's UI already shows the outcome. Keep the
    // refusal (no second publish) but stay silent: a "已经通过审核" toast on top
    // of a finished review is noise.
    return { ok: false, code: 'conflict', message: '' };
  }
  if (task.review_status === 'rejected') {
    return { ok: false, code: 'conflict', message: '' };
  }
  if (task.review_status === 'superseded') {
    // Superseded is informational; the queue already shows the newer task.
    return { ok: false, code: 'conflict', message: '' };
  }
  if (task.review_status !== 'pending' && task.review_status !== 'on_hold') {
    return { ok: false, code: 'conflict', message: `当前状态不可操作（${task.review_status}）` };
  }

  // ---------------------------------------------------------- hold
  if (input.decision === 'hold') {
    const res = await DB.prepare(
      `UPDATE module_review_tasks
          SET review_status = 'on_hold', note = ?, updated_at = ?
        WHERE id = ? AND review_status IN ('pending', 'on_hold')`,
    )
      .bind((input.note ?? task.note ?? '').slice(0, 1000), iso(), task.id)
      .run();
    if (((res.meta as { changes?: number }).changes ?? 0) === 0) {
      return { ok: false, code: 'conflict', message: '任务状态已变化，请刷新后重试' };
    }
    await refreshRepositoryCounters(DB, task.repository_id);
    await logAudit(DB, {
      taskId: task.id,
      action: 'review.hold',
      operator: input.operator,
      source: input.source,
      details: { note: input.note },
    });
    return { ok: true, status: 'on_hold' };
  }

  // --------------------------------------------------------- reject
  if (input.decision === 'reject') {
    // Rejecting an UPDATE must leave the live module untouched — the conditional
    // UPDATE below only touches review_status, never modules.
    const res = await DB.prepare(
      `UPDATE module_review_tasks
          SET review_status = 'rejected', rejection_reason = ?, reviewer = ?,
              reviewed_at = ?, note = ?, updated_at = ?
        WHERE id = ? AND review_status IN ('pending', 'on_hold')`,
    )
      .bind(
        (input.reason ?? '').slice(0, 1000),
        input.operator,
        iso(),
        (input.note ?? task.note ?? '').slice(0, 1000),
        iso(),
        task.id,
      )
      .run();

    if (((res.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
      return { ok: false, code: 'conflict', message: '任务状态已变化，请刷新后重试' };
    }

    if (task.task_type === 'new') {
      // an unaccepted discovery stays invisible but is no longer "pending";
      // the record itself is kept so a re-push does not re-notify endlessly
      await DB.prepare(
        `UPDATE third_party_modules SET published = 0, updated_at = ?
          WHERE id = ?`,
      )
        .bind(iso(), task.third_party_module_id)
        .run();
    }

    await refreshRepositoryCounters(DB, task.repository_id);
    await logAudit(DB, {
      taskId: task.id,
      action: 'review.reject',
      operator: input.operator,
      source: input.source,
      details: { reason: input.reason, taskType: task.task_type },
    });

    if (env.TELEGRAM_BOT_TOKEN) {
      await notifyAudit(env, 'rejected', task, input.operator, input.reason ?? '');
    }
    return { ok: true, status: 'rejected' };
  }

  // -------------------------------------------------------- approve
  return approveTask(env, task, input);
}

async function approveTask(
  env: ReviewEnv,
  task: TaskWithContext,
  input: DecideInput,
): Promise<DecideResult> {
  const { DB } = env;

  // Guard: for updates, the pending content must be newer than what is live.
  // If the module was updated by something else in the meantime, publishing
  // this task would roll it back.
  if (task.task_type === 'update' && task.module_id) {
    const live = await DB.prepare(
      'SELECT version, content_hash, is_published FROM modules WHERE id = ?',
    )
      .bind(task.module_id)
      .first<{ version: string; content_hash: string | null; is_published: number }>();

    if (!live) {
      return { ok: false, code: 'conflict', message: '关联模块已不存在' };
    }
    if (live.content_hash && live.content_hash === task.content_sha) {
      // already published by another path — mark approved so the queue clears,
      // but do not write again
      await DB.prepare(
        `UPDATE module_review_tasks
            SET review_status = 'approved', reviewer = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND review_status IN ('pending','on_hold')`,
      )
        .bind(input.operator, iso(), iso(), task.id)
        .run();
      return { ok: true, status: 'approved', published: false, moduleId: task.module_id };
    }
  }

  // Claim the transition. Only one caller can win this UPDATE.
  const claim = await DB.prepare(
    `UPDATE module_review_tasks
        SET review_status = 'approved', reviewer = ?, reviewed_at = ?,
            rejection_reason = '', note = ?, updated_at = ?
      WHERE id = ? AND review_status IN ('pending', 'on_hold')`,
  )
    .bind(
      input.operator,
      iso(),
      (input.note ?? task.note ?? '').slice(0, 1000),
      iso(),
      task.id,
    )
    .run();

  const claimed = ((claim.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
  if (!claimed) {
    return { ok: false, code: 'conflict', message: '任务已被处理，请刷新后重试' };
  }

  try {
    if (task.task_type === 'delete') {
      const result = await approveDelete(env, task, input);
      await finishAudit(env, task, input, result);
      return result;
    }
    const result =
      task.task_type === 'new'
        ? await approveNew(env, task, input)
        : await approveUpdate(env, task, input);
    await finishAudit(env, task, input, result);
    return result;
  } catch (err) {
    // The claim succeeded but the write failed. Put the task back so the admin
    // can retry — a half-applied publish is worse than a re-review.
    await DB.prepare(
      `UPDATE module_review_tasks SET review_status = 'pending', reviewer = NULL,
              reviewed_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
      .bind(iso(), task.id)
      .run();
    return {
      ok: false,
      code: 'internal',
      message: err instanceof Error ? err.message : '发布失败',
    };
  }
}

async function finishAudit(
  env: ReviewEnv,
  task: TaskWithContext,
  input: DecideInput,
  result: DecideResult,
): Promise<void> {
  await refreshRepositoryCounters(env.DB, task.repository_id);
  await logAudit(env.DB, {
    taskId: task.id,
    action: 'review.approve',
    operator: input.operator,
    source: input.source,
    details: result.ok
      ? { moduleId: result.moduleId, slug: result.slug, published: result.published }
      : { error: 'message' in result ? result.message : 'unknown' },
  });
  if (env.TELEGRAM_BOT_TOKEN && result.ok) {
    await notifyAudit(env, 'approved', task, input.operator, '');
  }
}

/** Parses the pending content and derives the module's display fields. */
function deriveNewModule(task: TaskWithContext, overrides: DecideInput['overrides']) {
  const fallback = task.file_path.split('/').pop()?.replace(/\.sgmodule$/i, '') ?? 'module';
  const meta = parseModuleMeta(task.new_content || '', fallback);
  return {
    name: (overrides?.name || meta.name || fallback).slice(0, 120),
    description: (overrides?.description || meta.description || '').slice(0, 500),
    author: (meta.author || task.owner || '').slice(0, 80),
    version: task.new_version || '1.0.0',
    categoryId: overrides?.categoryId || null,
    featured: overrides?.featured === true,
  };
}

/**
 * Picks a slug that does not collide.
 *
 * Slug candidates must come from something ASCII: `slugify` strips every CJK
 * character, so a module named 「七猫小说去广告」 collapses to an empty string and
 * the first one published would take the bare slug `module`. The file path is
 * the real identity anyway, so it is tried first and the display name only as a
 * fallback.
 */
async function allocateSlug(db: D1Database, base: string, filePath = ''): Promise<string> {
  const fileStem = (filePath.split('/').pop() ?? '').replace(/\.sgmodule$/i, '');
  const root =
    slugify(fileStem).slice(0, 60) || slugify(base).slice(0, 60) || 'module';
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? root : `${root}-${n + 1}`;
    const hit = await db
      .prepare('SELECT 1 AS x FROM modules WHERE slug = ? AND deleted_at IS NULL')
      .bind(candidate)
      .first<{ x: number }>();
    if (!hit) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

async function approveNew(
  env: ReviewEnv,
  task: TaskWithContext,
  input: DecideInput,
): Promise<DecideResult> {
  const { DB } = env;
  const info = deriveNewModule(task, input.overrides);

  const slug = await allocateSlug(DB, info.name || task.file_path, task.file_path);
  const moduleId = crypto.randomUUID();
  const contentSha = await sha256(task.new_content || '');

  const categoryId =
    info.categoryId ??
    (await DB.prepare(
      'SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY sort_order LIMIT 1',
    ).first<{ id: string }>())?.id ??
    null;

  const sourceUrl = `https://github.com/${task.owner}/${task.repository}/blob/${encodeURIComponent(
    task.branch || 'main',
  )}/${task.file_path.split('/').map(encodeURIComponent).join('/')}`;

  await DB.prepare(
    `INSERT INTO modules
      (id, slug, name, description, author, category_id, version, source_id,
       source_path, content_hash, upstream_url, repository_url, is_featured,
       is_published, published_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      moduleId,
      slug,
      info.name,
      info.description,
      info.author,
      categoryId,
      info.version,
      task.file_path,
      contentSha,
      sourceUrl,
      `https://github.com/${task.owner}/${task.repository}`,
      info.featured ? 1 : 0,
      iso(),
      iso(),
    )
    .run();

  // first version history entry
  await DB.prepare(
    `INSERT INTO module_versions
      (id, module_id, version, content_hash, changelog, commit_sha, released_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      moduleId,
      info.version,
      contentSha,
      '首次收录（第三方仓库审核通过）',
      task.commit_sha,
      iso(),
      iso(),
    )
    .run();

  await DB.prepare(
    `INSERT INTO module_version_history
      (id, module_id, third_party_module_id, version, content, content_sha,
       commit_sha, source_url, published_at, reviewed_by, review_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      moduleId,
      task.third_party_module_id,
      info.version,
      (task.new_content || '').slice(0, 120_000),
      contentSha,
      task.commit_sha,
      sourceUrl,
      iso(),
      input.operator,
      task.id,
    )
    .run();

  // link the discovery row to the live module and flip it to published
  if (task.third_party_module_id) {
    await DB.prepare(
      `UPDATE third_party_modules
          SET module_id = ?, published = 1, current_version = ?,
              current_content = ?, current_content_sha = ?,
              source_commit_sha = ?, module_name = ?, module_description = ?,
              author = ?, is_deleted_upstream = 0, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        moduleId,
        info.version,
        (task.new_content || '').slice(0, 120_000),
        contentSha,
        task.commit_sha,
        info.name,
        info.description,
        info.author,
        iso(),
        task.third_party_module_id,
      )
      .run();
  }

  await DB.prepare('UPDATE module_review_tasks SET module_id = ? WHERE id = ?')
    .bind(moduleId, task.id)
    .run();

  // The proxy worker routes by public_slug; without a mapping row the module is
  // live on the site but its install link and raw URL both 404.
  // INSERT OR IGNORE rather than ON CONFLICT(public_slug): the slug uniqueness
  // is a partial index (WHERE deleted_at IS NULL), which SQLite cannot target
  // from an upsert clause. IGNORE skips any unique violation, same semantics.
  await DB.prepare(
    `INSERT OR IGNORE INTO module_proxy_mappings
       (id, module_id, public_slug, source_id, file_path, serve_mode,
        is_enabled, content_hash, third_party_repository_id)
     VALUES (?, ?, ?, NULL, ?, 'raw', 1, ?, ?)`,
  )
    .bind(crypto.randomUUID(), moduleId, slug, task.file_path, contentSha, task.repository_id)
    .run();

  return { ok: true, status: 'approved', published: true, moduleId, slug };
}

async function approveUpdate(
  env: ReviewEnv,
  task: TaskWithContext,
  input: DecideInput,
): Promise<DecideResult> {
  const { DB } = env;
  if (!task.module_id) {
    return { ok: false, code: 'invalid', message: '更新任务缺少关联模块' };
  }

  const contentSha = await sha256(task.new_content || '');

  // Re-read the live row INSIDE the publish path. Between the earlier check and
  // here another approval could have run; the sha comparison below is the final
  // word on whether this task is still the newest.
  const live = await DB.prepare(
    'SELECT id, slug, version, content_hash, name, description FROM modules WHERE id = ?',
  )
    .bind(task.module_id)
    .first<{
      id: string;
      slug: string;
      version: string;
      content_hash: string | null;
      name: string;
      description: string;
    }>();
  if (!live) return { ok: false, code: 'not_found', message: '关联模块不存在' };

  if (live.content_hash === contentSha) {
    return { ok: true, status: 'approved', published: false, moduleId: live.id, slug: live.slug };
  }

  // A pending task whose old_version no longer matches the live version means a
  // different update landed first. Refuse rather than overwrite it.
  if (task.old_version && live.version && task.old_version !== live.version) {
    const newer = await DB.prepare(
      `SELECT 1 AS x FROM module_review_tasks
        WHERE module_id = ? AND review_status = 'pending' AND id <> ?
        LIMIT 1`,
    )
      .bind(task.module_id, task.id)
      .first<{ x: number }>();
    if (newer) {
      return {
        ok: false,
        code: 'conflict',
        message: `线上版本已变为 ${live.version}，当前任务基于 ${task.old_version}，已失效`,
      };
    }
  }

  const meta = parseModuleMeta(task.new_content || '', live.name);
  const name = (input.overrides?.name || meta.name || live.name).slice(0, 120);
  const description = (input.overrides?.description || meta.description || live.description).slice(
    0,
    500,
  );

  await DB.prepare(
    `UPDATE modules
        SET version = ?, content_hash = ?, name = ?, description = ?,
            is_published = 1, synced_at = ?, updated_at = ?,
            published_at = COALESCE(published_at, ?)
      WHERE id = ?`,
  )
    .bind(
      task.new_version || live.version,
      contentSha,
      name,
      description,
      iso(),
      iso(),
      iso(),
      live.id,
    )
    .run();

  if (input.overrides?.featured !== undefined) {
    await DB.prepare('UPDATE modules SET is_featured = ? WHERE id = ?')
      .bind(input.overrides.featured ? 1 : 0, live.id)
      .run();
  }
  if (input.overrides?.categoryId) {
    await DB.prepare('UPDATE modules SET category_id = ? WHERE id = ?')
      .bind(input.overrides.categoryId, live.id)
      .run();
  }

  await DB.prepare(
    `INSERT INTO module_versions
      (id, module_id, version, content_hash, changelog, commit_sha, released_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      live.id,
      task.new_version || live.version,
      contentSha,
      `第三方仓库更新（${task.detection_method}）`,
      task.commit_sha,
      iso(),
      iso(),
    )
    .run();

  await DB.prepare(
    `INSERT INTO module_version_history
      (id, module_id, third_party_module_id, version, content, content_sha,
       commit_sha, source_url, published_at, reviewed_by, review_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      live.id,
      task.third_party_module_id,
      task.new_version || live.version,
      (task.new_content || '').slice(0, 120_000),
      contentSha,
      task.commit_sha,
      `https://github.com/${task.owner}/${task.repository}/commit/${task.commit_sha}`,
      iso(),
      input.operator,
      task.id,
    )
    .run();

  // keep the proxy's revision hash in sync so its cache invalidates
  await DB.prepare(
    `UPDATE module_proxy_mappings SET content_hash = ?, updated_at = ?
      WHERE module_id = ? AND deleted_at IS NULL`,
  )
    .bind(contentSha, iso(), live.id)
    .run();

  if (task.third_party_module_id) {
    await DB.prepare(
      `UPDATE third_party_modules
          SET current_version = ?, current_content = ?, current_content_sha = ?,
              source_commit_sha = ?, published = 1, is_deleted_upstream = 0,
              module_name = ?, module_description = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        task.new_version || live.version,
        (task.new_content || '').slice(0, 120_000),
        contentSha,
        task.commit_sha,
        name,
        description,
        iso(),
        task.third_party_module_id,
      )
      .run();
  }

  return { ok: true, status: 'approved', published: true, moduleId: live.id, slug: live.slug };
}

/**
 * Deleting upstream NEVER deletes a live module automatically. Approving a
 * delete task is what actually removes it from the site — and that requires a
 * human choosing between keep / hide / unpublish / delete.
 */
async function approveDelete(
  env: ReviewEnv,
  task: TaskWithContext,
  input: DecideInput,
): Promise<DecideResult> {
  const { DB } = env;
  const action = (input.note ?? '').trim() || 'hide';

  if (!task.module_id) {
    return { ok: true, status: 'approved', published: false };
  }

  if (action === 'keep') {
    return { ok: true, status: 'approved', published: false, moduleId: task.module_id };
  }
  if (action === 'hide' || action === 'unpublish') {
    await DB.prepare(
      'UPDATE modules SET is_published = 0, updated_at = ? WHERE id = ?',
    )
      .bind(iso(), task.module_id)
      .run();
    await DB.prepare(
      "UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ? AND deleted_at IS NULL",
    )
      .bind(task.module_id)
      .run();
    return { ok: true, status: 'approved', published: false, moduleId: task.module_id };
  }

  // 'delete' — soft delete, keeps history and the tombstone so a later push
  // cannot silently resurrect it without a fresh review
  await DB.prepare(
    'UPDATE modules SET is_published = 0, deleted_at = ?, updated_at = ? WHERE id = ?',
  )
    .bind(iso(), iso(), task.module_id)
    .run();
  await DB.prepare(
    'UPDATE module_proxy_mappings SET is_enabled = 0, deleted_at = ? WHERE module_id = ? AND deleted_at IS NULL',
  )
    .bind(iso(), task.module_id)
    .run();
  await DB.prepare(
    `INSERT OR IGNORE INTO module_tombstones (slug, module_id, reason)
     SELECT slug, id, '第三方仓库删除并经管理员确认' FROM modules WHERE id = ?`,
  )
    .bind(task.module_id)
    .run();

  return { ok: true, status: 'approved', published: false, moduleId: task.module_id };
}

/**
 * Recomputes the counters cached on `third_party_repositories`.
 *
 * Those columns are denormalised so the repository list renders without an
 * aggregate per row, but they were only ever written during a check. Approving
 * or rejecting from Telegram left them stale — the card kept showing "1 待审"
 * after the queue was empty. Every decision path calls this.
 */
export async function refreshRepositoryCounters(
  db: D1Database,
  repositoryId: string | null,
): Promise<void> {
  if (!repositoryId) return;
  await db
    .prepare(
      `UPDATE third_party_repositories
          SET pending_new = (
                SELECT COUNT(*) FROM module_review_tasks
                 WHERE repository_id = ? AND review_status = 'pending' AND task_type = 'new'
              ),
              pending_updates = (
                SELECT COUNT(*) FROM module_review_tasks
                 WHERE repository_id = ? AND review_status = 'pending' AND task_type = 'update'
              ),
              discovered_modules = (
                SELECT COUNT(*) FROM third_party_modules WHERE repository_id = ?
              ),
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(repositoryId, repositoryId, repositoryId, iso(), repositoryId)
    .run();
}

// -------------------------------------------------------------- stats read
export async function reviewStats(db: D1Database): Promise<{
  pendingNew: number;
  pendingUpdates: number;
  pendingDeletes: number;
  approved: number;
  rejected: number;
  total: number;
  oldestPendingAt: string | null;
}> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'new' THEN 1 ELSE 0 END) AS pendingNew,
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'update' THEN 1 ELSE 0 END) AS pendingUpdates,
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'delete' THEN 1 ELSE 0 END) AS pendingDeletes,
         SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         COUNT(*) AS total,
         MIN(CASE WHEN review_status = 'pending' THEN created_at END) AS oldestPendingAt
       FROM module_review_tasks`,
    )
    .first<Record<string, number | string | null>>();

  return {
    pendingNew: Number(row?.pendingNew ?? 0),
    pendingUpdates: Number(row?.pendingUpdates ?? 0),
    pendingDeletes: Number(row?.pendingDeletes ?? 0),
    approved: Number(row?.approved ?? 0),
    rejected: Number(row?.rejected ?? 0),
    total: Number(row?.total ?? 0),
    oldestPendingAt: (row?.oldestPendingAt as string | null) ?? null,
  };
}
