import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { resolveCategoryIcon } from '@/lib/icons';
import type { CategoryWithCount } from '@/services/categoryService';

export interface CategoryCardProps {
  category: CategoryWithCount;
  /** compact grid tile for desktop rails */
  variant?: 'tile' | 'rail';
  className?: string;
}

export function CategoryCard({ category, variant = 'tile', className }: CategoryCardProps) {
  const Icon = resolveCategoryIcon(category.icon);
  const to = `/discover?category=${encodeURIComponent(category.slug)}`;

  if (variant === 'rail') {
    return (
      <Link
        to={to}
        data-fx-card
        className={cn(
          'group flex w-[220px] shrink-0 flex-col justify-between gap-6 rounded-[var(--radius-lg)]',
          'border border-line bg-raised p-4 card-hover card-spotlight',
          className,
        )}
      >
        <span className="flex size-9 items-center justify-center rounded-[var(--radius-xs)] border border-line bg-surface text-muted transition-colors group-hover:text-accent">
          <Icon className="size-4" strokeWidth={1.6} aria-hidden="true" />
        </span>
        <span>
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-[13.5px] font-medium text-fg">{category.name}</span>
            <span className="font-mono text-[10.5px] tabular-nums text-faint">
              {String(category.moduleCount).padStart(2, '0')}
            </span>
          </span>
          <span className="mt-1.5 line-clamp-2 block text-[11.5px] leading-relaxed text-faint">
            {category.description}
          </span>
        </span>
      </Link>
    );
  }

  return (
    <Link
      to={to}
      data-fx-card
      className={cn(
        'group relative flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-raised p-5',
        'card-hover card-spotlight',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="flex size-10 items-center justify-center rounded-[var(--radius-sm)] border border-line bg-inset text-muted transition-colors duration-300 group-hover:border-[var(--line-accent-32)] group-hover:text-accent">
          <Icon className="size-[18px]" strokeWidth={1.7} aria-hidden="true" />
        </span>
        <span className="rounded-full border border-line bg-inset px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-faint">
          {category.moduleCount}
        </span>
      </div>
      <div>
        <h3 className="flex items-center gap-1.5 text-[14.5px] font-semibold leading-snug">
          {category.name}
          <ArrowUpRight
            className="size-3 text-faint opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            aria-hidden="true"
          />
        </h3>
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
          {category.description}
        </p>
      </div>
    </Link>
  );
}
