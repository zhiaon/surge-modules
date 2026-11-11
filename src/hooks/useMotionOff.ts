import { useEffect, useState } from 'react';

/**
 * True when global motion is switched off.
 *
 * `motionPolicy.ts` sets `html[data-motion="off"]` when the document is hidden
 * (frozen compositor clock) or the user prefers reduced motion. Overlays must
 * honour it: an entrance animation started while the clock is frozen leaves the
 * panel stuck at its off-screen start position, which looks like a broken sheet.
 * Reading the flag lets them mount directly at the final position instead.
 */
export function useMotionOff(): boolean {
  const [off, setOff] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off',
  );

  useEffect(() => {
    const el = document.documentElement;
    const read = () => setOff(el.dataset.motion === 'off');
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ['data-motion'] });
    return () => observer.disconnect();
  }, []);

  return off;
}
