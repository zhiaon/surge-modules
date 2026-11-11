/**
 * Global motion arbitration.
 *
 * Sets `html[data-motion="off"]` whenever the doc is hidden or the user asked
 * for reduced motion. CSS then collapses every entrance/reveal to its final
 * state with no transition — which is the only way to guarantee that content
 * is never stuck at `opacity: 0` when the compositor clock is paused.
 */

const apply = (): void => {
  if (typeof document === 'undefined') return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const off = document.visibilityState === 'hidden' || reduce.matches;
  document.documentElement.dataset.motion = off ? 'off' : 'on';
};

export function initMotionPolicy(): void {
  apply();

  document.addEventListener('visibilitychange', apply);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onReduceChange = () => apply();
  if (typeof reduce.addEventListener === 'function') {
    reduce.addEventListener('change', onReduceChange);
  } else {
    reduce.addListener(onReduceChange);
  }
}
