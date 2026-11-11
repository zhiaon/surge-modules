import { useSyncExternalStore } from 'react';

/**
 * Detail-sheet store.
 *
 * Tapping a card opens the module detail as a sheet instead of navigating to a
 * full page — the browse → inspect → install loop stays on one screen, which is
 * how the hub-style sites behave. The `/modules/:slug` route still exists for
 * direct links, search results and shares; only in-app card taps use the sheet.
 *
 * The open slug lives in a tiny external store (same pattern as favorites) so
 * any card anywhere can open it without threading props through five layers.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

let openSlug: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function openModuleSheet(slug: string): void {
  if (openSlug === slug) return;
  openSlug = slug;
  emit();
}

export function closeModuleSheet(): void {
  if (openSlug === null) return;
  openSlug = null;
  emit();
}

export function subscribeModuleSheet(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return openSlug;
}

export function useModuleSheet(): { slug: string | null } {
  const slug = useSyncExternalStore(subscribeModuleSheet, getSnapshot, getSnapshot);
  return { slug };
}
