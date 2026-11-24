/**
 * Entrance animation helper.
 *
 * The document may be hidden at mount (background tab, offscreen webview,
 * prerender). In that state the animation clock is frozen — and an animation
 * with `fill: both` would pin the element at `opacity: 0` forever, i.e. a blank
 * page. So: only animate when the document is actually visible; otherwise the
 * element simply renders in its final state.
 *
 * Revisits (returning from the bottom tab bar remounts the page) skip the
 * entrance entirely: replaying it would put the hero back at `opacity: 0` and,
 * if the webview pauses its clock, that state can outlive the visit. Only the
 * first page of a document load animates — see `lib/pageSession`.
 *
 * Usage: `const enter = useEnter();  <div className={enter.cls(0.06)} style={enter.style(0.06)}>`
 */

import { useEffect, useState } from 'react';
import { isFirstEntry, markPainted } from '@/lib/pageSession';

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
  if (typeof document === 'undefined') return 'done';
  if (!isFirstEntry()) return 'done';
  return motionAllowed() ? 'hidden' : 'done';
}

export function useEnter(): EnterApi {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  // Runs after the first page's whole tree has rendered, so every entrance on
  // that page still sees `isFirstEntry() === true`.
  useEffect(() => {
    markPainted();
  }, []);

  useEffect(() => {
    if (phase === 'done') return;
    // If the document goes hidden while the entrance is armed or in flight, the
    // clock stops and `fill: both` can leave the element transparent. Settle.
    const settle = () => {
      if (!motionAllowed()) setPhase('done');
    };
    document.addEventListener('visibilitychange', settle);

    let inner = 0;
    let outer = 0;
    if (phase === 'hidden') {
      if (!motionAllowed()) {
        setPhase('done');
      } else {
        // two frames: one to commit the hidden state, one to start the transition
        outer = requestAnimationFrame(() => {
          inner = requestAnimationFrame(() => setPhase('playing'));
        });
      }
    }

    return () => {
      document.removeEventListener('visibilitychange', settle);
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
