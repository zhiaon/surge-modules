import { AlertTriangle, RotateCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/common/Button';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  error?: Error;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

/**
 * Failure state for any async resource.
 *
 * `useAsync` already distinguishes `status: 'error'`; without this component a
 * failed fetch would render an empty region with no explanation — which reads
 * as "there is nothing here" rather than "something broke". The raw message is
 * shown in a secondary line (never as HTML), because a stack trace in the UI is
 * noise for users and a leak surface for internals.
 */
export function ErrorState({
  title = '加载失败',
  description = '数据没有加载成功。可以重试一次；如果仍然失败，稍后再回来看看。',
  error,
  onRetry,
  className,
  compact = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed',
        'border-[var(--line-danger-38)] bg-[var(--tint-danger-08)] text-center',
        compact ? 'px-6 py-10' : 'px-6 py-16',
        className,
      )}
    >
      <span
        className="mb-4 flex size-11 items-center justify-center rounded-full border border-[var(--line-danger-28)] text-danger"
        aria-hidden="true"
      >
        <AlertTriangle className="size-4.5" strokeWidth={1.5} />
      </span>
      <p className="text-[15px] font-medium">{title}</p>
      <p className="mt-2 max-w-sm text-pretty text-[13px] leading-relaxed text-faint">
        {description}
      </p>
      {error?.message && (
        <p className="mt-3 max-w-sm break-words font-mono text-[10.5px] leading-relaxed text-faint/70">
          {error.message}
        </p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-6">
          <RotateCw className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          重试
        </Button>
      )}
    </div>
  );
}
