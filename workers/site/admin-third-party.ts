/**
 * Third-party repository admin API + webhook receiver.
 *
 * Mounted from admin.ts under /admin/third-party/*, and from index.ts at
 * /webhook/github/:repositoryId.
 *
 * Everything here runs AFTER `requireAdmin` (except the webhook, which is
 * authenticated by HMAC). No handler trusts a body value for identity: repository
 * ids are re-read from D1, and a task's status is re-checked inside review.ts.
 */

import { jsonError, jsonOk, methodNotAllowed } from '../../packages/shared/src/http';
import {
  createReviewTask,
  decryptSecret,
  encryptSecret,
  fetchRepoInfo,
  getRepository,
  ghRequest,
  inspectRepository,
  listRepositories,
  listSgmoduleFiles,
  parseRepoUrl,
  readJsonCapped,
  recordCheck,
  safeSegment,
  verifyGithubSignature,
  type CheckResult,
  type DetectionMethod,
  type RepositoryRow,
  type ThirdPartyEnv,
  addBudget,
  readBudget,
  D1_BUDGET_LIMIT,
  today as budgetToday,
} from './third-party';
import {
  decideTask,
  getTask,
  listTasks,
  logAudit,
  reviewStats,
  type DecideInput,
} from './review';
import { notifyOps } from './telegram';
import { credentialStatus, saveCredential, type CredentialName } from './credentials';

const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

export interface ThirdPartyCtx {
  db: D1Database;
  env: ThirdPartyEnv;
  admin: { id: string; username: string; role: string };
  request: Request;
  url: URL;
}

type Env = ThirdPartyEnv;

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const bool = (v: unknown, fallback = true): number => {
  if (v === undefined || v === null) return fallback ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '0' || v === 0 || v === 'false') return 0;
  return 1;
};

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/** Like num() but allows 0 (unlimited) and caps at 86400. */
const num0 = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), 86400);
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const capped = await readJsonCapped(request, 128 * 1024);
  if ('error' in capped) return null;
  const data = capped.data;
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)
    : null;
}

// =========================================================== repositories
export async function listRepos(ctx: ThirdPartyCtx): Promise<Response> {
  const repos = await listRepositories(ctx.db);
  const stats = await reviewStats(ctx.db);

  const rows = await Promise.all(
    repos.map(async (r) => {
      // Counters are computed live rather than read from the cached columns.
      // The cache is only refreshed by recordCheck, so a review completed via
      // Telegram (or any path that skips a scan) left the card showing a stale
      // "N 待审" for tasks that no longer existed.
      const counts = await ctx.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM third_party_modules
               WHERE repository_id = ?1 AND published = 1) AS published,
             (SELECT COUNT(*) FROM third_party_modules
               WHERE repository_id = ?1) AS total,
             (SELECT COUNT(*) FROM module_review_tasks
               WHERE repository_id = ?1 AND review_status = 'pending'
                 AND task_type = 'new') AS pending_new,
             (SELECT COUNT(*) FROM module_review_tasks
               WHERE repository_id = ?1 AND review_status = 'pending'
                 AND task_type = 'update') AS pending_updates`,
        )
        .bind(r.id)
        .first<{
          published: number;
          total: number;
          pending_new: number;
          pending_updates: number;
        }>();

      return {
        id: r.id,
        name: r.name,
        owner: r.owner,
        repository: r.repository,
        repositoryUrl: r.repository_url,
        defaultBranch: r.default_branch,
        description: r.description,
        categoryId: r.category_id,
        notes: r.notes,
        enabled: r.enabled === 1,
        webhookEnabled: r.webhook_enabled === 1,
        cronEnabled: r.cron_enabled === 1,
        manualCheckEnabled: r.manual_check_enabled === 1,
        hasWebhookSecret: Boolean(r.webhook_secret_enc),
        webhookSecretHint: r.webhook_secret_hint,
        checkIntervalHours: r.check_interval_hours,
        lastCheckedAt: r.last_checked_at,
        nextCheckAt: r.next_check_at,
        lastCheckStatus: r.last_check_status,
        lastCheckError: r.last_check_error,
        consecutiveFailures: r.consecutive_failures,
        autoReviewNew: r.auto_review_new === 1,
        autoReviewUpdate: r.auto_review_update === 1,
        discoveredModules: counts?.total ?? 0,
        publishedModules: counts?.published ?? 0,
        pendingNew: counts?.pending_new ?? 0,
        pendingUpdates: counts?.pending_updates ?? 0,
        createdAt: r.created_at,
      };
    }),
  );

  return jsonOk({
    items: rows,
    stats: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      disabled: rows.filter((r) => !r.enabled).length,
      discoveredModules: rows.reduce((s, r) => s + r.discoveredModules, 0),
      pendingNew: stats.pendingNew,
      pendingUpdates: stats.pendingUpdates,
      pendingDeletes: stats.pendingDeletes,
      lastCheckedAt:
        rows
          .map((r) => r.lastCheckedAt)
          .filter(Boolean)
          .sort()
          .pop() ?? null,
      lastCheckStatus:
        rows.find((r) => r.lastCheckedAt === rows.map((x) => x.lastCheckedAt).filter(Boolean).sort().pop())
          ?.lastCheckStatus ?? null,
    },
  });
}

export async function createRepo(ctx: ThirdPartyCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const input = str(body.repositoryUrl ?? body.url, 300);
  const parsed = parseRepoUrl(input);
  if (!parsed) {
    return jsonError('bad_request', '无法解析仓库地址，请填写 https://github.com/owner/repo');
  }

  const existing = await ctx.db
    .prepare(
      `SELECT id FROM third_party_repositories
        WHERE owner = ? AND repository = ? AND deleted_at IS NULL`,
    )
    .bind(parsed.owner, parsed.repo)
    .first<{ id: string }>();
  if (existing) return jsonError('conflict', '该仓库已存在');

  // Read the real default branch + description from GitHub rather than trusting
  // the form; a wrong branch silently produces zero files forever.
  const info = await fetchRepoInfo(parsed.owner, parsed.repo, ctx.env.GITHUB_READ_TOKEN);
  const defaultBranch =
    str(body.defaultBranch, 100) || (!('error' in info) ? info.info.defaultBranch : 'main');
  if (!safeSegment(defaultBranch)) return jsonError('bad_request', '分支名不合法');

  const id = crypto.randomUUID();
  const name =
    str(body.name, 120) || (!('error' in info) ? info.info.fullName : `${parsed.owner}/${parsed.repo}`);
  const description =
    str(body.description, 500) || (!('error' in info) ? info.info.description : '');

  await ctx.db
    .prepare(
      `INSERT INTO third_party_repositories
        (id, name, owner, repository, repository_url, default_branch, description,
         category_id, notes, enabled, webhook_enabled, cron_enabled,
         manual_check_enabled, check_interval_hours, next_check_at,
         auto_review_new, auto_review_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      name,
      parsed.owner,
      parsed.repo,
      parsed.url,
      defaultBranch,
      description,
      str(body.categoryId, 60) || null,
      str(body.notes, 1000),
      bool(body.enabled),
      bool(body.webhookEnabled),
      bool(body.cronEnabled),
      bool(body.manualCheckEnabled),
      num(body.checkIntervalHours, 6, 1, 720),
      iso(new Date(Date.now() + 6 * 3600_000)),
      // Auto-review is always ON for a newly added repository: discovery and
      // updates must land in the review queue without anyone remembering to
      // flip the switches afterwards. The edit form can still turn them off
      // per-repository later if a source proves too noisy.
      1,
      1,
    )
    .run();

  await logAudit(ctx.db, {
    taskId: null,
    action: 'repo.create',
    operator: ctx.admin.username,
    source: 'web',
    details: { repositoryId: id, repo: `${parsed.owner}/${parsed.repo}` },
  });

  return jsonOk({
    id,
    repositoryUrl: parsed.url,
    defaultBranch,
    repositoryWarning: 'error' in info ? info.error : undefined,
  });
}

export async function updateRepo(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (frag: string, value: unknown) => {
    sets.push(frag);
    binds.push(value);
  };

  if (body.name !== undefined) push('name = ?', str(body.name, 120) || repo.name);
  if (body.defaultBranch !== undefined) {
    const b = str(body.defaultBranch, 100);
    if (!b || !safeSegment(b)) return jsonError('bad_request', '分支名不合法');
    push('default_branch = ?', b);
  }
  if (body.description !== undefined) push('description = ?', str(body.description, 500));
  if (body.notes !== undefined) push('notes = ?', str(body.notes, 1000));
  if (body.categoryId !== undefined) push('category_id = ?', str(body.categoryId, 60) || null);
  if (body.enabled !== undefined) push('enabled = ?', bool(body.enabled));
  if (body.webhookEnabled !== undefined) push('webhook_enabled = ?', bool(body.webhookEnabled));
  if (body.cronEnabled !== undefined) push('cron_enabled = ?', bool(body.cronEnabled));
  if (body.manualCheckEnabled !== undefined)
    push('manual_check_enabled = ?', bool(body.manualCheckEnabled));
  if (body.checkIntervalHours !== undefined) {
    push('check_interval_hours = ?', num(body.checkIntervalHours, 6, 1, 720));
    push('next_check_at = ?', iso(new Date(Date.now() + num(body.checkIntervalHours, 6, 1, 720) * 3600_000)));
  }
  if (body.autoReviewNew !== undefined) push('auto_review_new = ?', bool(body.autoReviewNew));
  if (body.autoReviewUpdate !== undefined)
    push('auto_review_update = ?', bool(body.autoReviewUpdate));

  if (sets.length === 0) return jsonError('bad_request', '没有可更新的字段');

  push('updated_at = ?', iso());
  binds.push(id);

  await ctx.db
    .prepare(`UPDATE third_party_repositories SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(ctx.db, {
    taskId: null,
    action: 'repo.update',
    operator: ctx.admin.username,
    source: 'web',
    details: { repositoryId: id, fields: Object.keys(body) },
  });

  return jsonOk({ id });
}

/**
 * Deleting a repository config is a soft delete and NEVER deletes published
 * modules. `?purge=1` additionally hides its modules, which the UI must confirm
 * separately — the default leaves the live catalogue alone.
 */
export async function deleteRepo(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const confirm = ctx.request.headers.get('x-confirm-delete');
  if (confirm !== repo.repository) {
    return jsonError(
      'bad_request',
      `删除仓库需要确认：请在请求头 X-Confirm-Delete 填写仓库名「${repo.repository}」`,
    );
  }

  await ctx.db
    .prepare('UPDATE third_party_repositories SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?')
    .bind(iso(), iso(), id)
    .run();

  // pending tasks for a removed config are no longer actionable
  await ctx.db
    .prepare(
      `UPDATE module_review_tasks SET review_status = 'superseded', updated_at = ?
        WHERE repository_id = ? AND review_status IN ('pending','on_hold')`,
    )
    .bind(iso(), id)
    .run();

  // Deleting a repo ALWAYS removes every module it imported: the site owner's
  // mental model is "this source and everything from it". Modules are soft-
  // deleted (audit trail + tombstone semantics stay intact), their proxy
  // mappings stop resolving immediately, and the third_party_modules import
  // cache rows are physically removed so a re-add starts clean.
  let affected = 0;
  {
    // 1) unpublish + soft-delete the modules this repo created
    const res = await ctx.db
      .prepare(
        `UPDATE modules SET is_published = 0, deleted_at = ?, updated_at = ?
          WHERE deleted_at IS NULL
            AND id IN (SELECT module_id FROM third_party_modules
                        WHERE repository_id = ? AND module_id IS NOT NULL)`,
      )
      .bind(iso(), iso(), id)
      .run();
    affected = (res.meta as { changes?: number } | undefined)?.changes ?? 0;

    // 2) their proxy mappings stop resolving at once
    await ctx.db
      .prepare(
        `UPDATE module_proxy_mappings
            SET is_enabled = 0, deleted_at = ?, updated_at = ?
          WHERE deleted_at IS NULL
            AND module_id IN (SELECT module_id FROM third_party_modules
                               WHERE repository_id = ? AND module_id IS NOT NULL)`,
      )
      .bind(iso(), iso(), id)
      .run();

    // 3) drop the import cache rows for this repo
    await ctx.db
      .prepare('DELETE FROM third_party_modules WHERE repository_id = ?')
      .bind(id)
      .run();
  }

  await logAudit(ctx.db, {
    taskId: null,
    action: 'repo.delete',
    operator: ctx.admin.username,
    source: 'web',
    details: { repositoryId: id, purge: true, modulesHidden: affected },
  });

  return jsonOk({ id, purged: true, modulesHidden: affected });
}

/** Reads repo metadata again — used by 「验证」 to prove the token can see it. */
export async function verifyRepo(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const info = await fetchRepoInfo(repo.owner, repo.repository, ctx.env.GITHUB_READ_TOKEN);
  if ('error' in info) {
    return jsonOk({
      ok: false,
      error: info.error,
      hint: '如果这是私有仓库，需要在 Worker Secret 中配置有权限的 GITHUB_READ_TOKEN',
    });
  }

  const listing = await listSgmoduleFiles(
    repo.owner,
    repo.repository,
    repo.default_branch,
    ctx.env.GITHUB_READ_TOKEN,
  );

  return jsonOk({
    ok: true,
    defaultBranch: info.info.defaultBranch,
    private: info.info.private,
    description: info.info.description,
    sgmoduleCount: 'files' in listing ? listing.files.length : null,
    listingError: 'error' in listing ? listing.error : undefined,
  });
}

// ------------------------------------------------------------- webhook secret
export async function setWebhookSecret(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const key = ctx.env.WEBHOOK_SECRET_KEY;
  if (!key) {
    return jsonError(
      'bad_request',
      '未配置 WEBHOOK_SECRET_KEY，无法加密保存仓库 Secret。请先运行 wrangler secret put WEBHOOK_SECRET_KEY',
    );
  }

  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  // empty body = clear the secret (turn verification off for this repo)
  const plain = str(body.secret, 200);
  if (!plain) {
    await ctx.db
      .prepare(
        'UPDATE third_party_repositories SET webhook_secret_enc = NULL, webhook_secret_hint = \'\', updated_at = ? WHERE id = ?',
      )
      .bind(iso(), id)
      .run();
    return jsonOk({ cleared: true });
  }
  if (plain.length < 16) {
    return jsonError('bad_request', 'Webhook Secret 至少 16 位');
  }

  const enc = await encryptSecret(plain, key);
  const hint = `${plain.slice(0, 6)}…${plain.slice(-4)}`;

  await ctx.db
    .prepare(
      'UPDATE third_party_repositories SET webhook_secret_enc = ?, webhook_secret_hint = ?, updated_at = ? WHERE id = ?',
    )
    .bind(enc, hint, iso(), id)
    .run();

  await logAudit(ctx.db, {
    taskId: null,
    action: 'repo.webhook_secret',
    operator: ctx.admin.username,
    source: 'web',
    details: { repositoryId: id, hint },
  });

  return jsonOk({ hint });
}

// ------------------------------------------------------------------ checks
export async function triggerCheck(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');
  if (repo.manual_check_enabled !== 1) {
    return jsonError('forbidden', '该仓库已关闭手动检查');
  }

  const body = (await readBody(ctx.request)) ?? {};
  const branch = str(body.branch, 100) || repo.default_branch;
  if (!safeSegment(branch)) return jsonError('bad_request', '分支名不合法');

  const filePath = str(body.filePath, 400);
  if (filePath && !filePath.toLowerCase().endsWith('.sgmodule')) {
    return jsonError('bad_request', '只能检查 .sgmodule 文件');
  }

  const result = await runCheck(ctx.env, repo, {
    method: 'manual',
    branch,
    filePath: filePath || undefined,
    pathPrefix: str(body.pathPrefix, 200) || undefined,
    maxFiles: num(body.maxFiles, 200, 1, 2000),
    silent: false,
  });

  await logAudit(ctx.db, {
    taskId: null,
    action: 'repo.check',
    operator: ctx.admin.username,
    source: 'web',
    details: {
      repositoryId: id,
      branch,
      status: result.status,
      new: result.newModules,
      updated: result.updatedModules,
      deleted: result.deletedModules,
    },
  });

  if (result.status === 'failed' && result.error) {
    await notifyOps(
      ctx.env,
      '第三方仓库检查失败',
      `${repo.name}（${repo.owner}/${repo.repository}）\n${result.error}`,
    );
  }

  return jsonOk({
    ok: result.status !== 'failed',
    logId: result.logId,
    branch: result.branch,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    newModules: result.newModules,
    updatedModules: result.updatedModules,
    deletedModules: result.deletedModules,
    unchanged: result.unchanged,
    failed: result.failed,
    filesScanned: result.filesScanned,
    error: result.error,
    outcomes: result.outcomes.slice(0, 100),
  });
}

/** Shared by manual + cron so both write identical logs and counters. */
export async function runCheck(
  env: Env,
  repo: RepositoryRow,
  options: {
    method: DetectionMethod;
    branch?: string;
    filePath?: string;
    pathPrefix?: string;
    commitSha?: string;
    changes?: Parameters<typeof inspectRepository>[2]['changes'];
    maxFiles?: number;
    deadline?: number;
    silent?: boolean;
  },
): Promise<CheckResult> {
  // D1 budget guard: a pathological scan loop must not take the whole
  // platform read-only again. Large scans (new repos, many changed files) are
  // refused once 80% of the daily budget is gone; small increments always run.
  // Threshold lowered and applied to EVERY check, not just "large" ones: the
  // incident that took the platform down twice was a long series of small
  // per-file requests, which the previous large-scan-only rule never saw.
  const budget = await readBudget(env.DB);
  if (budget.date === budgetToday() && budget.used >= D1_BUDGET_LIMIT) {
    const result: CheckResult = {
      logId: '',
      repositoryId: repo.id,
      branch: options.branch || repo.default_branch,
      status: 'failed' as 'ok' | 'partial' | 'failed',
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      unchanged: 0,
      failed: 0,
      filesScanned: 0,
      error: `D1 日额度已用 ${budget.used}（≥${D1_BUDGET_LIMIT}），大扫描跳过，明日再试`,
      outcomes: [],
      startedAt: iso(),
      finishedAt: iso(),
    };
    await recordCheck(env.DB, repo, result, options.method);
    if (!options.silent) {
      await notifyOps(env, 'D1 额度护栏触发', `${repo.name}（${repo.owner}/${repo.repository}）大扫描被跳过：今日已用 ${budget.used} 行读取。明早额度重置后自动恢复。`);
    }
    return { ...result, logId: '' };
  }

  let result: CheckResult;
  try {
    result = await inspectRepository(env, repo, options);
  } catch (err) {
    result = {
      logId: '',
      repositoryId: repo.id,
      branch: options.branch || repo.default_branch,
      status: 'failed',
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      unchanged: 0,
      failed: 0,
      filesScanned: 0,
      error: err instanceof Error ? err.message : '检查异常',
      outcomes: [],
      startedAt: iso(),
      finishedAt: iso(),
    };
  }
  const logId = await recordCheck(env.DB, repo, result, options.method);
  // tally the estimate: ~3 reads per known file + ~520 per changed file
  // (content lookups + inserts). Rough on purpose — it exists to catch
  // runaway loops, not for billing.
  // Cost model, measured against the real incident: each scanned file costs
  // ~6 row reads (known-row lookup + insert/compare), and the bounded
  // self-heal adds 3×543 ≈ 1.6k per run — NOT multiplied by file count.
  await addBudget(env.DB, result.filesScanned * 6 + 1_600);
  return { ...result, logId };
}

export async function repoLogs(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const limit = num(ctx.url.searchParams.get('limit'), 30, 1, 100);
  const rows = await ctx.db
    .prepare(
      `SELECT id, detection_method, check_status, new_modules_count, updated_modules_count,
              deleted_modules_count, unchanged_modules_count, failed_count,
              files_scanned, branch, error_message, started_at, finished_at
         FROM repository_check_logs
        WHERE repository_id = ?
        ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(id, limit)
    .all<Record<string, unknown>>();

  return jsonOk({ items: rows.results ?? [] });
}

export async function repoModules(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');

  const rows = await ctx.db
    .prepare(
      `SELECT t.id, t.module_name, t.file_path, t.branch, t.current_version,
              t.published, t.is_deleted_upstream, t.last_seen_at, t.updated_at,
              m.slug AS module_slug, m.is_published AS module_published
         FROM third_party_modules t
         LEFT JOIN modules m ON m.id = t.module_id
        WHERE t.repository_id = ?
        ORDER BY t.published DESC, t.updated_at DESC LIMIT 500`,
    )
    .bind(id)
    .all<Record<string, unknown>>();

  return jsonOk({ items: rows.results ?? [] });
}

// -------------------------------------------------------------- credentials
/**
 * Reads credential status (never the values).
 *
 * The two tokens are editable here so an operator can rotate them from a phone;
 * the encryption key is deliberately NOT editable — it protects the stored
 * ciphertext, so a UI field for it would let anyone with panel access decrypt
 * everything by replacing it.
 */
export async function getCredentials(ctx: ThirdPartyCtx): Promise<Response> {
  const status = async (name: CredentialName, fallback: boolean) => {
    const s = await credentialStatus(ctx.env, name);
    return {
      fromPanel: s.fromPanel,
      usable: s.usable,
      hint: s.hint,
      hasFallback: fallback,
    };
  };

  return jsonOk({
    githubReadToken: await status('github_read_token', Boolean(ctx.env.GITHUB_READ_TOKEN)),
    telegramBotToken: await status('telegram_bot_token', Boolean(ctx.env.TELEGRAM_BOT_TOKEN)),
    // Editable and reported, but only as "configured"
    encryptionKey: {
      fromPanel: false,
      usable: Boolean(ctx.env.WEBHOOK_SECRET_KEY),
      hint: ctx.env.WEBHOOK_SECRET_KEY ? '由 Worker Secret 提供' : '',
      hasFallback: Boolean(ctx.env.WEBHOOK_SECRET_KEY),
    },
    telegramAdminId:
      (await ctx.db
        .prepare("SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'")
        .first<{ value: string }>())?.value ?? '',
  });
}

/**
 * Saves a credential.
 *
 * Only super admins reach this (the route checks `thirdparty:write`, which is
 * super-only) and the value is encrypted before it touches D1. The response
 * returns a fingerprint, never the value.
 */
export async function saveCredentials(ctx: ThirdPartyCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const key = (ctx.env.WEBHOOK_SECRET_KEY ?? '').trim();
  if (!key) {
    return jsonError(
      'bad_request',
      '未配置 WEBHOOK_SECRET_KEY，无法加密保存凭据。请先设置该 Worker Secret。',
    );
  }

  const saved: string[] = [];
  const rejected: string[] = [];

  const write = async (name: CredentialName, value: unknown) => {
    if (value === undefined) return;
    const plain = typeof value === 'string' ? value.trim() : '';
    // A GitHub token and a bot token have distinctive shapes; reject obvious
    // mistakes here so a pasted password does not silently break every check.
    if (plain) {
      if (name === 'github_read_token' && !/^(gh[pousr]_|github_pat_)/.test(plain)) {
        rejected.push('GitHub Token 格式不正确（应以 ghp_ / github_pat_ 开头）');
        return;
      }
      if (name === 'telegram_bot_token' && !/^\d{6,}:[\w-]{30,}$/.test(plain)) {
        rejected.push('Telegram Bot Token 格式不正确（应为 数字:字母数字）');
        return;
      }
    }
    await saveCredential(ctx.env, name, plain, key);
    saved.push(name);
  };

  await write('github_read_token', body.githubReadToken);
  await write('telegram_bot_token', body.telegramBotToken);
  await write('webhook_secret_key', body.webhookSecretKey);

  // ---- user system switches (super admin only; they change who can read
  // modules, so an editor must not be able to flip them)
  if (body.requireCredential !== undefined || body.freeRegister !== undefined ||
      body.inviteRegister !== undefined || body.approvalRegister !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改账号与鉴权设置');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.requireCredential !== undefined) {
      sets.push('require_credential = ?');
      binds.push(bool(body.requireCredential) ? 1 : 0);
    }
    if (body.freeRegister !== undefined) {
      sets.push('free_register = ?');
      binds.push(bool(body.freeRegister) ? 1 : 0);
    }
    if (body.inviteRegister !== undefined) {
      sets.push('invite_register = ?');
      binds.push(bool(body.inviteRegister) ? 1 : 0);
    }
    if (body.approvalRegister !== undefined) {
      sets.push('approval_register = ?');
      binds.push(bool(body.approvalRegister) ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push('updated_by = ?', 'updated_at = ?');
      binds.push(ctx.admin.username, iso());
      await ctx.db
        .prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = 1`)
        .bind(...binds)
        .run();
    }
  }

  // ---- device policy (super admin): how many links one account may hold
  if (body.deviceLimitEnabled !== undefined || body.maxDevices !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改设备限制');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.deviceLimitEnabled !== undefined) {
      sets.push('device_limit_enabled = ?');
      binds.push(bool(body.deviceLimitEnabled) ? 1 : 0);
    }
    if (body.maxDevices !== undefined) {
      sets.push('max_devices = ?');
      binds.push(num(body.maxDevices, 2, 1, 100));
    }
    sets.push('updated_by = ?', 'updated_at = ?');
    binds.push(ctx.admin.username, iso());
    await ctx.db
      .prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = 1`)
      .bind(...binds)
      .run();
    await logAudit(ctx.db, {
      taskId: null,
      action: 'device.policy',
      operator: ctx.admin.username,
      source: 'web',
      details: { maxDevices: body.maxDevices, enabled: body.deviceLimitEnabled },
    });
  }

  if (body.telegramAdminId !== undefined) {
    const id = str(body.telegramAdminId, 40);
    if (id && !/^-?\d{5,20}$/.test(id)) {
      rejected.push('Telegram 管理员 ID 必须是纯数字');
    } else {
      await ctx.db
        .prepare(
          `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
           VALUES ('third_party.telegram_admin_id', ?, 'string', 'admin', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(id, iso())
        .run();
      saved.push('telegram_admin_id');
    }
  }

  if (rejected.length > 0 && saved.length === 0) {
    return jsonError('bad_request', rejected.join('；'));
  }

  await logAudit(ctx.db, {
    taskId: null,
    action: 'thirdparty.credentials',
    operator: ctx.admin.username,
    source: 'web',
    // names only — a credential must never reach the audit log
    details: { saved },
  });

  return jsonOk({ saved, rejected });
}

/** Sends a test message so a freshly pasted bot token can be verified. */
export async function testTelegram(ctx: ThirdPartyCtx): Promise<Response> {
  const token = (ctx.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return jsonError('bad_request', '未配置 Telegram Bot Token');

  const adminRow = await ctx.db
    .prepare("SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'")
    .first<{ value: string }>();
  const adminId = (ctx.env.TELEGRAM_ADMIN_ID ?? '').trim() || (adminRow?.value ?? '').trim();
  if (!adminId) return jsonError('bad_request', '未配置 Telegram 管理员 ID');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminId,
      text: '<b>Surge Modules</b>\n\n这是一条测试消息：Bot 与管理员 ID 都已连通。',
      parse_mode: 'HTML',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };

  if (!body.ok) {
    return jsonError('bad_request', body.description ?? 'Telegram 拒绝了这条消息');
  }
  return jsonOk({ sent: true, messageId: body.result?.message_id ?? null });
}

// ------------------------------------------------------------------ global
export async function getSettings(ctx: ThirdPartyCtx): Promise<Response> {
  const rows = await ctx.db
    .prepare(
      `SELECT key, value FROM site_settings WHERE key LIKE 'third_party.%' ORDER BY key`,
    )
    .all<{ key: string; value: string }>();

  const map: Record<string, string> = {};
  for (const row of rows.results ?? []) map[row.key.replace('third_party.', '')] = row.value;

  const hasToken = Boolean(ctx.env.TELEGRAM_BOT_TOKEN);
  const resolvedAdmin =
    ctx.env.TELEGRAM_ADMIN_ID?.trim() || map.telegram_admin_id || '';

  return jsonOk({
    settings: {
      autoEnabled: map.auto_enabled !== '0',
      defaultInterval: Number.parseInt(map.default_interval ?? '6', 10) || 6,
      cronExpression: map.cron_expression ?? '0 */6 * * *',
      // 0 = unlimited is a legal stored value; the `|| fallback` idiom would
      // turn it back into the default, so parse with an explicit check.
      maxReposPerRun: Number.isFinite(Number.parseInt(map.max_repos_per_run ?? '', 10))
        ? Number.parseInt(map.max_repos_per_run, 10)
        : 10,
      maxFilesPerRun: Number.isFinite(Number.parseInt(map.max_files_per_run ?? '', 10))
        ? Number.parseInt(map.max_files_per_run, 10)
        : 80,
      maxRunSeconds: Number.parseInt(map.max_run_seconds ?? '50', 10) || 50,
      maxRetries: Number.parseInt(map.max_retries ?? '2', 10) || 2,
      notifyOnCheck: map.notify_on_check !== '0',
      notifyNew: map.notify_new !== '0',
      notifyUpdate: map.notify_update !== '0',
      notifyDelete: map.notify_delete !== '0',
      notifyFailure: map.notify_failure !== '0',
      notifyReviewed: map.notify_reviewed !== '0',
    },
    telegram: {
      hasToken,
      adminIdConfigured: Boolean(resolvedAdmin),
      adminIdHint: resolvedAdmin ? `${resolvedAdmin.slice(0, 4)}…` : '',
      // the token itself is never returned, in any form
    },
    github: { hasToken: Boolean(ctx.env.GITHUB_READ_TOKEN) },
    uaPolicies: await (async () => {
      const rows = await ctx.db
        .prepare(
          `SELECT id, policy_type, pattern, description, enabled
             FROM client_access_policies ORDER BY policy_type, id`,
        )
        .all<Record<string, unknown>>();
      const sw = await ctx.db
        .prepare('SELECT ua_blocking FROM user_settings WHERE id = 1')
        .first<{ ua_blocking: number }>();
      return {
        enabled: Number(sw?.ua_blocking ?? 0) === 1,
        items: (rows.results ?? []).map((r) => ({
          id: r.id,
          type: r.policy_type,
          pattern: r.pattern,
          description: r.description,
          enabled: Number(r.enabled ?? 1) === 1,
        })),
      };
    })(),
    devicePolicy: await (async () => {
      const row = await ctx.db
        .prepare('SELECT device_limit_enabled, max_devices FROM user_settings WHERE id = 1')
        .first<{ device_limit_enabled: number; max_devices: number }>();
      const total = await ctx.db
        .prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'active'")
        .first<{ n: number }>();
      return {
        enabled: Number(row?.device_limit_enabled ?? 1) === 1,
        max: Number(row?.max_devices ?? 2),
        activeTotal: total?.n ?? 0,
      };
    })(),
    userSystem: await (async () => {
      const row = await ctx.db
        .prepare('SELECT require_credential, free_register, invite_register, approval_register FROM user_settings WHERE id = 1')
        .first<Record<string, number>>();
      const users = await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').first<{ n: number }>();
      return {
        requireCredential: Number(row?.require_credential ?? 0) === 1,
        freeRegister: Number(row?.free_register ?? 1) === 1,
        inviteRegister: Number(row?.invite_register ?? 0) === 1,
        approvalRegister: Number(row?.approval_register ?? 0) === 1,
        userCount: users?.n ?? 0,
      };
    })(),
    encryptionKey: { configured: Boolean(ctx.env.WEBHOOK_SECRET_KEY) },
  });
}

export async function updateSettings(ctx: ThirdPartyCtx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const writable: Array<[string, string]> = [];
  const put = (key: string, value: unknown, type: 'boolean' | 'number' | 'string') => {
    if (value === undefined) return;
    let v: string;
    if (type === 'boolean') v = bool(value) ? '1' : '0';
    else if (type === 'number') v = String(num(value, 6, 1, 86400));
    else v = str(value, 200);
    writable.push([key, v]);
  };

  put('auto_enabled', body.autoEnabled, 'boolean');
  put('default_interval', body.defaultInterval, 'number');
  put('cron_expression', body.cronExpression, 'string');
  // 0 = unlimited for the two run-size caps; num()'s clamp floor is 1, so they
  // are written directly instead of going through the generic path.
  if (body.maxReposPerRun !== undefined) {
    writable.push(['max_repos_per_run', String(num0(body.maxReposPerRun, 10))]);
  }
  if (body.maxFilesPerRun !== undefined) {
    writable.push(['max_files_per_run', String(num0(body.maxFilesPerRun, 80))]);
  }
  put('max_run_seconds', body.maxRunSeconds, 'number');
  put('max_retries', body.maxRetries, 'number');
  put('notify_on_check', body.notifyOnCheck, 'boolean');
  put('notify_new', body.notifyNew, 'boolean');
  put('notify_update', body.notifyUpdate, 'boolean');
  put('notify_delete', body.notifyDelete, 'boolean');
  put('notify_failure', body.notifyFailure, 'boolean');
  put('notify_reviewed', body.notifyReviewed, 'boolean');

  // The Telegram admin id is the one setting that grants powers, so it is only
  // writable by a super admin — an editor must not be able to point reviews at
  // their own chat.
  // ---- user system switches (super admin only; they change who can read
  // modules, so an editor must not be able to flip them)
  if (body.requireCredential !== undefined || body.freeRegister !== undefined ||
      body.inviteRegister !== undefined || body.approvalRegister !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改账号与鉴权设置');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.requireCredential !== undefined) {
      sets.push('require_credential = ?');
      binds.push(bool(body.requireCredential) ? 1 : 0);
    }
    if (body.freeRegister !== undefined) {
      sets.push('free_register = ?');
      binds.push(bool(body.freeRegister) ? 1 : 0);
    }
    if (body.inviteRegister !== undefined) {
      sets.push('invite_register = ?');
      binds.push(bool(body.inviteRegister) ? 1 : 0);
    }
    if (body.approvalRegister !== undefined) {
      sets.push('approval_register = ?');
      binds.push(bool(body.approvalRegister) ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push('updated_by = ?', 'updated_at = ?');
      binds.push(ctx.admin.username, iso());
      await ctx.db
        .prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = 1`)
        .bind(...binds)
        .run();
    }
  }

  // ---- UA blocking: master switch + rule CRUD
  if (body.uaBlocking !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改访问策略');
    }
    await ctx.db
      .prepare('UPDATE user_settings SET ua_blocking = ?, updated_by = ?, updated_at = ? WHERE id = 1')
      .bind(bool(body.uaBlocking) ? 1 : 0, ctx.admin.username, iso())
      .run();
    await logAudit(ctx.db, {
      taskId: null,
      action: 'ua.switch',
      operator: ctx.admin.username,
      source: 'web',
      details: { enabled: bool(body.uaBlocking) === 1 },
    });
  }

  if (body.uaRuleAdd !== undefined) {
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '无权修改访问策略');
    const rule = body.uaRuleAdd as Record<string, unknown>;
    const type = str(rule.type, 40);
    const pattern = str(rule.pattern, 200);
    if (!['surge_whitelist', 'browser_blacklist', 'client_blacklist'].includes(type)) {
      return jsonError('bad_request', '未知规则类型');
    }
    if (!pattern) return jsonError('bad_request', '规则不能为空');
    try {
      // Validate before storing: an invalid regex must be rejected now, not
      // silently skipped later while the operator believes it is active.
      new RegExp(pattern);
    } catch {
      return jsonError('bad_request', '正则表达式无效');
    }
    const id = crypto.randomUUID();
    await ctx.db
      .prepare(
        `INSERT INTO client_access_policies (id, policy_type, pattern, description, enabled, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, type, pattern, str(rule.description, 100), ctx.admin.username)
      .run();
    await logAudit(ctx.db, {
      taskId: null,
      action: 'ua.rule_add',
      operator: ctx.admin.username,
      source: 'web',
      details: { type, pattern },
    });
  }

  if (body.uaRuleToggle !== undefined) {
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '无权修改访问策略');
    const ruleId = str((body.uaRuleToggle as Record<string, unknown>).id, 60);
    const enabled = bool((body.uaRuleToggle as Record<string, unknown>).enabled);
    await ctx.db
      .prepare('UPDATE client_access_policies SET enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled, iso(), ruleId)
      .run();
  }

  if (body.uaRuleDelete !== undefined) {
    if (ctx.admin.role !== 'super') return jsonError('forbidden', '无权修改访问策略');
    const ruleId = str(body.uaRuleDelete, 60);
    await ctx.db.prepare('DELETE FROM client_access_policies WHERE id = ?').bind(ruleId).run();
    await logAudit(ctx.db, {
      taskId: null,
      action: 'ua.rule_delete',
      operator: ctx.admin.username,
      source: 'web',
      details: { ruleId },
    });
  }

  // ---- device policy (super admin): how many links one account may hold
  if (body.deviceLimitEnabled !== undefined || body.maxDevices !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改设备限制');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.deviceLimitEnabled !== undefined) {
      sets.push('device_limit_enabled = ?');
      binds.push(bool(body.deviceLimitEnabled) ? 1 : 0);
    }
    if (body.maxDevices !== undefined) {
      sets.push('max_devices = ?');
      binds.push(num(body.maxDevices, 2, 1, 100));
    }
    sets.push('updated_by = ?', 'updated_at = ?');
    binds.push(ctx.admin.username, iso());
    await ctx.db
      .prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = 1`)
      .bind(...binds)
      .run();
    await logAudit(ctx.db, {
      taskId: null,
      action: 'device.policy',
      operator: ctx.admin.username,
      source: 'web',
      details: { maxDevices: body.maxDevices, enabled: body.deviceLimitEnabled },
    });
  }

  if (body.telegramAdminId !== undefined) {
    if (ctx.admin.role !== 'super') {
      return jsonError('forbidden', '只有超级管理员可以修改 Telegram 管理员 ID');
    }
    const id = str(body.telegramAdminId, 40);
    if (id && !/^-?\d{5,20}$/.test(id)) {
      return jsonError('bad_request', 'Telegram 管理员 ID 必须是纯数字（用户 ID，不是用户名）');
    }
    writable.push(['telegram_admin_id', id]);
  }

  for (const [key, value] of writable) {
    await ctx.db
      .prepare(
        `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
         VALUES (?, ?, 'string', 'admin', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(`third_party.${key}`, value, iso())
      .run();
  }

  await logAudit(ctx.db, {
    taskId: null,
    action: 'thirdparty.settings',
    operator: ctx.admin.username,
    source: 'web',
    details: { keys: writable.map(([k]) => k) },
  });

  return jsonOk({ updated: writable.length });
}

/**
 * Runs the scheduler immediately (the 「立即运行」 button).
 *
 * This is the same code path as the Cron trigger — the button does not have its
 * own logic, it just invokes the scheduler early. That is what makes the manual
 * button a trustworthy test of what cron will do.
 */
export async function runSchedulerNow(ctx: ThirdPartyCtx): Promise<Response> {
  const result = await runScheduler(ctx.env, { force: true, trigger: 'manual' });
  await logAudit(ctx.db, {
    taskId: null,
    action: 'thirdparty.scheduler',
    operator: ctx.admin.username,
    source: 'web',
    details: result,
  });
  return jsonOk(result);
}

/**
 * Picks due repositories and checks them, bounded by time and count.
 *
 * A cron run must finish inside the Worker's CPU/wall budget, so it processes a
 * slice and returns: the next run continues where this one stopped (due-time
 * ordering makes that automatic — a repo is only "due" again after its interval,
 * and the ones not reached still have a past `next_check_at`).
 */
export async function runScheduler(
  env: Env,
  options: { force?: boolean; trigger: 'cron' | 'manual' },
): Promise<{
  ran: boolean;
  reason?: string;
  reposChecked: number;
  newModules: number;
  updatedModules: number;
  deletedModules: number;
  failed: number;
  durationMs: number;
}> {
  const startedMs = Date.now();

  const settings = await env.DB.prepare(
    `SELECT key, value FROM site_settings WHERE key LIKE 'third_party.%'`,
  ).all<{ key: string; value: string }>();
  const cfg: Record<string, string> = {};
  for (const row of settings.results ?? []) cfg[row.key.replace('third_party.', '')] = row.value;

  if (cfg.auto_enabled === '0' && !options.force) {
    return {
      ran: false,
      reason: '全局自动检测已关闭',
      reposChecked: 0,
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      failed: 0,
      durationMs: 0,
    };
  }

  // 0 = unlimited. A missing/legacy value keeps the old defaults; parseInt on
  // "0" yields 0 which is falsy, so the historical `|| 10` idiom would have
  // silently resurrected the default — hence the explicit Number.isFinite check.
  const parseLimit = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const maxRepos = parseLimit(cfg.max_repos_per_run, 10);
  const maxFiles = parseLimit(cfg.max_files_per_run, 80);
  const maxSeconds = Number.parseInt(cfg.max_run_seconds ?? '50', 10) || 50;
  const deadline = startedMs + maxSeconds * 1000;

  const now = iso();
  // "Run now" in the admin panel (manual+force) means *check everything*:
  // the due-time filter would keep returning 0 repos for the whole interval
  // right after any successful pass, making the button look broken. Cron keeps
  // the due-only semantics.
  const dueFilter = options.force && options.trigger === 'manual'
    ? ''
    : `AND (next_check_at IS NULL OR next_check_at <= ?)`;
  const bindNow = dueFilter !== '';
  const dueSql = `SELECT * FROM third_party_repositories
      WHERE deleted_at IS NULL AND enabled = 1 AND cron_enabled = 1
        ${dueFilter}
      ORDER BY COALESCE(next_check_at, '1970-01-01T00:00:00Z') ASC`;
  const due = maxRepos === 0
    ? await (bindNow ? env.DB.prepare(dueSql).bind(now) : env.DB.prepare(dueSql)).all<RepositoryRow>()
    : await (bindNow ? env.DB.prepare(`${dueSql} LIMIT ?`).bind(now, maxRepos) : env.DB.prepare(`${dueSql} LIMIT ?`).bind(maxRepos)).all<RepositoryRow>();

  const repos = due.results ?? [];
  let newModules = 0;
  let updatedModules = 0;
  let deletedModules = 0;
  let failed = 0;
  let checked = 0;

  for (const repo of repos) {
    if (Date.now() > deadline) break;
    const result = await runCheck(env, repo, {
      method: 'cron',
      maxFiles,
      deadline,
      silent: false,
    });
    checked += 1;
    newModules += result.newModules;
    updatedModules += result.updatedModules;
    deletedModules += result.deletedModules;
    if (result.status === 'failed') {
      failed += 1;
      if (result.error) {
        await notifyOps(
          env,
          '定时检测失败',
          `${repo.name}（${repo.owner}/${repo.repository}）\n${result.error}`,
        );
      }
    }
  }

  return {
    ran: true,
    reposChecked: checked,
    newModules,
    updatedModules,
    deletedModules,
    failed,
    durationMs: Date.now() - startedMs,
  };
}

// ------------------------------------------------------------------ reviews
export async function listReviews(ctx: ThirdPartyCtx): Promise<Response> {
  const q = ctx.url.searchParams;
  const result = await listTasks(ctx.db, {
    status: q.get('status') ?? 'pending',
    type: q.get('type') ?? undefined,
    method: q.get('method') ?? undefined,
    repositoryId: q.get('repositoryId') ?? undefined,
    search: q.get('q') ?? undefined,
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    page: num(q.get('page'), 1, 1, 10000),
    perPage: num(q.get('perPage'), 20, 1, 100),
    sort: q.get('sort') === 'oldest' ? 'oldest' : 'newest',
  });

  const stats = await reviewStats(ctx.db);

  return jsonOk({
    items: result.items.map((t) => ({
      id: t.id,
      taskType: t.task_type,
      detectionMethod: t.detection_method,
      reviewStatus: t.review_status,
      filePath: t.file_path,
      branch: t.branch,
      oldVersion: t.old_version,
      newVersion: t.new_version,
      commitSha: t.commit_sha,
      contentSha: t.content_sha,
      repositoryId: t.repository_id,
      repositoryName: t.repository_name,
      owner: t.owner,
      repository: t.repository,
      moduleId: t.module_id,
      moduleName: t.module_name,
      moduleSlug: t.module_slug,
      liveVersion: t.module_live_version,
      rejectionReason: t.rejection_reason,
      reviewer: t.reviewer,
      reviewedAt: t.reviewed_at,
      createdAt: t.created_at,
      notifyStatus: t.notify_status,
    })),
    total: result.total,
    page: result.page,
    perPage: result.perPage,
    stats,
  });
}

export async function getReview(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const task = await getTask(ctx.db, id);
  if (!task) return jsonError('not_found', '审核任务不存在');

  const audits = await ctx.db
    .prepare(
      `SELECT action, operator, source, details, created_at
         FROM module_audit_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 30`,
    )
    .bind(id)
    .all<Record<string, unknown>>();

  return jsonOk({
    task: {
      id: task.id,
      taskType: task.task_type,
      detectionMethod: task.detection_method,
      reviewStatus: task.review_status,
      filePath: task.file_path,
      branch: task.branch,
      oldVersion: task.old_version,
      newVersion: task.new_version,
      oldContent: task.old_content,
      newContent: task.new_content,
      contentSha: task.content_sha,
      commitSha: task.commit_sha,
      repositoryId: task.repository_id,
      repositoryName: task.repository_name,
      owner: task.owner,
      repository: task.repository,
      moduleId: task.module_id,
      moduleName: task.module_name,
      moduleSlug: task.module_slug,
      liveVersion: task.module_live_version,
      liveSha: task.module_live_sha,
      rejectionReason: task.rejection_reason,
      reviewer: task.reviewer,
      reviewedAt: task.reviewed_at,
      note: task.note,
      notifyStatus: task.notify_status,
      notifyError: task.notify_error,
      createdAt: task.created_at,
      supersededBy: task.superseded_by,
      overrides: {
        name: task.override_name,
        description: task.override_description,
        categoryId: task.override_category_id,
        icon: task.override_icon,
        featured: task.override_featured === null ? null : task.override_featured === 1,
      },
    },
    audits: audits.results ?? [],
  });
}

export async function decideReview(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return jsonError('bad_request', '请求体不合法');

  const decision = str(body.decision, 20);
  if (!['approve', 'reject', 'hold'].includes(decision)) {
    return jsonError('bad_request', '未知操作');
  }

  const overridesRaw =
    typeof body.overrides === 'object' && body.overrides !== null
      ? (body.overrides as Record<string, unknown>)
      : {};

  const input: DecideInput = {
    taskId: id,
    decision: decision as DecideInput['decision'],
    operator: ctx.admin.username,
    source: 'web',
    reason: str(body.reason, 1000),
    note: str(body.note, 1000),
    overrides: {
      name: str(overridesRaw.name, 120) || undefined,
      description: str(overridesRaw.description, 500) || undefined,
      categoryId: str(overridesRaw.categoryId, 60) || undefined,
      icon: str(overridesRaw.icon, 200) || undefined,
      featured:
        overridesRaw.featured === undefined ? undefined : bool(overridesRaw.featured) === 1,
    },
  };

  const result = await decideTask(ctx.env, input);
  if (!result.ok) {
    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'conflict'
          ? 409
          : result.code === 'invalid'
            ? 400
            : 500;
    return jsonError(result.code, result.message, { status });
  }

  return jsonOk({
    id,
    status: result.status,
    published: result.published ?? false,
    moduleId: result.moduleId,
    slug: result.slug,
  });
}

/** Re-sends a notification that previously failed (or was never sent). */
export async function resendNotification(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const task = await getTask(ctx.db, id);
  if (!task) return jsonError('not_found', '审核任务不存在');

  await ctx.db
    .prepare("UPDATE module_review_tasks SET notify_status = 'pending' WHERE id = ?")
    .bind(id)
    .run();

  const { notifyReviewTask } = await import('./telegram');
  const res = await notifyReviewTask(
    ctx.env,
    id,
    task.task_type === 'delete' ? 'delete' : task.task_type === 'update' ? 'update' : 'new',
  );

  return jsonOk({ sent: res.sent, error: res.error });
}

// ------------------------------------------------------- webhook receiver
/**
 * POST /api/v1/webhook/github/:repositoryId
 *
 * Order of operations is security-relevant:
 *   1. read the RAW body (HMAC is over raw bytes, not re-serialised JSON)
 *   2. dedupe on X-GitHub-Delivery BEFORE doing any work
 *   3. verify HMAC against the repo-specific secret
 *   4. only then touch GitHub / D1
 *
 * A failed verification returns 401 and creates nothing.
 */
export async function handleRepoWebhook(
  request: Request,
  env: Env,
  repositoryId: string,
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  const repo = await getRepository(env.DB, repositoryId);
  if (!repo) return jsonError('not_found', '仓库不存在');
  if (repo.enabled !== 1 || repo.webhook_enabled !== 1) {
    return jsonError('forbidden', '该仓库的 Webhook 检测已关闭');
  }

  // Read the raw text ONCE. HMAC is over the exact bytes GitHub signed, and a
  // stream can only be consumed once — cloning for a second read is fragile
  // (and returns "" for some body types), which would reject every valid push.
  let rawText: string;
  try {
    const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
    if (declared > 2 * 1024 * 1024) return jsonError('payload_too_large', '请求体过大');
    rawText = await request.text();
  } catch {
    return jsonError('bad_request', '请求体读取失败');
  }
  if (rawText.length > 2 * 1024 * 1024) return jsonError('payload_too_large', '请求体过大');

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawText);
  } catch {
    const form = new URLSearchParams(rawText).get('payload');
    try {
      parsedPayload = form ? JSON.parse(form) : null;
    } catch {
      parsedPayload = null;
    }
  }
  if (parsedPayload === null || typeof parsedPayload !== 'object') {
    return jsonError('bad_request', '请求体不是合法 JSON');
  }
  const raw = { data: parsedPayload };

  const eventId = (request.headers.get('x-github-delivery') ?? '').slice(0, 100);
  const eventType = (request.headers.get('x-github-event') ?? '').slice(0, 40);
  const signature = request.headers.get('x-hub-signature-256');

  if (!eventId) return jsonError('bad_request', '缺少 X-GitHub-Delivery');

  if (!eventType || !['push', 'ping'].includes(eventType)) {
    // acknowledge so GitHub does not retry forever; we only care about pushes
    return jsonOk({ ok: true, ignored: `未监听的事件：${eventType || 'unknown'}` }, { status: 202 });
  }

  // ---- dedupe first: a redelivery must not re-run (or re-notify)
  const existing = await env.DB.prepare(
    'SELECT processing_status FROM github_webhook_events WHERE event_id = ?',
  )
    .bind(eventId)
    .first<{ processing_status: string }>();
  if (existing) {
    return jsonOk({ ok: true, duplicate: true, status: existing.processing_status }, { status: 202 });
  }

  const insertEvent = async (sha: string, summary: string, status: string, error = '') => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO github_webhook_events
        (id, repository_id, event_id, event_type, commit_sha, payload_summary,
         processing_status, error_message, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        repo.id,
        eventId,
        eventType,
        sha.slice(0, 40),
        summary.slice(0, 500),
        status,
        error.slice(0, 500),
        status === 'received' ? null : iso(),
      )
      .run();
  };

  // ---- signature: required whenever a secret is configured for this repo
  if (repo.webhook_secret_enc) {
    const key = env.WEBHOOK_SECRET_KEY;
    if (!key) {
      await insertEvent('', 'missing WEBHOOK_SECRET_KEY', 'failed', '服务端未配置加密密钥');
      return jsonError('internal_error', '服务端未配置 Webhook 加密密钥');
    }
    const secret = await decryptSecret(repo.webhook_secret_enc, key);
    if (!secret) {
      await insertEvent('', 'secret decrypt failed', 'failed', '无法解密仓库 Secret');
      return jsonError('internal_error', '无法解密仓库 Secret');
    }

    const valid = await verifyGithubSignature(rawText, signature, secret);
    if (!valid) {
      await insertEvent('', 'signature mismatch', 'failed', '签名验证失败');
      return jsonError('unauthorized', 'Webhook 签名验证失败');
    }
  } else if (env.ENVIRONMENT === 'production') {
    // No secret in production means anyone could POST a fake push. Refuse rather
    // than silently trusting an unauthenticated webhook.
    await insertEvent('', 'no secret configured', 'failed', '仓库未配置 Webhook Secret');
    return jsonError('unauthorized', '该仓库未配置 Webhook Secret，出于安全考虑拒绝处理');
  }

  const payload = raw.data as {
    ref?: string;
    after?: string;
    head_commit?: { id?: string } | null;
    repository?: { full_name?: string; default_branch?: string };
    commits?: Array<{ id?: string; added?: string[]; modified?: string[]; removed?: string[] }>;
    zen?: string;
  };

  if (eventType === 'ping') {
    await insertEvent('', 'ping', 'ignored');
    return jsonOk({ ok: true, pong: true }, { status: 202 });
  }

  const branch = (payload.ref ?? '').replace('refs/heads/', '') || repo.default_branch;
  const commitSha = payload.head_commit?.id ?? payload.after ?? '';

  if (!bucketSegments(branch)) {
    await insertEvent(commitSha, `invalid branch ${branch}`, 'failed', '分支名不合法');
    return jsonError('bad_request', '分支名不合法');
  }

  // Only the configured branch is tracked; a push to another branch is noise.
  if (branch !== repo.default_branch) {
    await insertEvent(commitSha, `branch ${branch} ignored`, 'ignored');
    return jsonOk({ ok: true, ignored: `只跟踪分支 ${repo.default_branch}` }, { status: 202 });
  }

  const { changesFromPush } = await import('./third-party');
  const changes = changesFromPush(payload);
  if (changes.length === 0) {
    await insertEvent(commitSha, 'no sgmodule changes', 'ignored');
    return jsonOk({ ok: true, changes: 0 }, { status: 202 });
  }

  const summary = changes
    .slice(0, 20)
    .map((c) => `${c.status}:${c.path}`)
    .join(', ');
  await insertEvent(commitSha, summary, 'received');

  // Process after acknowledging: GitHub aborts at 10s and a check can take longer.
  const work = (async () => {
    try {
      const result = await runCheck(env, repo, {
        method: 'webhook',
        branch,
        commitSha,
        changes,
        silent: false,
      });
      const ok = result.status !== 'failed';
      await env.DB.prepare(
        `UPDATE github_webhook_events
            SET processing_status = ?, processed_at = ?, error_message = ?
          WHERE event_id = ?`,
      )
        .bind(
          ok ? 'processed' : 'failed',
          iso(),
          ok ? '' : (result.error || result.outcomes.find((o) => o.reason)?.reason || '处理失败').slice(0, 500),
          eventId,
        )
        .run();
      if (result.status === 'failed' && result.error) {
        await notifyOps(env, 'Webhook 处理失败', `${repo.name}\n${result.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[webhook] processing failed', message);
      await env.DB.prepare(
        `UPDATE github_webhook_events SET processing_status = 'failed',
                processed_at = ?, error_message = ? WHERE event_id = ?`,
      )
        .bind(iso(), message.slice(0, 500), eventId)
        .run();
    }
  })();

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;

  return jsonOk(
    { ok: true, queued: true, changes: changes.length, branch, commit: commitSha.slice(0, 10) },
    { status: 202 },
  );
}

function bucketSegments(value: string): boolean {
  return /^[\w.\-/]{1,200}$/.test(value) && !value.includes('..');
}

/** Public helper for the admin UI: preview what a push would contain. */
/**
 * Lists the `.sgmodule` files in a repository plus the current branch head.
 *
 * The head SHA is what an admin needs to test a webhook end-to-end: the handler
 * reads file content *at the pushed commit*, so replaying an event with an
 * invented SHA legitimately 404s. Returning the real head makes that testable
 * without shell access.
 */
export async function previewPush(ctx: ThirdPartyCtx, id: string): Promise<Response> {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError('not_found', '仓库不存在');
  const listing = await listSgmoduleFiles(
    repo.owner,
    repo.repository,
    repo.default_branch,
    ctx.env.GITHUB_READ_TOKEN,
  );
  if ('error' in listing) return jsonError('bad_request', listing.error);

  const head = await ghRequest(
    `/repos/${repo.owner}/${repo.repository}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
    { token: ctx.env.GITHUB_READ_TOKEN },
  );
  const headSha =
    head.ok && head.json
      ? ((head.json as { object?: { sha?: string } }).object?.sha ?? '')
      : '';

  return jsonOk({
    files: listing.files.slice(0, 200),
    truncated: listing.truncated,
    branch: repo.default_branch,
    headSha,
  });
}

export { createReviewTask };
