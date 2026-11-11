import { ArrowRight, Layers, Sparkles, Users, Zap } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { ButtonLink } from '@/components/common/Button';
import { formatDate } from '@/lib/format';
import { useEnter } from '@/hooks/useEnter';
import { cn } from '@/lib/cn';
import { openStatSheet, type StatSheetKind } from '@/stores/statSheet';
import type { ModuleStats } from '@/types';

export interface HeroProps {
  stats: ModuleStats | undefined;
  topCategory?: { name: string; slug: string } | undefined;
}

/**
 * Hero.
 *
 * Type does the work, one soft accent bloom behind it, and four stat cards fed
 * only by real counts from the static data (nothing is invented — when a value has not
 * loaded it renders an em dash instead of 0).
 *
 * Cards are now interactive: each opens a stat sheet over the homepage. The
 * whole card is clickable with hover/press feedback; layout, size and spacing
 * are unchanged.
 */
export function Hero({ stats, topCategory }: HeroProps) {
  const enter = useEnter();

  const cards: Array<{
    label: string;
    value: string;
    hint: string;
    icon: typeof Layers;
    kind: StatSheetKind;
  }> = [
    {
      label: '模块总数',
      value: stats ? String(stats.modules) : '—',
      hint: '已收录并公开',
      icon: Layers,
      kind: 'modules',
    },
    {
      label: '分类',
      value: stats ? String(stats.categories) : '—',
      hint: topCategory ? `最多：${topCategory.name}` : '按用途划分',
      icon: Sparkles,
      kind: 'categories',
    },
    {
      label: '模块来源',
      value: stats ? String(stats.authors) : '—',
      hint: '已接入的上游仓库',
      icon: Users,
      kind: 'sources',
    },
    {
      label: '最近更新',
      value: stats?.lastUpdatedAt ? formatDate(stats.lastUpdatedAt) : '—',
      hint: stats ? `${stats.versions} 个版本记录` : '按发布倒序',
      icon: Zap,
      kind: 'updates',
    },
  ];

  return (
    <section className="relative overflow-hidden">
      {/* one accent bloom, rasterised once — no blur filter on a huge element */}
      <div className="glow-field pointer-events-none absolute inset-x-0 top-0 h-[520px]" aria-hidden="true" />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: 'linear-gradient(to right, transparent, var(--color-line-strong), transparent)' }}
        aria-hidden="true"
      />

      <Container size="wide" className="relative">
        <div className="flex flex-col items-center pb-14 pt-14 text-center sm:pb-16 sm:pt-20 lg:pb-24 lg:pt-24">
          <div className={cn(enter.cls(0), 'flex items-center gap-2.5')} style={enter.style(0)}>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/70 px-3 py-1.5 text-[11.5px] text-muted">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
              独立 Surge 模块索引
            </span>
          </div>

          <h1
            className={cn(
              enter.cls(0.05),
              'mt-6 max-w-[19ch] text-balance text-[2.3rem] font-semibold leading-[1.05] tracking-[-0.032em] sm:text-[3.2rem] lg:text-[4rem]',
            )}
            style={enter.style(0.05)}
          >
            让 Surge 模块
            <span className="block bg-[linear-gradient(180deg,var(--color-fg),var(--color-accent-soft))] bg-clip-text text-transparent">
              发现更简单
            </span>
          </h1>

          <p
            className={cn(
              enter.cls(0.12),
              'mt-5 max-w-[46ch] text-pretty text-[15px] leading-[1.72] text-muted sm:text-[16px]',
            )}
            style={enter.style(0.12)}
          >
            浏览、搜索与收藏优质 Surge 模块，查看原始配置、复制安装链接，一次找到需要的规则与脚本。
          </p>

          <div
            className={cn(
              enter.cls(0.18),
              'mt-8 flex w-full flex-col items-stretch gap-2.5 sm:w-auto sm:flex-row sm:items-center',
            )}
            style={enter.style(0.18)}
          >
            <ButtonLink to="/discover" variant="primary" size="lg" fullWidth className="sm:w-auto">
              探索模块
              <ArrowRight className="size-4" strokeWidth={1.9} aria-hidden="true" />
            </ButtonLink>
            <ButtonLink to="/discover#categories" variant="secondary" size="lg" fullWidth className="sm:w-auto">
              浏览分类
            </ButtonLink>
          </div>

        </div>

        {/* stat cards — 2 columns on phones, 4 from md up. Never a horizontal scroll.
            Each card opens its stat sheet; the whole surface is the tap target. */}
        <div
          className={cn(enter.cls(0.28), 'grid grid-cols-2 gap-2.5 pb-12 sm:gap-3 md:grid-cols-4 lg:pb-16')}
          style={enter.style(0.28)}
        >
          {cards.map((card, i) => {
            const Icon = card.icon;
            return (
              <button
                key={card.label}
                type="button"
                onClick={() => openStatSheet(card.kind)}
                aria-label={`查看${card.label}`}
                style={i === cards.length - 1 ? undefined : undefined}
                className={cn(
                  'group text-left rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight p-4',
                  'shadow-[var(--shadow-card)]',
                  'transition-[transform,box-shadow,border-color] duration-200 ease-out',
                  'hover:-translate-y-0.5 hover:border-[var(--line-accent-32)] hover:shadow-[var(--shadow-raised)]',
                  'active:scale-[0.98] active:translate-y-0',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-[0.1em] text-faint">{card.label}</p>
                  <Icon
                    className="size-3.5 shrink-0 text-faint transition-colors duration-200 group-hover:text-accent"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-2.5 truncate font-mono text-[1.35rem] font-medium leading-none tabular-nums tracking-tight text-fg">
                  {card.value}
                </p>
                <p className="mt-1.5 truncate text-[10.5px] text-faint">{card.hint}</p>
              </button>
            );
          })}
        </div>

        <p className="pb-8 text-center text-[10.5px] text-faint">
          模块数据构建时生成，
          共 1270 个模块
        </p>
      </Container>
    </section>
  );
}
