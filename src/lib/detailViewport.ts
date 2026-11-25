/** Visible CSS-pixel rectangle; never multiply by visualViewport.scale. */
export interface DetailViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportMetrics {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
}

/** Pure so zoom, dynamic bars and small landscape sizes can be regression-tested. */
export function detailViewport(
  layout: { width: number; height: number },
  visual?: ViewportMetrics | null,
): DetailViewport {
  const positive = (n: number, fallback: number) => Number.isFinite(n) && n > 0 ? n : fallback;
  return {
    left: Math.max(0, visual?.offsetLeft ?? 0),
    top: Math.max(0, visual?.offsetTop ?? 0),
    width: positive(visual?.width ?? layout.width, layout.width),
    height: positive(visual?.height ?? layout.height, layout.height),
  };
}

/** These paddings are INSIDE the visible rectangle, not an extra outer margin. */
export const detailViewportPadding = {
  paddingTop: 'max(12px, env(safe-area-inset-top, 0px))',
  paddingRight: 'max(12px, env(safe-area-inset-right, 0px))',
  paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
  paddingLeft: 'max(12px, env(safe-area-inset-left, 0px))',
} as const;
