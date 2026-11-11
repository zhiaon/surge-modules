/**
 * Entrance animation helper.
 *
 * The document may be hidden at mount (background tab, offscreen webview,
 * prerender). In that state the animation clock is frozen — and an animation
 * with `fill: both` would pin the element at `opacity: 0` forever, i.e. a blank
 * page. So: only animate when the document is actually visible; otherwise the
 * element simply renders in its final state.
 *
 * Usage: `const enter = useEnter();  <div className={enter.cls(0.06)} style={enter.style(0.06)}>`
 */

import { useEffect, useState } from 'react';

type Phase = 'hidden' | 'playing' | 'done';

export interface EnterApi {
  /** class list for a phase-aware element */
  cls: (delay?: number) => string;
  /** inline delay custom property */
  style: (delay?: number) => React.CSSProperties | undefined;
  /** true while the entrance is still in flight (rarely needed) */
  playing: boolean;
}

function motionAllowed(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initialPhase(): Phase {
  return motionAllowed() ? 'hidden' : 'done';
}

export function useEnter(): EnterApi {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  useEffect(() => {
    if (phase !== 'hidden') return;
    if (!motionAllowed()) {
      setPhase('done');
      return;
    }
    // two frames: one to commit the hidden state, one to start the transition
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase('playing'));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [phase]);

  return {
    playing: phase !== 'done',
    cls: (delay = 0) =>
      phase === 'playing'
        ? delay > 0
          ? 'enter enter--delay'
          : 'enter'
        : phase === 'hidden'
          ? 'enter-hold'
          : '',
    style: (delay = 0) =>
      delay > 0 ? ({ '--enter-delay': `${delay}s` } as React.CSSProperties) : undefined,
  };
}
