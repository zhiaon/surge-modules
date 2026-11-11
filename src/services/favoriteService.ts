import type { ModuleWithMeta } from '@/types';
import { moduleService, MODULE_SERVICE_IS_MOCK } from './moduleService';
import { favoritesStore } from '@/stores/favorites';

/**
 * Favorites facade.
 *
 * Phase 1 persists to localStorage (see stores/favorites.ts). The async API
 * here is the contract a cloud-backed implementation will fulfil later —
 * pages already await it, so the swap is invisible to them.
 */

export interface FavoriteEntry {
  module: ModuleWithMeta;
  addedAt: string;
}

export const favoriteService = {
  /** MOCK (local) */
  async getFavorites(): Promise<FavoriteEntry[]> {
    const records = favoritesStore.getSnapshot();
    const all = await moduleService.getModules();
    const byId = new Map(all.items.map((m) => [m.id, m]));
    return records.flatMap((rec) => {
      const module = byId.get(rec.moduleId);
      return module ? [{ module, addedAt: rec.addedAt }] : [];
    });
  },

  /** MOCK (local) */
  async addFavorite(moduleId: string): Promise<void> {
    favoritesStore.add(moduleId);
  },

  /** MOCK (local) */
  async removeFavorite(moduleId: string): Promise<void> {
    favoritesStore.remove(moduleId);
  },

  /** MOCK (local), synchronous read for render paths */
  isFavorite(moduleId: string): boolean {
    return favoritesStore.isFavorite(moduleId);
  },

  /** MOCK (local) */
  async count(): Promise<number> {
    return favoritesStore.getSnapshot().length;
  },
};

export const FAVORITE_SERVICE_IS_LOCAL = true;
export const FAVORITE_SERVICE_IS_MOCK = MODULE_SERVICE_IS_MOCK;
