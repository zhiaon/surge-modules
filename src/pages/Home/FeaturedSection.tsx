import { Reveal } from '@/components/motion/Reveal';
import { Container } from '@/components/common/Container';
import { SectionHeading } from '@/components/common/SectionHeading';
import { ModuleCard } from '@/components/modules/ModuleCard';
import { ModuleCardSkeleton } from '@/components/common/Skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { ButtonLink } from '@/components/common/Button';
import { ErrorState } from '@/components/feedback/ErrorState';
import type { ModuleWithMeta } from '@/types';

export interface FeaturedSectionProps {
  modules: ModuleWithMeta[] | undefined;
  loading?: boolean;
  error?: Error;
  onRetry?: () => void;
}

/**
 * Featured modules.
 *
 * The grid adapts to how much content actually exists: one item gets the full
 * row, two split it, three or more use an asymmetric 6-column layout where the
 * first card is wider. This keeps the section from looking like a broken grid
 * while the catalogue is still small.
 */
export function FeaturedSection({ modules, loading, error, onRetry }: FeaturedSectionProps) {
  const count = modules?.length ?? 0;

  return (
    <section className="border-y border-line bg-surface/40 py-12 sm:py-14 lg:py-16">
      <Container size="wide">
        <Reveal>
          <SectionHeading
            eyebrow="精选"
            index="02"
            title="本期推荐"
            description="由维护者手动标记的模块，按最近更新时间排序。"
            action={{ label: '全部模块', to: '/discover' }}
          />
        </Reveal>

        <div className="mt-7 lg:mt-9">
          {error ? (
            <ErrorState
              title="精选模块加载失败"
              error={error}
              onRetry={onRetry}
              compact
            />
          ) : loading || !modules ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <ModuleCardSkeleton key={i} />
              ))}
            </div>
          ) : count === 0 ? (
            <EmptyState
              title="暂无精选模块"
              description="精选由维护者标记，标记后会自动出现在这里。"
              action={
                <ButtonLink to="/discover" size="sm">
                  浏览全部模块
                </ButtonLink>
              }
            />
          ) : (
            <div
              className={
                count === 1
                  ? 'grid grid-cols-1 items-start gap-3'
                  : count === 2
                    ? 'grid grid-cols-1 items-start gap-3 sm:grid-cols-2'
                    : 'grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-6'
              }
            >
              {modules.map((m, i) => {
                const span =
                  count >= 3 ? (i === 0 ? 'sm:col-span-2 lg:col-span-6' : 'lg:col-span-3') : '';
                return (
                  <Reveal key={m.id} delay={Math.min(i, 5) * 0.04} className={span}>
                    <ModuleCard module={m} variant={i === 0 && count >= 2 ? 'featured' : 'default'} />
                  </Reveal>
                );
              })}
            </div>
          )}
        </div>
      </Container>
    </section>
  );
}
