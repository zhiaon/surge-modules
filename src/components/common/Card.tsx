import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** subtle background, no border — used for stacked rows */
  variant?: 'default' | 'flat' | 'inset';
  interactive?: boolean;
  /** disables clipping when the child needs to overflow, e.g. dropdowns */
  clip?: boolean;
  /** soft light from the top edge; on by default for solid surfaces */
  spotlight?: boolean;
}

/**
 * Base surface. 16px radius per the component scale (cards 16–20px), 1px
 * hairline border, and the shared .card-hover lift when interactive.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    variant = 'default',
    interactive = false,
    clip = true,
    spotlight,
    className,
    children,
    ...rest
  },
  ref,
) {
  // A flat card has no border to catch light and an inset well is already
  // darker than its surroundings, so only the default surface gets the glow.
  const lit = spotlight ?? variant === 'default';
  return (
    <div
      ref={ref}
      className={cn(
        'relative',
        clip && 'overflow-hidden',
        'rounded-[var(--radius-lg)]',
        variant === 'default' && 'border border-line bg-raised',
        variant === 'flat' && 'border border-transparent bg-surface',
        variant === 'inset' && 'border border-line bg-inset',
        interactive && 'card-hover',
        lit && 'card-spotlight',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
