import assert from 'node:assert';
import { createTestDb } from './harness/workers-shim';

/**
 * Batching, alerts and hook management.
 *
 * The sync engine is exercised against a fake GitHub so the assertions are about
 * our own logic (cursor advance, alert thresholds, hook create-vs-repair), not
 * about GitHub's behaviour.
 */

const { syncSource } = await import('../workers/site/sync');
const { ensureHook, planHooks } = await import('../workers/site/hooks');

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

/** Fake GitHub: a tree listing plus per-file content keyed by path. */
function installGitHub(files: Record<string, string>) {
  const calls: string[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const accept = new Headers(init?.headers ?? {}).get('accept') ?? '';

    if (url.includes('/git/trees/')) {
      return new Response(
        JSON.stringify({
          tree: Object.keys(files).map((path) => ({ path, type: 'blob' })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes('/contents/')) {
      const match = Object.keys(files).find((p) => url.includes(encodeURIComponent(p)) || url.includes(p));
      if (!match) return new Response('not found', { status: 404 });
      return new Response(files[match], {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    if (url.includes('/hooks')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    void accept;
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return calls;
}

function moduleText(name: string, version: string): string {
  return `#!name=${name}\n#!version=${version}\n#!author=tester\n#!desc=demo\n\n[Rule]\nDOMAIN-SUFFIX,example.com,REJECT\n`;
}

async function main(): Promise<void> {
  console.log('Batching, alerts & hooks\n');

  // ---------------------------------------------------------------- batching
  await test('a batch processes at most BATCH_SIZE files and records a cursor', async () => {
    const { db, raw } = createTestDb(true);
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`modules/m${i}.sgmodule`] = moduleText(`M${i}`, '1.0.0');
    installGitHub(files);

    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1, allow_paths='modules/' WHERE id='src-demo'",
    );

    const result = await syncSource(
      { DB: db, GITHUB_READ_TOKEN: 'fake' } as never,
      'src-demo',
      'manual',
    );

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.totalFiles, 10);
    assert.strictEqual(result.processed, 6, 'first batch should be 6 files');
    assert.strictEqual(result.partial, true, 'run should be marked partial');

    const cursor = raw("SELECT sync_cursor FROM sources WHERE id='src-demo'");
    assert.strictEqual(cursor, '6', 'cursor must advance');
  });

  await test('the second batch resumes from the cursor and finishes', async () => {
    const { db, raw } = createTestDb(true);
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`modules/m${i}.sgmodule`] = moduleText(`M${i}`, '1.0.0');
    installGitHub(files);

    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1, allow_paths='modules/' WHERE id='src-demo'",
    );

    await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    const second = await syncSource(
      { DB: db, GITHUB_READ_TOKEN: 'fake' } as never,
      'src-demo',
      'manual',
    );

    assert.strictEqual(second.processed, 4, 'remaining 4 files');
    assert.strictEqual(second.partial, false, 'sweep complete');

    const cursor = raw("SELECT sync_cursor FROM sources WHERE id='src-demo'");
    assert.strictEqual(cursor, '0', 'cursor resets after a full sweep');

    // the seed ships one demo module tied to src-demo, so 10 new + 1 seed = 11
    const count = raw(
      "SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND source_id='src-demo'",
    );
    assert.strictEqual(count, '11', 'all 10 new modules created across two batches');
  });

  await test('a changed file count restarts the sweep instead of resuming', async () => {
    const { db, raw } = createTestDb(true);
    let files: Record<string, string> = {};
    for (let i = 0; i < 8; i += 1) files[`modules/m${i}.sgmodule`] = moduleText(`M${i}`, '1.0.0');
    installGitHub(files);

    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1, allow_paths='modules/' WHERE id='src-demo'",
    );
    await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    assert.strictEqual(raw("SELECT sync_cursor FROM sources WHERE id='src-demo'"), '6');

    // the repository grew: cursor would be meaningless, so it must reset
    files['modules/new1.sgmodule'] = moduleText('New1', '1.0.0');
    files['modules/new2.sgmodule'] = moduleText('New2', '1.0.0');
    files['modules/new3.sgmodule'] = moduleText('New3', '1.0.0');
    installGitHub(files);

    const res = await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    assert.strictEqual(res.totalFiles, 11);
    assert.strictEqual(res.processed, 6, 'restart from the beginning');
  });

  await test('re-running a complete sweep writes nothing new', async () => {
    const { db, raw } = createTestDb(true);
    const files: Record<string, string> = { 'modules/a.sgmodule': moduleText('A', '1.0.0') };
    installGitHub(files);
    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1, allow_paths='modules/' WHERE id='src-demo'",
    );

    await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    const before = raw('SELECT COUNT(*) FROM modules WHERE source_id=\'src-demo\'');
    const again = await syncSource(
      { DB: db, GITHUB_READ_TOKEN: 'fake' } as never,
      'src-demo',
      'manual',
    );

    assert.strictEqual(again.unchanged, 1, 'unchanged file must be counted, not rewritten');
    assert.strictEqual(again.added, 0);
    assert.strictEqual(raw('SELECT COUNT(*) FROM modules WHERE source_id=\'src-demo\''), before);
  });

  // ------------------------------------------------------------------ alerts
  await test('consecutive failures create exactly one alert at the threshold', async () => {
    const { db, raw } = createTestDb(true);
    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1 WHERE id='src-demo'",
    );

    // a listing failure is an easy deterministic error
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;

    for (let i = 0; i < 4; i += 1) {
      await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    }

    const alerts = raw(
      "SELECT COUNT(*) FROM sync_alerts WHERE source_id='src-demo' AND kind='failure'",
    );
    assert.strictEqual(alerts, '1', 'only one alert for a single failure streak');

    const streak = raw("SELECT consecutive_failures FROM sources WHERE id='src-demo'");
    assert.strictEqual(streak, '4');
  });

  await test('a successful sync resets the counter and records recovery', async () => {
    const { db, raw } = createTestDb(true);
    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', branch='main', is_enabled=1, allow_paths='modules/' WHERE id='src-demo'",
    );

    // fail twice to cross the threshold
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i += 1) {
      await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');
    }
    assert.strictEqual(raw("SELECT consecutive_failures FROM sources WHERE id='src-demo'"), '3');

    // then succeed
    installGitHub({ 'modules/a.sgmodule': moduleText('A', '1.0.0') });
    await syncSource({ DB: db, GITHUB_READ_TOKEN: 'fake' } as never, 'src-demo', 'manual');

    assert.strictEqual(raw("SELECT consecutive_failures FROM sources WHERE id='src-demo'"), '0');
    const recovered = raw(
      "SELECT COUNT(*) FROM sync_alerts WHERE source_id='src-demo' AND kind='recovered'",
    );
    assert.strictEqual(recovered, '1', 'recovery must be recorded once');
  });

  // ------------------------------------------------------------------- hooks
  await test('ensureHook creates a hook when none exists', async () => {
    const { db, raw } = createTestDb(true);
    raw("UPDATE sources SET owner='zhiaon', repo='Modules' WHERE id='src-demo'");

    let created = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/hooks') && (init?.method ?? 'GET') === 'GET') {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/hooks') && init?.method === 'POST') {
        created = true;
        const body = JSON.parse(String(init.body)) as { config: { url: string } };
        assert.ok(body.config.url.endsWith('/api/v1/webhook/github'), body.config.url);
        return new Response(JSON.stringify({ id: 42 }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await ensureHook(
      { DB: db, GITHUB_READ_TOKEN: 'fake', PUBLIC_ORIGIN: 'https://son.zhiaon.top' } as never,
      { id: 'src-demo', owner: 'zhiaon', repo: 'Modules', webhook_secret: null },
    );

    assert.strictEqual(result.action, 'create');
    assert.strictEqual(result.hookId, 42);
    assert.strictEqual(created, true);

    const secret = raw("SELECT webhook_secret FROM sources WHERE id='src-demo'");
    assert.ok(secret.length >= 20, 'a per-source secret must be persisted');
  });

  await test('ensureHook reports ok when the hook already matches', async () => {
    const { db, raw } = createTestDb(true);
    raw("UPDATE sources SET owner='zhiaon', repo='Modules', webhook_secret='existing-secret' WHERE id='src-demo'");

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            id: 7,
            active: true,
            events: ['push'],
            config: {
              url: 'https://son.zhiaon.top/api/v1/webhook/github',
              content_type: 'json',
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await ensureHook(
      { DB: db, GITHUB_READ_TOKEN: 'fake', PUBLIC_ORIGIN: 'https://son.zhiaon.top' } as never,
      { id: 'src-demo', owner: 'zhiaon', repo: 'Modules', webhook_secret: 'existing-secret' },
    );

    assert.strictEqual(result.action, 'ok');
    assert.strictEqual(result.hookId, 7);
  });

  await test('ensureHook surfaces a missing permission instead of failing silently', async () => {
    const { db, raw } = createTestDb(true);
    raw("UPDATE sources SET owner='zhiaon', repo='Modules' WHERE id='src-demo'");

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ message: 'not found' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await ensureHook(
      { DB: db, GITHUB_READ_TOKEN: 'fake', PUBLIC_ORIGIN: 'https://son.zhiaon.top' } as never,
      { id: 'src-demo', owner: 'zhiaon', repo: 'Modules', webhook_secret: null },
    );

    assert.strictEqual(result.action, 'error');
    assert.ok(result.reason?.includes('admin:repo_hook'), result.reason);
  });

  await test('dry run never writes to GitHub', async () => {
    const { db, raw } = createTestDb(true);
    raw(
      "UPDATE sources SET owner='zhiaon', repo='Modules', is_enabled=1 WHERE id='src-demo'",
    );

    let wrote = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? 'GET') !== 'GET') wrote = true;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const plan = await planHooks({
      DB: db,
      GITHUB_READ_TOKEN: 'fake',
      PUBLIC_ORIGIN: 'https://son.zhiaon.top',
    } as never);

    assert.strictEqual(wrote, false, 'planHooks must not create anything');
    assert.ok(plan.length > 0);
    assert.strictEqual(plan[0].action, 'create');
  });

  await test('planHooks skips a disabled source without calling GitHub', async () => {
    const { db, raw } = createTestDb(true);
    raw("UPDATE sources SET is_enabled = 0 WHERE id='src-demo'");

    let called = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const plan = await planHooks({
      DB: db,
      GITHUB_READ_TOKEN: 'fake',
      PUBLIC_ORIGIN: 'https://son.zhiaon.top',
    } as never);

    assert.strictEqual(called, false, 'a disabled source needs no API call');
    assert.strictEqual(plan[0].action, 'skip');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
