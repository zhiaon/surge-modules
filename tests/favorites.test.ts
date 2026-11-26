import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'https://example.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom : (dom as any)[key],
  });
}

const category = { id: 'cat-tools', slug: 'tools', name: 'Tools', description: 'Utilities', sortOrder: 1 };
const catalogue = Array.from({ length: 130 }, (_, index) => ({
  id: `module-${index}`, slug: `module-${index}`, name: `Module ${index}`,
  description: `Description ${index}`, author: 'Example', category,
  tags: ['tools'], version: `1.0.${index}`,
  updatedAt: new Date(Date.UTC(2026, 10, 25) - index * 86400000).toISOString(),
  rawUrl: `https://example.test/m/module-${index}.sgmodule`,
  repositoryUrl: 'https://example.test/source', isFeatured: false,
  health: 'ok', healthReason: null, hasPanel: index % 2 === 0,
}));
let catalogueFetches = 0;
globalThis.fetch = async (input) => {
  const path = String(input);
  if (path === '/data/modules.json') {
    catalogueFetches++;
    return new Response(JSON.stringify(catalogue), { headers: { 'content-type': 'application/json' } });
  }
  if (path === '/data/categories.json') {
    return new Response(JSON.stringify([category]), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected request: ${path}`);
};

const { api } = await import('../src/services/apiClient');
const { moduleService } = await import('../src/services/moduleService');
const { favoriteService } = await import('../src/services/favoriteService');
const { favoritesStore } = await import('../src/stores/favorites');
let passed = 0;
const failures: string[] = [];
async function test(name: string, run: () => Promise<void>) {
  favoritesStore.clear();
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push(`${name}: ${error}`); console.error(`  ✗ ${name}: ${error}`); }
}

await test('empty favorites remain empty', async () => {
  assert.deepEqual(await favoriteService.getFavorites(), []);
});
await test('ordinary browsing still defaults to 24 items', async () => {
  const page = await moduleService.getModules();
  assert.equal(page.items.length, 24);
  assert.equal(page.total, catalogue.length);
});
await test('a favorite outside the first 24 modules is resolved', async () => {
  favoritesStore.add('module-100');
  const page = await moduleService.getModules();
  assert.ok(!page.items.some((module) => module.id === 'module-100'));
  assert.deepEqual((await favoriteService.getFavorites()).map(({ module }) => module.id), ['module-100']);
});
await test('more than 24 saved favorites are all returned', async () => {
  for (let index = 50; index < 110; index++) favoritesStore.add(`module-${index}`);
  const expected = favoritesStore.getSnapshot().map((record) => record.moduleId);
  const entries = await favoriteService.getFavorites();
  assert.equal(entries.length, 60);
  assert.deepEqual(entries.map(({ module }) => module.id), expected);
});
await test('favorite ordering and original addedAt values are preserved', async () => {
  for (const id of ['module-129', 'module-0', 'module-100']) favoritesStore.add(id);
  const expected = favoritesStore.getSnapshot().map((record) => ({ ...record }));
  const entries = await favoriteService.getFavorites();
  assert.deepEqual(entries.map(({ module, addedAt }) => ({ moduleId: module.id, addedAt })), expected);
});
await test('duplicate saves do not duplicate resolved favorites', async () => {
  assert.equal(favoritesStore.add('module-100'), true);
  assert.equal(favoritesStore.add('module-100'), false);
  assert.equal((await favoriteService.getFavorites()).length, 1);
});
await test('removing a non-first-page favorite leaves other favorites intact', async () => {
  favoritesStore.add('module-100'); favoritesStore.add('module-129');
  await favoriteService.removeFavorite('module-100');
  assert.deepEqual((await favoriteService.getFavorites()).map(({ module }) => module.id), ['module-129']);
  assert.equal(favoriteService.isFavorite('module-100'), false);
});
await test('unavailable modules do not hide valid favorites or erase saved records', async () => {
  favoritesStore.add('missing-module'); favoritesStore.add('module-100');
  const before = window.localStorage.getItem('surge-modules:favorites:v1');
  assert.deepEqual((await favoriteService.getFavorites()).map(({ module }) => module.id), ['module-100']);
  assert.equal(await favoriteService.count(), 2);
  assert.equal(favoriteService.isFavorite('missing-module'), true);
  assert.equal(window.localStorage.getItem('surge-modules:favorites:v1'), before);
});
await test('resolved favorites retain current version, category and health metadata', async () => {
  favoritesStore.add('module-100');
  const [{ module }] = await favoriteService.getFavorites();
  assert.equal(module.version, '1.0.100');
  assert.equal(module.category.slug, 'tools');
  assert.equal(module.category.description, 'Utilities');
  assert.equal(module.health, 'ok');
  assert.equal(module.hasPanel, true);
});
await test('full-catalogue lookups do not mutate source order or browsing pagination', async () => {
  const before = catalogue.map((module) => module.id);
  const all = await moduleService.getAllModules();
  assert.equal(all.length, catalogue.length);
  assert.deepEqual(all.map((module) => module.id), before);
  const page = await api.listModules({ page: 2, perPage: 24 });
  assert.equal(page.items.length, 24);
  assert.equal(page.items[0].id, 'module-24');
});
await test('full-catalogue lookups reuse the existing shared catalogue request', async () => {
  favoritesStore.add('module-129');
  await Promise.all([favoriteService.getFavorites(), moduleService.getModules(), moduleService.getAllModules()]);
  assert.equal(catalogueFetches, 1);
});

await dom.happyDOM.close();
console.log(`\nfavorites: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
