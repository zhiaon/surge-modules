import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Reset scroll on route change, keep anchor navigation working.
 *
 * The naive `window.scrollTo({ top: 0, behavior: 'auto' })` does NOT defeat a
 * CSS `scroll-behavior: smooth` on <html>: `behavior: 'auto'` means "use the
 * CSS value", so the reset animates. If the new route is shorter than the old
 * one, the animation clamps midway and the page can end up parked near the
 * bottom — which is exactly the "I open a module and land at the footer" bug.
 *
 * Fix: force `scroll-behavior: auto` on the root for the duration of the call,
 * then put it back so in-page anchor links stay smooth.
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;

    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }

    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    // restore on the next frame so the instant jump isn't re-animated
    const id = window.setTimeout(() => {
      root.style.scrollBehavior = previous;
    }, 0);

    return () => {
      window.clearTimeout(id);
      root.style.scrollBehavior = previous;
    };
  }, [pathname, hash]);

  return null;
}
