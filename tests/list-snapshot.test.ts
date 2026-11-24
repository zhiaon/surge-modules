import assert from 'node:assert';
import {
  CATALOGUE_KEY,
  clearPublicSnapshots,
  createSnapshotStore,
  favoriteSignature,
  snapshots,
} from '../src/lib/publicSnapshots';
import { begin, fromSnapshot, idle, reject, resolve } from '../src/hooks/asyncState';
import { isFirstEntry, markPainted, resetEntrySession } from '../src/lib/pageSession';

/**
 * Revisit behaviour for the card lists.
 *
 * `useAsync` is a thin wrapper over the pure transitions in
 * `src/hooks/asyncState.ts`; these tests pin the contract the pages rely on:
 *  - an identical request paints from the snapshot on the first frame
 *    (`success`, never `loading` → no skeleton);
 *  - the background refresh replaces that data when it lands;
 *  - the favorites list is only reusable while the exact favorite records match;
 *  - empty results and first-load errors still render their own states.
 */

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

const module = (id: string) => ({ id, slug: id, name: id }) as never;

await test('snapshot store keeps values by key and forgets the oldest', () => {
  const store = createSnapshotStore<string>(2);
  store.save('a', 'A');
  store.save('b', 'B');
  assert.equal(store.peek('a'), 'A');
  store.save('c', 'C');
  assert.equal(store.size(), 2);
  assert.deepEqual(store.keys(), ['a', 'c'], 'least recently used key is evicted');
  store.drop('a');
  assert.equal(store.peek('a'), undefined);
  store.clear();
  assert.equal(store.size(), 0);
});

await test('home and discover share one catalogue snapshot', () => {
  clearPublicSnapshots();
  const home = snapshots.catalogue();
  assert.equal(home.key, CATALOGUE_KEY);
  assert.equal(home.peek(), undefined, 'nothing cached before the first load');

  home.save({ items: [module('one'), module('two')], total: 2 });

  const discover = snapshots.catalogue();
  assert.equal(discover.key, home.key);
  assert.deepEqual(discover.peek()?.items.map((m) => (m as { id: string }).id), ['one', 'two']);
});

await test('a snapshot hit starts as success, not loading', () => {
  clearPublicSnapshots();
  const binding = snapshots.catalogue();
  const fresh = fromSnapshot(binding.peek());
  assert.equal(fresh.status, 'idle');

  binding.save({ items: [module('one')], total: 1 });
  const cached = fromSnapshot(binding.peek());
  assert.equal(cached.status, 'success');
  assert.equal(cached.refreshing, true, 'the revisit still refreshes');
  assert.equal(cached.data?.total, 1);
  // pages render skeletons for idle/loading only — a cached list must never
  // reach either of those states
  assert.notEqual(cached.status, 'loading');
  assert.notEqual(cached.status, 'idle');
});

await test('background refresh replaces the cached list without a skeleton', () => {
  clearPublicSnapshots();
  const binding = snapshots.catalogue();
  binding.save({ items: [module('old')], total: 1 });
  const cached = fromSnapshot(binding.peek());

  const refreshing = begin(cached);
  assert.equal(refreshing.status, 'success');
  assert.equal(refreshing.refreshing, true);
  assert.equal(refreshing.data?.total, 1, 'old list stays on screen while refreshing');

  const next = { items: [module('new'), module('newer')], total: 2 };
  binding.save(next);
  const settled = resolve(next);
  assert.equal(settled.status, 'success');
  assert.equal(settled.refreshing, false);
  assert.equal(settled.data?.total, 2, 'refreshed data replaces the snapshot');
  assert.equal(binding.peek()?.total, 2, 'snapshot is updated for the next visit');
});

await test('a first-load error keeps the error state and retry path', () => {
  const failed = reject(idle(), new Error('backend down'));
  assert.equal(failed.status, 'error');
  assert.equal(failed.data, undefined);
  assert.equal(failed.error?.message, 'backend down');

  // retrying from the error state goes through loading (skeleton) again
  assert.equal(begin(failed).status, 'loading');
});

await test('a failed background refresh keeps the list on screen', () => {
  const cached = fromSnapshot({ items: [module('one')], total: 1 });
  const failed = reject(begin(cached), new Error('network'));
  assert.equal(failed.status, 'success');
  assert.equal(failed.data?.total, 1, 'the last good list is not thrown away');
  assert.equal(failed.error, undefined, 'no error UI replaces the list');
  assert.equal(failed.refreshError?.message, 'network');
});

await test('an empty catalogue renders the empty state, not a skeleton', () => {
  clearPublicSnapshots();
  const binding = snapshots.catalogue();
  binding.save({ items: [], total: 0 });
  const cached = fromSnapshot(binding.peek());
  assert.equal(cached.status, 'success');
  assert.deepEqual(cached.data, { items: [], total: 0 });
});

await test('favorites snapshot only matches the exact records', () => {
  clearPublicSnapshots();
  const records = [
    { moduleId: 'a', addedAt: '2026-01-01T00:00:00.000Z' },
    { moduleId: 'b', addedAt: '2026-01-02T00:00:00.000Z' },
  ];
  const sig = favoriteSignature(records);
  const binding = snapshots.favorites(sig);
  binding.save([{ module: module('a'), addedAt: records[0].addedAt }]);
  assert.equal(snapshots.favorites(favoriteSignature(records)).peek()?.length, 1);

  // add
  const added = [...records, { moduleId: 'c', addedAt: '2026-01-03T00:00:00.000Z' }];
  assert.notEqual(favoriteSignature(added), sig);
  assert.equal(snapshots.favorites(favoriteSignature(added)).peek(), undefined);

  // remove
  const removed = [records[1]];
  assert.notEqual(favoriteSignature(removed), sig);
  assert.equal(snapshots.favorites(favoriteSignature(removed)).peek(), undefined);

  // re-add: same ids, new timestamp → still a different key
  const readded = [records[0], { ...records[1], addedAt: '2026-02-02T00:00:00.000Z' }];
  assert.notEqual(favoriteSignature(readded), sig);

  // identical records (same order) reuse the snapshot
  assert.equal(favoriteSignature([...records]), sig);
  assert.equal(
    fromSnapshot(snapshots.favorites(sig).peek()).status,
    'success',
    'an unchanged favorite set paints without a skeleton',
  );

  // empty favorites is a real result too
  const emptySig = favoriteSignature([]);
  snapshots.favorites(emptySig).save([]);
  assert.deepEqual(snapshots.favorites(emptySig).peek(), []);
});

await test('entrance motion only plays for the first page of a document load', () => {
  resetEntrySession();
  assert.equal(isFirstEntry(), true, 'the initial entry animates');
  markPainted();
  assert.equal(
    isFirstEntry(),
    false,
    'a revisit from the bottom tab bar must render the final state, not replay',
  );
  resetEntrySession();
  assert.equal(isFirstEntry(), true, 'a new document load animates again');
});

console.log(`\nlist-snapshot: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
