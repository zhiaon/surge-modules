import { useEffect } from 'react';

/**
 * Locks page scroll while an overlay is open, without the iOS jump-to-top
 * bug (position:fixed + restore scroll position).
 */
let locks = 0;
let savedY = 0;
let savedStyles: Record<string, string> = {};

export function useLockBodyScroll(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const body = document.body;
    if (locks === 0) {
      savedY = window.scrollY;
      savedStyles = {
        overflow: body.style.overflow,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        paddingRight: body.style.paddingRight,
      };
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      body.style.overflow = 'hidden';
      body.style.position = 'fixed';
      body.style.top = `-${savedY}px`;
      body.style.width = '100%';
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0) {
        body.style.overflow = savedStyles.overflow ?? '';
        body.style.position = savedStyles.position ?? '';
        body.style.top = savedStyles.top ?? '';
        body.style.width = savedStyles.width ?? '';
        body.style.paddingRight = savedStyles.paddingRight ?? '';
        window.scrollTo(0, savedY);
      }
    };
  }, [locked]);
}
