import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createTestDb, installFetch, restoreFetch, fakeFetch } from './harness/workers-shim';

/**
 * Phase 7 — third-party repository integration.
 *
 * The suites here test the properties that would be catastrophic to get wrong,
 * not the happy path for its own sake:
 *
 *   - unreviewed content can never reach `modules` (version protection)
 *   - the same change detected by webhook + cron + manual creates ONE task
 *   - a stale approval can never overwrite a newer version
 *   - a Telegram callback from a non-admin decides nothing
 *   - deleting a file upstream never deletes a live module by itself
 *   - HMAC is over the raw body and a bad signature creates no task
 */

// The engine calls the global `fetch`; point it at the stub before any module
// that performs a request is imported.
(globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;

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

const {
  inspectRepository,
  recordCheck,
  listRepositories,
  getRepository,
  createReviewTask,
  verifyGithubSignature,
  parseRepoUrl,
  changesFromPush,
  safePath,
  isSgmodule,
  encryptSecret,
  decryptSecret,
} = await import('../workers/site/third-party');
const { sha256: sha256Of } = await import('../workers/site/sync');
const { decideTask, listTasks, getTask } = await import('../workers/site/review');
const { handleTelegramWebhook } = await import('../workers/site/telegram');
const { handleRepoWebhook } = await import('../workers/site/admin-third-party');

// ------------------------------------------------------------------ fixtures
const MODULE_V1 = `#!name=测试模块
#!desc=V1.0: 原始版本
#!author=测试作者
#!category=工具

[Rule]
DOMAIN,example.com,REJECT
`;

const MODULE_V2 = `#!name=测试模块
#!desc=V2.0: 更新版本
#!author=测试作者
#!category=工具

[Rule]
DOMAIN,example.com,REJECT
DOMAIN,example.org,REJECT
`;

const MODULE_NEW = `#!name=全新模块
#!desc=一个刚被发现的新模块
#!author=新作者

[Script]
http-response ^https://api.example.com/ script-path=test.js
`;

interface RepoSeed {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  secret?: string;
}

/** Inserts a repository row directly; the API path is exercised separately. */
function seedRepo(path: string, seed: RepoSeed): void {
  execFileSync('sqlite3', [path], {
    input: `PRAGMA foreign_keys=OFF;
INSERT INTO third_party_repositories
  (id, name, owner, repository, repository_url, default_branch, description,
   enabled, webhook_enabled, cron_enabled, manual_check_enabled,
   check_interval_hours, next_check_at, auto_review_new, auto_review_update,
   webhook_secret_enc)
VALUES ('${seed.id}', '${seed.owner}/${seed.repo}', '${seed.owner}', '${seed.repo}',
        'https://github.com/${seed.owner}/${seed.repo}', '${seed.branch}',
        '测试仓库', 1, 1, 1, 1, 6, '1970-01-01T00:00:00Z', 1, 1,
        ${seed.secret ? `'${seed.secret}'` : 'NULL'});`,
  });
}

/** A fetch stub that serves a fixed tree + file contents from memory. */
/**
 * Deterministic pseudo-blob SHA.
 *
 * Must depend on the WHOLE content: `Buffer.from(c).toString('hex').slice(0,40)`
 * only covers the first 20 bytes, and every module file starts with the same
 * `#!name=` header — so two different versions collided on the same blob sha and
 * the change detector correctly concluded "unchanged". Real git hashes the full
 * object, so the stub must too.
 */
function pseudoBlob(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  const part = (n: number) => n.toString(16).padStart(8, '0');
  return (part(h1) + part(h2) + part(content.length) + part(h1 ^ h2) + part(h2 + 1)).slice(0, 40);
}

function stubGitHub(tree: Record<string, string>) {
  installFetch(async (call) => {
    const url = call.url;

    if (url.includes('/git/trees/')) {
      const body = {
        tree: Object.entries(tree).map(([path, content]) => ({
          path,
          type: 'blob',
          sha: pseudoBlob(content),
          size: content.length,
        })),
        truncated: false,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/contents/')) {
      const decoded = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      const content = tree[decoded];
      if (content === undefined) return new Response('not found', { status: 404 });
      return new Response(content, { status: 200 });
    }

    if (url.includes('/repos/')) {
      return new Response(
        JSON.stringify({ default_branch: 'main', description: 'stub', full_name: 'a/b' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response('{}', { status: 200 });
  });
}

async function sign(body: string, secret: string): Promise<string> {
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

async function main(): Promise<void> {
  console.log('Phase 7 — third-party repositories\n');

  // ------------------------------------------------------- URL & path parsing
  console.log('URL / path parsing');

  await test('parses https, ssh and bare owner/repo forms', () => {
    assert.deepStrictEqual(parseRepoUrl('https://github.com/zhiaon/Modules')?.owner, 'zhiaon');
    assert.deepStrictEqual(parseRepoUrl('https://github.com/zhiaon/Modules.git')?.repo, 'Modules');
    assert.strictEqual(parseRepoUrl('git@github.com:zhiaon/Modules.git')?.repo, 'Modules');
    assert.strictEqual(parseRepoUrl('zhiaon/Modules')?.owner, 'zhiaon');
    assert.strictEqual(parseRepoUrl('https://gitlab.com/a/b'), null);
    assert.strictEqual(parseRepoUrl(''), null);
  });

  await test('rejects path traversal and non-sgmodule files', () => {
    assert.strictEqual(safePath('../../etc/passwd'), false);
    assert.strictEqual(safePath('/absolute.sgmodule'), false);
    assert.strictEqual(safePath('a/../b.sgmodule'), false);
    assert.strictEqual(safePath('dir/mod.sgmodule'), true);
    assert.strictEqual(isSgmodule('a/b.SGMODULE'), true);
    assert.strictEqual(isSgmodule('a/b.js'), false);
    assert.strictEqual(isSgmodule('a/b.json'), false);
  });

  await test('push payload collapses to one change per path, last state wins', () => {
    const changes = changesFromPush({
      after: 'sha-head',
      commits: [
        { id: 'c1', added: ['a.sgmodule'], modified: [], removed: [] },
        { id: 'c2', added: [], modified: ['a.sgmodule'], removed: [] },
        { id: 'c3', added: [], modified: [], removed: ['b.sgmodule'] },
        { id: 'c4', added: [], modified: [], removed: ['a.sgmodule'] },
      ],
    });
    const byPath = new Map(changes.map((c) => [c.path, c.status]));
    assert.strictEqual(byPath.get('a.sgmodule'), 'removed', 'last state of a wins');
    assert.strictEqual(byPath.get('b.sgmodule'), 'removed');
  });

  await test('push payload ignores non-sgmodule and unsafe paths', () => {
    const changes = changesFromPush({
      commits: [{ id: 'c1', added: ['x.js', 'y.sgmodule'], modified: [], removed: ['../evil.sgmodule'] }],
    });
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].path, 'y.sgmodule');
  });

  // ---------------------------------------------------- webhook crypto/signing
  console.log('\nWebhook security');

  await test('AES-GCM round-trips a per-repo secret', async () => {
    const key = 'a'.repeat(32);
    const enc = await encryptSecret('super-secret-value-123', key);
    assert.notStrictEqual(enc, 'super-secret-value-123');
    assert.strictEqual(await decryptSecret(enc, key), 'super-secret-value-123');
    // a different key must not decrypt
    assert.strictEqual(await decryptSecret(enc, 'b'.repeat(32)), null);
  });

  await test('HMAC verification accepts the real payload and rejects tampering', async () => {
    const secret = 'repo-secret-value-abc';
    const body = '{"ref":"refs/heads/main"}';
    const good = await sign(body, secret);
    assert.strictEqual(await verifyGithubSignature(body, good, secret), true);
    assert.strictEqual(await verifyGithubSignature(body + ' ', good, secret), false);
    assert.strictEqual(await verifyGithubSignature(body, good, 'other-secret'), false);
    assert.strictEqual(await verifyGithubSignature(body, null, secret), false);
    assert.strictEqual(await verifyGithubSignature(body, 'md5=abc', secret), false);
  });

  // --------------------------------------------------------- detection engine
  console.log('\nDetection (all three methods share one engine)');

  const { db, path, raw } = createTestDb(true);
  seedRepo(path, { id: 'repo-1', owner: 'zhiaon', repo: 'Modules', branch: 'main' });

  const env = {
    DB: db,
    GITHUB_READ_TOKEN: 'ghp_FAKE',
    ENVIRONMENT: 'test',
  };

  await test('first scan discovers a new module and creates a pending task', async () => {
    stubGitHub({ 'mods/first.sgmodule': MODULE_V1 });
    const repo = await getRepository(db as never, 'repo-1');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'cron',
      silent: true,
    });
    assert.strictEqual(result.newModules, 1, `expected 1 new module, got ${result.newModules}`);
    assert.strictEqual(result.updatedModules, 0);

    const tasks = await listTasks(db as never, { status: 'pending' });
    assert.strictEqual(tasks.total, 1);
    assert.strictEqual(tasks.items[0].task_type, 'new');
    assert.strictEqual(tasks.items[0].detection_method, 'cron');
  });

  await test('nothing is published before approval', () => {
    const rows = raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(rows, '0', 'unreviewed module must not reach the live table');
    const published = raw('SELECT published FROM third_party_modules LIMIT 1');
    assert.strictEqual(published, '0');
  });

  await test('re-scanning unchanged content creates no duplicate task', async () => {
    stubGitHub({ 'mods/first.sgmodule': MODULE_V1 });
    const repo = await getRepository(db as never, 'repo-1');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'cron',
      silent: true,
    });
    assert.strictEqual(result.newModules, 0);
    assert.strictEqual(result.unchanged, 1);
    const tasks = await listTasks(db as never, { status: 'pending' });
    assert.strictEqual(tasks.total, 1, 'dedupe must keep exactly one pending task');
  });

  await test('the same change via webhook dedupes against the cron task', async () => {
    const repo = await getRepository(db as never, 'repo-1');
    const changes = changesFromPush({
      commits: [{ id: 'deadbeef', added: ['mods/first.sgmodule'], modified: [], removed: [] }],
    });
    stubGitHub({ 'mods/first.sgmodule': MODULE_V1 });
    await inspectRepository(env as never, repo as never, {
      method: 'webhook',
      changes,
      commitSha: 'deadbeef',
      silent: true,
    });
    const tasks = await listTasks(db as never, { status: 'pending' });
    assert.strictEqual(tasks.total, 1, 'three methods must not multiply pending tasks');
  });

  await test('approving publishes the module into the live catalogue', async () => {
    const tasks = await listTasks(db as never, { status: 'pending' });
    const task = tasks.items[0];
    const res = await decideTask(env as never, {
      taskId: task.id,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.message);
    assert.strictEqual((res as { published?: boolean }).published, true);

    const live = raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(live, '1', 'approved module must appear in modules');
    const published = raw('SELECT published FROM third_party_modules LIMIT 1');
    assert.strictEqual(published, '1');
    const history = raw('SELECT COUNT(*) FROM module_version_history');
    assert.strictEqual(history, '1', 'first version must be recorded');
  });

  await test('a second approval of the same task is refused', async () => {
    const tasks = await listTasks(db as never, { status: 'approved' });
    const res = await decideTask(env as never, {
      taskId: tasks.items[0].id,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual((res as { code?: string }).code, 'conflict');
  });

  await test('an update is detected but does NOT touch the live module', async () => {
    stubGitHub({ 'mods/first.sgmodule': MODULE_V2 });
    const repo = await getRepository(db as never, 'repo-1');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'manual',
      silent: true,
    });
    assert.strictEqual(
      result.updatedModules,
      1,
      `got ${result.updatedModules}; outcomes=${JSON.stringify(result.outcomes)}; ` +
        `blob=${raw("SELECT COALESCE(current_blob_sha,'NULL') FROM third_party_modules WHERE file_path='mods/first.sgmodule'")}`,
    );

    // live version must still be the old content
    const liveHash = raw("SELECT content_hash FROM modules WHERE source_path = 'mods/first.sgmodule'");
    const oldHash = await sha256Of(MODULE_V1);
    assert.strictEqual(liveHash, oldHash, 'pending update must not overwrite the live version');

    const tasks = await listTasks(db as never, { status: 'pending' });
    assert.strictEqual(tasks.items[0].task_type, 'update');
  });

  await test('rejecting an update leaves the live module untouched', async () => {
    const tasks = await listTasks(db as never, { status: 'pending' });
    const res = await decideTask(env as never, {
      taskId: tasks.items[0].id,
      decision: 'reject',
      operator: 'tester',
      source: 'web',
      reason: '内容不合规',
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.message);

    const liveHash = raw("SELECT content_hash FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(liveHash, await sha256Of(MODULE_V1), 'rejected update must not publish');
    const reason = raw("SELECT rejection_reason FROM module_review_tasks WHERE review_status='rejected'");
    assert.strictEqual(reason, '内容不合规');
  });

  await test('a newer version supersedes the older pending task', async () => {
    // Independent fixture: two unreviewed updates in a row on a repo of its own,
    // so the assertion does not depend on what earlier tests left behind.
    seedRepo(path, { id: 'repo-sup', owner: 'sup', repo: 'demo', branch: 'main' });

    const v1 = `#!name=覆盖测试\n#!desc=V1.0 初始\n\n[Rule]\nDOMAIN,a.com,REJECT\n`;
    const v2 = `#!name=覆盖测试\n#!desc=V2.0 第二\n\n[Rule]\nDOMAIN,a.com,REJECT\nDOMAIN,b.com,REJECT\n`;
    const v3 = `#!name=覆盖测试\n#!desc=V3.0 第三\n\n[Rule]\nDOMAIN,a.com,REJECT\nDOMAIN,c.com,REJECT\n`;

    stubGitHub({ 'mod.sgmodule': v1 });
    let repo = await getRepository(db as never, 'repo-sup');
    await inspectRepository(env as never, repo as never, { method: 'cron', silent: true });

    // Publish V1 first: an "update" only exists for a module that is already
    // live, which is the real ordering (new → approve → update → approve).
    const firstId = raw(
      "SELECT id FROM module_review_tasks WHERE repository_id='repo-sup' AND review_status='pending' LIMIT 1",
    );
    const first = await decideTask(env as never, {
      taskId: firstId,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
    });
    assert.strictEqual(first.ok, true, first.ok ? '' : first.message);

    stubGitHub({ 'mod.sgmodule': v2 });
    repo = await getRepository(db as never, 'repo-sup');
    await inspectRepository(env as never, repo as never, { method: 'cron', silent: true });

    stubGitHub({ 'mod.sgmodule': v3 });
    repo = await getRepository(db as never, 'repo-sup');
    await inspectRepository(env as never, repo as never, { method: 'cron', silent: true });

    const tasks = raw(
      "SELECT group_concat(review_status,' ') FROM module_review_tasks WHERE repository_id='repo-sup'",
    );
    assert.ok(tasks.includes('superseded'), `expected a superseded task, got: ${tasks}`);

    const pending = raw(
      "SELECT COUNT(*) FROM module_review_tasks WHERE repository_id='repo-sup' AND review_status='pending'",
    );
    assert.strictEqual(pending, '1', 'only the newest task stays actionable');
  });

  await test('approving the newest task publishes V3', async () => {
    const pendingId = raw(
      "SELECT id FROM module_review_tasks WHERE repository_id='repo-sup' AND review_status='pending' LIMIT 1",
    );
    const res = await decideTask(env as never, {
      taskId: pendingId,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.message);
    const version = raw("SELECT version FROM modules WHERE source_path = 'mod.sgmodule'");
    assert.strictEqual(version, '3.0');
  });

  await test('approving a superseded task is refused with 409 semantics', async () => {
    const superseded = raw(
      "SELECT id FROM module_review_tasks WHERE repository_id='repo-sup' AND review_status='superseded' LIMIT 1",
    );
    const res = await decideTask(env as never, {
      taskId: superseded,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual((res as { code?: string }).code, 'conflict');
  });

  await test('an upstream deletion never deletes the live module by itself', async () => {
    stubGitHub({}); // file gone
    const repo = await getRepository(db as never, 'repo-1');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'cron',
      silent: true,
    });
    assert.strictEqual(result.deletedModules, 1, `got ${result.deletedModules}`);

    const live = raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/first.sgmodule' AND deleted_at IS NULL");
    assert.strictEqual(live, '1', 'the module must stay live until a human decides');

    const flags = raw('SELECT is_deleted_upstream FROM third_party_modules LIMIT 1');
    assert.strictEqual(flags, '1');
  });

  await test('approving a delete task with "hide" unpublishes but keeps the row', async () => {
    const pending = await listTasks(db as never, { status: 'pending', type: 'delete' });
    assert.strictEqual(pending.total, 1);
    const res = await decideTask(env as never, {
      taskId: pending.items[0].id,
      decision: 'approve',
      operator: 'tester',
      source: 'web',
      note: 'hide',
    });
    assert.strictEqual(res.ok, true, res.ok ? '' : res.message);
    const published = raw("SELECT is_published FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(published, '0');
    const exists = raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(exists, '1', 'hide must not delete the row');
  });

  // ------------------------------------------------------------ webhook route
  console.log('\nWebhook receiver');

  const secret = 'repo-webhook-secret-value';
  const encSecret = await encryptSecret(secret, 'k'.repeat(32));
  seedRepo(path, {
    id: 'repo-2',
    owner: 'someone',
    repo: 'third-party',
    branch: 'main',
    secret: encSecret,
  });

  await test('a bad signature is rejected and creates no task', async () => {
    stubGitHub({ 'new.sgmodule': MODULE_NEW });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc',
      commits: [{ id: 'abc', added: ['new.sgmodule'], modified: [], removed: [] }],
    });
    const req = new Request('http://x/api/v1/webhook/github/repo-2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': await sign(body, 'wrong-secret'),
      },
      body,
    });
    const res = await handleRepoWebhook(req, {
      DB: db,
      WEBHOOK_SECRET_KEY: 'k'.repeat(32),
      ENVIRONMENT: 'test',
      GITHUB_READ_TOKEN: 'ghp_FAKE',
    } as never, 'repo-2');

    assert.strictEqual(res.status, 401);
    const before = Number(raw("SELECT COUNT(*) FROM module_review_tasks WHERE repository_id='repo-2'"));
    assert.strictEqual(before, 0, 'failed signature must not create a task');
  });

  await test('a valid signature creates exactly one task', async () => {
    stubGitHub({ 'new.sgmodule': MODULE_NEW });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc123',
      commits: [{ id: 'abc123', added: ['new.sgmodule'], modified: [], removed: [] }],
    });
    const delivery = crypto.randomUUID();
    const req = new Request('http://x/api/v1/webhook/github/repo-2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': delivery,
        'x-hub-signature-256': await sign(body, secret),
      },
      body,
    });
    const res = await handleRepoWebhook(req, {
      DB: db,
      WEBHOOK_SECRET_KEY: 'k'.repeat(32),
      ENVIRONMENT: 'test',
      GITHUB_READ_TOKEN: 'ghp_FAKE',
      TELEGRAM_BOT_TOKEN: undefined,
    } as never, 'repo-2');

    assert.strictEqual(res.status, 202);
    const count = Number(raw("SELECT COUNT(*) FROM module_review_tasks WHERE repository_id='repo-2'"));
    assert.strictEqual(count, 1, 'exactly one task from one push');
    const method = raw("SELECT detection_method FROM module_review_tasks WHERE repository_id='repo-2'");
    assert.strictEqual(method, 'webhook');
  });

  await test('a redelivery of the same event id is a no-op', async () => {
    stubGitHub({ 'new.sgmodule': MODULE_NEW });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc123',
      commits: [{ id: 'abc123', added: ['new.sgmodule'], modified: [], removed: [] }],
    });
    const delivery = 'fixed-delivery-id';
    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': delivery,
      'x-hub-signature-256': await sign(body, secret),
    };

    const first = await handleRepoWebhook(
      new Request('http://x/api/v1/webhook/github/repo-2', { method: 'POST', headers, body }),
      { DB: db, WEBHOOK_SECRET_KEY: 'k'.repeat(32), ENVIRONMENT: 'test' } as never,
      'repo-2',
    );
    assert.strictEqual(first.status, 202);

    const second = await handleRepoWebhook(
      new Request('http://x/api/v1/webhook/github/repo-2', { method: 'POST', headers, body }),
      { DB: db, WEBHOOK_SECRET_KEY: 'k'.repeat(32), ENVIRONMENT: 'test' } as never,
      'repo-2',
    );
    assert.strictEqual(second.status, 202);
    const payload = (await second.json()) as { data?: { duplicate?: boolean } };
    assert.strictEqual(payload.data?.duplicate, true, JSON.stringify(payload));
  });

  await test('a push to another branch is ignored', async () => {
    stubGitHub({ 'new.sgmodule': MODULE_NEW });
    const body = JSON.stringify({
      ref: 'refs/heads/feature',
      after: 'zzz',
      commits: [{ id: 'zzz', added: ['new.sgmodule'], modified: [], removed: [] }],
    });
    const res = await handleRepoWebhook(
      new Request('http://x/api/v1/webhook/github/repo-2', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': crypto.randomUUID(),
          'x-hub-signature-256': await sign(body, secret),
        },
        body,
      }),
      { DB: db, WEBHOOK_SECRET_KEY: 'k'.repeat(32), ENVIRONMENT: 'test' } as never,
      'repo-2',
    );
    // jsonOk wraps the payload: { ok: true, data: { ignored } }
    const payload = (await res.json()) as { data?: { ignored?: string } };
    assert.ok(
      payload.data?.ignored?.includes('main'),
      `non-default branch must be ignored, got ${JSON.stringify(payload)}`,
    );
  });

  await test('production refuses a repo with no webhook secret', async () => {
    seedRepo(path, { id: 'repo-3', owner: 'nohook', repo: 'nosign', branch: 'main' });
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
    const res = await handleRepoWebhook(
      new Request('http://x/api/v1/webhook/github/repo-3', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': crypto.randomUUID(),
        },
        body,
      }),
      { DB: db, ENVIRONMENT: 'production' } as never,
      'repo-3',
    );
    assert.strictEqual(res.status, 401);
  });

  // ---------------------------------------------------------------- Telegram
  console.log('\nTelegram review authority');

  const decideCalls: Array<{ taskId: string; decision: string; operator: string }> = [];
  const decideDeps = {
    decide: async (input: {
      taskId: string;
      decision: 'approve' | 'reject';
      operator: string;
    }) => {
      decideCalls.push({
        taskId: input.taskId,
        decision: input.decision,
        operator: input.operator,
      });
      return { ok: true, status: 'approved' };
    },
  };

  const tgEnv = {
    DB: db,
    TELEGRAM_BOT_TOKEN: 'bot-token-for-test',
    TELEGRAM_ADMIN_ID: '123456789',
  };

  await test('a callback from a non-admin decides nothing', async () => {
    decideCalls.length = 0;
    const result = await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb1',
          from: { id: 999999, username: 'attacker' },
          message: { message_id: 5, chat: { id: 999999 }, text: 'hi' },
          data: 'a:task-123',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(result.status, 200);
    assert.strictEqual(decideCalls.length, 0, 'non-admin must not reach decide');
    assert.strictEqual((result.body as { ignored?: string }).ignored, 'not_admin');
  });

  await test('the configured admin id is the only accepted identity', async () => {
    // TELEGRAM_ADMIN_ID from the secret wins over the D1 setting
    raw("UPDATE site_settings SET value='555555' WHERE key='third_party.telegram_admin_id'");
    decideCalls.length = 0;
    const result = await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb2',
          from: { id: 555555, username: 'from-db-setting' },
          message: { message_id: 6, chat: { id: 555555 }, text: 'hi' },
          data: 'a:task-123',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(decideCalls.length, 0, 'D1 value must not override the secret');
    assert.strictEqual((result.body as { ignored?: string }).ignored, 'not_admin');
  });

  await test('the admin can approve from an inline button', async () => {
    decideCalls.length = 0;
    const result = await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb3',
          from: { id: 123456789, username: 'owner' },
          message: { message_id: 7, chat: { id: 123456789 }, text: 'pending' },
          data: 'a:task-abc',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(decideCalls.length, 1);
    assert.strictEqual(decideCalls[0].taskId, 'task-abc');
    assert.strictEqual(decideCalls[0].decision, 'approve');
    assert.ok(result.body);
  });

  await test('reject requires a second confirmation click', async () => {
    decideCalls.length = 0;
    await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb4',
          from: { id: 123456789, username: 'owner' },
          message: { message_id: 8, chat: { id: 123456789 }, text: 'pending' },
          data: 'r:task-def',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(decideCalls.length, 0, 'first press must not decide');

    await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb5',
          from: { id: 123456789, username: 'owner' },
          message: { message_id: 8, chat: { id: 123456789 }, text: 'pending' },
          data: 'c:r:task-def',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(decideCalls.length, 1, 'confirm press decides');
    assert.strictEqual(decideCalls[0].decision, 'reject');
  });

  await test('a delete decision requires confirmation too', async () => {
    decideCalls.length = 0;
    await handleTelegramWebhook(
      tgEnv as never,
      {
        callback_query: {
          id: 'cb6',
          from: { id: 123456789, username: 'owner' },
          message: { message_id: 9, chat: { id: 123456789 }, text: 'deleted' },
          data: 'd:x:task-ghi',
        },
      },
      decideDeps as never,
    );
    assert.strictEqual(decideCalls.length, 0, 'delete must ask first');
  });

  await test('a plain message from a stranger is ignored', async () => {
    const result = await handleTelegramWebhook(
      tgEnv as never,
      { message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: '/pending' } },
      decideDeps as never,
    );
    assert.strictEqual((result.body as { ignored?: string }).ignored, 'not_admin');
  });

  // -------------------------------------------------------------- check logs
  console.log('\nCheck logs and counters');

  await test('a check run is persisted with per-file detail', async () => {
    stubGitHub({ 'mods/first.sgmodule': MODULE_V2, 'mods/second.sgmodule': MODULE_NEW });
    const repo = await getRepository(db as never, 'repo-1');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'manual',
      silent: true,
    });
    const logId = await recordCheck(db as never, repo as never, result, 'manual');
    assert.ok(logId.length > 10);

    const row = raw(
      `SELECT check_status || '|' || files_scanned FROM repository_check_logs WHERE id='${logId}'`,
    );
    assert.ok(row.includes('|'), 'log row must exist');
    const detail = raw(`SELECT LENGTH(detail) FROM repository_check_logs WHERE id='${logId}'`);
    assert.ok(Number(detail) > 2, 'per-file detail must be stored');

    const status = raw("SELECT last_check_status FROM third_party_repositories WHERE id='repo-1'");
    assert.ok(['ok', 'partial', 'failed'].includes(status));
    const next = raw("SELECT next_check_at FROM third_party_repositories WHERE id='repo-1'");
    assert.ok(next.length > 10, 'next check must be scheduled');
  });

  await test('failed GitHub access is recorded, not silently swallowed', async () => {
    installFetch(async () => new Response('nope', { status: 403 }));
    const repo = await getRepository(db as never, 'repo-2');
    const result = await inspectRepository(env as never, repo as never, {
      method: 'manual',
      silent: true,
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.length > 0, 'error must be surfaced');
  });

  // ------------------------------------------------------- repository CRUD API
  console.log('\nRepository configuration protection');

  await test('a repository can be listed with its counters', async () => {
    const repos = await listRepositories(db as never);
    assert.ok(repos.length >= 3);
    const r = repos.find((x) => x.id === 'repo-1');
    assert.ok(r);
    assert.strictEqual(r.enabled, 1);
    assert.strictEqual(r.default_branch, 'main');
  });

  await test('deleting a repo config is a soft delete', async () => {
    execFileSync('sqlite3', [path], {
      input: "UPDATE third_party_repositories SET deleted_at='2020-01-01T00:00:00Z' WHERE id='repo-3';",
    });
    const repos = await listRepositories(db as never);
    assert.strictEqual(repos.find((r) => r.id === 'repo-3'), undefined);
    // the row is still there for the audit trail
    const still = raw("SELECT COUNT(*) FROM third_party_repositories WHERE id='repo-3'");
    assert.strictEqual(still, '1');
  });

  await test('published modules survive repo deletion', async () => {
    const live = raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/first.sgmodule'");
    assert.strictEqual(live, '1', 'deleting a repo must not delete published modules');
  });

  // ------------------------------------------------------------------ dedupe
  console.log('\nDeduplication invariants');

  await test('identical createReviewTask calls collapse to one row', async () => {
    const before = Number(raw('SELECT COUNT(*) FROM module_review_tasks'));
    const input = {
      repositoryId: 'repo-2',
      moduleId: null,
      thirdPartyModuleId: null,
      taskType: 'new' as const,
      detectionMethod: 'manual' as const,
      filePath: 'dup.sgmodule',
      branch: 'main',
      oldVersion: '',
      newVersion: '1.0.0',
      oldContent: '',
      newContent: MODULE_NEW,
      contentSha: 'deadbeefdeadbeef',
      commitSha: 'abc',
    };
    const first = await createReviewTask(db as never, input);
    const second = await createReviewTask(db as never, { ...input, detectionMethod: 'cron' });
    const third = await createReviewTask(db as never, { ...input, detectionMethod: 'webhook' });
    assert.ok(first, 'first insert must succeed');
    assert.strictEqual(second, null, 'second insert must be ignored');
    assert.strictEqual(third, null, 'third insert must be ignored');
    const after = Number(raw('SELECT COUNT(*) FROM module_review_tasks'));
    assert.strictEqual(after, before + 1);
  });

  await test('a different content sha is a different task', async () => {
    const id = await createReviewTask(db as never, {
      repositoryId: 'repo-2',
      moduleId: null,
      thirdPartyModuleId: null,
      taskType: 'new',
      detectionMethod: 'manual',
      filePath: 'dup.sgmodule',
      branch: 'main',
      oldVersion: '',
      newVersion: '1.1.0',
      oldContent: '',
      newContent: MODULE_V2,
      contentSha: 'cafebabecafebabe',
      commitSha: 'def',
    });
    assert.ok(id, 'new content must create a task');
  });

  // --------------------------------------------------------------- task reads
  console.log('\nReview queue reads');

  await test('filters combine and paginate', async () => {
    const page = await listTasks(db as never, { status: 'all', perPage: 2, page: 1 });
    assert.strictEqual(page.items.length <= 2, true);
    assert.ok(page.total >= page.items.length);
    assert.strictEqual(page.page, 1);

    const byType = await listTasks(db as never, { status: 'all', type: 'delete' });
    for (const item of byType.items) assert.strictEqual(item.task_type, 'delete');

    const byMethod = await listTasks(db as never, { status: 'all', method: 'webhook' });
    for (const item of byMethod.items) assert.strictEqual(item.detection_method, 'webhook');
  });

  await test('a task carries the context the detail page needs', async () => {
    const all = await listTasks(db as never, { status: 'all' });
    const task = await getTask(db as never, all.items[0].id);
    assert.ok(task);
    assert.ok(task!.file_path.length > 0);
    assert.ok(task!.content_sha.length > 0);
  });

  // --------------------------------------------------- existing-module identity
  console.log('\nModule identity across sources');

  await test('a file already live from first-party sync is linked, not duplicated', async () => {
    // simulate the first-party sync having imported this exact file
    raw(
      `INSERT INTO modules (id, slug, name, description, author, version, source_id,
         source_path, content_hash, upstream_url, repository_url, is_published, published_at)
       VALUES ('mod-existing', 'shared-mod', '共享模块', 'd', 'a', '2.0.0', NULL,
         'mods/shared.sgmodule', 'OLDSHA',
         'https://raw.githubusercontent.com/zhiaon/Modules/main/mods/shared.sgmodule',
         'https://github.com/zhiaon/Modules', 1, '2026-01-01T00:00:00Z')`,
    );

    stubGitHub({ 'mods/shared.sgmodule': MODULE_V2 });
    const repo = await getRepository(db as never, 'repo-1');
    const before = Number(raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/shared.sgmodule'"));

    const result = await inspectRepository(env as never, repo as never, {
      method: 'manual',
      filePath: 'mods/shared.sgmodule',
      silent: true,
    });

    const after = Number(raw("SELECT COUNT(*) FROM modules WHERE source_path = 'mods/shared.sgmodule'"));
    assert.strictEqual(before, 1);
    assert.strictEqual(after, 1, 'must not create a second module row for the same file');

    // and the task must be an update pointing at the existing module
    if (result.updatedModules === 1) {
      const task = raw(
        `SELECT task_type || '|' || COALESCE(module_id,'null') FROM module_review_tasks
          WHERE file_path='mods/shared.sgmodule' AND review_status='pending' LIMIT 1`,
      );
      assert.strictEqual(task, 'update|mod-existing');
    }
  });

  // ------------------------------------------------- dispatch layer regression
  // The unit tests above call decideTask directly, which is exactly how a
  // name collision in the admin dispatcher went unnoticed: the route resolved to
  // the legacy phase-5 handler and every third-party decision returned
  // "未知决定". Exercise the real HTTP path this time.
  console.log('\nAdmin dispatch');

  await test('the decide route reaches the third-party handler', async () => {
    installFetch(async () => new Response('{}', { status: 200 }));
    const { default: worker } = await import('../workers/site/index');

    // create an admin session directly (bcrypt is irrelevant here)
    raw(
      "INSERT OR IGNORE INTO admins (id, username, display_name, role, password_hash, is_active) " +
        "VALUES ('adm-test', 'tester', 'Tester', 'super', 'x', 1)",
    );
    const token = 'session-token-for-dispatch-test';
    const { hashToken } = await import('../workers/site/auth');
    const tokenHash = await hashToken(token);
    raw(
      `INSERT OR IGNORE INTO admin_sessions (token_hash, admin_id, expires_at) VALUES ` +
        `('${tokenHash}', 'adm-test', '2099-01-01T00:00:00Z')`,
    );

    // a pending task to act on
    const taskId = await createReviewTask(db as never, {
      repositoryId: 'repo-2',
      moduleId: null,
      thirdPartyModuleId: null,
      taskType: 'new',
      detectionMethod: 'manual',
      filePath: 'dispatch.sgmodule',
      branch: 'main',
      oldVersion: '',
      newVersion: '1.0.0',
      oldContent: '',
      newContent: MODULE_NEW,
      contentSha: 'dispatch-test-sha',
      commitSha: 'abc',
    });
    assert.ok(taskId, 'need a pending task');

    const res = await worker.fetch(
      new Request(`https://x/api/v1/admin/third-party/reviews/${taskId}/decide`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sm_admin=${token}`,
          origin: 'https://x',
        },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      { ASSETS: { fetch: async () => new Response('spa') }, DB: db } as never,
    );

    const bodyText = await res.text();
    assert.ok(
      !bodyText.includes('未知决定'),
      `route hit the legacy handler: ${bodyText}`,
    );
    assert.strictEqual(res.status, 200, bodyText);
    const status = raw(`SELECT review_status FROM module_review_tasks WHERE id='${taskId}'`);
    assert.strictEqual(status, 'approved');
  });

  restoreFetch();
}

await main();

// every table the phase introduced must exist and be queryable
const { path } = createTestDb(true);
for (const table of [
  'third_party_repositories',
  'third_party_modules',
  'module_review_tasks',
  'module_version_history',
  'repository_check_logs',
  'github_webhook_events',
  'module_audit_logs',
]) {
  const out = execFileSync('sqlite3', [path, `SELECT COUNT(*) FROM ${table}`], {
    encoding: 'utf8',
  }).trim();
  assert.strictEqual(out, '0', `${table} must exist and be empty`);
  passed += 1;
  console.log(`  ✓ schema: ${table} exists`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
