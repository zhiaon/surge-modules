import { useEffect, useState } from 'react';

/**
 * Is the software keyboard covering the bottom of the page?
 *
 * iOS Safari (and Android Chrome) shrink the *visual* viewport for the keyboard
 * while leaving the *layout* viewport — which is what `position: fixed` is
 * measured against — untouched. Measuring `visualViewport` is the only reliable
 * signal, and it is what both the floating tab bar and the scroll buttons need:
 * neither should hover over the keyboard.
 *
 * The 120px threshold ignores the small shrink caused by the collapsing
 * address bar, which is not a keyboard.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const update = () => {
      const covered = Math.max(0, document.documentElement.clientHeight - (vv.height + vv.offsetTop));
      setOpen(covered > 120);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return open;
}
