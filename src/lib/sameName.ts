/**
 * Same-name grouping.
 *
 * Several upstream repos ship a module with the same title (jd, tieba,
 * youtube, …), and after de-duplicating slugs the catalogue holds `jd`,
 * `jd-2`, `jd-3`. The user then sees four cards called 「京东去广告」 and has no
 * way to tell them apart. This groups those modules and ranks them.
 */
import type { ModuleWithMeta } from '@/types';

/** Normalised key: strips punctuation, spaces and case so 「京东去广告」 groups. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '') // drop parenthetical qualifiers
    .replace(/[\s·・,，.。:：\-—_/\\|]+/g, '')
    .trim();
}

export function groupBySameName(modules: ModuleWithMeta[]): Map<string, ModuleWithMeta[]> {
  const map = new Map<string, ModuleWithMeta[]>();
  for (const m of modules) {
    const key = nameKey(m.name);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(m);
    else map.set(key, [m]);
  }
  return map;
}

/** nameKey → how many modules share that title (absent when unique). */
export function duplicateCounts(modules: ModuleWithMeta[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of groupBySameName(modules)) {
    if (list.length < 2) continue;
    out.set(key, list.length);
  }
  return out;
}

export interface CompareTech {
  rules: number;
  rewrites: number;
  mitm: number;
  scripts: number;
  crons: number;
}

export interface CompareRow {
  module: ModuleWithMeta;
  tech: CompareTech | null;
  score: number;
  recommended: boolean;
}

/**
 * Preference order for 「which of these four should I install」:
 *   1. scripts still reachable (health ≠ broken) — the single strongest signal
 *   2. more enforcement surface (rules + rewrites + hosts)
 *   3. newer content
 */
export function rankGroup(
  modules: ModuleWithMeta[],
  techBySlug: Record<string, CompareTech | null>,
): CompareRow[] {
  const scored = modules.map((m) => {
    const tech = techBySlug[m.slug] ?? null;
    let score = 0;
    if (m.health !== 'broken') score += 100;
    if (tech) score += (tech.rules + tech.rewrites) * 2 + tech.mitm + tech.scripts * 3;
    // newer is better, but only as a tie-breaker
    score += Math.min(20, Math.floor((Date.parse(m.updatedAt) || 0) / 1e11));
    return { module: m, tech, score, recommended: false };
  });

  scored.sort((a, b) => b.score - a.score);
  if (scored.length) scored[0].recommended = true;
  return scored;
}
