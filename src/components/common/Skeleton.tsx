import { cn } from '@/lib/cn';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  rounded?: 'sm' | 'md' | 'full';
}

export function Skeleton({ className, rounded = 'sm', ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={{ animation: 'skeleton-pulse 1.6s var(--ease-in-out-soft) infinite' }}
      className={cn(
        'bg-raised-hover',
        rounded === 'sm' && 'rounded-[var(--radius-xs)]',
        rounded === 'md' && 'rounded-[var(--radius-lg)]',
        rounded === 'full' && 'rounded-full',
        className,
      )}
      {...rest}
    />
  );
}

/** Placeholder matching ModuleCard's footprint — prevents layout shift. */
export function ModuleCardSkeleton() {
  return (
    <div className="rounded-[var(--radius-md)] border border-line bg-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="mb-2 h-4 w-2/3" />
      <Skeleton className="mb-1.5 h-3 w-full" />
      <Skeleton className="mb-5 h-3 w-4/5" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-14" rounded="md" />
      </div>
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="flex-1">
        <Skeleton className="mb-2 h-3.5 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="h-3 w-12" />
    </div>
  );
}
