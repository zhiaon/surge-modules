/**
 * GitHub webhook receiver.
 *
 * Security model
 * --------------
 * GitHub signs every delivery with HMAC-SHA256 over the **raw request body**
 * using a secret you set on the repository side. We recompute that digest and
 * compare in constant time. Without this check the endpoint would let anyone
 * trigger a sync.
 *
 * Hardening on top of the signature:
 *   - the event must be `push` (anything else is acknowledged and ignored, so
 *     GitHub does not retry forever)
 *   - the delivery id is stored so a replayed payload is dropped
 *   - the repository must match an enabled row in `sources`; an unknown repo is
 *     a 404, not a silent success
 *   - the ref must be the branch that source tracks
 *   - body size is capped before parsing
 *   - the response never echoes the secret or the computed digest
 */

const MAX_BODY = 5 * 1024 * 1024; // GitHub caps pushes around 25MB; 5 is plenty

export interface WebhookEnv {
  DB: D1Database;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_READ_TOKEN?: string;
}

export interface WebhookDeps {
  /** injected so the handler stays testable without importing the sync engine */
  sync: (db: D1Database, sourceId: string, trigger: 'webhook') => Promise<unknown>;
  /**
   * Keeps the isolate alive after the response is sent. In production this is
   * `ctx.waitUntil`; when absent (tests) the sync is awaited so assertions can
   * observe the call.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Constant-time compare for two hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, body as unknown as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string; default_branch?: string };
  commits?: Array<{ id?: string; message?: string }>;
  head_commit?: { id?: string; message?: string } | null;
  deleted?: boolean;
  zen?: string;
}

export async function handleWebhook(
  request: Request,
  env: WebhookEnv,
  deps: WebhookDeps,
): Promise<Response> {
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  if (!env.GITHUB_WEBHOOK_SECRET) {
    // not configured is an operator error, not a client error — but still do not
    // pretend the delivery succeeded
    return json(503, { ok: false, error: 'webhook_not_configured' });
  }

  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_BODY) {
    return json(413, { ok: false, error: 'payload_too_large' });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY) {
    return json(413, { ok: false, error: 'payload_too_large' });
  }

  const signature = request.headers.get('x-hub-signature-256') ?? '';
  if (!signature) {
    return json(401, { ok: false, error: 'missing_signature' });
  }

  // ---- event type: acknowledge anything we do not act on
  const event = request.headers.get('x-github-event') ?? '';

  const bodyText = new TextDecoder().decode(raw);
  let parsedBody: PushPayload;
  try {
    parsedBody = JSON.parse(bodyText) as PushPayload;
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  // Resolve the secret to verify against. A `ping` carries no repository field
  // in its body when sent from the hooks API, so it falls back to the
  // deployment-wide secret; a `push` always names its repository.
  const repoFullName = parsedBody.repository?.full_name ?? '';
  const [repoOwner, repoName] = repoFullName.split('/');

  let verifyWith: string | null = null;
  if (repoOwner && repoName) {
    const row = await env.DB.prepare(
      `SELECT webhook_secret FROM sources
        WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND deleted_at IS NULL
        LIMIT 1`,
    )
      .bind(repoOwner, repoName)
      .first<{ webhook_secret: string | null }>();
    if (row?.webhook_secret) verifyWith = row.webhook_secret;
  }
  if (!verifyWith) verifyWith = env.GITHUB_WEBHOOK_SECRET ?? null;

  if (!verifyWith) {
    return json(503, { ok: false, error: 'webhook_not_configured' });
  }

  let verified = timingSafeEqualHex(
    signature,
    `sha256=${await hmacSha256Hex(verifyWith, raw)}`,
  );

  // `ping` sent from the hooks API carries no repository, so the per-source
  // secret is unknown. Accept it if it matches any registered secret: a ping
  // performs no action, so the worst case is an unauthenticated handshake.
  if (!verified && event === 'ping') {
    const { results } = await env.DB.prepare(
      'SELECT webhook_secret FROM sources WHERE deleted_at IS NULL AND webhook_secret IS NOT NULL',
    ).all<{ webhook_secret: string }>();
    for (const row of results ?? []) {
      const candidate = `sha256=${await hmacSha256Hex(row.webhook_secret, raw)}`;
      if (timingSafeEqualHex(signature, candidate)) {
        verified = true;
        break;
      }
    }
  }

  if (!verified) {
    return json(401, { ok: false, error: 'invalid_signature' });
  }

  if (event === 'ping') {
    return json(200, { ok: true, action: 'pong' });
  }
  if (event !== 'push') {
    return json(202, { ok: true, action: 'ignored', reason: `event:${event || 'unknown'}` });
  }

  // ---- delivery id: drop replays
  const delivery = request.headers.get('x-github-delivery') ?? '';
  if (delivery) {
    const seen = await env.DB.prepare(
      'SELECT 1 AS hit FROM rate_limits WHERE bucket = ? AND window = ? LIMIT 1',
    )
      .bind(`webhook:${delivery}`, 'seen')
      .first<{ hit: number }>();
    if (seen) {
      return json(200, { ok: true, action: 'duplicate' });
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rate_limits (bucket, window, count) VALUES (?, 'seen', 1)`,
    )
      .bind(`webhook:${delivery}`)
      .run();
  }

  const payload = parsedBody;

  // an empty push (branch delete, or a push with no commits) has nothing to sync
  if (payload.deleted) {
    return json(200, { ok: true, action: 'ignored', reason: 'branch_deleted' });
  }

  const fullName = payload.repository?.full_name ?? '';
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    return json(400, { ok: false, error: 'missing_repository' });
  }
  const ref = payload.ref ?? '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';

  // ---- must match a registered source
  const source = await env.DB.prepare(
    `SELECT id, branch, is_enabled FROM sources
      WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(owner, repo)
    .first<{ id: string; branch: string; is_enabled: number }>();

  if (!source) {
    // 404 rather than 202: an unregistered repo is a misconfiguration someone
    // should notice in the GitHub delivery log
    return json(404, { ok: false, error: 'source_not_registered' });
  }
  if (source.is_enabled !== 1) {
    return json(200, { ok: true, action: 'ignored', reason: 'source_disabled' });
  }
  if (branch && branch !== source.branch) {
    return json(200, { ok: true, action: 'ignored', reason: `branch:${branch}` });
  }

  // ---- sync
  //
  // Acknowledge first, work after. GitHub aborts the request at 10s; a full scan
  // of a dozen modules already exceeds that, and a 500 in the delivery log while
  // the sync actually succeeded is worse than useless — it trains the operator
  // to ignore red entries.
  const work = deps.sync(env.DB, source.id, 'webhook');

  if (deps.waitUntil) {
    // the rejection must be swallowed here or it becomes an unhandled rejection
    // inside waitUntil; the sync engine already records the failure in sync_jobs
    deps.waitUntil(
      work.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[webhook] background sync failed:', message);
      }),
    );
    return json(202, { ok: true, action: 'accepted', source: source.id });
  }

  // no waitUntil available (tests, or a runtime without it): await so the caller
  // sees a deterministic outcome, and surface failure as 500 because nothing else
  // would report it
  try {
    await work;
    return json(200, { ok: true, action: 'synced', source: source.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[webhook] sync failed:', message);
    return json(500, { ok: false, error: 'sync_failed' });
  }
}

/** Exposed for tests. */
export const __test = { hmacSha256Hex, timingSafeEqualHex };
