import { cn } from '@/lib/cn';

export interface DividerProps {
  className?: string;
  /** fade the ends — the default, more editorial than a hard rule */
  fade?: boolean;
  vertical?: boolean;
}

export function Divider({ className, fade = true, vertical = false }: DividerProps) {
  if (vertical) {
    return (
      <span
        role="separator"
        aria-orientation="vertical"
        className={cn('inline-block w-px self-stretch bg-line', className)}
      />
    );
  }
  return (
    <hr
      className={cn(
        'h-px w-full border-0',
        fade
          ? 'bg-[linear-gradient(to_right,transparent,var(--color-line)_10%,var(--color-line)_90%,transparent)]'
          : 'bg-line',
        className,
      )}
    />
  );
}

/** Small labelled rule used to open a section in an editorial layout. */
export function LabeledRule({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="eyebrow shrink-0">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}
