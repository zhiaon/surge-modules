import { Link } from 'react-router-dom';
import { Megaphone, Pin, RotateCw } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { Badge, VersionBadge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { Skeleton } from '@/components/common/Skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { useAsync } from '@/hooks/useAsync';
import { moduleService } from '@/services/moduleService';
import { usePageMeta } from '@/hooks/usePageMeta';
import { formatDate, formatRelative, toIsoDate } from '@/lib/format';
import { siteConfig } from '@/config/site';
import { ErrorState } from '@/components/feedback/ErrorState';
import { cn } from '@/lib/cn';

/**
 * Updates page: two timelines.
 *
 * Left — module versions, newest first, grouped by day so a busy week reads as
 * a few blocks instead of a wall of identical rows.
 * Right — platform announcements.
 *
 * A failure in either block is isolated: the other one still renders, and the
 * retry button calls the real loader.
 */
export function UpdatesPage() {
  usePageMeta({
    title: '更新日志',
    description: '平台公告与模块版本更新记录。',
    path: '/updates',
  });

  const announcements = useAsync(() => moduleService.getAnnouncements(), []);
  const versions = useAsync(async () => {
    const all = await moduleService.getModules();
    // getVersions() resolves by slug, not by the internal id. Using the id made
    // every lookup 404, and because they ran under Promise.all the first failure
    // blanked the whole page.
    //
    // Failures are also isolated per module now: one broken module must not hide
    // the changelog of the other seven.
    const rows = await Promise.all(
      all.items.map(async (m) => {
        try {
          return { module: m, versions: await moduleService.getVersions(m.slug) };
        } catch {
          return {
            module: m,
            versions: [] as Awaited<ReturnType<typeof moduleService.getVersions>>,
          };
        }
      }),
    );
    return rows
      .flatMap((r) => r.versions.map((v) => ({ ...v, module: r.module })))
      .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
  }, []);

  const groups = groupByDay(versions.data ?? []);

  return (
    <Container size="wide" className="py-8 sm:py-12">
      <header className="max-w-2xl">
        <span className="eyebrow">更新</span>
        <h1 className="mt-2.5 text-balance text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.028em] sm:text-[2.4rem]">
          更新日志
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          平台公告与模块版本记录。当前版本 v{siteConfig.version}。
        </p>
      </header>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-12">
        <section aria-labelledby="module-versions" className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="module-versions" className="text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">
              模块更新
            </h2>
            {versions.data && (
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {versions.data.length} 条
              </span>
            )}
          </div>

          {versions.status === 'error' ? (
            <ErrorState
              title="更新记录加载失败"
              error={versions.error}
              onRetry={versions.reload}
              compact
            />
          ) : versions.status === 'loading' && !versions.data ? (
            <ul className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={i}
                  className="rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight p-4"
                >
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="ml-auto h-3 w-16" />
                  </div>
                  <Skeleton className="mt-2.5 h-3 w-3/4" />
                </li>
              ))}
            </ul>
          ) : groups.length === 0 ? (
            <EmptyState
              title="暂无模块更新"
              description="模块同步并发布新版本后，记录会出现在这里。"
              action={
                <Button size="sm" onClick={versions.reload}>
                  <RotateCw className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  重新加载
                </Button>
              }
              compact
            />
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <div key={group.key}>
                  <div className="mb-3 flex items-center gap-2.5">
                    <h3 className="text-[12px] font-medium text-muted">{group.label}</h3>
                    <span className="h-px flex-1 bg-line" aria-hidden="true" />
                    <span className="font-mono text-[10.5px] tabular-nums text-faint">
                      {group.items.length}
                    </span>
                  </div>
                  <ol className="space-y-2.5">
                    {group.items.map((v) => (
                      <li
                        key={v.id}
                        className="group relative rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight p-4
                                   transition-colors duration-200 hover:border-line-strong hover:bg-raised-hover"
                      >
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                          <Link
                            to={`/modules/${v.module.slug}`}
                            className="tap-target text-[14px] font-medium text-fg transition-colors hover:text-accent-soft"
                          >
                            {v.module.name}
                          </Link>
                          <VersionBadge version={v.version} />
                          <span className="rounded-full border border-line bg-inset px-2 py-0.5 text-[10.5px] text-faint">
                            {v.module.category.name}
                          </span>
                          {groups[0]?.items[0]?.id === v.id && (
                            <Badge tone="success">
                              <span className="size-1 rounded-full bg-ok" aria-hidden="true" />
                              最新
                            </Badge>
                          )}
                          <time
                            dateTime={toIsoDate(v.releasedAt)}
                            className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-faint"
                          >
                            {formatRelative(v.releasedAt)}
                          </time>
                        </div>
                        {(v.changelog || m.description) && (
                          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                            {v.changelog || m.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside aria-labelledby="announcements" className="min-w-0">
          <h2
            id="announcements"
            className="mb-4 text-[13px] font-semibold uppercase tracking-[0.08em] text-faint"
          >
            平台公告
          </h2>

          {announcements.status === 'error' ? (
            <ErrorState
              title="公告加载失败"
              error={announcements.error}
              onRetry={announcements.reload}
              compact
            />
          ) : announcements.status === 'loading' && !announcements.data ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-[var(--radius-lg)] border border-line bg-raised card-spotlight p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="mt-2.5 h-3 w-full" />
                  <Skeleton className="mt-1.5 h-3 w-4/5" />
                </div>
              ))}
            </div>
          ) : !announcements.data || announcements.data.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-line px-4 py-8 text-center">
              <Megaphone className="mx-auto size-5 text-faint" strokeWidth={1.6} aria-hidden="true" />
              <p className="mt-2.5 text-[12.5px] text-faint">暂无公告</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {announcements.data.map((a) => (
                <li
                  key={a.id}
                  className={cn(
                    'rounded-[var(--radius-lg)] border border-line bg-raised p-4',
                    a.pinned && 'border-[var(--line-accent-28)]',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-[13.5px] font-medium leading-snug">{a.title}</h3>
                    {a.pinned && (
                      <Badge tone="accent">
                        <Pin className="size-2.5" aria-hidden="true" />
                        置顶
                      </Badge>
                    )}
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{a.body}</p>
                  <time
                    dateTime={toIsoDate(a.publishedAt)}
                    className="mt-3 block font-mono text-[10.5px] tabular-nums text-faint"
                  >
                    {formatDate(a.publishedAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </Container>
  );
}

/** Groups version rows into day buckets, preserving the incoming (newest-first) order. */
function groupByDay<T extends { releasedAt: string }>(items: T[]) {
  const out: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    // toIsoDate returns undefined for an unparseable date; fall back to the raw
    // string so such a row still lands in a bucket instead of crashing the page.
    const key = toIsoDate(item.releasedAt) ?? item.releasedAt;
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: formatDate(item.releasedAt), items: [item] });
  }
  return out;
}
