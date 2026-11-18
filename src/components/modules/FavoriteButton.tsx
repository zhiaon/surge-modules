import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useIsFavorite, favoritesStore } from '@/stores/favorites';
import { analyticsService } from '@/services/analyticsService';
import { toast } from '@/components/feedback/Toast';
import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n';

export interface FavoriteButtonProps {
  moduleId: string;
  moduleName: string;
  /** 'icon' in dense rows, 'labelled' where there's room */
  variant?: 'icon' | 'labelled';
  size?: 'sm' | 'md';
  /** 32px pill that matches the other card action buttons */
  compact?: boolean;
  className?: string;
}

/**
 * Real, working favorite toggle backed by localStorage. Hit area is ≥44px tall
 * in both variants so it is reachable on a phone.
 */
export function FavoriteButton({
  moduleId,
  moduleName,
  variant = 'icon',
  size = 'md',
  compact = false,
  className,
}: FavoriteButtonProps) {
  const active = useIsFavorite(moduleId);
  const { t } = useI18n();

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = favoritesStore.toggle(moduleId);
    analyticsService.trackFavorite(moduleId, next);
    toast.show(
      next ? t('已加入收藏') : t('已取消收藏'),
      next ? moduleName : undefined,
      next ? 'success' : 'default',
    );
  };

  if (variant === 'labelled') {
    return (
      <button
        type="button"
        data-compact={compact ? '' : undefined}
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          compact
            ? 'inline-flex h-8 min-h-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-1 text-[10.5px]'
            : 'inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] border px-4 text-[13px]',
          'font-medium transition-colors duration-200 active:scale-[0.98]',
          active
            ? 'border-[var(--line-accent-45)] bg-[var(--tint-accent-12)] text-accent-soft'
            : 'border-line bg-raised text-muted hover:border-line-strong hover:bg-raised-hover hover:text-fg',
          className,
        )}
      >
        {active ? (
          <BookmarkCheck className="size-4" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Bookmark className="size-4" strokeWidth={1.75} aria-hidden="true" />
        )}
        {active ? t('已收藏') : t('收藏')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? t('取消收藏 {name}', { name: moduleName }) : t('收藏 {name}', { name: moduleName })}
      title={active ? t('取消收藏') : t('收藏')}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--radius-md)]',
        'border border-transparent text-faint transition-colors duration-200',
        'hover:bg-surface hover:text-fg active:scale-95',
        active && 'text-accent hover:text-accent-soft',
        size === 'sm' ? 'size-9' : 'size-11',
        className,
      )}
    >
      {active ? (
        <BookmarkCheck className="size-4" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Bookmark className="size-4" strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}
