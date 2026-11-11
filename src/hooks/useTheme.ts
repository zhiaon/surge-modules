import { useCallback, useSyncExternalStore } from 'react';
import type { ResolvedTheme, ThemeMode } from '@/types';
import { siteConfig } from '@/config/site';

/**
 * Theme state: 'dark' | 'light' | 'system', persisted per device.
 *
 * The resolved value is written to <html data-theme> and mirrored in
 * <meta name="theme-color">, and that is ALL that happens on a switch — no
 * remount, no reload, no route change. Every surface reads CSS variables, so
 * the whole page re-tints in one style recalculation.
 *
 * 'system' is a first-class mode (not just the initial value): it keeps
 * listening to `prefers-color-scheme` so a dark→light OS switch at sunset
 * moves the site with it.
 */

const STORAGE_KEY = 'surge-modules:theme:v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
let mode: ThemeMode = readStoredMode();

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return siteConfig.defaultTheme;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  } catch {
    /* private mode / storage disabled */
  }
  return siteConfig.defaultTheme;
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolve(current: ThemeMode): ResolvedTheme {
  return current === 'system' ? systemTheme() : current;
}

function notify(): void {
  listeners.forEach((l) => l());
}

/** Writes the resolved theme to the DOM. Idempotent — safe to call often. */
function apply(next: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const resolved = resolve(next);
  const root = document.documentElement;
  if (root.dataset.theme !== resolved) root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#0B0D12' : '#F6F7FA';
  notify();
}

function persist(next: ThemeMode): void {
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply(next);
}

export function initTheme(): void {
  apply(mode);
  // In 'system' mode the OS preference can change while the tab is open.
  // Listening once at module scope covers every consumer via the store.
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (mode === 'system') apply(mode);
    };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener?.(onChange);
  }
}

export function useTheme() {
  // Re-render when the mode changes OR when the OS preference changes while in
  // 'system' mode (apply() notifies both). The snapshot recomputes the resolved
  // value, which is exactly what the UI needs.
  const resolved = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => {
      // `mode` is a module variable; touch it so React sees a stable string
      // snapshot instead of a fresh object every call.
      return `${mode}:${resolve(mode)}` as const;
    },
    () => `${mode}:${resolve(mode)}` as const,
  );

  const currentMode = resolved.slice(0, resolved.indexOf(':')) as ThemeMode;
  const current: ResolvedTheme = resolved.endsWith('dark') ? 'dark' : 'light';

  const setMode = useCallback((next: ThemeMode) => {
    persist(next);
  }, []);

  const toggle = useCallback(() => {
    // Toggling from 'system' resolves first, so the button always visibly flips.
    persist(resolve(mode) === 'dark' ? 'light' : 'dark');
  }, []);

  return { mode: currentMode, resolved: current, setMode, toggle };
}
