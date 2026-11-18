import { useCallback, useSyncExternalStore } from 'react';
import { EN, type DictValue } from './dict';

/**
 * Interface language: 'zh' | 'en' | 'system', persisted per device.
 *
 * Deliberately mirrors `useTheme`: one module-level store, `useSyncExternalStore`
 * in the hook, the resolved value mirrored onto <html lang> / <html data-lang>,
 * and the choice survives a reload. Switching re-renders; it never reloads.
 *
 * 'system' is a first-class mode, not just the initial value: it keeps listening
 * to `languagechange` and to a `matchMedia` change, so switching the phone between
 * Chinese and English moves the site with it.
 *
 * Chinese is the site's own language — the Chinese strings in the components ARE
 * the copy, not a translation table. `EN` holds the English rendering; when the
 * resolved language is Chinese the source string is returned untouched.
 */

export type Lang = 'zh' | 'en';
export type LangMode = Lang | 'system';

const STORAGE_KEY = 'surge-modules:lang:v1';

const listeners = new Set<() => void>();
let mode: LangMode = readStoredMode();

/** BCP-47 tags whose primary subtag is `zh` all count as Chinese. */
function isChinese(tag: string | undefined | null): boolean {
  return typeof tag === 'string' && /^zh\b/i.test(tag);
}

function systemLang(): Lang {
  if (typeof navigator === 'undefined') return 'zh';
  const list = navigator.languages;
  if (list && list.length > 0) {
    // First tag decides, matching how browsers pick a UI language. A zh-TW
    // browser still gets the Chinese copy; we only have one written form.
    return isChinese(list[0]) ? 'zh' : 'en';
  }
  return isChinese(navigator.language) ? 'zh' : 'en';
}

function readStoredMode(): LangMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'zh' || raw === 'en' || raw === 'system') return raw;
  } catch {
    /* private mode / storage disabled */
  }
  // No stored choice: follow the device.
  return 'system';
}

function resolve(current: LangMode): Lang {
  return current === 'system' ? systemLang() : current;
}

function apply(next: LangMode): void {
  if (typeof document === 'undefined') return;
  const resolved = resolve(next);
  const root = document.documentElement;
  const tag = resolved === 'zh' ? 'zh-CN' : 'en';
  if (root.lang !== tag) root.lang = tag;
  if (root.dataset.lang !== resolved) root.dataset.lang = resolved;
  if (root.dataset.langMode !== next) root.dataset.langMode = next;
  listeners.forEach((l) => l());
}

function persist(next: LangMode): void {
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply(next);
}

/** Applies the stored language before first paint (called from main.tsx). */
export function initLang(): void {
  apply(mode);
  // In 'system' mode the device language can change while the tab is open.
  if (typeof window === 'undefined') return;
  const onSystemChange = () => {
    if (mode === 'system') apply(mode);
  };
  window.addEventListener('languagechange', onSystemChange);
}

/** Explicit choice: 'zh', 'en' or 'system'. */
export function setLangMode(next: LangMode): void {
  persist(next);
}

function currentMode(): LangMode {
  return mode;
}

function currentLang(): Lang {
  return resolve(mode);
}

/**
 * Translate one string.
 *
 * `translate('共 {n} 个模块', { n: 12 })` → "12 modules" (English) or the
 * source string unchanged (Chinese).
 *
 * A dictionary value may be `{one, many}`; the plural is picked from `vars.n`.
 * Unknown keys fall back to the source string with placeholders filled, which
 * is exactly the copy the components already contain — a missing translation
 * degrades to readable Chinese, never to a raw key.
 */
export function translate(source: string, vars?: Record<string, string | number>): string {
  const entry: DictValue | undefined = currentLang() === 'en' ? EN[source] : undefined;
  let out = source;
  if (entry !== undefined) {
    if (typeof entry === 'string') out = entry;
    else out = Number(vars?.n ?? 0) === 1 ? entry.one : entry.many;
  }
  if (vars) {
    for (const [k, val] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(val));
  }
  return out;
}

export function useI18n() {
  // One subscription covers both the mode and (in 'system' mode) the device
  // language, because apply() notifies in either case. The snapshot is a plain
  // string so React never sees a fresh object and loops.
  const snapshot = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => `${mode}:${resolve(mode)}` as const,
    () => `${mode}:${resolve(mode)}` as const,
  );

  const currentMode_ = snapshot.slice(0, snapshot.indexOf(':')) as LangMode;
  const lang: Lang = snapshot.endsWith(':en') ? 'en' : 'zh';

  const t = useCallback(
    (source: string, vars?: Record<string, string | number>) => translate(source, vars),
    // `snapshot` is a real dependency: the store lives at module scope, but
    // React needs a fresh `t` identity so memoised children re-render.
    [snapshot],
  );

  const toggle = useCallback(() => {
    // Toggling from 'system' resolves first, so the button always visibly flips.
    persist(resolve(mode) === 'zh' ? 'en' : 'zh');
  }, []);

  return {
    lang,
    isZh: lang === 'zh',
    /** the stored choice, including 'system' */
    mode: currentMode_,
    setMode: setLangMode,
    /** explicit two-way switch, used by the compact header control */
    toggle,
    t,
  };
}

/** Non-hook access for module-level code (services, thrown messages). */
export const i18n = { translate, current: currentLang, mode: currentMode, set: setLangMode };
