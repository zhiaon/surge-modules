/**
 * Query parameter parsing with hard limits.
 *
 * Every value the API reads from the URL goes through here, so pagination caps,
 * sort whitelists and slug validation are defined once instead of per endpoint.
 */

import type { ModuleListQuery, ModuleSort } from './contract';

export const LIMITS = {
  perPageMax: 60,
  perPageDefault: 20,
  searchMaxLength: 80,
  tagMaxLength: 40,
  slugMaxLength: 80,
} as const;

const SORTS: ModuleSort[] = ['updated', 'name', 'created', 'featured'];

/** Module slugs are lowercase alphanumeric with single dashes. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseModuleListQuery(params: URLSearchParams): ModuleListQuery {
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;

  const perPageRaw = Number.parseInt(params.get('perPage') ?? '', 10);
  const perPage = clamp(
    Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : LIMITS.perPageDefault,
    1,
    LIMITS.perPageMax,
  );

  const search = (params.get('q') ?? '').trim().slice(0, LIMITS.searchMaxLength);
  const category = validSlug(params.get('category')) ? params.get('category')!.trim() : '';
  const tag = (params.get('tag') ?? '').trim().slice(0, LIMITS.tagMaxLength);

  const featuredRaw = params.get('featured');
  const featured = featuredRaw === '1' || featuredRaw === 'true' ? true : null;

  const sortRaw = params.get('sort') as ModuleSort | null;
  const sort: ModuleSort = sortRaw && SORTS.includes(sortRaw) ? sortRaw : 'updated';

  return { page, perPage, search, category, tag, featured, sort };
}

/** Returns the slug when it is well-formed, otherwise null. */
export function validSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.length === 0 || v.length > LIMITS.slugMaxLength) return null;
  if (!SLUG_RE.test(v)) return null;
  return v;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Escapes a string for a D1 `LIKE` pattern. `%` and `_` are wildcards, and `\`
 * is the escape character — a user typing "100%" must not match everything.
 */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Splits a free-text query into tokens for AND matching. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 6);
}
