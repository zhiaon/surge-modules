import { cn } from '@/lib/cn';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

export interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: { label: string; to: string };
  align?: 'left' | 'center';
  className?: string;
  /** big editorial number, e.g. "01" */
  index?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  align = 'left',
  className,
  index,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between',
        align === 'center' && 'sm:flex-col sm:items-center sm:text-center',
        className,
      )}
    >
      <div className={cn('max-w-2xl', align === 'center' && 'mx-auto')}>
        {eyebrow && (
          <div className={cn('mb-2.5 flex items-center gap-2', align === 'center' && 'justify-center')}>
            <span className="eyebrow">{eyebrow}</span>
            {index && (
              <span className="font-mono text-[10.5px] tabular-nums text-faint/70">{index}</span>
            )}
          </div>
        )}
        <h2 className="text-balance text-[1.5rem] font-semibold leading-[1.14] tracking-[-0.02em] sm:text-[1.9rem]">
          {title}
        </h2>
        {description && (
          <p className="mt-2.5 max-w-xl text-pretty text-[13.5px] leading-relaxed text-muted sm:text-[14.5px]">
            {description}
          </p>
        )}
      </div>
      {action && (
        <Link
          to={action.to}
          className="tap-target group inline-flex shrink-0 items-center gap-1.5 self-start text-[13px] text-muted transition-colors hover:text-fg sm:self-auto"
        >
          <span className="border-b border-transparent pb-0.5 transition-colors group-hover:border-line-strong">
            {action.label}
          </span>
          <ArrowUpRight
            className="size-3.5 transition-transform duration-300 ease-[var(--ease-out-soft)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      )}
    </div>
  );
}
