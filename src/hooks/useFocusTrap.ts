import { useEffect, useRef } from 'react';

/**
 * Keeps Tab focus inside an overlay while it is open, and restores focus to
 * the element that opened it on close.
 *
 * Without this, a `role="dialog" aria-modal="true"` element lies to screen
 * readers: the attribute claims that content behind it is inert, but Tab still
 * walks out into the page. The search palette and Modal both need the same
 * behaviour, so it lives here once.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const root = ref.current;
    if (!root) return;

    const selector =
      'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const current = document.activeElement;

      if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // return focus where the user left it (skipped if that node is gone)
      const prev = previouslyFocused.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [active]);

  return ref;
}
