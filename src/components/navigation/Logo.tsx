import { cn } from '@/lib/cn';

/**
 * Wordmark: a stack of horizontal rules (rules / modules) inside a bracket.
 * Drawn, not bitmap, so it stays crisp and inherits currentColor.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('text-fg', className)}
      fill="none"
      aria-hidden="true"
      role="img"
    >
      <rect
        x="1.25"
        y="1.25"
        width="21.5"
        height="21.5"
        rx="5"
        stroke="currentColor"
        strokeOpacity="0.28"
        strokeWidth="1.5"
      />
      <path d="M6.5 8.25h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M6.5 12h7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />
      <path
        d="M6.5 15.75h4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.5"
      />
      <circle cx="17.4" cy="15.75" r="1.35" fill="currentColor" />
    </svg>
  );
}
