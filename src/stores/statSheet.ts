import { useSyncExternalStore } from 'react';

/**
 * Home stat-sheet store — mirrors the pattern of moduleSheet.ts.
 *
 * Tapping a stat card opens one of four sheets over the homepage. The store is
 * a tiny external store (same shape as favorites) so any card anywhere can
 * trigger it without threading props.
 */

export type StatSheetKind = 'modules' | 'categories' | 'sources' | 'updates';

type Listener = () => void;
const listeners = new Set<Listener>();

let open: StatSheetKind | null = null;

function emit(): void {
  for (const l of listeners) l();
}

export function openStatSheet(kind: StatSheetKind): void {
  if (open === kind) return;
  open = kind;
  emit();
}

export function closeStatSheet(): void {
  if (open === null) return;
  open = null;
  emit();
}

export function subscribeStatSheet(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): StatSheetKind | null {
  return open;
}

export function useStatSheet(): { kind: StatSheetKind | null } {
  const kind = useSyncExternalStore(subscribeStatSheet, getSnapshot, getSnapshot);
  return { kind };
}
