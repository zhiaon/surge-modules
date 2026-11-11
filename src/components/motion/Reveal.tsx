import { useEffect, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';

/**
 * Scroll reveal — IntersectionObserver for timing, CSS for the motion.
 *
 * Two failure modes had to be designed around:
 *
 * 1. **Frozen animation clock.** When the document is hidden (background tab,
 *    offscreen in-app webview, prerender), the browser stops advancing both
 *    rAF and CSS transitions. An element left at `opacity: 0` by a transition
 *    that never progresses is invisible *forever*. So while the document is
 *    hidden we disable motion entirely (`html[data-motion='off']`) and render
 *    the final state immediately.
 *
 * 2. **Observer never firing.** If IntersectionObserver is missing or starved,
 *    a one-shot timer reveals the element. The timer only fires for elements
 *    that are already near the viewport, so below-the-fold content still gets
 *    its scroll-in.
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

export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
  y = 10,
  once = true,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    // hidden document / reduced motion: show now, animate nothing
    if (motionOff() || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

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
      { rootMargin: '0px 0px -6% 0px', threshold: 0.01 },
    );
    io.observe(el);

    // Safety net for a starved observer — only for content already on screen,
    // so scrolling still produces the intended entrance for everything else.
    timer = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) setShown(true);
    }, 1200);

    return () => {
      io.disconnect();
      window.clearTimeout(timer);
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
