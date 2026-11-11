import assert from 'node:assert';
import { createTestDb, invoke } from './harness/workers-shim';

/**
 * Webhook and cron tests.
 *
 * The webhook endpoint is unauthenticated by design, so its signature check is
 * the only thing standing between the internet and a sync trigger. Every
 * rejection path is asserted, plus replay and wrong-repo handling.
 */

(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
  Promise.reject(new Error('network disabled'))) as unknown as typeof fetch;

const { default: siteWorker } = await import('../workers/site/index');
const { handleWebhook } = await import('../workers/site/webhook');
const { runCronSync } = await import('../workers/site/cron');

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

const SECRET = 'test-webhook-secret-value';

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function pushBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: 'zhiaon/Modules', default_branch: 'main' },
    commits: [{ id: 'abc123', message: 'update module' }],
    ...overrides,
  });
}

async function post(
  body: string,
  opts: { signature?: string | null; event?: string; delivery?: string } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event ?? 'push',
    'x-github-delivery': opts.delivery ?? crypto.randomUUID(),
  };
  if (opts.signature !== null) {
    headers['x-hub-signature-256'] = opts.signature ?? (await sign(body));
  }
  return new Request('http://localhost:8787/api/v1/webhook/github', {
    method: 'POST',
    headers,
    body,
  });
}

async function main(): Promise<void> {
  console.log('Webhook & cron tests\n');

  const { db, raw } = createTestDb(true);
  raw(
    "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1 WHERE id='src-demo'",
  );

  const env = {
    ASSETS: { fetch: async () => new Response('spa') },
    DB: db,
    ENVIRONMENT: 'test',
    RATE_LIMIT_SALT: 'x',
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_READ_TOKEN: 'ghp_FAKE',
  };

  const syncCalls: string[] = [];
  const deps = {
    sync: async (_db: unknown, sourceId: string) => {
      syncCalls.push(sourceId);
    },
  };

  // ------------------------------------------------------------ signature
  await test('valid signature triggers a sync', async () => {
    syncCalls.length = 0;
    const body = pushBody();
    const res = await handleWebhook(await post(body), env as never, deps as never);
    assert.strictEqual(res.status, 200);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'synced');
    assert.deepStrictEqual(syncCalls, ['src-demo']);
  });

  await test('missing signature header is rejected', async () => {
    syncCalls.length = 0;
    const body = pushBody();
    const res = await handleWebhook(
      await post(body, { signature: null }),
      env as never,
      deps as never,
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(syncCalls.length, 0, 'must not sync without a signature');
  });

  await test('wrong signature is rejected', async () => {
    syncCalls.length = 0;
    const body = pushBody();
    const forged = await sign(body, 'attacker-secret');
    const res = await handleWebhook(
      await post(body, { signature: forged }),
      env as never,
      deps as never,
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('tampered body is rejected even with a valid-looking signature', async () => {
    syncCalls.length = 0;
    const original = pushBody();
    const signature = await sign(original);
    const tampered = pushBody({ ref: 'refs/heads/evil' });
    const res = await handleWebhook(
      await post(tampered, { signature }),
      env as never,
      deps as never,
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('missing secret in the deployment returns 503, not success', async () => {
    const noSecret = { ...env, GITHUB_WEBHOOK_SECRET: undefined };
    const res = await handleWebhook(await post(pushBody()), noSecret as never, deps as never);
    assert.strictEqual(res.status, 503);
  });

  // ------------------------------------------------------------- replay
  await test('a replayed delivery id is dropped', async () => {
    syncCalls.length = 0;
    const body = pushBody();
    const delivery = 'fixed-delivery-id-001';
    const sig = await sign(body);

    const first = await handleWebhook(
      await post(body, { signature: sig, delivery }),
      env as never,
      deps as never,
    );
    assert.strictEqual(first.status, 200);
    assert.strictEqual(syncCalls.length, 1);

    syncCalls.length = 0;
    const second = await handleWebhook(
      await post(body, { signature: sig, delivery }),
      env as never,
      deps as never,
    );
    assert.strictEqual(second.status, 200);
    const payload = (await second.json()) as { action: string };
    assert.strictEqual(payload.action, 'duplicate');
    assert.strictEqual(syncCalls.length, 0, 'replay must not trigger a second sync');
  });

  // -------------------------------------------------------------- events
  await test('ping event is acknowledged without syncing', async () => {
    syncCalls.length = 0;
    const body = JSON.stringify({ zen: 'Non-blocking is better than blocking.', hook_id: 1 });
    const res = await handleWebhook(await post(body, { event: 'ping' }), env as never, deps as never);
    assert.strictEqual(res.status, 200);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'pong');
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('non-push events are acknowledged and ignored', async () => {
    syncCalls.length = 0;
    for (const event of ['issues', 'pull_request', 'release']) {
      const res = await handleWebhook(await post(pushBody(), { event }), env as never, deps as never);
      assert.strictEqual(res.status, 202, `${event} should be 202`);
      const payload = (await res.json()) as { action: string };
      assert.strictEqual(payload.action, 'ignored');
    }
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('branch deletion is ignored', async () => {
    syncCalls.length = 0;
    const body = pushBody({ deleted: true, commits: [] });
    const res = await handleWebhook(await post(body), env as never, deps as never);
    assert.strictEqual(res.status, 200);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'ignored');
    assert.strictEqual(syncCalls.length, 0);
  });

  // -------------------------------------------------------------- scoping
  await test('an unregistered repository is refused', async () => {
    syncCalls.length = 0;
    const body = pushBody({ repository: { full_name: 'someone-else/their-modules' } });
    const res = await handleWebhook(await post(body), env as never, deps as never);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('a push to a different branch is ignored', async () => {
    syncCalls.length = 0;
    const body = pushBody({ ref: 'refs/heads/feature/dev' });
    const res = await handleWebhook(await post(body), env as never, deps as never);
    assert.strictEqual(res.status, 200);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'ignored');
    assert.strictEqual(syncCalls.length, 0);
  });

  await test('a disabled source is ignored', async () => {
    raw("UPDATE sources SET is_enabled = 0 WHERE id = 'src-demo'");
    syncCalls.length = 0;
    const res = await handleWebhook(await post(pushBody()), env as never, deps as never);
    assert.strictEqual(res.status, 200);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'ignored');
    assert.strictEqual(syncCalls.length, 0);
    raw("UPDATE sources SET is_enabled = 1 WHERE id = 'src-demo'");
  });

  await test('invalid JSON is rejected', async () => {
    const body = 'not json at all';
    const res = await handleWebhook(
      await post(body, { signature: await sign(body) }),
      env as never,
      deps as never,
    );
    assert.strictEqual(res.status, 400);
  });

  await test('oversized body is rejected before parsing', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024);
    const res = await handleWebhook(
      await post(huge, { signature: await sign(huge) }),
      env as never,
      deps as never,
    );
    assert.strictEqual(res.status, 413);
  });

  await test('the response never contains the secret', async () => {
    const res = await handleWebhook(await post(pushBody()), env as never, deps as never);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), 'secret leaked into the webhook response');
  });

  await test('with waitUntil the webhook answers 202 before the sync finishes', async () => {
    const pending: Array<Promise<unknown>> = [];
    let resolved = false;
    const slowDeps = {
      sync: async () => {
        await new Promise((r) => setTimeout(r, 50));
        resolved = true;
      },
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
    };

    const body = pushBody();
    const res = await handleWebhook(await post(body), env as never, slowDeps as never);

    // the response must be returned before the work completes
    assert.strictEqual(res.status, 202);
    const payload = (await res.json()) as { action: string };
    assert.strictEqual(payload.action, 'accepted');
    assert.strictEqual(resolved, false, 'sync must not block the response');
    assert.strictEqual(pending.length, 1, 'work must be handed to waitUntil');

    await pending[0];
    assert.strictEqual(resolved, true, 'background work must actually run');
  });

  await test('a failing background sync does not reject waitUntil', async () => {
    const pending: Array<Promise<unknown>> = [];
    const failingDeps = {
      sync: async () => {
        throw new Error('boom');
      },
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
    };

    const res = await handleWebhook(await post(pushBody()), env as never, failingDeps as never);
    assert.strictEqual(res.status, 202);
    // must resolve, never reject, or Cloudflare logs an unhandled rejection
    await pending[0];
  });

  // -------------------------------------------------------------- router
  await test('the webhook route is wired into the public API', async () => {
    const body = pushBody();
    const request = new Request('http://localhost:8787/api/v1/webhook/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': await sign(body),
      },
      body,
    });
    const res = await invoke(siteWorker, request, env as never);
    assert.notStrictEqual(res.status, 404, 'webhook route missing');
  });

  // ---------------------------------------------------------------- cron
  await test('cron syncs only sources past the interval', async () => {
    const { db: cronDb, raw: cronRaw } = createTestDb(true);
    cronRaw("UPDATE sources SET is_enabled = 1 WHERE id = 'src-demo'");
    cronRaw(
      "UPDATE sources SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 'src-demo'",
    );

    const calls: string[] = [];
    const result = await runCronSync(
      { DB: cronDb, SYNC_INTERVAL_HOURS: '6' } as never,
      (async (_db: unknown, id: string) => {
        calls.push(id);
        return { status: 'ok' };
      }) as never,
    );

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.skipped, 1, 'a fresh source must be skipped');
    assert.strictEqual(calls.length, 0);
  });

  await test('cron syncs a stale source', async () => {
    const { db: cronDb, raw: cronRaw } = createTestDb(true);
    cronRaw("UPDATE sources SET is_enabled = 1 WHERE id = 'src-demo'");
    cronRaw("UPDATE sources SET last_synced_at = '2020-01-01T00:00:00Z' WHERE id = 'src-demo'");

    const calls: string[] = [];
    const result = await runCronSync(
      { DB: cronDb, SYNC_INTERVAL_HOURS: '6' } as never,
      (async (_db: unknown, id: string) => {
        calls.push(id);
        return { status: 'ok' };
      }) as never,
    );

    assert.strictEqual(result.synced, 1);
    assert.deepStrictEqual(calls, ['src-demo']);
  });

  await test('cron skips a source that is currently locked', async () => {
    const { db: cronDb, raw: cronRaw } = createTestDb(true);
    cronRaw(
      "UPDATE sources SET is_enabled = 1, sync_lock = 'held', sync_lock_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 'src-demo'",
    );
    cronRaw("UPDATE sources SET last_synced_at = '2020-01-01T00:00:00Z' WHERE id = 'src-demo'");

    const result = await runCronSync(
      { DB: cronDb, SYNC_INTERVAL_HOURS: '6' } as never,
      (async () => ({ status: 'ok' })) as never,
    );

    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.details[0].reason, 'locked');
  });

  await test('cron ignores disabled sources entirely', async () => {
    const { db: cronDb, raw: cronRaw } = createTestDb(true);
    cronRaw("UPDATE sources SET is_enabled = 0 WHERE id = 'src-demo'");

    const result = await runCronSync(
      { DB: cronDb, SYNC_INTERVAL_HOURS: '6' } as never,
      (async () => ({ status: 'ok' })) as never,
    );

    assert.strictEqual(result.scanned, 0, 'disabled source must not even be listed');
  });

  await test('a throwing sync is counted as failed, not fatal', async () => {
    const { db: cronDb, raw: cronRaw } = createTestDb(true);
    cronRaw(
      "UPDATE sources SET is_enabled = 1, last_synced_at = '2020-01-01T00:00:00Z' WHERE id = 'src-demo'",
    );

    const result = await runCronSync(
      { DB: cronDb, SYNC_INTERVAL_HOURS: '6' } as never,
      (async () => {
        throw new Error('github is down');
      }) as never,
    );

    assert.strictEqual(result.failed, 1);
    assert.ok(result.details[0].reason?.includes('github is down'));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
