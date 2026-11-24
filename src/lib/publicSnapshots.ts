/**
 * In-memory snapshots for public list data.
 *
 * Why this exists: every page remounts when the reader comes back from the
 * bottom tab bar, and `useAsync` starts at `idle` again — so the first frame is
 * a skeleton grid even though the exact same JSON was rendered a second ago.
 * These stores keep the last successful result of a read for the lifetime of
 * the document, so a revisit can paint the real list synchronously while the
 * normal fetch keeps running in the background and replaces it when it lands.
 *
 * Deliberately narrow:
 *  - memory only — nothing is written to localStorage/IndexedDB, so no public
 *    catalogue data (or anything derived from a credential) survives a reload;
 *  - read paths only — `fetch` is untouched, no global network cache;
 *  - keyed — only an identical request can reuse an entry. The favorites list
 *    also keys on the exact favorite records (see `favoriteSignature`), so a
 *    list produced before an add/remove can never be served again.
 */

import type { Category, ListResult, ModuleStats, ModuleWithMeta } from '@/types';

/**
 * What `categoryService.getCategories()` returns. Restated here (instead of
 * imported) so this module stays dependency-free and the card lists can be
 * tested without the API layer.
 */
export interface CategorySnapshotEntry extends Category {
  moduleCount: number;
}

/** A binding `useAsync` can consume: one key, one read, one write. */
export interface SnapshotBinding<T> {
  key: string;
  peek: () => T | undefined;
  save: (value: T) => void;
}

export interface SnapshotStore<T> {
  peek: (key: string) => T | undefined;
  save: (key: string, value: T) => void;
  drop: (key: string) => void;
  clear: () => void;
  keys: () => string[];
  size: () => number;
}

/**
 * Small LRU of settled list results.
 *
 * `limit` only needs to cover the distinct keys a reader can bounce between
 * (catalogue, featured, recent, a few favorites signatures); old keys are
 * dropped rather than growing without bound.
 */
export function createSnapshotStore<T>(limit = 12): SnapshotStore<T> {
  const entries = new Map<string, T>();

  const peek = (key: string): T | undefined => {
    const value = entries.get(key);
    if (value !== undefined) {
      // refresh recency: delete + set moves the key to the end
      entries.delete(key);
      entries.set(key, value);
    }
    return value;
  };

  const save = (key: string, value: T): void => {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > Math.max(1, limit)) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    peek,
    save,
    drop: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
    keys: () => [...entries.keys()],
    size: () => entries.size,
  };
}

function binding<T>(store: SnapshotStore<T>, key: string): SnapshotBinding<T> {
  return {
    key,
    peek: () => store.peek(key),
    save: (value) => store.save(key, value),
  };
}

/** One catalogue entry for every page that shows the whole library. */
export const CATALOGUE_KEY = 'modules:catalogue';

const catalogueStore = createSnapshotStore<ListResult<ModuleWithMeta>>(2);
const moduleListStore = createSnapshotStore<ModuleWithMeta[]>(8);
const categoryStore = createSnapshotStore<CategorySnapshotEntry[]>(1);
const statsStore = createSnapshotStore<ModuleStats>(1);
const favoriteStore = createSnapshotStore<Array<{ module: ModuleWithMeta; addedAt: string }>>(8);

export const snapshots = {
  /** `getModules({ perPage: 9999 })` — Home preview, Discover, Collection. */
  catalogue: (): SnapshotBinding<ListResult<ModuleWithMeta>> => binding(catalogueStore, CATALOGUE_KEY),
  featured: (limit: number): SnapshotBinding<ModuleWithMeta[]> =>
    binding(moduleListStore, `modules:featured:${limit}`),
  recent: (limit: number): SnapshotBinding<ModuleWithMeta[]> =>
    binding(moduleListStore, `modules:recent:${limit}`),
  categories: (): SnapshotBinding<CategorySnapshotEntry[]> => binding(categoryStore, 'categories'),
  stats: (): SnapshotBinding<ModuleStats> => binding(statsStore, 'modules:stats'),
  /**
   * Favorite entries. `signature` must describe the exact favorite records the
   * list was built from — see `favoriteSignature`.
   */
  favorites: (
    signature: string,
  ): SnapshotBinding<Array<{ module: ModuleWithMeta; addedAt: string }>> =>
    binding(favoriteStore, `favorites:${signature}`),
};

/**
 * Identity of a favorites list's inputs.
 *
 * Includes every record's id *and* timestamp and keeps the order, so the key
 * changes on add, on remove and on re-adding a module (new `addedAt`). Two
 * different favorite sets can never share a snapshot.
 */
export function favoriteSignature(
  records: ReadonlyArray<{ moduleId: string; addedAt: string }>,
): string {
  return records.map((r) => `${r.moduleId}@${r.addedAt}`).join('|');
}

/** Test/HMR helper: forget every public snapshot. */
export function clearPublicSnapshots(): void {
  catalogueStore.clear();
  moduleListStore.clear();
  categoryStore.clear();
  statsStore.clear();
  favoriteStore.clear();
}
