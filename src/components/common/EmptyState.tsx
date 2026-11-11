import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-line bg-raised/40 text-center',
        compact ? 'px-6 py-10' : 'px-6 py-14 sm:py-20',
        className,
      )}
    >
      <span
        className="mb-4 flex size-12 items-center justify-center rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight text-faint"
        aria-hidden="true"
      >
        <Icon className="size-4.5" strokeWidth={1.5} />
      </span>
      <p className="text-[15px] font-semibold">{title}</p>
      {description && (
        <p className="mt-2 max-w-sm text-pretty text-[13px] leading-relaxed text-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
