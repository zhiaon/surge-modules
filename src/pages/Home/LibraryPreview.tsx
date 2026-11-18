import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Container } from '@/components/common/Container';
import { SectionHeading } from '@/components/common/SectionHeading';
import { ModuleCard } from '@/components/modules/ModuleCard';
import { ModuleCardSkeleton } from '@/components/common/Skeleton';
import { ButtonLink } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import type { ModuleWithMeta } from '@/types';
import { useI18n } from '@/i18n';

export interface LibraryPreviewProps {
  modules: ModuleWithMeta[] | undefined;
  total: number | undefined;
  loading?: boolean;
  error?: Error;
  onRetry?: () => void;
}

/**
 * Library preview: tabs are not needed — instead a single rail of the newest
 * modules, with the honest total and a plain "browse everything" exit.
 */
export function LibraryPreview({ modules, total, loading, error, onRetry }: LibraryPreviewProps) {
  const { t } = useI18n();
  return (
    <section className="border-t border-line py-12 sm:py-14 lg:py-16">
      <Container size="wide">
        <Reveal>
          <SectionHeading
            eyebrow={t('模块库')}
            index="04"
            title={t('全部模块')}
            description={
              total === undefined
                ? t('按更新时间倒序展示最新收录的模块。')
                : total === 0
                  ? t('模块库尚未导入内容。')
                  : total === 1
                    ? t('当前索引 1 个演示模块，用于验证列表结构。')
                    : t('当前索引 {n} 个已发布模块，按更新时间倒序展示。', { n: total })
            }
            action={{ label: t('探索全部模块'), to: '/discover' }}
          />
        </Reveal>

        <div className="mt-7 lg:mt-9">
          {error ? (
            <ErrorState title={t('模块库加载失败')} error={error} onRetry={onRetry} compact />
          ) : loading || !modules ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <ModuleCardSkeleton key={i} />
              ))}
            </div>
          ) : modules.length === 0 ? (
            <EmptyState
              title={t('模块库为空')}
              description={t('导入模块后，最新收录的内容会出现在这里。')}
              action={<ButtonLink to="/about" size="sm">{t('了解导入计划')}</ButtonLink>}
            />
          ) : (
            <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {modules.map((m, i) => (
                <Reveal key={m.id} delay={Math.min(i, 5) * 0.04}>
                  <ModuleCard module={m} hideTags={false} />
                </Reveal>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 flex flex-col items-start gap-4 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11.5px] leading-relaxed text-faint">
            {t('展示的是索引内的全部内容，不含安装量或热度排序 —— 这些统计尚未接入。')}
          </p>
          <ButtonLink to="/discover" variant="secondary" size="sm" className="shrink-0">
            {t('进入发现页')}
            <ArrowRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        </div>
      </Container>
    </section>
  );
}

/** Compact "platform intro" block used between library and footer. */
export function PlatformIntro() {
  const { t } = useI18n();
  const points = [
    { title: t('独立索引'), body: t('由维护者整理的 Surge 模块目录，与 Surge 官方无隶属关系。') },
    { title: t('原始配置'), body: t('在详情页直接查看模块的 .sgmodule 原文，复制原始链接。') },
    { title: t('版本记录'), body: t('记录每个模块的版本号、发布时间与更新说明。') },
    { title: t('本地收藏'), body: t('收藏保存在本机浏览器，无需账号，清除站点数据会一并清空。') },
  ];

  return (
    <section className="border-t border-line bg-surface/40 py-12 sm:py-14 lg:py-16">
      <Container size="wide">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <div className="lg:sticky lg:top-24">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="eyebrow">{t('关于平台')}</span>
                <span className="font-mono text-[10.5px] tabular-nums text-faint/70">05</span>
              </div>
              <h2 className="text-balance text-[1.5rem] font-semibold leading-[1.14] tracking-[-0.02em] sm:text-[1.9rem]">
                {t('一个专注的模块索引。')}
              </h2>
              <p className="mt-3 text-pretty text-[13.5px] leading-relaxed text-muted">
                {t('不做社区，不做商店。只负责把模块整理清楚，让你更快找到需要的那一个。')}
              </p>
              <Link
                to="/about"
                className="tap-target group mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-muted transition-colors hover:text-fg"
              >
                <span className="border-b border-transparent pb-0.5 group-hover:border-line-strong">
                  {t('了解平台范围')}
                </span>
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </Reveal>

          <Reveal delay={0.06}>
            <dl className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-2">
              {points.map((p) => (
                <div key={p.title} className="bg-raised p-5 sm:p-6">
                  <dt className="text-[13.5px] font-semibold">{p.title}</dt>
                  <dd className="mt-1.5 text-pretty text-[12.5px] leading-relaxed text-muted">
                    {p.body}
                  </dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
