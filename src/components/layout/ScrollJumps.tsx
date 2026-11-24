import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';

/**
 * Jump-to-top / jump-to-bottom controls.
 *
 * Pinned to the right edge, vertically centred — the one strip of a phone
 * screen that is never covered by the header, the tab bar or the footer, and
 * that stays in the same place while the page scrolls. Because the position is
 * a percentage of the viewport, it needs no knowledge of the bar's height or
 * of iOS Safari's address pill.
 *
 * Both buttons are hidden until there is something to scroll: a page that fits
 * the viewport shows nothing. The top button also disappears at the very top
 * and the bottom button at the very bottom, so a click always does something.
 * Scrolls are smooth, and fall back to an instant jump for readers who asked
 * for reduced motion.
 */

/** How far from the top the page must be before "back to top" appears. */
const SHOW_AFTER = 240;
/** Tolerance for sub-pixel scroll heights (zoom, fractional layout). */
const EDGE_SLACK = 4;

/**
 * Which buttons a given scroll position justifies. Pure so it can be tested
 * without a browser: `scrollHeight`/`innerHeight`/`scrollY` are the three
 * numbers the decision actually needs.
 */
export function jumpAvailability(
  scrollY: number,
  scrollHeight: number,
  innerHeight: number,
): { canUp: boolean; canDown: boolean } {
  const max = scrollHeight - innerHeight;
  return {
    canUp: scrollY > SHOW_AFTER,
    canDown: max > SHOW_AFTER && scrollY < max - EDGE_SLACK,
  };
}

function scrollToEdge(target: 'top' | 'bottom'): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = target === 'top' ? 0 : document.documentElement.scrollHeight;
  window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
}

export function ScrollJumps() {
  const { t } = useI18n();
  // The floating bar hides while typing; the buttons follow it so neither one
  // hovers over the keyboard.
  const keyboardOpen = useKeyboardOpen();
  const [state, setState] = useState({ canUp: false, canDown: false });

  const measure = useCallback(() => {
    const doc = document.documentElement;
    setState(jumpAvailability(window.scrollY, doc.scrollHeight, window.innerHeight));
  }, []);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      // Coalesce to one measurement per frame: scroll fires far more often than
      // the buttons need to change, and setState on every event would re-render
      // the layout tree during a fling.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    // Content grows after mount (list pages fetch), and images settle later, so
    // the page height is not a mount-time constant — watch the document itself.
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => measure());
    ro?.observe(document.body);

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [measure]);

  const visible = (state.canUp || state.canDown) && !keyboardOpen;

  return (
    // Two elements on purpose: the outer one owns the fixed, vertically
    // centred position (a percentage that must never animate), the inner one
    // owns the show/hide fade and its small lift. Collapsing them into one
    // would make `translate-y-2` fight `-translate-y-1/2` and the group would
    // jump by half its height every time it appeared.
    <div
      aria-hidden={!visible}
      className="pointer-events-none fixed right-3 top-1/2 z-40 -translate-y-1/2 md:right-6"
    >
      <div
        className={cn(
          'flex flex-col gap-2 transition-[opacity,transform] duration-200 ease-out',
          visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
      >
        <JumpButton
          label={t('回到顶部')}
          icon={<ArrowUpToLine className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />}
          shown={state.canUp && !keyboardOpen}
          onClick={() => scrollToEdge('top')}
        />
        <JumpButton
          label={t('跳到底部')}
          icon={<ArrowDownToLine className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />}
          shown={state.canDown && !keyboardOpen}
          onClick={() => scrollToEdge('bottom')}
        />
      </div>
    </div>
  );
}

function JumpButton({
  label,
  icon,
  shown,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  shown: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      tabIndex={shown ? 0 : -1}
      className={cn(
        'flex size-10 items-center justify-center rounded-full',
        'border border-[var(--line-soft)] bg-[var(--glass-bg)] text-muted',
        'backdrop-blur-[20px] backdrop-saturate-150',
        'shadow-[0_1px_0_0_var(--glass-highlight)_inset,0_4px_16px_-6px_rgba(0,0,0,0.18)]',
        'transition-[opacity,transform,color] duration-200 ease-out',
        'hover:text-fg active:scale-95',
        shown ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {icon}
    </button>
  );
}
