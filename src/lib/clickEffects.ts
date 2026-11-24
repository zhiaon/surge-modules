/**
 * Global click feedback.
 *
 * One delegated listener for the whole site. It never calls preventDefault,
 * never stops propagation, and never touches the element it decorates — the
 * animation lives in a separate fixed-position layer clipped to that element's
 * box. Original handlers, navigation, form submits and clipboard calls are all
 * untouched by construction, not by careful ordering.
 *
 * Why a separate layer rather than a pseudo-element on the target:
 *   - `overflow: hidden` on a card does not clip a fixed-position child, so the
 *     light can never bleed outside the element's rounded corners
 *   - no z-index, isolation or stacking-context change is imposed on the target,
 *     which matters because the module cards use a stretched-link `::after`
 *   - nothing is added to the DOM the app owns, so React re-renders cannot
 *     fight with it
 *
 * The layer is created on the pointerdown that actually hits an interactive
 * element, and removed when its animations finish (with a timeout backstop so a
 * dropped animationend can never leak a node).
 */

type FxKind =
  | 'ripple'
  | 'glow'
  | 'sheen'
  | 'press'
  | 'halo'
  | 'hop'
  | 'wave';

interface Palette {
  /** matches the three spotlight colours so feedback feels like the same system */
  colors: string[];
}

const PALETTE: Record<'dark' | 'light', Palette> = {
  dark: {
    colors: [
      'rgb(96 165 250)', // blue-400
      'rgb(167 139 250)', // violet-400
      'rgb(34 211 238)', // cyan-400
    ],
  },
  light: {
    colors: ['rgb(59 130 246)', 'rgb(139 92 246)', 'rgb(6 182 212)'],
  },
};

/** Everything the brief lists as interactive, plus the ARIA roles that stand in
 *  for real controls. `[data-fx]` is the escape hatch for a custom element. */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'label[for]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  'input[type="button"]',
  'select',
  '[data-fx]',
  /* cards that behave as links: a <li>/<article> wrapping a stretched <a>
     is handled by the <a> itself, but a card with a click handler is not */
  '[data-fx-card]',
].join(',');

/**
 * Only two things suppress feedback:
 *
 *   1. The user asked for reduced motion (a preference, not a transient state).
 *   2. The document is not currently visible (a background tab / prerender).
 *
 * `data-motion="off"` is deliberately NOT used here. That flag is set when the
 * document was hidden at mount, and it is the signal that stops *entrance*
 * animations from pinning elements invisible. A click happens while the page is
 * visible, so gating on it would silence feedback forever after any tab switch.
 * Checking visibility at click time is the correct, live test.
 */
const motionSuppressed = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.visibilityState !== 'visible');

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

/** Reads the current theme so the effect colour matches the surface. */
function palette(): string[] {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return PALETTE[theme].colors;
}

/**
 * Chooses which effects to play, weighted by element type.
 *
 * Element-specific feedback wins (the brief calls this out): an icon button hops
 * before it ripples, a card prefers a border flash over a ripple that would be
 * mostly hidden under its own content. Generic buttons get the full random set.
 */
function chooseEffects(el: Element): FxKind[] {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const isCard = el.hasAttribute('data-fx-card');
  const isIconButton =
    (tag === 'button' || role === 'button') &&
    !el.textContent?.trim() &&
    Boolean(el.querySelector('svg'));

  if (isCard) {
    // Cards: wide, soft feedback. Never `press` — the card already lifts on
    // hover and a scale would fight the stretched link's hit area.
    return pickPlan(el, [['glow'], ['sheen'], ['wave']]);
  }

  if (isIconButton) {
    return pickPlan(el, [['hop'], ['hop', 'ripple'], ['press', 'halo'], ['sheen', 'hop']]);
  }

  const isNav = el.closest('nav') !== null;
  if (isNav) {
    return pickPlan(el, [['sheen'], ['ripple']]);
  }

  const isField =
    tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'label';
  if (isField) {
    // Fields: no ripple over the text, just a quiet edge acknowledgement.
    return pickPlan(el, [['glow']]);
  }

  return pickPlan(el, [
    ['ripple'],
    ['ripple', 'press'],
    ['glow'],
    ['sheen'],
    ['halo'],
    ['ripple', 'halo'],
    ['wave'],
  ]);
}

/**
 * Plans are written as `FxKind[]` and indexed directly: no string keys, no
 * parsing back. The previous index is remembered per element so clicking the
 * same button twice does not replay the identical animation.
 */
const lastPlan = new WeakMap<Element, number>();

function pickPlan(el: Element, plans: FxKind[][]): FxKind[] {
  if (plans.length === 1) return plans[0];
  const prev = lastPlan.get(el) ?? -1;
  let index = Math.floor(Math.random() * plans.length);
  if (index === prev) index = (index + 1 + Math.floor(Math.random() * (plans.length - 1))) % plans.length;
  lastPlan.set(el, index);
  return plans[index];
}

/** Neighbours already animating are skipped, so a fast clicker cannot spawn a
 *  pile of layers on the same element. */
const busy = new WeakSet<Element>();

const LAYER_TTL = 1200;

function spawnLayer(el: HTMLElement, clientX: number, clientY: number): HTMLDivElement | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${rect.left}px`;
  layer.style.top = `${rect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;

  // Match the element's corner radius so the glow is clipped to its real shape.
  // A floor of 10px keeps square elements (bottom-tab items are 0px) from
  // flashing a hard-edged rectangle — the light should never have corners.
  const radius = getComputedStyle(el).borderRadius;
  const numeric = Number.parseFloat(radius) || 0;
  layer.style.borderRadius = numeric >= 10 ? radius : '10px';

  // Click offset inside the element, clamped so a click on the border still
  // produces a sensible origin.
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  layer.style.setProperty('--fx-x', `${x}px`);
  layer.style.setProperty('--fx-y', `${y}px`);

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), LAYER_TTL);
  return layer;
}

function addPiece(
  layer: HTMLElement,
  kind: FxKind,
  x: number,
  y: number,
  color: string,
): number {
  const piece = document.createElement('span');
  piece.className = `fx-piece fx-${kind}`;
  piece.style.left = `${x}px`;
  piece.style.top = `${y}px`;
  piece.style.setProperty('--fx-color', color);

  const rect = layer.getBoundingClientRect();
  // Big enough to reach the far corner from the click point, so the ring is
  // visibly complete on small buttons and cards alike.
  const reach = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
  const size = Math.round(Math.min(Math.max(reach * 2, 64), 620));

  piece.style.setProperty('--fx-size', `${size}px`);
  piece.style.setProperty('--fx-dur', `${320 + Math.round(Math.random() * 180)}ms`);
  piece.style.setProperty('--fx-dir', Math.random() > 0.5 ? '1' : '-1');
  piece.style.setProperty('--fx-angle', `${Math.round(Math.random() * 360)}deg`);

  // Directional effects (sheen/wave) sweep across the element's centre line
  // rather than radiating from the click point — their CSS positions them via
  // top/left percentages of the layer, so no inline override is needed here.

  layer.appendChild(piece);
  return 340 + 260; // roughly the longest duration above
}

/** Plays the element's own press animation without touching its layout. */
function animateElement(el: HTMLElement, kind: 'press' | 'hop'): void {
  // Icon hop targets the svg so the box stays put; press targets the element.
  const target =
    kind === 'hop' ? ((el.querySelector('svg') as SVGElement | null) ?? el) : el;
  const cls = kind === 'hop' ? 'fx-hop' : 'fx-press';
  target.classList.remove(cls);
  // force a reflow so re-adding restarts the animation on rapid clicks
  void (target as HTMLElement).offsetWidth;
  target.classList.add(cls);
  window.setTimeout(() => target.classList.remove(cls), 420);
}

let installed = false;

/**
 * Installs the global listener. Idempotent — React StrictMode mounts effects
 * twice in development and a hot reload can re-run this.
 */
export function installClickEffects(): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const onPointerDown = (event: PointerEvent) => {
    // Only primary button; a right-click or a scroll gesture must stay silent.
    if (event.button !== 0) return;
    if (motionSuppressed()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const el = target.closest(INTERACTIVE_SELECTOR);
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-own-tap-feedback')) return;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
    if (busy.has(el)) return;

    const plan = chooseEffects(el);
    // Nothing to draw for a press-only plan on a tiny element with no room.
    const wantsLayer = plan.some((k) => k !== 'press' && k !== 'hop');

    busy.add(el);
    window.setTimeout(() => busy.delete(el), 260);

    const colors = palette();
    const color = pick(colors);

    if (wantsLayer) {
      const layer = spawnLayer(el, event.clientX, event.clientY);
      if (layer) {
        const rect = layer.getBoundingClientRect();
        const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
        const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
        for (const kind of plan) {
          if (kind === 'press' || kind === 'hop') {
            animateElement(el, kind);
            continue;
          }
          addPiece(layer, kind, x, y, color);
        }
      }
    } else {
      for (const kind of plan) {
        if (kind === 'press' || kind === 'hop') animateElement(el, kind);
      }
    }
  };

  // `pointerdown` (not click) so the feedback starts with the touch, not after
  // the browser has finished dispatching click through to React.
  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    installed = false;
  };
}
