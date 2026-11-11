import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium ' +
  'transition-[background-color,border-color,color,transform,box-shadow,opacity] duration-200 ' +
  'ease-[var(--ease-out-soft)] active:scale-[0.97] disabled:pointer-events-none ' +
  'disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-accent';

/* Every variant is a real surface + border pair, so a button never floats on
   the page with no edge — that is what made the old ghost buttons disappear. */
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-[var(--color-accent-fg)] border border-[var(--line-accent-45)] ' +
    'hover:bg-accent-strong hover:border-[var(--line-accent-62)] ' +
    'shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset,0_8px_24px_-12px_rgba(139,156,255,0.7)]',
  secondary:
    'bg-raised text-fg border border-line hover:border-line-strong hover:bg-raised-hover',
  outline:
    'bg-transparent text-fg border border-line-strong hover:bg-raised hover:border-fg/30',
  ghost:
    'bg-transparent text-muted border border-transparent hover:text-fg hover:bg-raised',
  danger:
    'bg-[var(--tint-danger-08)] text-danger border border-[var(--line-danger-35)] ' +
    'hover:bg-[var(--tint-danger-28)]',
};

const SIZES: Record<Size, string> = {
  /* touch floor: sm is 44px tall on a phone (see .btn-sm in index.css), 38px
     on a mouse. md/lg are already ≥44. */
  sm: 'btn-sm h-10 px-3.5 text-[13px] rounded-[var(--radius-sm)]',
  md: 'h-11 px-5 text-[14px] rounded-[var(--radius-md)]',
  lg: 'h-12 px-6 text-[15px] rounded-[var(--radius-md)]',
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children?: React.ReactNode;
  fullWidth?: boolean;
  /** leading icon slot, vertically centred with the label */
  icon?: React.ReactNode;
}

export interface ButtonProps
  extends CommonProps,
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, fullWidth, icon, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends CommonProps {
  to: string;
  state?: unknown;
  'aria-label'?: string;
}

/** Router-aware link styled as a button. External URLs use ExternalButtonLink. */
export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  className,
  fullWidth,
  icon,
  children,
  state,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      to={to}
      state={state}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {icon}
      {children}
    </Link>
  );
}

export interface ExternalButtonLinkProps
  extends CommonProps,
    Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'> {
  href: string;
}

export function ExternalButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  className,
  fullWidth,
  icon,
  children,
  ...rest
}: ExternalButtonLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {icon}
      {children}
    </a>
  );
}
