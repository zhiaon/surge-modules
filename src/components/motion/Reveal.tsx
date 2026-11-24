import { useEffect, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import { isFirstEntry, markPainted } from '@/lib/pageSession';

/**
 * Scroll reveal — IntersectionObserver for timing, CSS for the motion.
 *
 * Three failure modes had to be designed around:
 *
 * 1. **Frozen animation clock.** When the document is hidden (background tab,
 *    offscreen in-app webview, prerender), the browser stops advancing both
 *    rAF and CSS transitions. An element left at `opacity: 0` by a transition
 *    that never progresses is invisible *forever*. So while the document is
 *    hidden we disable motion entirely (`html[data-motion='off']`), render the
 *    final state immediately, and settle anything still in flight the moment
 *    the document is hidden.
 *
 * 2. **Observer never firing.** If IntersectionObserver is missing or starved,
 *    a one-shot timer reveals the element. The timer only fires for elements
 *    that are already at or above the viewport bottom, so below-the-fold
 *    content still gets its scroll-in.
 *
 * 3. **Revisit hiding content.** This component mounts again on every return
 *    from the bottom tab bar. Replaying the reveal then means a visible flash
 *    back to `opacity: 0`, and elements that were scrolled past stay hidden.
 *    Only the first page of a document load animates (see `lib/pageSession`).
 *    A revisit renders its final state on the very first frame.
 */

export interface RevealProps {
  children: ReactNode;
  /** seconds, applied as transition-delay */
  delay?: number;
  className?: string;
  as?: ElementType;
  /** distance in px the element travels up */
  y?: number;
  once?: boolean;
}

const motionOff = (): boolean =>
  typeof document !== 'undefined' &&
  (document.visibilityState === 'hidden' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function initiallyShown(): boolean {
  // Revisit: no entrance, no hidden frame — paint the final state at once.
  if (!isFirstEntry()) return true;
  return motionOff() || typeof IntersectionObserver === 'undefined';
}

export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
  y = 10,
  once = true,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(initiallyShown);

  // Everything above runs before this effect on the first page, so the flag
  // only affects pages mounted after the initial entry.
  useEffect(() => {
    markPainted();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    // hidden document / reduced motion: show now, animate nothing
    if (motionOff() || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    // Settle immediately if the document is hidden mid-reveal, otherwise a
    // paused transition can leave the element transparent until the tab wakes.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setShown(true);
    };
    document.addEventListener('visibilitychange', onVisibility);

    let timer = 0;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            if (once) io.disconnect();
          }
        }
      },
      // The top allowance catches content the reader has already scrolled past
      // (anchor links, restored positions) — it is above the viewport, so a
      // plain observer would never intersect it.
      { rootMargin: '60% 0px -6% 0px', threshold: 0.01 },
    );
    io.observe(el);

    // Safety net for a starved observer — only for content already on screen,
    // so scrolling still produces the intended entrance for everything else.
    timer = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight) setShown(true);
    }, 1200);

    return () => {
      io.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [once, shown]);

  return (
    <Tag
      ref={ref}
      data-reveal={shown ? 'in' : 'out'}
      className={className}
      style={
        {
          '--reveal-y': `${y}px`,
          '--reveal-delay': `${delay}s`,
        } as React.CSSProperties
      }
    >
      {children}
    </Tag>
  );
}
