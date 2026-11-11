import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

type Size = 'sm' | 'md';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** required — icon-only controls need an accessible name */
  label: string;
  size?: Size;
  active?: boolean;
  tone?: 'default' | 'accent';
}

/**
 * Icon-only control. The visual box is 36/44px while hit area stays ≥44px
 * on touch devices via the pseudo-element expansion below.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', active = false, tone = 'default', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={rest['aria-pressed'] ?? undefined}
      data-active={active || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
        'border border-transparent text-muted transition-colors duration-200',
        'hover:bg-raised hover:text-fg active:scale-95',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2',
        'before:-translate-y-1/2 before:content-[""]',
        size === 'sm' ? 'size-8' : 'size-11',
        active && 'text-fg',
        tone === 'accent' && 'text-accent hover:text-accent-soft',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
