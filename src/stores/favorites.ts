import { useSyncExternalStore } from 'react';

/**
 * Local favorites store.
 *
 * A tiny external store on top of localStorage so that every card, the
 * favorites page and the nav badge stay in sync without a state library.
 * The shape is intentionally close to what a future `favoriteService`
 * backend will return (moduleId + addedAt), so swapping in D1 later only
 * changes the persistence layer.
 */

export interface FavoriteRecord {
  moduleId: string;
  addedAt: string;
}

const STORAGE_KEY = 'surge-modules:favorites:v1';

type Listener = () => void;
const listeners = new Set<Listener>();

let cache: FavoriteRecord[] | null = null;

function readStorage(): FavoriteRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const rec = entry as Partial<FavoriteRecord>;
      if (typeof rec.moduleId !== 'string') return [];
      return [
        {
          moduleId: rec.moduleId,
          addedAt: typeof rec.addedAt === 'string' ? rec.addedAt : new Date().toISOString(),
        },
      ];
    });
  } catch {
    return [];
  }
}

function getSnapshot(): FavoriteRecord[] {
  if (cache === null) cache = readStorage();
  return cache;
}

function commit(next: FavoriteRecord[]): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota or private mode — keep the in-memory state */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: FavoriteRecord[] = [];

export const favoritesStore = {
  subscribe,
  getSnapshot,
  add(moduleId: string): boolean {
    const current = getSnapshot();
    if (current.some((f) => f.moduleId === moduleId)) return false;
    commit([{ moduleId, addedAt: new Date().toISOString() }, ...current]);
    return true;
  },
  remove(moduleId: string): boolean {
    const current = getSnapshot();
    const next = current.filter((f) => f.moduleId !== moduleId);
    if (next.length === current.length) return false;
    commit(next);
    return true;
  },
  toggle(moduleId: string): boolean {
    return favoritesStore.isFavorite(moduleId)
      ? (favoritesStore.remove(moduleId), false)
      : (favoritesStore.add(moduleId), true);
  },
  isFavorite(moduleId: string): boolean {
    return getSnapshot().some((f) => f.moduleId === moduleId);
  },
  clear(): void {
    commit([]);
  },
};

/** React binding. Re-renders on every change, granular by component. */
export function useFavorites(): FavoriteRecord[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export function useIsFavorite(moduleId: string | undefined): boolean {
  const favorites = useFavorites();
  if (!moduleId) return false;
  return favorites.some((f) => f.moduleId === moduleId);
}
