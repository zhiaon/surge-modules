/**
 * Cron-triggered sync.
 *
 * Why this exists alongside webhooks: a webhook is only delivered if the
 * repository is configured correctly and GitHub can reach us. If a delivery is
 * lost, or a repo is added without its webhook, nothing would ever pick up the
 * change. The cron sweep is the safety net — it walks every enabled source and
 * re-syncs the ones whose last run is older than the configured interval.
 *
 * Concurrency: sources are processed sequentially. Cloudflare gives a single
 * cron invocation a limited CPU budget, and the per-source lock in `syncSource`
 * already prevents overlap with a webhook-triggered run. Sequential also keeps
 * GitHub API usage predictable against the 5000/hour limit.
 */

export interface CronEnv {
  DB: D1Database;
  GITHUB_READ_TOKEN?: string;
  /** minimum hours between cron runs for a single source (default 6) */
  SYNC_INTERVAL_HOURS?: string;
}

export interface CronResult {
  scanned: number;
  synced: number;
  skipped: number;
  failed: number;
  details: Array<{ sourceId: string; status: string; reason?: string }>;
}

export type SyncFn = (
  db: D1Database,
  sourceId: string,
  trigger: 'cron',
) => Promise<{ status: string; message?: string }>;

export async function runCronSync(
  env: CronEnv,
  sync: SyncFn,
  now = Date.now(),
): Promise<CronResult> {
  const intervalHours = Math.max(1, Number.parseInt(env.SYNC_INTERVAL_HOURS ?? '6', 10) || 6);
  const cutoff = new Date(now - intervalHours * 3600 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  const { results } = await env.DB.prepare(
    `SELECT id, owner, repo, last_synced_at, sync_lock
       FROM sources
      WHERE deleted_at IS NULL AND is_enabled = 1
      ORDER BY COALESCE(last_synced_at, '1970-01-01T00:00:00Z') ASC
      LIMIT 20`,
  ).all<{
    id: string;
    owner: string;
    repo: string;
    last_synced_at: string | null;
    sync_lock: string | null;
  }>();

  const rows = results ?? [];
  const result: CronResult = {
    scanned: rows.length,
    synced: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const row of rows) {
    // another run already holds the lock
    if (row.sync_lock) {
      result.skipped += 1;
      result.details.push({ sourceId: row.id, status: 'skipped', reason: 'locked' });
      continue;
    }

    // recently synced (by webhook or a previous cron) — nothing to do
    if (row.last_synced_at && row.last_synced_at > cutoff) {
      result.skipped += 1;
      result.details.push({ sourceId: row.id, status: 'skipped', reason: 'fresh' });
      continue;
    }

    try {
      const outcome = await sync(env.DB, row.id, 'cron');
      if (outcome.status === 'ok') {
        result.synced += 1;
        result.details.push({ sourceId: row.id, status: 'ok' });
      } else if (outcome.status === 'skipped') {
        result.skipped += 1;
        result.details.push({
          sourceId: row.id,
          status: 'skipped',
          reason: outcome.message ?? 'skipped',
        });
      } else {
        result.failed += 1;
        result.details.push({
          sourceId: row.id,
          status: 'failed',
          reason: outcome.message ?? 'unknown',
        });
      }
    } catch (err) {
      result.failed += 1;
      result.details.push({
        sourceId: row.id,
        status: 'failed',
        reason: err instanceof Error ? err.message.slice(0, 200) : 'threw',
      });
    }
  }

  return result;
}
