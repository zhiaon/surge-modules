import { BookmarkX } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { EmptyState } from '@/components/common/EmptyState';
import { ButtonLink } from '@/components/common/Button';
import { ModuleCard } from '@/components/modules/ModuleCard';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/common/Skeleton';
import { useAsync } from '@/hooks/useAsync';
import { favoriteService } from '@/services/favoriteService';
import { useFavorites } from '@/stores/favorites';
import { usePageMeta } from '@/hooks/usePageMeta';
import { formatRelative, toIsoDate } from '@/lib/format';
import { useI18n } from '@/i18n';

export function FavoritesPage() {
  const { t } = useI18n();
  usePageMeta({
    title: t('我的收藏'),
    description: t('保存在本机的 Surge 模块收藏。'),
    path: '/favorites',
  });

  // subscribe so removing a favorite on this page updates immediately
  const records = useFavorites();
  const { data, status, error, reload } = useAsync(
    () => favoriteService.getFavorites(),
    [records.length],
  );

  return (
    <Container size="wide" className="py-8 sm:py-12">
      <header className="max-w-2xl">
        <span className="eyebrow">{t('收藏')}</span>
        <h1 className="mt-2.5 text-balance text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.028em] sm:text-[2.4rem]">
          {t('我的收藏')}
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          {t('收藏保存在这台设备的浏览器中，刷新或重新打开都不会丢失。')}
        </p>
      </header>

      <div className="mt-7">
        {status === 'error' ? (
          <ErrorState title={t('收藏加载失败')} error={error} onRetry={reload} />
        ) : status === 'loading' && !data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight p-5"
              >
                <Skeleton className="mb-3 h-8 w-8" rounded="md" />
                <Skeleton className="mb-2 h-4 w-2/3" />
                <Skeleton className="mb-1.5 h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={BookmarkX}
            title={t('还没有收藏任何模块')}
            description={t('在模块卡片或详情页点击收藏，之后可以在这里集中查看。收藏只保存在本机，不会上传。')}
            action={
              <ButtonLink to="/discover" size="md" variant="primary">
                {t('去发现模块')}
              </ButtonLink>
            }
          />
        ) : (
          <>
            <p className="mb-4 flex items-baseline gap-2 text-[12px] text-faint">
              <span className="font-mono text-[13px] tabular-nums text-fg">{data.length}</span>
              {t('{n} 个收藏 · 按添加时间倒序', { n: data.length })}
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.map((entry) => (
                <li key={entry.module.id} className="flex min-w-0 flex-col gap-1.5">
                  <ModuleCard module={entry.module} />
                  <p className="pl-1 text-[10.5px] text-faint">
                    {t('收藏于')}{' '}
                    <time dateTime={toIsoDate(entry.addedAt)}>
                      {formatRelative(entry.addedAt)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <p className="mt-10 border-t border-line pt-5 text-[11px] leading-relaxed text-faint">
        {t('账号体系与云端同步尚未实现；当前收藏不会跨设备同步，清除站点数据会一并清空。')}
      </p>
    </Container>
  );
}
