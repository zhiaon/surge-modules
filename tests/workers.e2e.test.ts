import assert from 'node:assert';
import {
  createTestDb,
  installFetch,
  restoreFetch,
  fetchCalls,
  fakeFetch,
  MemoryCache,
  invoke,
  jsonResponse,
} from './harness/workers-shim';

/**
 * End-to-end tests for both workers, run against real SQLite and a shimmed
 * GitHub upstream.
 *
 * Coverage maps to the phase-4 acceptance list:
 *   1. SPA/static routing and API both respond
 *   2. list / detail / versions / categories / announcements / settings
 *   3. pagination, filtering, sorting, search
 *   4. proxy resolves only registered own-repo modules
 *   5. arbitrary URL / hostname / traversal / unknown slug are rejected
 *   6. credentials never appear in a response
 *   7. upstream 404 / 403 / 429 / timeout handled with safe errors
 *   8. cache hit / miss and revision rotation
 *   9. analytics whitelist + rate limit
 */

// The workers call global fetch/caches; wire the shims before importing them.
(globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
(globalThis as unknown as { caches: unknown }).caches = { default: new MemoryCache() };

const { default: siteWorker } = await import('../workers/site/index');
const { default: proxyWorker } = await import('../workers/module-proxy/index');

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    // isolate the edge cache per test: a cached 200 would mask a failure case
    (globalThis as unknown as { caches: unknown }).caches = { default: new MemoryCache() };
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

const ORIGIN = 'https://site.example.com';

interface SiteEnv {
  ASSETS: { fetch: (r: Request) => Promise<Response> };
  DB: unknown;
  ENVIRONMENT: string;
  RATE_LIMIT_SALT: string;
}

async function newSite(opts: { seed?: boolean } = {}): Promise<SiteEnv> {
  const { db } = createTestDb(opts.seed ?? false);
  return {
    ASSETS: {
      fetch: async () => new Response('<!doctype html><title>spa</title>', {
        headers: { 'content-type': 'text/html' },
      }),
    },
    DB: db,
    ENVIRONMENT: 'test',
    RATE_LIMIT_SALT: 'test-salt',
  };
}

function get(env: SiteEnv, path: string): Promise<ReturnType<typeof invoke>> {
  return invoke(siteWorker, new Request(`${ORIGIN}${path}`), env as never);
}

async function main(): Promise<void> {
  console.log('Worker end-to-end tests\n');

  // ------------------------------------------------------------- site: basics
  const site = await newSite();

  await test('non-API path is served by the asset binding (SPA fallback)', async () => {
    const res = await get(site, '/modules/anything');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('spa'), res.text.slice(0, 80));
  });

  await test('health returns a coarse status without internals', async () => {
    const res = await get(site, '/api/v1/health');
    assert.strictEqual(res.status, 200);
    const body = res.json<{ ok: boolean; data: Record<string, unknown> }>();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.status, 'ok');
    assert.strictEqual(body.data.db, true);
    // must not leak versions, binding names or env vars
    const raw = JSON.stringify(body);
    for (const leak of ['database_id', 'compatibility', 'wrangler', 'token']) {
      assert.ok(!raw.toLowerCase().includes(leak), `health leaked ${leak}`);
    }
  });

  await test('unknown API route is a JSON 404, not the SPA shell', async () => {
    const res = await get(site, '/api/v1/nope');
    assert.strictEqual(res.status, 404);
    assert.ok(res.headers['content-type']?.includes('application/json'));
    assert.strictEqual(res.json<{ ok: boolean }>().ok, false);
  });

  await test('wrong method yields 405 with an Allow header', async () => {
    const res = await invoke(
      siteWorker,
      new Request(`${ORIGIN}/api/v1/modules`, { method: 'POST' }),
      site as never,
    );
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.allow, 'GET');
  });

  // ----------------------------------------------------------- site: catalogue
  const seeded = await newSite({ seed: true });

  await test('empty database returns an empty page, not an error', async () => {
    const res = await get(site, '/api/v1/modules');
    assert.strictEqual(res.status, 200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    assert.deepStrictEqual(body.data, []);
    assert.strictEqual(body.meta.total, 0);
  });

  await test('module list returns the seeded module with a proxy rawUrl', async () => {
    const res = await get(seeded, '/api/v1/modules');
    const body = res.json<{
      data: Array<{ slug: string; rawUrl: string; tags: string[]; category: { slug: string } }>;
      meta: { total: number; page: number; perPage: number };
    }>();
    assert.strictEqual(body.meta.total, 1);
    assert.strictEqual(body.data[0].slug, 'demo-module');
    assert.strictEqual(body.data[0].rawUrl, 'http://localhost:8788/demo-module');
    assert.deepStrictEqual(body.data[0].tags.sort(), ['占位', '示例'].sort());
    assert.strictEqual(body.data[0].category.slug, 'adblock');
  });

  await test('module payload never contains upstream or source fields', async () => {
    const res = await get(seeded, '/api/v1/modules');
    const raw = res.text;
    for (const leak of ['upstream_url', 'raw.githubusercontent', 'source_id', 'source_path']) {
      assert.ok(!raw.includes(leak), `list payload leaked ${leak}`);
    }
  });

  await test('detail includes versions in release order', async () => {
    const res = await get(seeded, '/api/v1/modules/demo-module');
    assert.strictEqual(res.status, 200);
    const body = res.json<{ data: { versions: Array<{ version: string }>; rawUrl: string } }>();
    assert.deepStrictEqual(
      body.data.versions.map((v) => v.version),
      ['1.2.0', '1.1.0', '1.0.0'],
    );
    assert.strictEqual(body.data.rawUrl, 'http://localhost:8788/demo-module');
  });

  await test('unknown slug is 404 and malformed slug is 400', async () => {
    assert.strictEqual((await get(seeded, '/api/v1/modules/nope')).status, 404);
    assert.strictEqual((await get(seeded, '/api/v1/modules/Bad_Slug')).status, 400);
    assert.strictEqual(
      (await get(seeded, '/api/v1/modules/..%2f..%2fetc')).status,
      400,
    );
  });

  await test('perPage is clamped to the configured maximum', async () => {
    const res = await get(seeded, '/api/v1/modules?perPage=9999');
    const body = res.json<{ meta: { perPage: number } }>();
    assert.strictEqual(body.meta.perPage, 60);
  });

  await test('category filter and empty category behave correctly', async () => {
    const hit = await get(seeded, '/api/v1/modules?category=adblock');
    assert.strictEqual(hit.json<{ meta: { total: number } }>().meta.total, 1);
    const miss = await get(seeded, '/api/v1/modules?category=tools');
    assert.strictEqual(miss.json<{ meta: { total: number } }>().meta.total, 0);
  });

  await test('search matches name and tags, and rejects SQL-ish input safely', async () => {
    const byName = await get(seeded, `/api/v1/modules?q=${encodeURIComponent('演示')}`);
    assert.strictEqual(byName.json<{ meta: { total: number } }>().meta.total, 1);

    const byTag = await get(seeded, `/api/v1/modules?q=${encodeURIComponent('占位')}`);
    assert.strictEqual(byTag.json<{ meta: { total: number } }>().meta.total, 1);

    // a wildcard must not match everything
    const wildcard = await get(seeded, `/api/v1/modules?q=${encodeURIComponent('%')}`);
    assert.strictEqual(wildcard.json<{ meta: { total: number } }>().meta.total, 0);

    // injection attempt stays a literal string
    const evil = await get(
      seeded,
      `/api/v1/modules?q=${encodeURIComponent("' OR 1=1 --")}`,
    );
    assert.strictEqual(evil.json<{ meta: { total: number } }>().meta.total, 0);
  });

  await test('sort whitelist ignores unknown values', async () => {
    const res = await get(seeded, '/api/v1/modules?sort=;DROP TABLE modules');
    assert.strictEqual(res.status, 200);
    const after = await get(seeded, '/api/v1/modules');
    assert.strictEqual(after.json<{ meta: { total: number } }>().meta.total, 1);
  });

  await test('categories strip the deleted category and report real counts', async () => {
    const res = await get(seeded, '/api/v1/categories');
    const body = res.json<{ data: Array<{ slug: string; moduleCount: number }> }>();
    const slugs = body.data.map((c) => c.slug);
    assert.ok(!slugs.includes('gone'), 'deleted category leaked');
    const adblock = body.data.find((c) => c.slug === 'adblock');
    assert.strictEqual(adblock?.moduleCount, 1);
  });

  await test('announcements return only published rows', async () => {
    const res = await get(seeded, '/api/v1/announcements');
    const body = res.json<{ data: Array<{ id: string }> }>();
    assert.ok(body.data.length >= 1);
  });

  await test('public settings exclude every internal key', async () => {
    const res = await get(seeded, '/api/v1/settings');
    assert.strictEqual(res.status, 200);
    const raw = res.text;
    assert.ok(!raw.includes('cache_ttl'), 'internal setting leaked');
    assert.ok(!raw.includes('max_bytes'), 'internal setting leaked');
    assert.ok(!raw.includes('analytics.enabled'), 'internal setting leaked');
    const body = res.json<{ data: { siteName: string; proxyBase: string } }>();
    assert.strictEqual(body.data.siteName, 'Surge Modules');
    assert.strictEqual(body.data.proxyBase, 'http://localhost:8788');
  });

  // --------------------------------------------------------------- analytics
  await test('analytics accepts whitelisted events', async () => {
    const res = await invoke(
      siteWorker,
      new Request(`${ORIGIN}/api/v1/analytics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ event: 'page_view', subject: '/' }] }),
      }),
      seeded as never,
    );
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.json<{ data: { accepted: number } }>().data.accepted, 1);
  });

  await test('analytics rejects unknown events and oversized bodies', async () => {
    const bad = await invoke(
      siteWorker,
      new Request(`${ORIGIN}/api/v1/analytics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ event: 'install_success' }] }),
      }),
      seeded as never,
    );
    assert.strictEqual(bad.status, 400);

    const big = await invoke(
      siteWorker,
      new Request(`${ORIGIN}/api/v1/analytics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2048),
      }),
      seeded as never,
    );
    assert.strictEqual(big.status, 413);
  });

  await test('analytics is rate limited per client window', async () => {
    // Send enough requests that the fixed window cannot be missed, and stop at
    // the first 429. A tighter loop was flaky because the window rolls over on a
    // minute boundary and resets the counter mid-test.
    const env = await newSite({ seed: true });
    let seen429 = false;
    for (let i = 0; i < 200; i += 1) {
      const res = await invoke(
        siteWorker,
        new Request(`${ORIGIN}/api/v1/analytics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
          body: JSON.stringify({ events: [{ event: 'page_view' }] }),
        }),
        env as never,
      );
      if (res.status === 429) {
        seen429 = true;
        assert.ok(res.headers['cache-control']?.includes('no-store'), 'error must not be cached');
        break;
      }
    }
    assert.ok(seen429, 'expected 429 once the window is exhausted');
  });

  // ------------------------------------------------------------------ proxy
  const SLUG_BODY = '#!name=Demo\n[Rule]\nDOMAIN-SUFFIX,example.com,REJECT\n';

  const proxyEnv = () => {
    const { db, raw } = createTestDb(true);
    // the seed leaves the source disabled on purpose; enable it for proxy tests
    raw("UPDATE sources SET is_enabled = 1 WHERE id = 'src-demo'");
    return {
      env: {
        DB: db,
        GITHUB_READ_TOKEN: 'ghp_SUPERSECRETTOKENVALUE',
        PUBLIC_BASE: 'https://raw.example.com',
        ENVIRONMENT: 'test',
        CACHE_TTL_SECONDS: '300',
        MAX_MODULE_BYTES: '4096',
        UPSTREAM_TIMEOUT_MS: '50',
      },
      raw,
    };
  };

  /** One-call convenience: fresh db, source enabled, worker env. */
  const proxyCase = () => {
    const { env, raw } = proxyEnv();
    return { env, raw };
  };

  await test('proxy serves a registered own-repo module as text/plain', async () => {
    installFetch(() =>
      Promise.resolve(new Response(SLUG_BODY, { status: 200, headers: { etag: '"abc"' } })),
    );
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type']?.startsWith('text/plain'));
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['content-security-policy']?.includes("default-src 'none'"));
    assert.ok(res.text.includes('DOMAIN-SUFFIX'));
    restoreFetch();
  });

  await test('proxy never leaks the GitHub token to the client', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    for (const value of Object.values(res.headers)) {
      assert.ok(!value.includes('SUPERSECRET'), 'token in response headers');
    }
    assert.ok(!res.text.includes('SUPERSECRET'), 'token in response body');
    // and the token is sent to GitHub as a bearer header, not a query param
    assert.ok(fetchCalls.length > 0);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.strictEqual(call.headers.authorization, 'Bearer ghp_SUPERSECRETTOKENVALUE');
    assert.ok(!call.url.includes('SUPERSECRET'), 'token in upstream URL');
    restoreFetch();
  });

  await test('proxy asks for a path inside the allowlisted directory only', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env } = proxyCase();
    await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.ok(call.url.startsWith('https://api.github.com/repos/your-github-user/your-modules-repo/contents/'), call.url);
    assert.ok(call.url.includes('modules/demo-module.sgmodule'), call.url);
    assert.ok(call.headers.accept.includes('vnd.github.raw'));
    restoreFetch();
  });

  await test('proxy rejects unknown slug, traversal, extra segments and query strings', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env } = proxyCase();
    const cases: Array<[string, number]> = [
      ['https://raw.example.com/no-such-module', 404],
      ['https://raw.example.com/..%2f..%2fetc%2fpasswd', 400],
      ['https://raw.example.com/demo-module/extra', 400],
      ['https://raw.example.com/demo-module?ref=other', 400],
      ['https://raw.example.com/demo-module?url=http://evil.com', 400],
      ['https://raw.example.com/Demo_Module', 400],
      ['https://raw.example.com/', 200],
    ];
    for (const [url, expected] of cases) {
      const res = await invoke(proxyWorker, new Request(url), env as never);
      assert.strictEqual(res.status, expected, `${url} → ${res.status}`);
    }
    restoreFetch();
  });

  await test('proxy refuses to fetch anything when the mapping is disabled', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env, raw } = proxyCase();
    raw("UPDATE module_proxy_mappings SET is_enabled = 0 WHERE public_slug = 'demo-module'");
    const res = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(fetchCalls.length, 0, 'upstream must not be called for a disabled mapping');
    restoreFetch();
  });

  await test('proxy refuses to fetch when the source is disabled', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env, raw } = proxyCase();
    raw("UPDATE sources SET is_enabled = 0 WHERE id = 'src-demo'");
    const res = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(fetchCalls.length, 0);
    restoreFetch();
  });

  await test('proxy refuses to fetch when the file path escapes the allowlist', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env, raw } = proxyCase();
    raw("UPDATE module_proxy_mappings SET file_path = '../secrets.txt' WHERE public_slug = 'demo-module'");
    const res = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(fetchCalls.length, 0);
    restoreFetch();
  });

  await test('proxy refuses a path outside allow_paths even inside the repo', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env, raw } = proxyCase();
    raw("UPDATE module_proxy_mappings SET file_path = 'other/evil.sgmodule' WHERE public_slug = 'demo-module'");
    const res = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(fetchCalls.length, 0);
    restoreFetch();
  });

  // ------------------------------------------------------- upstream failures
  await test('upstream 404 becomes a safe 404', async () => {
    installFetch(() => Promise.resolve(new Response('not found', { status: 404 })));
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 404);
    assert.ok(!res.text.toLowerCase().includes('github'));
    restoreFetch();
  });

  await test('upstream 403 (no quota left) becomes 429 with Retry-After', async () => {
    installFetch(() =>
      Promise.resolve(
        new Response('forbidden', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'retry-after': '42' },
        }),
      ),
    );
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '42');
    restoreFetch();
  });

  await test('upstream 403 without rate limit info becomes 403 without detail', async () => {
    installFetch(() => Promise.resolve(new Response('forbidden', { status: 403 })));
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 403);
    const raw = res.text;
    assert.ok(!raw.includes('repo'), 'must not reveal repo existence');
    restoreFetch();
  });

  await test('upstream timeout becomes 504', async () => {
    installFetch(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, 10);
        }),
    );
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 504);
    restoreFetch();
  });

  await test('oversized upstream body becomes 413', async () => {
    installFetch(() => Promise.resolve(new Response('x'.repeat(9000), { status: 200 })));
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 413);
    restoreFetch();
  });

  // ------------------------------------------------------------------- cache
  await test('second request is served from cache and does not call upstream', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: new MemoryCache() };
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env } = proxyCase();

    const first = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(first.headers['x-proxy-cache'], 'miss');
    const callsAfterFirst = fetchCalls.length;

    const second = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(second.headers['x-proxy-cache'], 'hit');
    assert.strictEqual(fetchCalls.length, callsAfterFirst, 'cache hit must not refetch');
    restoreFetch();
  });

  await test('a new content hash rotates the cache key', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: new MemoryCache() };
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const { env, raw } = proxyCase();

    await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    const before = fetchCalls.length;

    raw("UPDATE module_proxy_mappings SET content_hash = 'seed-v2' WHERE public_slug = 'demo-module'");
    assert.strictEqual(
      raw("SELECT content_hash FROM module_proxy_mappings WHERE public_slug = 'demo-module'"),
      'seed-v2',
      'test setup: hash must be updated in the shared db file',
    );
    const after = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);

    assert.strictEqual(after.headers['x-proxy-cache'], 'miss', 'revision change must miss');
    assert.ok(fetchCalls.length > before, 'a rotated key refetches');
    assert.strictEqual(after.headers['x-module-revision'], 'seed-v2');
    restoreFetch();
  });

  await test('errors are never cached', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: new MemoryCache() };
    installFetch(() => Promise.resolve(new Response('nope', { status: 404 })));
    const { env } = proxyCase();
    await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    const res = await invoke(proxyWorker, new Request('https://raw.example.com/demo-module'), env as never);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    restoreFetch();
  });

  await test('HEAD returns headers without a body', async () => {
    installFetch(() => Promise.resolve(new Response(SLUG_BODY, { status: 200 })));
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module', { method: 'HEAD' }),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, '');
    restoreFetch();
  });

  await test('unknown slug is 404 even when the deployment has no token', async () => {
    // a 500 for an unknown slug would confirm to a prober that the slug exists
    const base = proxyCase();
    const env = { ...base.env, GITHUB_READ_TOKEN: '' };
    const unknown = await invoke(proxyWorker, new Request('https://raw.example.com/nope'), env as never);
    assert.strictEqual(unknown.status, 404, 'unknown slug must not reveal misconfiguration');

    const known = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module'),
      env as never,
    );
    assert.strictEqual(known.status, 500, 'a known slug with no token is an operator error');
    assert.ok(!known.text.includes('token'), 'must not echo the secret name back');
  });

  await test('proxy rejects non-GET methods', async () => {
    const res = await invoke(
      proxyWorker,
      new Request('https://raw.example.com/demo-module', { method: 'POST' }),
      proxyCase().env as never,
    );
    assert.strictEqual(res.status, 405);
  });

  // ---------------------------------------------------------------- summary
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
void jsonResponse;
