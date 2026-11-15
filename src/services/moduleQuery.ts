import { moduleService } from './moduleService';
import { tokenize } from '@/lib/format';
import type { ListResult, ModuleQuery, ModuleWithMeta, ModuleSort } from '@/types';

/**
 * Query layer used by Discover / Home search. Kept separate from
 * `moduleService` so the filtering semantics live in one place and can later
 * be pushed down to D1 SQL without touching components.
 */

function score(module: ModuleWithMeta, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let total = 0;
  const name = module.name.toLowerCase();
  const author = module.author.toLowerCase();
  const tags = module.tags.map((t) => t.toLowerCase());
  // Pinyin index: 'jingdong' / 'jd' both reach 「京东去广告」.
  const py = module.py;
  const pyFull = (py?.full ?? '').replace(/\s+/g, '');
  const pyInitials = (py?.initials ?? '').replace(/\s+/g, '');

  for (const token of tokens) {
    if (name.includes(token)) total += 6;
    if (pyFull && pyFull.includes(token)) total += 5;
    if (pyInitials && pyInitials.includes(token)) total += 3;
    if (tags.some((t) => t.includes(token))) total += 4;
    if (author.includes(token)) total += 3;
    if (module.category.name.toLowerCase().includes(token)) total += 2;
    if (module.description.toLowerCase().includes(token)) total += 1;
  }
  return total;
}

const SORTERS: Record<ModuleSort, (a: ModuleWithMeta, b: ModuleWithMeta) => number> = {
  recommended: (a, b) =>
    Number(b.isFeatured) - Number(a.isFeatured) ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  updated: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  name: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
  added: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
};

export const moduleQuery = {
  apply(
    modules: ModuleWithMeta[],
    { search = '', categorySlug, tag, panelOnly, featuredOnly, sort = 'recommended', limit }: ModuleQuery,
  ): ListResult<ModuleWithMeta> {
    const tokens = tokenize(search);
    let items = modules.filter((m) => {
      if (!m.isPublished) return false;
      if (featuredOnly && !m.isFeatured) return false;
      if (categorySlug && m.category.slug !== categorySlug) return false;
      if (tag && !m.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
      // Structural, not a tag: only modules whose file really has a [Panel]
      // section render a dashboard card in Surge.
      if (panelOnly && !m.hasPanel) return false;
      if (tokens.length > 0 && score(m, tokens) === 0) return false;
      return true;
    });

    if (tokens.length > 0 && sort === 'recommended') {
      items = items.sort((a, b) => score(b, tokens) - score(a, tokens));
    } else {
      items = items.sort(SORTERS[sort]);
    }

    const total = items.length;
    if (limit !== undefined && limit > 0) items = items.slice(0, limit);
    return { items, total };
  },

  /** MOCK — loads the sample catalogue then applies the query. */
  async search(query: ModuleQuery): Promise<ListResult<ModuleWithMeta>> {
    const { items } = await moduleService.getModules();
    return moduleQuery.apply(items, query);
  },
};
