import assert from 'node:assert';
import { createTestDb, invoke } from './harness/workers-shim';

/**
 * Phase-6 tests.
 *
 * Focus: the operations phase 6 added must respect the same rules as phase 5 —
 * role checks before any write, no credential in a backup, no restore without
 * explicit confirmation.
 */

(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
  Promise.reject(new Error('network disabled'))) as unknown as typeof fetch;

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

const { db, raw } = createTestDb(true);
const env = {
  ASSETS: { fetch: async () => new Response('spa') },
  DB: db,
  ENVIRONMENT: 'test',
  RATE_LIMIT_SALT: 'test',
  GITHUB_READ_TOKEN: 'ghp_TESTTOKENFORPHASE6',
};

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}
function post(data: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) };
}
function cookieOf(res: { headers: Record<string, string> }): string {
  const rawHeader = res.headers['set-cookie'] ?? '';
  const m = rawHeader.match(/sm_admin=([^;]+)/);
  return m ? `sm_admin=${m[1]}` : '';
}

async function main(): Promise<void> {
  console.log('Phase 6 tests\n');

  // bootstrap a super admin, then an editor that shares its password hash
  await invoke(siteWorker, req('/api/v1/admin/bootstrap', post({ username: 'root', password: 'phase6-super-pass-1' })), env as never);
  const superLogin = await invoke(
    siteWorker,
    req('/api/v1/admin/login', post({ username: 'root', password: 'phase6-super-pass-1' })),
    env as never,
  );
  const superCookie = cookieOf(superLogin);

  const hash = raw("SELECT password_hash FROM admins WHERE username='root'");
  raw(
    `INSERT INTO admins (id, username, display_name, role, password_hash)
     VALUES ('e1','editor1','E','editor','${hash}')`,
  );
  const editorLogin = await invoke(
    siteWorker,
    req('/api/v1/admin/login', post({ username: 'editor1', password: 'phase6-super-pass-1' })),
    env as never,
  );
  const editorCookie = cookieOf(editorLogin);

  const asSuper = { cookie: superCookie };
  const asEditor = { cookie: editorCookie };

  // ---------------------------------------------------------- create module
  await test('creating a module requires authentication', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/modules', post({ name: 'No Auth' })),
      env as never,
    );
    assert.strictEqual(res.status, 401);
  });

  await test('super can create a module and it is written to the database', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/modules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ name: '手工模块', slug: 'manual-one', author: 'ops', is_published: true }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const row = raw("SELECT slug, is_published FROM modules WHERE slug='manual-one'");
    assert.strictEqual(row, 'manual-one|1');
  });

  await test('duplicate slug is rejected with a clear message', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/modules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ name: 'dup', slug: 'manual-one' }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.text.includes('已被占用'));
  });

  await test('invalid slug shape is refused', async () => {
    for (const slug of ['Bad Slug', 'UPPER', '../etc', 'a_b']) {
      const res = await invoke(
        siteWorker,
        req('/api/v1/admin/modules', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...asSuper },
          body: JSON.stringify({ name: 'x', slug }),
        }),
        env as never,
      );
      assert.strictEqual(res.status, 400, `should reject ${slug}`);
    }
  });

  // ------------------------------------------------------- role enforcement
  await test('editor cannot delete a category (403 before any write)', async () => {
    raw("INSERT INTO categories (id,name,slug,description,sort_order,is_visible) VALUES ('cat-empty','空','empty2','',99,1)");
    const before = raw("SELECT COUNT(*) FROM categories WHERE deleted_at IS NULL");
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/categories/cat-empty/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asEditor },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 403, 'editor must be refused');
    const after = raw("SELECT COUNT(*) FROM categories WHERE deleted_at IS NULL");
    assert.strictEqual(after, before, 'the write must not have happened');
  });

  await test('editor cannot create a backup (settings:write is super-only)', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/backups', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asEditor },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 403);
  });

  // ------------------------------------------------------------- categories
  await test('deleting a category with modules is refused', async () => {
    const catId = raw("SELECT category_id FROM modules WHERE deleted_at IS NULL AND category_id IS NOT NULL LIMIT 1");
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/categories/${catId}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.text.includes('还有'), res.text);
  });

  await test('an empty category is soft-deleted', async () => {
    raw("INSERT OR IGNORE INTO categories (id,name,slug,description,sort_order,is_visible) VALUES ('cat-free','自由','freecat','',98,1)");
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/categories/cat-free/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    const alive = raw("SELECT COUNT(*) FROM categories WHERE slug='freecat' AND deleted_at IS NULL");
    assert.strictEqual(alive, '0');
  });

  // ---------------------------------------------------------- update logs
  await test('update log can be created and appears in the list', async () => {
    const created = await invoke(
      siteWorker,
      req('/api/v1/admin/update-logs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ version: '0.6.0', title: '第六阶段', body: '部署与后台完善', kind: 'feature' }),
      }),
      env as never,
    );
    assert.strictEqual(created.status, 200);

    const list = await invoke(
      siteWorker,
      req('/api/v1/admin/update-logs', { headers: asSuper }),
      env as never,
    );
    assert.ok(list.text.includes('第六阶段'));
  });

  await test('update log requires a title', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/update-logs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ body: 'no title' }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 400);
  });

  // -------------------------------------------------------------- backups
  await test('backup snapshot contains content tables and no credentials', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/backups', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ label: 'test' }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);

    const payload = raw("SELECT payload FROM backups ORDER BY created_at DESC LIMIT 1");
    assert.ok(payload.includes('modules'), 'modules table missing from snapshot');
    assert.ok(!payload.includes('password_hash'), 'password hash leaked into backup');
    assert.ok(!payload.includes('ghp_'), 'token leaked into backup');
    assert.ok(!payload.includes('token_hash'), 'session hash leaked into backup');
  });

  await test('backup download sets an attachment filename', async () => {
    const id = raw("SELECT id FROM backups ORDER BY created_at DESC LIMIT 1");
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/backups/${id}/download`, { headers: asSuper }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-disposition']?.includes('attachment'), res.headers['content-disposition']);
    assert.ok(res.headers['content-disposition']?.endsWith('.json"'));
  });

  await test('restore refuses to run without an explicit confirm token', async () => {
    const id = raw("SELECT id FROM backups ORDER BY created_at DESC LIMIT 1");
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/backups/${id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: '{}',
      }),
      env as never,
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.text.includes('确认'));
  });

  await test('restore dry-run reports what would change without writing', async () => {
    const id = raw("SELECT id FROM backups ORDER BY created_at DESC LIMIT 1");
    const before = raw('SELECT COUNT(*) FROM modules');
    const res = await invoke(
      siteWorker,
      req(`/api/v1/admin/backups/${id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ dryRun: true }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('wouldWrite'));
    const after = raw('SELECT COUNT(*) FROM modules');
    assert.strictEqual(after, before, 'dry run must not write');
  });

  await test('restore does not delete rows added after the snapshot', async () => {
    const id = raw("SELECT id FROM backups ORDER BY created_at DESC LIMIT 1");
    // add a module that is not in the snapshot
    raw(
      `INSERT INTO modules (id, slug, name, version, is_published, created_at, updated_at)
       VALUES ('mod-later','later-one','后来加的','1.0.0',1,'2026-12-01T00:00:00Z','2026-12-01T00:00:00Z')`,
    );
    await invoke(
      siteWorker,
      req(`/api/v1/admin/backups/${id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ confirm: id }),
      }),
      env as never,
    );
    const stillThere = raw("SELECT COUNT(*) FROM modules WHERE slug='later-one'");
    assert.strictEqual(stillThere, '1', 'restore must be additive, not destructive');
  });

  // ------------------------------------------------------- operation logs
  await test('mutations are recorded in operation_logs', async () => {
    const actions = raw('SELECT action FROM operation_logs ORDER BY id');
    assert.ok(actions.includes('module.create'), 'module.create not logged');
    assert.ok(actions.includes('backup.create'), 'backup.create not logged');
  });

  await test('operation log output redacts credential-shaped strings', async () => {
    raw(
      `INSERT INTO operation_logs (actor, action, target, result, detail)
       VALUES ('x','test.leak','t','ok','{"token":"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"}')`,
    );
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/operation-logs', { headers: asSuper }),
      env as never,
    );
    assert.ok(!res.text.includes('ghp_ABCDEF'), 'token not redacted from log output');
    assert.ok(res.text.includes('[redacted]'));
  });

  // ----------------------------------------------------------- config I/O
  await test('config export contains public settings only', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/config/export', { headers: asSuper }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes('cache_ttl'), 'internal setting exported');
    assert.ok(!res.text.includes('ghp_'), 'token exported');
  });

  await test('config import writes settings it is given', async () => {
    const res = await invoke(
      siteWorker,
      req('/api/v1/admin/config/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asSuper },
        body: JSON.stringify({ settings: [{ key: 'site.tagline', value: '导入后的标语' }] }),
      }),
      env as never,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(raw("SELECT value FROM site_settings WHERE key='site.tagline'"), '导入后的标语');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
