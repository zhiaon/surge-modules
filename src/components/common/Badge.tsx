import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'accent' | 'outline' | 'success' | 'warn' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-raised text-muted border border-line',
  accent:
    'bg-[var(--tint-accent-12)] text-accent-soft border border-[var(--line-accent-28)]',
  outline: 'bg-transparent text-faint border border-line',
  success: 'bg-[var(--tint-ok-14)] text-ok border border-[var(--line-ok-26)]',
  warn: 'bg-[var(--tint-warn-08)] text-warn border border-[var(--line-accent-28)]',
  danger: 'bg-[var(--tint-danger-08)] text-danger border border-[var(--line-danger-28)]',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: 'xs' | 'sm';
  mono?: boolean;
}

export function Badge({
  tone = 'neutral',
  size = 'xs',
  mono = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--radius-xs)] leading-none',
        size === 'xs' ? 'px-2 py-1 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]',
        mono && 'font-mono tracking-tight',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** Version pill: monospace, tabular, quiet. */
export function VersionBadge({ version, className }: { version: string; className?: string }) {
  return (
    <Badge mono tone="outline" className={cn('tabular-nums', className)}>
      v{version}
    </Badge>
  );
}
