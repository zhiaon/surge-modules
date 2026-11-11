import { useSyncExternalStore } from 'react';

/**
 * Donate-sheet store — same external-store pattern as moduleSheet/statSheet.
 * Opened from the footer「支持作者」card; renders the WeChat QR code.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

let open = false;

function emit(): void {
  for (const l of listeners) l();
}

export function openDonateSheet(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeDonateSheet(): void {
  if (!open) return;
  open = false;
  emit();
}

export function subscribeDonateSheet(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): boolean {
  return open;
}

export function useDonateSheet(): boolean {
  return useSyncExternalStore(subscribeDonateSheet, getSnapshot, getSnapshot);
}
