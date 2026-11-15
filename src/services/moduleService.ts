/**
 * Backend-backed module service.
 *
 * Decides *once* per page load whether the API is reachable, then serves every
 * read from it. If the API is missing (plain `vite dev` without the worker) the
 * service reports that explicitly instead of swapping in fixtures — the UI shows
 * a clear "backend not running" state, which is what keeps sample data from
 * leaking into a real deployment.
 */

import type {
  Announcement,
  Category,
  ListResult,
  Module,
  ModuleStats,
  ModuleVersion,
  ModuleWithMeta,
} from '@/types';
import { api, ApiError, type ModuleListParams } from './apiClient';
import type { PublicModule, PublicCategory } from '../../packages/shared/src/contract';

export type DataSource = 'api' | 'unavailable';

let probe: Promise<boolean> | null = null;

/** One shared health probe per page load. */
export function apiAvailable(): Promise<boolean> {
  if (!probe) {
    probe = api
      .health()
      .then((h) => h.status === 'ok')
      .catch(() => false);
  }
  return probe;
}

export class BackendUnavailableError extends Error {
  constructor() {
    super('后端接口未启动：请用 npm run dev:site，或部署后访问。');
    this.name = 'BackendUnavailableError';
  }
}

async function requireApi(): Promise<void> {
  if (!(await apiAvailable())) throw new BackendUnavailableError();
}

/** Maps the API shape onto the shape the existing components already consume. */
function toModuleWithMeta(
  m: PublicModule,
  categories: PublicCategory[],
  versions: ModuleVersion[] = [],
): ModuleWithMeta {
  const category: Category = m.category
    ? {
        id: m.category.id,
        name: m.category.name,
        slug: m.category.slug,
        description: categories.find((c) => c.id === m.category!.id)?.description ?? '',
        sortOrder: categories.find((c) => c.id === m.category!.id)?.sortOrder ?? 0,
        isVisible: true,
      }
    : {
        id: 'uncategorised',
        name: '未分类',
        slug: 'uncategorised',
        description: '',
        sortOrder: 999,
        isVisible: true,
      };

  const base: Module = {
    id: m.id,
    slug: m.slug,
    name: m.name,
    description: m.description,
    author: m.author,
    categoryId: category.id,
    tags: m.tags,
    version: m.version,
    updatedAt: m.updatedAt,
    rawUrl: m.rawUrl,
    repositoryUrl: m.repositoryUrl ?? undefined,
    isFeatured: m.isFeatured,
    isPublished: true,
  };

  return {
    ...base,
    category,
    latestVersion: versions[0],
    health: m.health,
    dupe: m.dupe,
    py: m.py,
    hasPanel: m.hasPanel,
    source: 'api',
  } as ModuleWithMeta;
}

export const moduleService = {
  async getModules(params: ModuleListParams = {}): Promise<ListResult<ModuleWithMeta>> {
    await requireApi();
    const [page, categories] = await Promise.all([api.listModules(params), api.listCategories()]);
    return {
      items: page.items.map((m) => toModuleWithMeta(m, categories)),
      total: page.total,
    };
  },

  async getFeaturedModules(limit = 6): Promise<ModuleWithMeta[]> {
    const { items } = await moduleService.getModules({ featured: true, perPage: limit });
    return items.slice(0, limit);
  },

  async getRecentlyUpdated(limit = 5): Promise<ModuleWithMeta[]> {
    const { items } = await moduleService.getModules({ perPage: limit, sort: 'updated' });
    return items.slice(0, limit);
  },

  async getModuleStats(): Promise<ModuleStats> {
    await requireApi();
    const [page, categories, settings] = await Promise.all([
      api.listModules({ perPage: 60 }),
      api.listCategories(),
      api.getSettings(),
    ]);
    const authors = new Set(page.items.map((m) => m.author).filter(Boolean));
    const latest = page.items
      .map((m) => m.updatedAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    // Build-time settings carry the catalogue-wide totals: computing authors
    // from the first page undercounts on a catalogue this size.
    const s = settings as unknown as { totalVersions?: number; sourceCount?: number };
    return {
      modules: page.total,
      categories: categories.length,
      authors: s.sourceCount ?? authors.size,
      versions: s.totalVersions ?? 0,
      lastUpdatedAt: latest ?? null,
    };
  },

  async getModuleBySlug(slug: string): Promise<ModuleWithMeta | null> {
    await requireApi();
    try {
      const [detail, categories] = await Promise.all([api.getModule(slug), api.listCategories()]);
      const versions: ModuleVersion[] = detail.versions.map((v, i) => ({
        id: `${detail.id}-${v.version}-${i}`,
        moduleId: detail.id,
        version: v.version,
        changelog: v.changelog,
        releasedAt: v.releasedAt,
      }));
      return toModuleWithMeta(detail, categories, versions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * The raw .sgmodule text. Fetched from the proxy URL, which is the only public
   * address for module content — the upstream repository stays backend-only.
   */
  async getRawConfig(slug: string): Promise<string> {
    await requireApi();
    const detail = await api.getModule(slug);
    if (!detail.rawUrl) {
      throw new Error('未配置模块反代地址，无法读取原始配置。');
    }
    const res = await fetch(detail.rawUrl, { credentials: 'omit' });
    if (!res.ok) throw new Error(`读取原始配置失败（HTTP ${res.status}）`);
    const text = await res.text();
    // hard cap in the client too: the proxy already limits, this is a second fence
    return text.slice(0, 512 * 1024);
  },

  /** @param slug public module slug (not the internal id) */
  async getVersions(slug: string): Promise<ModuleVersion[]> {
    await requireApi();
    const detail = await api.getModule(slug);
    return detail.versions.map((v, i) => ({
      id: `${detail.id}-${v.version}-${i}`,
      moduleId: detail.id,
      version: v.version,
      changelog: v.changelog,
      releasedAt: v.releasedAt,
    }));
  },

  async getAnnouncements(): Promise<Announcement[]> {
    await requireApi();
    const rows = await api.listAnnouncements();
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      publishedAt: a.publishedAt,
      pinned: a.isPinned,
    }));
  },
};

export const MODULE_SERVICE_IS_MOCK = false;
export const MODULE_SERVICE_BACKEND = 'cloudflare-worker' as const;
