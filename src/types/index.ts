/** Shared domain types. Nothing here may be redefined inside pages. */

export type ThemeMode = 'dark' | 'light' | 'system';

export type ResolvedTheme = 'dark' | 'light';

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** key into the icon registry (src/lib/icons.ts) */
  icon?: string;
  sortOrder: number;
  isVisible: boolean;
}

export interface Module {
  id: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  categoryId: string;
  tags: string[];
  version: string;
  updatedAt: string;
  rawUrl: string;
  repositoryUrl?: string;
  isFeatured: boolean;
  isPublished: boolean;
}

export interface ModuleVersion {
  id: string;
  moduleId: string;
  version: string;
  changelog: string;
  releasedAt: string;
}

/** A module joined with the display data its card / detail view needs. */
export interface ModuleWithMeta extends Module {
  category: Category;
  latestVersion?: ModuleVersion;
  /** stable identity of where the record came from */
  source: 'api' | 'sample' | 'github';
}

export interface ModuleStats {
  modules: number;
  categories: number;
  authors: number;
  versions: number;
  lastUpdatedAt: string | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  pinned: boolean;
}

export type ModuleSort = 'recommended' | 'updated' | 'name' | 'added';

export interface ModuleQuery {
  search?: string;
  categorySlug?: string;
  tag?: string;
  featuredOnly?: boolean;
  sort?: ModuleSort;
  limit?: number;
}

/** Result envelope — mirrors what the future Worker API will return. */
export interface ListResult<T> {
  items: T[];
  total: number;
}

export interface AnalyticsEvent {
  name:
    | 'page_view'
    | 'module_view'
    | 'install_click'
    | 'copy_click'
    | 'search'
    | 'favorite_add'
    | 'favorite_remove';
  payload?: Record<string, string | number | boolean | undefined>;
  at: number;
}
