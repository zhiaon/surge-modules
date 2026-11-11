import type { Category } from '@/types';
import { api, ApiError } from './apiClient';
import { BackendUnavailableError, apiAvailable } from './moduleService';

/**
 * Backend-backed category service.
 *
 * `moduleCount` comes from the API (a COUNT over published, non-deleted
 * modules), so the number on the home page is always the real one.
 */

export interface CategoryWithCount extends Category {
  moduleCount: number;
}

export const categoryService = {
  async getCategories(): Promise<CategoryWithCount[]> {
    if (!(await apiAvailable())) throw new BackendUnavailableError();
    const rows = await api.listCategories();
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      icon: c.icon ?? undefined,
      sortOrder: c.sortOrder,
      isVisible: true,
      moduleCount: c.moduleCount,
    }));
  },

  async getCategoryBySlug(slug: string): Promise<CategoryWithCount | null> {
    try {
      const all = await categoryService.getCategories();
      return all.find((c) => c.slug === slug) ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
};

export const CATEGORY_SERVICE_IS_MOCK = false;
