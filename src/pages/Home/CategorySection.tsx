import { Link } from 'react-router-dom';
import { Reveal } from '@/components/motion/Reveal';
import { Container } from '@/components/common/Container';
import { SectionHeading } from '@/components/common/SectionHeading';
import { CategoryCard } from '@/components/modules/CategoryCard';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useI18n } from '@/i18n';
import type { CategoryWithCount } from '@/services/categoryService';

export interface CategorySectionProps {
  categories: CategoryWithCount[] | undefined;
  loading?: boolean;
  error?: Error;
  onRetry?: () => void;
}

/**
 * Categories. Desktop: a 3-across grid inside the container.
 * Mobile: a full-bleed horizontal rail whose first card still lines up with
 * the container padding, so the rail reads as part of the grid rather than a
 * stray carousel.
 */
export function CategorySection({ categories, loading, error, onRetry }: CategorySectionProps) {
  const { t } = useI18n();
  return (
    <section id="categories" className="scroll-mt-24 pb-10 pt-12 sm:pb-12 sm:pt-14 lg:pb-16 lg:pt-16">
      <Container size="wide">
        <Reveal>
          <SectionHeading
            eyebrow={t('分类')}
            index="01"
            title={t('按用途浏览')}
            description={t('从拦截规则到脚本增强，按实际用途归类的模块目录。')}
            action={{ label: t('参与筛选'), to: '/discover#categories' }}
          />
        </Reveal>
      </Container>

      <div className="mt-7 lg:mt-9">
        {error ? (
          <Container size="wide">
            <ErrorState title={t('分类加载失败')} error={error} onRetry={onRetry} compact />
          </Container>
        ) : loading || !categories ? (
          <Container size="wide">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[104px] animate-pulse rounded-[var(--radius-md)] bg-raised"
                />
              ))}
            </div>
          </Container>
        ) : (
          <>
            {/* mobile / tablet: edge-to-edge scroll rail.
                The track must be exactly the viewport width: no negative margin
                (which would widen it past the viewport and be clipped), just
                padding that lines the first card up with the container. */}
            <div className="no-scrollbar w-full overflow-x-auto pb-2 lg:hidden">
              <ul className="flex w-max gap-3 px-5 sm:px-7">
                {categories.map((c) => (
                  <li key={c.id} className="shrink-0">
                    <CategoryCard category={c} variant="rail" />
                  </li>
                ))}
              </ul>
            </div>

            {/* desktop: grid */}
            <Container size="wide" className="hidden lg:block">
              <div className="grid grid-cols-3 gap-3">
                {categories.map((c, i) => (
                  <Reveal key={c.id} delay={Math.min(i, 4) * 0.05}>
                    <CategoryCard category={c} />
                  </Reveal>
                ))}
              </div>
            </Container>
          </>
        )}
      </div>

      <Container size="wide">
        <p className="mt-5 text-[11px] leading-relaxed text-faint lg:mt-6">
          {t('数据随构建更新。')}
          <Link to="/discover" className="tap-target ml-2 text-muted underline-offset-4 hover:underline">
            {t('查看全部模块')}
          </Link>
        </p>
      </Container>
    </section>
  );
}
