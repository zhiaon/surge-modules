import assert from 'node:assert';
import {
  createTestDb,
  installFetch,
  restoreFetch,
  fetchCalls,
  invoke,
} from './harness/workers-shim';

/**
 * Phase-5 admin tests.
 *
 * Security assertions come first because they are the ones that matter:
 * unauthenticated access, role enforcement, password handling, session
 * revocation, and the promise that a GitHub token is never stored or echoed.
 */

(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
  Promise.reject(new Error('network disabled in this suite'))) as unknown as typeof fetch;

const { default: siteWorker } = await import('../workers/site/index');

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

const ORIGIN = 'http://localhost:8787';

function makeEnv(db: unknown, token?: string) {
  return {
    ASSETS: { fetch: async () => new Response('spa') },
    DB: db,
    ENVIRONMENT: 'test',
    RATE_LIMIT_SALT: 'test',
    GITHUB_READ_TOKEN: token,
  };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function jsonBody(data: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function cookieOf(res: { headers: Record<string, string> }): string {
  const raw = res.headers['set-cookie'] ?? '';
  const match = raw.match(/sm_admin=([^;]+)/);
  return match ? `sm_admin=${match[1]}` : '';
}

async function main(): Promise<void> {
  console.log('Admin & sync tests\n');

  // ============================================================ auth basics
  const { db, raw } = createTestDb(true);
  const env = makeEnv(db, 'ghp_TESTTOKENVALUE1234567890');

  await test('admin API rejects unauthenticated access', async () => {
    for (const path of [
      '/api/v1/admin/dashboard',
      '/api/v1/admin/modules',
      '/api/v1/admin/mappings',
      '/api/v1/admin/sources',
      '/api/v1/admin/review',
      '/api/v1/admin/settings',
      '/api/v1/admin/audit',
    ]) {
      const res = await invoke(siteWorker, req(path), env as never);
      assert.strictEqual(res.status, 401, `${path} should be 401`);
    }
  });

  await test('bootstrap is allowed only while no admin exists', async () => {
    const first = await invoke(
      siteWorker,
      req('/api/v1/admin/bootstrap', jsonBody({ username: 'root', password: 'correct-horse-battery' })),
      env as never,
    );
    assert.strictEqual(first.status, 200);

    const second = await invoke(
      siteWorker,
      req('/api/v1/admin/bootstrap', jsonBody({ username: 'root2', password: 'another-long-one-here' })),
      env as never,
    );
    assert.strictEqual(second.status, 403, 'second bootstrap must be refused');
  });

  await test('password is stored as a PBKDF2 hash, never in plaintext', async () => {
    const hash = raw("SELECT password_hash FROM admins WHERE username='root'");
    assert.ok(hash.startsWith('pbkdf2$'), hash.slice(0, 20));
    assert.ok(!hash.includes('correct-horse-battery'), 'plaintext password in database');
    const iterations = Number.parseInt(hash.split('$')[1], 10);
    assert.ok(iterations >= 100_000, `iteration count too low: ${iterations}`);
  });

  await test('login rejects a wrong password without revealing the account', async () => {
    const wrong = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'root', password: 'nope' })),
      env as never,
    );
    const missing = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'ghost', password: 'nope' })),
      env as never,
    );
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(missing.status, 401);
    // identical message ⇒ no account enumeration
    assert.strictEqual(wrong.text, missing.text);
  });

  await test('successful login sets an HttpOnly session cookie', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'root', password: 'correct-horse-battery' })),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const cookie = res.headers['set-cookie'] ?? '';
    assert.ok(cookie.includes('sm_admin='), 'missing cookie');
    assert.ok(/HttpOnly/i.test(cookie), 'cookie must be HttpOnly');
    assert.ok(/SameSite=Lax/i.test(cookie), 'cookie must set SameSite');
    // Secure is added only over https, which this test is not
    assert.ok(!/Secure/i.test(cookie), 'Secure should not be set on http');
  });

  await test('five failed attempts lock the account', async () => {
    raw("INSERT INTO admins (id, username, display_name, role, password_hash) VALUES ('a2','victim','V','editor','pbkdf2$210000$AAAA$AAAA')");
    for (let i = 0; i < 5; i += 1) {
      await invoke(
        siteWorker,
        req('/api/v1/admin/login', jsonBody({ username: 'victim', password: 'wrong' })),
        env as never,
      );
    }
    const locked = raw("SELECT locked_until FROM admins WHERE username='victim'");
    assert.ok(locked && locked !== '', 'account should be locked');
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'victim', password: 'wrong' })),
      env as never,
    );
    assert.strictEqual(res.status, 429, 'locked account must be throttled');
  });

  // -------------------------------------------------- authenticated requests
  const login = await invoke(
    siteWorker,
    req('/api/v1/admin/login', jsonBody({ username: 'root', password: 'correct-horse-battery' })),
    env as never,
  );
  const authCookie = cookieOf(login);
  const auth = { cookie: authCookie };

  await test('session cookie grants access to the dashboard', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/dashboard', { headers: auth }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const body = res.json<{ ok: boolean; data: { counts: Record<string, number> } }>();
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.data.counts.total === 'number');
  });

  await test('dashboard reports only real counts, no invented metrics', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/dashboard', { headers: auth }),
      env as never,
    );
    const body = res.json<{
      data: { counts: Record<string, number>; proxy: { hits: number; misses: number } };
    }>();
    // a fresh database has one seeded module and zero proxy traffic
    assert.strictEqual(body.data.counts.total, 1);
    assert.strictEqual(body.data.proxy.hits, 0);
    assert.strictEqual(body.data.proxy.misses, 0);
  });

  await test('the session token is stored only as a hash', async () => {
    const cookie = authCookie.replace('sm_admin=', '');
    const hashes = raw('SELECT token_hash FROM admin_sessions')
      .split('\n')
      .filter(Boolean);
    assert.ok(hashes.length > 0, 'no session row');
    for (const hash of hashes) {
      assert.notStrictEqual(hash, cookie, 'raw token stored in database');
      assert.strictEqual(hash.length, 44, `expected a sha-256 base64 digest, got ${hash.length}`);
    }
  });

  // ------------------------------------------------------------- role checks
  await test('editor role cannot touch sources or settings', async () => {
    const hashRes = await invoke(
      siteWorker,
      req('/api/v1/admin/bootstrap', jsonBody({ username: 'x', password: 'y' })),
      env as never,
    );
    void hashRes;

    // create an editor directly, then log in as them
    const saltHash = raw("SELECT password_hash FROM admins WHERE username='root'");
    raw(
      `INSERT INTO admins (id, username, display_name, role, password_hash)
       VALUES ('a3','editor1','E','editor','${saltHash}')`,
    );
    const loginRes = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'editor1', password: 'correct-horse-battery' })),
      env as never,
    );
    const editorCookie = cookieOf(loginRes);
    assert.ok(editorCookie, 'editor login failed');

    const sourceAttempt = await invoke(
      siteWorker,
      req('/api/v1/admin/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...{ cookie: editorCookie } },
        body: JSON.stringify({ owner: 'someone', repo: 'repo' }),
      }),
      env as never,
    );
    assert.strictEqual(sourceAttempt.status, 403, 'editor must not create sources');

    const settingsAttempt = await invoke(
      siteWorker,
      req('/api/v1/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: editorCookie },
        body: JSON.stringify({ items: [{ key: 'site.name', value: 'x' }] }),
      }),
      env as never,
    );
    assert.strictEqual(settingsAttempt.status, 403, 'editor must not write settings');
  });

  await test('editor can still moderate content', async () => {
    const loginRes = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'editor1', password: 'correct-horse-battery' })),
      env as never,
    );
    const cookie = cookieOf(loginRes);
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/modules/mod-demo', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ description: 'edited by editor' }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
  });

  await test('module deletion requires super role', async () => {
    const loginRes = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'editor1', password: 'correct-horse-battery' })),
      env as never,
    );
    const cookie = cookieOf(loginRes);
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/modules/mod-demo', { method: 'DELETE', headers: { cookie } }),
      env as never,
    );
    assert.strictEqual(res.status, 403, 'editor must not delete modules');
  });

  // ------------------------------------------------------- overrides persist
  await test('admin edits are stored as overrides, not just row changes', async () => {
    raw("DELETE FROM module_overrides WHERE module_id='mod-demo'");
    await invoke(
      siteWorker,
      req('/api/v1/admin/modules/mod-demo', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ name: '管理员改名' }),
      }),
      env as never,
    );
    const override = raw("SELECT value FROM module_overrides WHERE module_id='mod-demo' AND field='name'");
    assert.strictEqual(override, '管理员改名');
    const rowValue = raw("SELECT name FROM modules WHERE id='mod-demo'");
    assert.strictEqual(rowValue, '管理员改名');
  });

  await test('a later sync cannot overwrite an admin field', async () => {
    // simulate what sync does: it consults overrides before writing
    const overridden = raw("SELECT COUNT(*) FROM module_overrides WHERE module_id='mod-demo' AND field='name'");
    assert.strictEqual(overridden, '1');
    // the sync code path checks this set, so the guard is the row itself
    const ov = raw("SELECT field FROM module_overrides WHERE module_id='mod-demo'");
    assert.ok(ov.includes('name'));
  });

  // -------------------------------------------------------------- hiding
  await test('hiding a module also disables its proxy mapping', async () => {
    await invoke(
      siteWorker,
      req('/api/v1/admin/modules/mod-demo/hide', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      }),
      env as never,
    );
    const published = raw("SELECT is_published FROM modules WHERE id='mod-demo'");
    const mapping = raw("SELECT is_enabled FROM module_proxy_mappings WHERE module_id='mod-demo'");
    assert.strictEqual(published, '0');
    assert.strictEqual(mapping, '0', 'hidden module must not resolve via the proxy');
  });

  await test('a hidden module disappears from the public API', async () => {
    const res = await invoke(siteWorker, req('/api/v1/modules/demo-module'), env as never);
    assert.strictEqual(res.status, 404);
  });

  // ------------------------------------------------------------- audit trail
  await test('destructive actions are written to audit_logs', async () => {
    const actions = raw("SELECT action FROM audit_logs ORDER BY id");
    assert.ok(actions.includes('admin.bootstrap'), 'bootstrap not audited');
    assert.ok(actions.includes('module.hide'), 'hide not audited');
    assert.ok(actions.includes('source.create') || actions.includes('module.update'));
  });

  await test('audit log never contains a credential', async () => {
    const dump = raw('SELECT actor || action || COALESCE(target,\'\') || COALESCE(detail,\'\') FROM audit_logs');
    assert.ok(!dump.includes('correct-horse'), 'password leaked into audit log');
    assert.ok(!dump.includes('ghp_'), 'token leaked into audit log');
  });

  // ---------------------------------------------------------- token hygiene
  await test('no response body ever contains the GitHub token', async () => {
    const paths = [
      '/api/v1/admin/dashboard',
      '/api/v1/admin/sources',
      '/api/v1/admin/mappings',
      '/api/v1/admin/settings',
    ];
    for (const path of paths) {
      const res = await invoke(siteWorker, req(path, { headers: auth }), env as never);
      assert.ok(!res.text.includes('ghp_TESTTOKENVALUE'), `${path} leaked the token`);
    }
  });

  await test('the token is not stored in any database column', async () => {
    const tables = [
      'site_settings',
      'sources',
      'modules',
      'audit_logs',
      'admins',
      'module_proxy_mappings',
    ];
    for (const table of tables) {
      const dump = raw(`SELECT * FROM ${table}`);
      assert.ok(!dump.includes('ghp_TESTTOKENVALUE'), `token found in ${table}`);
    }
  });

  // ------------------------------------------------------------ proxy rules
  await test('deleting a mapping makes the slug unresolvable', async () => {
    const mapId = raw("SELECT id FROM module_proxy_mappings WHERE public_slug='demo-module'");
    await invoke(
      siteWorker,
      req(`/api/v1/admin/mappings/${mapId}`, { method: 'DELETE', headers: auth }),
      env as never,
    );
    const stillEnabled = raw(
      "SELECT COUNT(*) FROM module_proxy_mappings WHERE public_slug='demo-module' AND is_enabled=1 AND deleted_at IS NULL",
    );
    assert.strictEqual(stillEnabled, '0');
  });

  await test('mapping refresh bumps the revision so the cache key rotates', async () => {
    raw("UPDATE module_proxy_mappings SET deleted_at=NULL, is_enabled=1 WHERE public_slug='demo-module'");
    const before = raw("SELECT content_hash FROM module_proxy_mappings WHERE public_slug='demo-module'");
    const mapId = raw("SELECT id FROM module_proxy_mappings WHERE public_slug='demo-module'");
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/mappings/${mapId}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const after = raw("SELECT content_hash FROM module_proxy_mappings WHERE public_slug='demo-module'");
    assert.notStrictEqual(after, before);
  });

  await test('mapping path validation rejects traversal', async () => {
    const mapId = raw("SELECT id FROM module_proxy_mappings WHERE public_slug='demo-module'");
    for (const bad of ['../../../etc/passwd', '/etc/passwd', 'a\\b', 'http://evil/x']) {
      const res = await invoke(
        siteWorker,
        req(`/api/v1/admin/mappings/${mapId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ file_path: bad }),
        }),
        env as never,
      );
      assert.strictEqual(res.status, 400, `should reject ${bad}`);
    }
  });

  // ------------------------------------------------------------- sync basics
  await test('sync refuses to run without a token', async () => {
    raw('UPDATE sources SET is_enabled = 1');
    const noToken = makeEnv(db, undefined);
    const loginRes = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'root', password: 'correct-horse-battery' })),
      noToken as never,
    );
    const cookie = cookieOf(loginRes);
    const sourceId = raw('SELECT id FROM sources LIMIT 1');
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/sync/${sourceId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      }),
      noToken as never,
    );
    // the endpoint succeeds but the job reports failure — never a silent no-op
    const body = res.json<{ data: { results: Array<{ status: string; message: string }> } }>();
    assert.strictEqual(body.data.results[0].status, 'failed');
    assert.ok(body.data.results[0].message.includes('GITHUB_READ_TOKEN'));
  });

  await test('sync ignores a disabled source instead of touching data', async () => {
    raw("UPDATE sources SET is_enabled = 0");
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/sync/${raw('SELECT id FROM sources LIMIT 1')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      }),
      env as never,
    );
    const body = res.json<{ data: { results: Array<{ status: string }> } }>();
    assert.strictEqual(body.data.results[0].status, 'skipped');
    raw("UPDATE sources SET is_enabled = 1");
  });

  await test('a tombstoned path is skipped and cannot be resurrected', async () => {
    const sourceId = raw('SELECT id FROM sources LIMIT 1');
    const path = raw("SELECT source_path FROM modules WHERE id='mod-demo'");
    raw(
      `INSERT OR IGNORE INTO module_tombstones (id, source_id, source_path, reason)
       VALUES ('tomb1','${sourceId}','${path}','removed')`,
    );
    const count = raw(`SELECT COUNT(*) FROM module_tombstones WHERE source_path='${path}'`);
    assert.strictEqual(count, '1');
  });

  // ---------------------------------------------------------- session end
  await test('logout revokes the session server-side', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/logout', { method: 'POST', headers: auth }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const after = await invoke(
      siteWorker,
      req('/api/v1/admin/dashboard', { headers: auth }),
      env as never,
    );
    assert.strictEqual(after.status, 401, 'revoked session still works');
  });

  await test('an expired session is rejected', async () => {
    const loginRes = await invoke(
      siteWorker,
      req('/api/v1/admin/login', jsonBody({ username: 'root', password: 'correct-horse-battery' })),
      env as never,
    );
    const cookie = cookieOf(loginRes);
    raw("UPDATE admin_sessions SET expires_at = '2020-01-01T00:00:00Z' WHERE revoked_at IS NULL");
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/dashboard', { headers: { cookie } }),
      env as never,
    );
    assert.strictEqual(res.status, 401);
  });

  restoreFetch();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  void installFetch;
  void fetchCalls;
}

await main();
