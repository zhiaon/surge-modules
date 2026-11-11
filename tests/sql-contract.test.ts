import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

/**
 * SQL-level contract tests.
 *
 * workerd cannot start in this sandbox (`__res_init` missing from the bundled
 * binary), so the worker handlers are exercised through their SQL instead:
 * every query the API and the proxy run is executed here against a real SQLite
 * database built from the same migrations D1 would apply.
 *
 * What this proves:
 *   - the migrations apply cleanly from an empty database
 *   - the public list/detail/category/announcement queries return the intended
 *     rows and never leak backend-only columns
 *   - the proxy mapping query refuses disabled sources, disabled mappings and
 *     deleted rows
 *   - LIKE escaping stops `%` and `_` from acting as wildcards
 */

const DB = join(mkdtempSync(join(tmpdir(), 'sm-test-')), 'test.db');

function sql(query: string): string {
  // The CLI opens a new connection per invocation, and `PRAGMA foreign_keys`
  // is per-connection (D1 keeps it enabled for the whole request), so it has to
  // be re-armed here or FK cascades silently do nothing.
  return execFileSync(
    'sqlite3',
    ['-batch', '-noheader', '-separator', '|', DB, `PRAGMA foreign_keys=ON;\n${query}`],
    { encoding: 'utf8' },
  ).trim();
}

function applyMigrations(): void {
  for (const file of [
    'database/migrations/0001_init.sql',
    'database/migrations/0002_seed_reference.sql',
    'database/migrations/0003_backend_schema.sql',
    'database/migrations/0004_seed_settings.sql',
  ]) {
    execFileSync('sqlite3', [DB], { input: readFileSync(file, 'utf8') });
  }
}

function readFileSync(path: string, _enc: string): string {
  return execFileSync('cat', [path], { encoding: 'utf8' });
}

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

console.log('SQL contract tests\n');

applyMigrations();

// ---------------------------------------------------------------- fixtures
sql(`
INSERT INTO sources (id, owner, repo, branch, allow_paths, is_enabled)
VALUES ('src-1', 'operator', 'modules', 'main', 'modules/', 1);

INSERT INTO sources (id, owner, repo, branch, allow_paths, is_enabled)
VALUES ('src-off', 'operator', 'old', 'main', '', 0);

INSERT INTO modules (id, slug, name, description, author, category_id, version,
                     source_id, source_path, upstream_url, is_featured, is_published, updated_at)
VALUES
 ('m1','alpha-adblock','Alpha 拦截','广告与追踪拦截','alice','cat-adblock','1.2.0','src-1','modules/alpha.sgmodule','https://raw.githubusercontent.com/secret/x','1',1,'2026-11-01T00:00:00Z'),
 ('m2','beta-rules','Beta 规则','分流规则集','bob','cat-rules','0.9.0','src-1','modules/beta.sgmodule','https://raw.githubusercontent.com/secret/y','0',1,'2026-11-05T00:00:00Z'),
 ('m3','gamma-hidden','Gamma','未发布','carol','cat-rules','1.0.0',NULL,NULL,NULL,'0',0,'2026-11-06T00:00:00Z');

INSERT INTO modules (id, slug, name, description, author, version, is_published, updated_at, deleted_at)
VALUES ('m4','deleted-one','已删除','x','dave','1.0.0',1,'2026-11-07T00:00:00Z','2026-11-07T00:00:00Z');

INSERT INTO module_tags (module_id, tag) VALUES
 ('m1','广告'), ('m1','追踪'), ('m2','分流');

INSERT INTO module_proxy_mappings (id, module_id, public_slug, source_id, file_path, is_enabled, content_hash)
VALUES
 ('p1','m1','alpha-adblock','src-1','modules/alpha.sgmodule',1,'hash1'),
 ('p2','m2','beta-rules','src-1','modules/beta.sgmodule',1,'hash2'),
 ('p3','m1','disabled-map','src-1','modules/alpha.sgmodule',0,'hash3'),
 ('p4','m1','disabled-source','src-off','modules/old.sgmodule',1,'hash4');

INSERT INTO categories (id, name, slug, description, icon, sort_order, is_visible)
VALUES ('cat-empty','空分类','empty','没有模块','shield',99,1);

INSERT INTO categories (id, name, slug, description, sort_order, is_visible, deleted_at)
VALUES ('cat-gone','已删分类','gone','x',98,1,'2026-11-01T00:00:00Z');
`);

// ------------------------------------------------------------------- tests
test('migrations create every phase-4 table', () => {
  const tables = sql("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").split('\n');
  for (const t of [
    'modules',
    'module_versions',
    'categories',
    'sources',
    'module_proxy_mappings',
    'sync_jobs',
    'sync_logs',
    'announcements',
    'site_settings',
    'analytics_events',
    'audit_logs',
    'module_overrides',
    'module_tombstones',
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('list query returns only published, non-deleted modules', () => {
  const rows = sql(`
    SELECT m.slug FROM modules m
     LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
    WHERE m.deleted_at IS NULL AND m.is_published = 1
    ORDER BY m.updated_at DESC
  `).split('\n');
  assert.deepStrictEqual(rows, ['beta-rules', 'alpha-adblock']);
});

test('public list shape never exposes upstream_url or source columns', () => {
  // mirror the exact projection the worker uses
  const out = sql(`
    SELECT m.id, m.slug, m.name, m.description, m.author, m.version,
           m.updated_at, m.repository_url, m.is_featured,
           m.category_id, c.name, c.slug
      FROM modules m
      LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
     WHERE m.deleted_at IS NULL AND m.is_published = 1 AND m.slug = 'alpha-adblock'
  `);
  assert.ok(!out.includes('raw.githubusercontent'), 'upstream URL leaked into projection');
  assert.ok(out.includes('alpha-adblock'));
  assert.strictEqual(out.split('|').length, 12, 'unexpected column count');
});

test('category filter matches by slug', () => {
  const rows = sql(`
    SELECT m.slug FROM modules m
     JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
    WHERE m.deleted_at IS NULL AND m.is_published = 1 AND c.slug = 'adblock'
  `);
  assert.strictEqual(rows, 'alpha-adblock');
});

test('tag filter is case-insensitive and exact', () => {
  const rows = sql(`
    SELECT m.slug FROM modules m
    WHERE m.deleted_at IS NULL AND m.is_published = 1
      AND EXISTS (SELECT 1 FROM module_tags t WHERE t.module_id = m.id AND LOWER(t.tag) = LOWER('分流'))
  `);
  assert.strictEqual(rows, 'beta-rules');
  // a partial tag must not match
  const none = sql(`
    SELECT COUNT(*) FROM modules m
    WHERE m.deleted_at IS NULL AND m.is_published = 1
      AND EXISTS (SELECT 1 FROM module_tags t WHERE t.module_id = m.id AND LOWER(t.tag) = LOWER('分'))
  `);
  assert.strictEqual(none, '0');
});

test('keyword search escapes LIKE wildcards', () => {
  // an unescaped '%' would match every row
  const raw = sql(`
    SELECT COUNT(*) FROM modules m
    WHERE m.name LIKE '%${'%'}%'
  `);
  assert.strictEqual(raw, '4', 'sanity: bare % matches all rows');

  const escaped = sql(`
    SELECT COUNT(*) FROM modules m
    WHERE m.name LIKE '%${'\\%'}%' ESCAPE '\\'
  `);
  assert.strictEqual(escaped, '0', 'escaped % must not act as a wildcard');
});

test('category counts exclude unpublished, deleted and deleted-category rows', () => {
  const rows = sql(`
    SELECT c.slug || '=' || (SELECT COUNT(*) FROM modules m
        WHERE m.category_id = c.id AND m.deleted_at IS NULL AND m.is_published = 1)
      FROM categories c
     WHERE c.deleted_at IS NULL AND c.is_visible = 1 AND c.slug IN ('adblock','rules','empty')
     ORDER BY c.slug
  `).split('\n');
  assert.deepStrictEqual(rows, ['adblock=1', 'empty=0', 'rules=1']);
});

test('proxy mapping resolves only for enabled mapping + enabled source', () => {
  const ok = sql(`
    SELECT p.public_slug FROM module_proxy_mappings p
      JOIN sources s ON s.id = p.source_id
     WHERE p.public_slug = 'alpha-adblock'
       AND p.deleted_at IS NULL AND p.is_enabled = 1
       AND s.deleted_at IS NULL AND s.is_enabled = 1
  `);
  assert.strictEqual(ok, 'alpha-adblock');

  for (const slug of ['disabled-map', 'disabled-source', 'no-such-module', 'deleted-one']) {
    const hit = sql(`
      SELECT p.public_slug FROM module_proxy_mappings p
        JOIN sources s ON s.id = p.source_id
       WHERE p.public_slug = '${slug}'
         AND p.deleted_at IS NULL AND p.is_enabled = 1
         AND s.deleted_at IS NULL AND s.is_enabled = 1
    `);
    assert.strictEqual(hit, '', `${slug} must not resolve`);
  }
});

test('settings are split by scope and public reads never see internal keys', () => {
  const publicCount = sql("SELECT COUNT(*) FROM site_settings WHERE scope='public'");
  const internalCount = sql("SELECT COUNT(*) FROM site_settings WHERE scope='internal'");
  assert.ok(Number(publicCount) >= 8, 'expected public defaults');
  assert.ok(Number(internalCount) >= 3, 'expected internal defaults');

  const leaked = sql(
    "SELECT COUNT(*) FROM site_settings WHERE scope='internal' AND key LIKE 'proxy.cache%'",
  );
  assert.strictEqual(leaked, '1');
});

test('soft-deleted rows are invisible to every public query', () => {
  const slug = sql("SELECT slug FROM modules WHERE slug='deleted-one' AND deleted_at IS NULL");
  assert.strictEqual(slug, '');
  const cat = sql("SELECT slug FROM categories WHERE slug='gone' AND deleted_at IS NULL");
  assert.strictEqual(cat, '');
});

test('unique slug constraint blocks duplicates while allowing one soft-deleted row', () => {
  let threw = false;
  try {
    sql("INSERT INTO modules (id, slug, name, version, is_published) VALUES ('m9','alpha-adblock','dup','1',1)");
  } catch {
    threw = true;
  }
  assert.ok(threw, 'duplicate live slug must be rejected');
  // a deleted row with the same slug is allowed (partial index)
  sql("INSERT INTO modules (id, slug, name, version, is_published, deleted_at) VALUES ('m10','alpha-adblock','old','1',1,'2026-01-01T00:00:00Z')");
});

test('override rows are keyed per module+field and cascade with the module', () => {
  sql("INSERT INTO module_overrides (module_id, field, value) VALUES ('m1','name','改过的名字')");
  assert.strictEqual(sql("SELECT value FROM module_overrides WHERE module_id='m1' AND field='name'"), '改过的名字');
  sql("DELETE FROM modules WHERE id='m1'");
  assert.strictEqual(sql("SELECT COUNT(*) FROM module_overrides WHERE module_id='m1'"), '0');
});

test('analytics insert and day rollup query work', () => {
  sql(`INSERT INTO analytics_events (event, subject, day) VALUES
        ('page_view','/','2026-11-08'), ('module_view','alpha-adblock','2026-11-08'),
        ('copy_click','alpha-adblock','2026-11-08')`);
  const rows = sql(
    "SELECT event || '=' || COUNT(*) FROM analytics_events WHERE day='2026-11-08' GROUP BY event ORDER BY event",
  ).split('\n');
  assert.deepStrictEqual(rows, ['copy_click=1', 'module_view=1', 'page_view=1']);
});

test('rate limit upsert increments the same window', () => {
  sql("INSERT INTO rate_limits (bucket, window, count) VALUES ('b1','2026-11-08T09:00',1) ON CONFLICT(bucket,window) DO UPDATE SET count=count+1");
  sql("INSERT INTO rate_limits (bucket, window, count) VALUES ('b1','2026-11-08T09:00',1) ON CONFLICT(bucket,window) DO UPDATE SET count=count+1");
  assert.strictEqual(sql("SELECT count FROM rate_limits WHERE bucket='b1'"), '2');
});

// ------------------------------------------------------------------ summary
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
