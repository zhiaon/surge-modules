/**
 * Analytics ingestion.
 *
 * Constraints that matter more than the feature:
 *  - whitelisted event names only (a typo must not create unbounded rows)
 *  - no IP, no user agent, no cookie, no referrer — nothing that identifies a
 *    person is stored. Rate limiting uses a hashed, rotating bucket key.
 *  - body size, field length and per-window count are all capped
 */

import {
  ANALYTICS_EVENTS,
  ANALYTICS_LIMITS,
  type AnalyticsEventName,
} from '../../packages/shared/src/contract';

export interface IngestResult {
  accepted: number;
  rejected: number;
  limited: boolean;
}

interface EventInput {
  event: AnalyticsEventName;
  subject?: string;
}

/** Parses and validates the request body. Returns null when the shape is wrong. */
export function parseEvents(raw: unknown): EventInput[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const list = (raw as { events?: unknown }).events;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length > 10) return null;

  const out: EventInput[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const name = e.event;
    if (typeof name !== 'string') return null;
    if (!(ANALYTICS_EVENTS as readonly string[]).includes(name)) return null;

    const subject =
      typeof e.subject === 'string'
        ? e.subject.slice(0, ANALYTICS_LIMITS.maxSubjectLength)
        : undefined;

    // a slug-like subject only; free text is not needed for counters and would
    // let arbitrary strings leak into the table
    if (subject && !/^[a-zA-Z0-9/_.-]+$/.test(subject)) return null;

    out.push({ event: name as AnalyticsEventName, subject });
  }
  return out;
}

/**
 * Fixed-window counter in D1. Cheap, monotonic enough for abuse control, and it
 * avoids a Durable Object for what is essentially "don't let one client spam".
 *
 * The bucket key is a hash of the client's address + a per-deploy salt, rotated
 * by the window. The raw address never touches the database.
 */
export async function checkRateLimit(
  db: D1Database,
  salt: string,
  clientKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = new Date();
  // Window id granularity follows the configured window: a 60s window buckets
  // per minute, a 300s window per five minutes, so the stored counter and the
  // policy can never disagree.
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  const slot = Math.floor(now.getUTCMinutes() / minutes) * minutes;
  const windowId = `${now.toISOString().slice(0, 13)}:${String(slot).padStart(2, '0')}`;
  const bucket = `analytics:${await hashShort(`${salt}:${clientKey}:${windowId}`)}`;

  await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1`,
    )
    .bind(bucket, windowId)
    .run();

  const row = await db
    .prepare('SELECT count FROM rate_limits WHERE bucket = ? AND window = ?')
    .bind(bucket, windowId)
    .first<{ count: number }>();

  const used = row?.count ?? 1;

  // opportunistic cleanup: keep the table from growing without a cron
  if (Math.random() < 0.02) {
    const cutoff = new Date(now.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 16);
    await db
      .prepare('DELETE FROM rate_limits WHERE window < ?')
      .bind(cutoff)
      .run()
      .catch(() => undefined);
  }

  return used <= limit;
}

export async function insertEvents(
  db: D1Database,
  events: EventInput[],
): Promise<number> {
  if (events.length === 0) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(
    'INSERT INTO analytics_events (event, subject, day) VALUES (?, ?, ?)',
  );
  await db.batch(
    events.map((e) => stmt.bind(e.event, e.subject ?? null, day)),
  );
  return events.length;
}

/** Short hex digest; not reversible, not a stable cross-window identifier. */
export async function hashShort(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
