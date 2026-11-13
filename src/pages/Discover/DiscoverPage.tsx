import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SearchX, SlidersHorizontal, Users, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { SearchInput } from '@/components/common/SearchInput';
import { ModuleCard } from '@/components/modules/ModuleCard';
import { ModuleCardSkeleton } from '@/components/common/Skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Button, ButtonLink } from '@/components/common/Button';
import { CategoryCard } from '@/components/modules/CategoryCard';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { moduleService } from '@/services/moduleService';
import { categoryService } from '@/services/categoryService';
import { moduleQuery } from '@/services/moduleQuery';
import { usePageMeta } from '@/hooks/usePageMeta';
import { cn } from '@/lib/cn';
import type { ModuleSort } from '@/types';

const PAGE_SIZE = 24;

const SORTS: Array<{ value: ModuleSort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'updated', label: '最近更新' },
  { value: 'name', label: '名称' },
];

/**
 * Discover — the core page.
 *
 * Filters live in the URL (q / category / tag / sort) so every filtered view is
 * linkable and the browser Back button behaves.
 *
 * Layout: one column of cards on phones, two from sm, three from lg, four on a
 * wide desktop. The grid never stretches a card past a readable measure.
 */
export function DiscoverPage() {
  usePageMeta({
    title: '发现模块',
    description: '按分类、标签与关键词筛选 Surge 模块。',
    path: '/discover',
  });

  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categorySlug = params.get('category') ?? '';
  const tag = params.get('tag') ?? '';
  const sort = (params.get('sort') as ModuleSort | null) ?? 'recommended';

  const [search, setSearch] = useState(q);
  const debounced = useDebouncedValue(search, 160);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => setSearch(q), [q]);

  const all = useAsync(() => moduleService.getModules({ perPage: 9999 }), []);
  const categories = useAsync(() => categoryService.getCategories(), []);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    if (next.toString() !== params.toString()) {
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const owner = params.get('owner') ?? '';

  const sources = useMemo(() => {
    const map = new Map<string, { owner: string; repo: string; count: number }>();
    for (const m of all.data?.items ?? []) {
      const url = (m.repositoryUrl ?? '').replace(/\/$/, '');
      if (!url.includes('github.com')) continue;
      const parts = url.replace(/^https?:\/\/github\.com\//i, '').split('/');
      if (parts.length < 2) continue;
      const key = `${parts[0]}/${parts[1]}`.toLowerCase();
      const entry = map.get(key) ?? { owner: parts[0], repo: parts[1], count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
    return [...map.values()]
      .map((v) => ({ ...v, fullName: `${v.owner}/${v.repo}` }))
      .sort((a, b) => b.count - a.count);
  }, [all.data]);
  const result = useMemo(() => {
    if (!all.data) return null;
    const base = owner
      ? all.data.items.filter((m) =>
          (m.repositoryUrl ?? '').toLowerCase().includes(owner.toLowerCase()),
        )
      : all.data.items;
    return moduleQuery.apply(base, {
      search: debounced,
      categorySlug: categorySlug || undefined,
      tag: tag || undefined,
      sort,
    });
  }, [all.data, debounced, categorySlug, tag, sort, owner]);

  useEffect(() => setPage(1), [debounced, categorySlug, tag, sort, owner]);

  const activeCategory = categories.data?.find((c) => c.slug === categorySlug);
  const hasFilters = Boolean(categorySlug || tag || sort !== 'recommended' || debounced || owner);

  return (
    <>
      <Container size="wide" className="pt-8 sm:pt-12">
        <header className="max-w-2xl">
          <span className="eyebrow">发现</span>
          <h1 className="mt-2.5 text-balance text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.028em] sm:text-[2.4rem]">
            模块目录
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            按分类、标签与关键词筛选。所有条件都会写进地址栏，可直接分享。
          </p>
        </header>

        {/* search + sort */}
        <div className="mt-6 flex flex-col gap-2.5 sm:mt-7 sm:flex-row sm:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="搜索模块、描述、作者或标签"
            size="lg"
            className="flex-1"
            aria-label="筛选模块"
          />
          <div className="flex items-center gap-2">
            <ButtonLink
              to="/collection"
              variant="secondary"
              size="md"
              className="shrink-0"
            >
              合集
            </ButtonLink>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setFilterSheetOpen((v) => !v)}
              aria-expanded={filterSheetOpen}
              aria-controls="filter-panel"
            >
              <SlidersHorizontal className="size-4" strokeWidth={1.85} aria-hidden="true" />
              筛选
              {hasFilters && <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />}
            </Button>

            {/* segmented control — one surface, one active pill */}
            <div
              role="group"
              aria-label="排序方式"
              className="flex items-center gap-0.5 rounded-[var(--radius-md)] border border-line bg-raised p-0.5"
            >
              {SORTS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setParam('sort', s.value === 'recommended' ? null : s.value)}
                  aria-pressed={sort === s.value}
                  className={cn(
                    'rounded-[var(--radius-xs)] px-2.5 py-2 text-[12px] transition-colors duration-200',
                    sort === s.value
                      ? 'bg-raised-hover text-fg shadow-[var(--shadow-card)]'
                      : 'text-faint hover:text-muted',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Container>

      {/* Egern-style inline filter panel: expands under the search row.
          Sources as avatar chips, categories as text chips, both wrap. */}
      <Container size="wide" id="filter-panel" className={cn('mt-3', filterSheetOpen ? 'block' : 'hidden')}>
        <div className="rounded-[var(--radius-lg)] border border-line bg-raised p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13.5px] font-semibold">资源筛选</h2>
            <button
              type="button"
              onClick={() => setFilterSheetOpen(false)}
              aria-label="收起筛选"
              className="inline-flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-inset hover:text-fg"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-2.5 space-y-3">
            {/* sources */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[11.5px] text-faint">
                <Users className="size-3" strokeWidth={2} aria-hidden="true" />
                来源（{sources.length}）
              </p>
              <div className="flex flex-wrap gap-1">
                <Chip active={!owner} onClick={() => setParam('owner', null)}>全部</Chip>
                {sources.map((src) => (
                  <Chip
                    key={src.fullName}
                    active={owner === src.fullName}
                    onClick={() => setParam('owner', owner === src.fullName ? null : src.fullName)}
                  >
                    <span className="flex items-center gap-1">
                      <img
                        src={`https://github.com/${src.owner}.png?size=48`}
                        alt=""
                        loading="lazy"
                        className="size-3.5 rounded-full object-cover"
                      />
                      {src.owner}
                      <span className="font-mono text-[9.5px] tabular-nums opacity-60">{src.count}</span>
                    </span>
                  </Chip>
                ))}
              </div>
            </div>

            {/* categories */}
            <div>
              <p className="mb-2 text-[11.5px] text-faint">分类（{categories.data?.length ?? 0}）</p>
              <div className="flex flex-wrap gap-1">
                <Chip active={!categorySlug} onClick={() => setParam('category', null)}>全部</Chip>
                {(categories.data ?? []).map((c) => (
                  <Chip
                    key={c.id}
                    active={categorySlug === c.slug}
                    onClick={() => setParam('category', categorySlug === c.slug ? null : c.slug)}
                  >
                    {c.name}
                    <span className="font-mono text-[9.5px] tabular-nums opacity-60">{c.moduleCount}</span>
                  </Chip>
                ))}
              </div>
            </div>

            {(owner || categorySlug || tag) && (
              <button
                type="button"
                onClick={() => {
                  setParam('owner', null);
                  setParam('category', null);
                  setParam('tag', null);
                }}
                className="inline-flex items-center gap-1.5 text-[11.5px] text-muted underline-offset-4 hover:text-fg hover:underline"
              >
                重置筛选
                <X className="size-3" strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </Container>

      <Container size="wide">
        {/* active filter summary */}
        {hasFilters && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-raised/60 px-3 py-2.5">
            <span className="text-[11.5px] text-faint">当前筛选</span>
            {owner && (
              <ActiveChip onRemove={() => setParam('owner', null)}>
                来源：{owner}
              </ActiveChip>
            )}
            {activeCategory && (
              <ActiveChip onRemove={() => setParam('category', null)}>
                {activeCategory.name}
              </ActiveChip>
            )}
            {tag && <ActiveChip onRemove={() => setParam('tag', null)}>#{tag}</ActiveChip>}
            {sort !== 'recommended' && (
              <ActiveChip onRemove={() => setParam('sort', null)}>
                排序：{SORTS.find((s) => s.value === sort)?.label ?? sort}
              </ActiveChip>
            )}
            {debounced && (
              <ActiveChip onRemove={() => { setSearch(''); setParam('q', null); }}>
                “{debounced}”
              </ActiveChip>
            )}
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
              }}
              className="ml-auto shrink-0 text-[11.5px] text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              清除全部
            </button>
          </div>
        )}

        <p className="mt-5 text-[11.5px] tabular-nums text-faint" aria-live="polite">
          {result ? `共 ${result.total} 个模块` : '加载中…'}
        </p>

        <div className="mt-3.5">
          {all.status === 'error' ? (
            <ErrorState title="模块列表加载失败" error={all.error} onRetry={all.reload} />
          ) : all.status === 'loading' && !result ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <ModuleCardSkeleton key={i} />
              ))}
            </div>
          ) : result && result.items.length > 0 ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {result.items
                  .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
                  .map((m) => (
                    <ModuleCard key={m.id} module={m} />
                  ))}
              </div>

              {result.total > PAGE_SIZE && (
                <div className="mt-6 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setPage((p) => Math.max(1, p - 1));
                      window.scrollTo({ top: 260, behavior: 'smooth' });
                    }}
                    disabled={page <= 1}
                    aria-label="上一页"
                    className={cn(
                      'inline-flex size-10 items-center justify-center rounded-full border border-line',
                      'text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-35',
                    )}
                  >
                    <ChevronLeft className="size-4" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <span className="min-w-20 text-center text-[12px] tabular-nums text-faint">
                    {page} / {Math.ceil(result.total / PAGE_SIZE)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPage((p) => Math.min(Math.ceil(result.total / PAGE_SIZE), p + 1));
                      window.scrollTo({ top: 260, behavior: 'smooth' });
                    }}
                    disabled={page >= Math.ceil(result.total / PAGE_SIZE)}
                    aria-label="下一页"
                    className={cn(
                      'inline-flex size-10 items-center justify-center rounded-full border border-line',
                      'text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-35',
                    )}
                  >
                    <ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={SearchX}
              title="没有符合条件的模块"
              description="换一个关键词，或清除筛选条件重新浏览。"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          )}
        </div>
      </Container>

      {/* categories */}
      <section id="categories" className="mt-16 scroll-mt-24 border-t border-line bg-surface/40">
        <Container size="wide" className="py-12 sm:py-14">
          <h2 className="text-[1.15rem] font-semibold">分类</h2>
          <p className="mt-1.5 text-[13px] text-muted">选择一个分类快速缩小范围。</p>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {categories.data?.map((c) => (
              <CategoryCard key={c.id} category={c} />
            ))}
          </div>
          <div className="mt-8">
            <ButtonLink to="/" size="sm" variant="ghost">
              返回首页
            </ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}

function ActiveChip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line-accent-28)] bg-[var(--tint-accent-10)] py-1 pl-2.5 pr-1 text-[11.5px] text-accent-soft">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label="移除这个筛选条件"
        className="inline-flex size-5 items-center justify-center rounded-full transition-colors hover:bg-[var(--tint-accent-16)] hover:text-fg"
      >
        <X className="size-3" strokeWidth={2.2} aria-hidden="true" />
      </button>
    </span>
  );
}



function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-compact
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 min-h-0 min-w-0 shrink-0 items-center whitespace-nowrap rounded-md border px-2 text-[10px]',
        'transition-colors duration-200',
        active
          ? 'border-[var(--line-accent-45)] bg-[var(--tint-accent-12)] text-accent-soft'
          : 'border-line bg-inset text-muted hover:border-line-strong hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
