/**
 * Static data client.
 *
 * The site is hosted on Cloudflare Pages as a pure static bundle: there is no
 * Worker and no database at request time. Everything the UI needs was exported
 * to /data/*.json at build time (see scripts/dump_for_static.py +
 * scripts/build_static.py), so every "API call" below is just a fetch of a
 * static file plus local filtering.
 *
 * The whole catalogue is one file (~500 KB, ~110 KB gzipped) because browsing,
 * searching and sorting all happen client-side anyway — downloading the list
 * once removes every per-interaction request.
 *
 * The public surface (`api.listModules`, `api.getModule`, …) is unchanged so
 * no component needed editing during the migration.
 */

import type {
  PublicAnnouncement,
  PublicCategory,
  PublicModule,
  PublicModuleDetail,
  PublicSettings,
} from '../../packages/shared/src/contract';
import { i18n } from '@/i18n';

const DATA = '/data';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function loadJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DATA}${path}`, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'network_error', i18n.translate(i18n.translate('无法连接服务器')));
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'not_found', i18n.translate(i18n.translate('数据文件缺失')));
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(response.status, 'not_json', i18n.translate(i18n.translate('数据文件格式异常')));
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------- catalogue */
// Cached after the first fetch: every list/search/sort reuses it.
let catalogue: Promise<PublicModule[]> | null = null;

function allModules(): Promise<PublicModule[]> {
  if (!catalogue) {
    catalogue = loadJson<PublicModule[]>('/modules.json').catch((err) => {
      catalogue = null; // let a retry after a failed load try again
      throw err;
    });
  }
  return catalogue;
}

export interface ModuleListParams {
  page?: number;
  perPage?: number;
  q?: string;
  category?: string;
  tag?: string;
  featured?: boolean;
  sort?: 'updated' | 'name' | 'created' | 'featured';
}

export interface ModuleListPage {
  items: PublicModule[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Mirrors the server's behaviour closely enough that the UI is unchanged. */
function filterAndPage(items: PublicModule[], params: ModuleListParams): ModuleListPage {
  let rows = items;

  if (params.category) {
    const want = params.category;
    rows = rows.filter((m) => m.category?.slug === want || m.category?.id === want);
  }
  if (params.tag) {
    const want = params.tag.toLowerCase();
    rows = rows.filter((m) => m.tags.some((t) => t.toLowerCase() === want));
  }
  if (params.featured) {
    rows = rows.filter((m) => m.isFeatured);
  }
  if (params.q) {
    const q = params.q.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.author.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
  }

  const sort = params.sort ?? 'updated';
  const sorted = [...rows];
  if (sort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } else if (sort === 'created') {
    // createdAt is not part of the list payload; updatedAt is the closest proxy
    sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (sort === 'featured') {
    sorted.sort(
      (a, b) =>
        Number(b.isFeatured) - Number(a.isFeatured) || b.updatedAt.localeCompare(a.updatedAt),
    );
  } else {
    sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const perPage = params.perPage ?? 24;
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
  const start = (page - 1) * perPage;

  return {
    items: sorted.slice(start, start + perPage),
    page,
    perPage,
    total,
    totalPages,
  };
}

export const api = {
  /** Full cached catalogue for ID lookups; browsing pagination must not hide favorites. */
  getAllModules(): Promise<PublicModule[]> {
    return allModules();
  },

  async listModules(params: ModuleListParams = {}): Promise<ModuleListPage> {
    return filterAndPage(await allModules(), params);
  },

  async getModule(slug: string): Promise<PublicModuleDetail> {
    return loadJson<PublicModuleDetail>(
      `/details/${encodeURIComponent(slug)}.json`,
    );
  },

  listCategories(): Promise<PublicCategory[]> {
    return loadJson<PublicCategory[]>('/categories.json');
  },

  listAnnouncements(): Promise<PublicAnnouncement[]> {
    return loadJson<PublicAnnouncement[]>('/announcements.json');
  },

  getSettings(): Promise<PublicSettings> {
    return loadJson<PublicSettings>('/settings.json');
  },

  async health(): Promise<{ status: string; env: string; db: boolean }> {
    return { status: 'ok', env: 'static', db: false };
  },

  /**
   * Analytics had to go with the Worker: there is nowhere to POST to on a
   * static host. Kept as a no-op so callers do not need to change.
   */
  track(_events: Array<{ event: string; subject?: string }>): void {
    /* no-op on static hosting */
  },
};
