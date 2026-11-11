import assert from 'node:assert';
import { isSafeRepoPath, isSafeSegment } from '../workers/module-proxy/github';
import { buildCacheKey, cachePolicyFor } from '../packages/shared/src/cache';
import {
  likeEscape,
  parseModuleListQuery,
  tokenize,
  validSlug,
} from '../packages/shared/src/query';
import { parseEvents } from '../workers/site/analytics';

/**
 * Unit tests for the security-relevant pure functions. These run without a
 * runtime, so they pin the behaviour that the workers depend on:
 *   - the proxy rejects anything that is not a bare slug
 *   - repository paths cannot escape the repo or name another host
 *   - cache keys are derived from server state only
 *   - query parsing clamps everything the client controls
 *   - analytics accepts only whitelisted events
 */

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

console.log('Security unit tests\n');

// ------------------------------------------------------------- slug handling
test('validSlug accepts lowercase-dash slugs', () => {
  assert.strictEqual(validSlug('alpha-adblock'), 'alpha-adblock');
  assert.strictEqual(validSlug('a1-b2-c3'), 'a1-b2-c3');
});

test('validSlug rejects traversal, separators and empty input', () => {
  for (const bad of [
    '',
    ' ',
    '../etc/passwd',
    'a/b',
    'a%2fb',
    'A-Upper',
    'has space',
    'under_score',
    'a'.repeat(81),
    '-leading',
    'trailing-',
    'double--dash',
    'slug?suffix=1',
    'slug#frag',
  ]) {
    assert.strictEqual(validSlug(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------- repo paths
test('isSafeRepoPath accepts ordinary relative paths', () => {
  for (const ok of ['modules/alpha.sgmodule', 'a.txt', 'deep/nested/dir/file.sgmodule', 'x@1/y+z.sgmodule']) {
    assert.strictEqual(isSafeRepoPath(ok), true, `should accept ${ok}`);
  }
});

test('isSafeRepoPath rejects absolute, traversal, scheme and control chars', () => {
  for (const bad of [
    '/etc/passwd',
    '../secret',
    'modules/../../secret',
    'modules/..',
    'http://evil.com/x',
    'https://evil.com/x',
    'a\\b',
    'a\u0000b',
    'a\u001fb',
    '',
    'x'.repeat(513),
  ]) {
    assert.strictEqual(isSafeRepoPath(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isSafeSegment rejects anything that could break out of a URL segment', () => {
  for (const bad of ['', 'a/b', 'a?b', 'a#b', 'a b', '../x', 'a\nb', 'x'.repeat(101)]) {
    assert.strictEqual(isSafeSegment(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(isSafeSegment('owner-name_1.x'), true);
});

// ------------------------------------------------------------- cache keys
test('cache key is built from slug and revision only', () => {
  const a = buildCacheKey('https://raw.example.com', { slug: 'alpha', revision: 'abc123' });
  assert.strictEqual(a, 'https://raw.example.com/__cache/module/alpha/raw/abc123');
});

test('cache key strips characters that could split the key path', () => {
  const key = buildCacheKey('https://raw.example.com', {
    slug: 'alpha/../../x?y=1',
    revision: 'rev/../9',
  });
  assert.ok(!key.includes('..'), key);
  assert.ok(!key.includes('?'), key);
  // still a single well-formed path
  assert.ok(key.startsWith('https://raw.example.com/__cache/module/'), key);
});

test('cache key is stable for the same input and differs across revisions', () => {
  const base = { slug: 'alpha', revision: 'r1' };
  assert.strictEqual(
    buildCacheKey('https://h', base),
    buildCacheKey('https://h', base),
  );
  assert.notStrictEqual(
    buildCacheKey('https://h', base),
    buildCacheKey('https://h', { slug: 'alpha', revision: 'r2' }),
  );
});

test('only 200 responses are cacheable and errors are no-store', () => {
  assert.strictEqual(cachePolicyFor(200, 300).cacheable, true);
  assert.ok(cachePolicyFor(200, 300).cacheControl.includes('max-age=300'));
  for (const status of [301, 400, 403, 404, 429, 500, 502, 504]) {
    const p = cachePolicyFor(status, 300);
    assert.strictEqual(p.cacheable, false, `status ${status} must not be cached`);
    assert.strictEqual(p.cacheControl, 'no-store');
  }
});

// ------------------------------------------------------------- query parsing
test('perPage is clamped to the hard maximum', () => {
  const q = parseModuleListQuery(new URLSearchParams('perPage=9999'));
  assert.strictEqual(q.perPage, 60);
  const zero = parseModuleListQuery(new URLSearchParams('perPage=0'));
  assert.strictEqual(zero.perPage, 20);
  const neg = parseModuleListQuery(new URLSearchParams('perPage=-5'));
  assert.strictEqual(neg.perPage, 20);
});

test('page cannot be negative or absurd', () => {
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('page=-1')).page, 1);
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('page=abc')).page, 1);
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('page=999999')).page, 10_000);
});

test('sort is restricted to the whitelist', () => {
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('sort=name')).sort, 'name');
  assert.strictEqual(
    parseModuleListQuery(new URLSearchParams('sort=; DROP TABLE modules')).sort,
    'updated',
  );
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('')).sort, 'updated');
});

test('category must be a well-formed slug or it is ignored', () => {
  assert.strictEqual(
    parseModuleListQuery(new URLSearchParams('category=adblock')).category,
    'adblock',
  );
  assert.strictEqual(
    parseModuleListQuery(new URLSearchParams("category=adblock' OR 1=1--")).category,
    '',
  );
});

test('search and tag are length-capped', () => {
  const long = 'a'.repeat(500);
  const q = parseModuleListQuery(new URLSearchParams(`q=${long}&tag=${long}`));
  assert.strictEqual(q.search.length, 80);
  assert.strictEqual(q.tag.length, 40);
});

test('featured only becomes true for explicit truthy values', () => {
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('featured=1')).featured, true);
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('featured=true')).featured, true);
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('featured=0')).featured, null);
  assert.strictEqual(parseModuleListQuery(new URLSearchParams('featured=x')).featured, null);
});

test('likeEscape neutralises SQL LIKE wildcards', () => {
  assert.strictEqual(likeEscape('100%'), '100\\%');
  assert.strictEqual(likeEscape('a_b'), 'a\\_b');
  assert.strictEqual(likeEscape('a\\b'), 'a\\\\b');
  assert.strictEqual(likeEscape('plain'), 'plain');
});

test('tokenize caps the number of AND terms', () => {
  const many = Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ');
  assert.strictEqual(tokenize(many).length, 6);
  assert.deepStrictEqual(tokenize('广告， 追踪'), ['广告', '追踪']);
});

// ------------------------------------------------------------- analytics
test('analytics accepts only whitelisted events', () => {
  assert.ok(parseEvents({ events: [{ event: 'page_view' }] }));
  assert.ok(parseEvents({ events: [{ event: 'module_view', subject: 'alpha-adblock' }] }));
  assert.strictEqual(parseEvents({ events: [{ event: 'install_success' }] }), null);
  assert.strictEqual(parseEvents({ events: [{ event: 'PAGE_VIEW' }] }), null);
});

test('analytics rejects oversized batches and malformed bodies', () => {
  assert.strictEqual(parseEvents(null), null);
  assert.strictEqual(parseEvents({}), null);
  assert.strictEqual(parseEvents({ events: [] }), null);
  assert.strictEqual(
    parseEvents({ events: Array.from({ length: 11 }, () => ({ event: 'page_view' })) }),
    null,
  );
  assert.strictEqual(parseEvents({ events: ['page_view'] }), null);
});

test('analytics subject rejects free text and control characters', () => {
  assert.strictEqual(
    parseEvents({ events: [{ event: 'page_view', subject: '<script>alert(1)</script>' }] }),
    null,
  );
  assert.strictEqual(
    parseEvents({ events: [{ event: 'page_view', subject: 'a'.repeat(200) }] })![0].subject!.length,
    120,
  );
  assert.ok(parseEvents({ events: [{ event: 'page_view', subject: '/modules/alpha' }] }));
});

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
