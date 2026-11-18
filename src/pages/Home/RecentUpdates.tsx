import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Container } from '@/components/common/Container';
import { SectionHeading } from '@/components/common/SectionHeading';
import { RowSkeleton } from '@/components/common/Skeleton';
import { VersionBadge } from '@/components/common/Badge';
import { formatDate, formatRelative, toIsoDate } from '@/lib/format';
import { ErrorState } from '@/components/feedback/ErrorState';
import type { ModuleWithMeta } from '@/types';
import { useI18n } from '@/i18n';

export interface RecentUpdatesProps {
  modules: ModuleWithMeta[] | undefined;
  loading?: boolean;
  error?: Error;
  onRetry?: () => void;
}

/**
 * Recent updates as a typographic table, not cards: name / version / changelog /
 * date. Reads like a changelog page, which is what it is.
 */
export function RecentUpdates({ modules, loading, error, onRetry }: RecentUpdatesProps) {
  const { t } = useI18n();
  return (
    <section className="py-12 sm:py-14 lg:py-16">
      <Container size="wide">
        <Reveal>
          <SectionHeading
            eyebrow={t('更新')}
            index="03"
            title={t('最近更新')}
            description={t('按发布倒序排列的模块版本记录。')}
            action={{ label: t('查看全部更新'), to: '/updates' }}
          />
        </Reveal>

        <div className="mt-7 lg:mt-9">
          {error ? (
            <ErrorState title={t('更新记录加载失败')} error={error} onRetry={onRetry} compact />
          ) : loading || !modules ? (
            <div className="divide-y divide-line">
              {Array.from({ length: 5 }).map((_, i) => (
                <RowSkeleton key={i} />
              ))}
            </div>
          ) : modules.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-line px-5 py-10 text-center text-[12.5px] text-faint">
              {t('暂无版本记录。模块导入并同步后，更新会按时间倒序出现在这里。')}
            </p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {modules.map((m, i) => (
                <Reveal as="li" key={m.id} delay={Math.min(i, 5) * 0.03}>
                  <Link
                    to={`/modules/${m.slug}`}
                    className="group grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1.5 py-4
                               transition-colors duration-200 hover:bg-raised/40 sm:grid-cols-[220px_minmax(0,1fr)_auto]
                               sm:gap-x-6 sm:px-2"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-[13.5px] font-medium text-fg">{m.name}</span>
                      <VersionBadge version={m.version} />
                    </span>

                    <span className="col-span-2 min-w-0 truncate text-[12px] text-faint sm:col-span-1 sm:text-[12.5px]">
                      {m.latestVersion?.changelog ?? m.description}
                    </span>

                    <span className="col-start-2 row-start-1 flex shrink-0 items-center gap-2 text-[11px] text-faint sm:col-start-3">
                      <time dateTime={toIsoDate(m.updatedAt)} title={formatDate(m.updatedAt)}>
                        {formatRelative(m.updatedAt)}
                      </time>
                      <ArrowRight
                        className="size-3 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </span>
                  </Link>
                </Reveal>
              ))}
            </ul>
          )}
        </div>
      </Container>
    </section>
  );
}
