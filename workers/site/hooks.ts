/**
 * Webhook auto-registration.
 *
 * Problem this solves: a webhook is configured per repository on GitHub's side.
 * Adding a source in the admin UI does nothing until someone also visits the
 * repository settings and pastes a URL and a secret. That is exactly the step
 * people forget, and the failure is silent — the repo just never syncs.
 *
 * This module manages the hook through the GitHub API:
 *   - `ensureHook` creates or repairs the hook for one repository
 *   - `planHooks` reports what would change without touching GitHub
 *
 * The secret is generated per repository and stored in `sources.webhook_secret`
 * so a leaked secret only affects one repo. It is never returned by the API.
 */

const GITHUB_API = 'https://api.github.com';
const HOOK_PATH = '/api/v1/webhook/github';

export interface HookEnv {
  DB: D1Database;
  GITHUB_READ_TOKEN?: string;
  /** public origin used to build the payload URL */
  PUBLIC_ORIGIN?: string;
}

interface HookPlan {
  sourceId: string;
  owner: string;
  repo: string;
  action: 'create' | 'update' | 'ok' | 'skip' | 'error';
  reason?: string;
  hookId?: number;
}

interface GitHubHook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string; secret?: string };
}

/** 32 bytes of url-safe randomness; enough for an HMAC key. */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 40);
}

async function gh(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'surge-modules-hook-manager',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Lists existing hooks, tolerating a missing permission as an explicit error. */
async function listHooks(
  owner: string,
  repo: string,
  token: string,
): Promise<{ hooks: GitHubHook[] } | { error: string; status: number }> {
  const { status, data } = await gh(`/repos/${owner}/${repo}/hooks?per_page=100`, token);

  if (status === 404) return { error: '仓库不存在或无权访问', status };
  if (status === 403) return { error: 'Token 缺少 admin:repo_hook 权限', status };
  if (status === 401) return { error: 'Token 无效', status };
  if (status !== 200) return { error: `GitHub 返回 ${status}`, status };

  return { hooks: Array.isArray(data) ? (data as GitHubHook[]) : [] };
}

export interface EnsureResult {
  action: 'create' | 'update' | 'ok' | 'skip' | 'error';
  hookId?: number;
  reason?: string;
}

/**
 * Makes the hook for one repository match what this deployment needs.
 *
 * `dryRun` performs the read but skips every write, which is what the admin UI
 * shows before the operator commits.
 */
export async function ensureHook(
  env: HookEnv,
  source: { id: string; owner: string; repo: string; webhook_secret: string | null },
  options: { dryRun?: boolean } = {},
): Promise<EnsureResult> {
  if (!env.GITHUB_READ_TOKEN) return { action: 'error', reason: '未配置 GitHub Token' };

  const origin = (env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '');
  if (!origin) return { action: 'skip', reason: '未配置 PUBLIC_ORIGIN，无法生成回调地址' };

  const payloadUrl = `${origin}${HOOK_PATH}`;
  const listed = await listHooks(source.owner, source.repo, env.GITHUB_READ_TOKEN);
  if ('error' in listed) return { action: 'error', reason: listed.error };

  // reuse the existing secret if there is one, otherwise mint and persist it
  let secret = source.webhook_secret;
  const needsNewSecret = !secret;

  const existing = listed.hooks.find(
    (h) => (h.config?.url ?? '').replace(/\/+$/, '') === payloadUrl,
  );

  if (existing) {
    const matchesEvents =
      existing.events.length === 1 && existing.events[0] === 'push';
    const matchesType = existing.config?.content_type === 'json';
    if (existing.active && matchesEvents && matchesType && secret) {
      return { action: 'ok', hookId: existing.id };
    }
    if (options.dryRun) {
      return { action: 'update', hookId: existing.id, reason: '事件类型或启用状态不一致' };
    }
    if (needsNewSecret || !secret) {
      secret = generateSecret();
    }
    const { status } = await gh(
      `/repos/${source.owner}/${source.repo}/hooks/${existing.id}`,
      env.GITHUB_READ_TOKEN,
      {
        method: 'PATCH',
        body: {
          active: true,
          events: ['push'],
          config: { url: payloadUrl, content_type: 'json', secret, insecure_ssl: '0' },
        },
      },
    );
    if (status >= 400) return { action: 'error', reason: `更新失败：GitHub ${status}` };
    await persistSecret(env.DB, source.id, secret);
    return { action: 'update', hookId: existing.id };
  }

  if (options.dryRun) {
    return { action: 'create', reason: `将创建 ${payloadUrl}` };
  }

  if (!secret) secret = generateSecret();

  const { status, data } = await gh(`/repos/${source.owner}/${source.repo}/hooks`, env.GITHUB_READ_TOKEN, {
    method: 'POST',
    body: {
      name: 'web',
      active: true,
      events: ['push'],
      config: { url: payloadUrl, content_type: 'json', secret, insecure_ssl: '0' },
    },
  });

  if (status === 422) return { action: 'error', reason: 'GitHub 拒绝：该仓库可能已有相同 URL 的 hook' };
  if (status >= 400) return { action: 'error', reason: `创建失败：GitHub ${status}` };

  await persistSecret(env.DB, source.id, secret);
  const hookId = (data as GitHubHook | null)?.id;
  return { action: 'create', hookId };
}

async function persistSecret(db: D1Database, sourceId: string, secret: string): Promise<void> {
  await db
    .prepare('UPDATE sources SET webhook_secret = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE id = ?')
    .bind(secret, sourceId)
    .run();
}

/** Reports what each registered source needs, without writing anything. */
export async function planHooks(env: HookEnv): Promise<HookPlan[]> {
  // `env` is forwarded whole on purpose: building a partial object here dropped
  // PUBLIC_ORIGIN and made every plan report "not configured".
  const { results } = await env.DB.prepare(
    `SELECT id, owner, repo, webhook_secret, is_enabled
       FROM sources WHERE deleted_at IS NULL ORDER BY owner, repo`,
  ).all<{ id: string; owner: string; repo: string; webhook_secret: string | null; is_enabled: number }>();

  const plans: HookPlan[] = [];

  for (const row of results ?? []) {
    if (row.is_enabled !== 1) {
      plans.push({
        sourceId: row.id,
        owner: row.owner,
        repo: row.repo,
        action: 'skip',
        reason: '数据源未启用',
      });
      continue;
    }
    const outcome = await ensureHook(env, row, { dryRun: true });
    plans.push({
      sourceId: row.id,
      owner: row.owner,
      repo: row.repo,
      action: outcome.action,
      reason: outcome.reason,
      hookId: outcome.hookId,
    });
  }

  return plans;
}

/** Applies the plan for one source or all of them. */
export async function applyHooks(
  env: HookEnv,
  sourceId: 'all' | string = 'all',
): Promise<EnsureResult[]> {
  const rows =
    sourceId === 'all'
      ? (
          await env.DB.prepare(
            `SELECT id, owner, repo, webhook_secret FROM sources
              WHERE deleted_at IS NULL AND is_enabled = 1 ORDER BY owner, repo`,
          ).all<{ id: string; owner: string; repo: string; webhook_secret: string | null }>()
        ).results ?? []
      : (
          await env.DB.prepare(
            'SELECT id, owner, repo, webhook_secret FROM sources WHERE id = ? AND deleted_at IS NULL',
          )
            .bind(sourceId)
            .all<{ id: string; owner: string; repo: string; webhook_secret: string | null }>()
        ).results ?? [];

  const out: EnsureResult[] = [];
  for (const row of rows) {
    out.push(await ensureHook(env, row));
  }
  return out;
}
