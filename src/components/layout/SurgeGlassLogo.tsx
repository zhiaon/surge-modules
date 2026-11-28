import { useId } from 'react';

/** Official five-pill Surge mark, redrawn as a compact translucent glass SVG. */
export function SurgeGlassLogo({ className }: { className?: string }) {
  const gradientId = `surge-glass-${useId().replace(/:/g, '')}`;
  const edgeId = `${gradientId}-edge`;

  return (
    <svg
      viewBox="0 0 256 256"
      className={className ?? 'size-7'}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#3995f2" stopOpacity="0.86" />
          <stop offset="36%" stopColor="#43c9f4" stopOpacity="0.78" />
          <stop offset="70%" stopColor="#8271f5" stopOpacity="0.82" />
          <stop offset="100%" stopColor="#cc69ec" stopOpacity="0.82" />
        </linearGradient>
        <linearGradient id={edgeId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="48%" stopColor="#fff" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.76" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradientId})`} stroke={`url(#${edgeId})`} strokeWidth="1.5">
        <rect x="9" y="150" width="30" height="60" rx="15" />
        <rect x="61" y="106" width="30" height="141" rx="15" />
        <rect x="113" y="31" width="30" height="194" rx="15" />
        <rect x="165" y="9" width="30" height="142" rx="15" />
        <rect x="217" y="46" width="30" height="60" rx="15" />
      </g>
      <g fill="#fff" fillOpacity="0.31">
        <rect x="13" y="158" width="3" height="44" rx="1.5" />
        <rect x="65" y="114" width="3" height="125" rx="1.5" />
        <rect x="117" y="39" width="3" height="178" rx="1.5" />
        <rect x="169" y="17" width="3" height="126" rx="1.5" />
        <rect x="221" y="54" width="3" height="44" rx="1.5" />
      </g>
    </svg>
  );
}
