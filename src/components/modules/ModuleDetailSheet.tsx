import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Layers3,
  Share2,
  Calendar,
  Check,
  Copy,
  FileCode2,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { BottomSheet } from '@/components/common/BottomSheet';
import { Badge, VersionBadge } from '@/components/common/Badge';
import { Skeleton } from '@/components/common/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { FavoriteButton } from '@/components/modules/FavoriteButton';
import { cn } from '@/lib/cn';
import { toast } from '@/components/feedback/Toast';
import { useAsync } from '@/hooks/useAsync';
import { moduleService } from '@/services/moduleService';
import { rankGroup, type CompareTech } from '@/lib/sameName';
import { analyticsService } from '@/services/analyticsService';
import { copyText, formatDate, formatRelative, toIsoDate } from '@/lib/format';
import { resolveCategoryIcon } from '@/lib/icons';

/**
 * Module detail as a sheet.
 *
 * Opens over the list instead of navigating away, so browsing ten modules no
 * longer costs ten page loads and ten scroll restorations. Structure follows
 * the familiar hub layout: icon + name, category / update date / version as a
 * metadata strip, description, tags, the install + copy pair, then the raw
 * config folded away behind a disclosure.
 *
 * The full page at /modules/:slug stays — direct links, search engines and
 * shares still land there; only in-app card taps use this sheet.
 */
export function ModuleDetailSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data: module, status, error, reload } = useAsync(
    () => moduleService.getModuleBySlug(slug),
    [slug],
  );
  const { data: versions } = useAsync(
    () => (module ? moduleService.getVersions(module.slug) : Promise.resolve([])),
    [module?.slug],
  );
  // tech / history only exist in the per-module detail file
  const { data: detail } = useAsync(async () => {
    if (!slug) return null;
    try {
      const res = await fetch(`/data/details/${encodeURIComponent(slug)}.json`);
      if (!res.ok) return null;
      return (await res.json()) as {
        tech?: {
          rules?: number;
          mitm: string[];
          rewrites: number;
          scripts: Array<{ name: string; url: string }>;
          crons: string[];
        } | null;
        sameAs?: string[];
        history?: Array<{ at: string; type: 'added' | 'content' | 'removed' }>;
      };
    } catch {
      return null;
    }
  }, [slug]);

  const { data: rawConfig, status: configStatus } = useAsync(
    () => (module ? moduleService.getRawConfig(module.slug) : Promise.resolve('')),
    [module?.slug],
  );

  // Same-title modules from other repos: the catalogue carries up to four
  // 「京东去广告」 and by default the user cannot tell them apart.
  const { data: allModules } = useAsync(() => moduleService.getModules({ perPage: 9999 }), []);
  const [siblingTech, setSiblingTech] = useState<Record<string, CompareTech | null>>({});

  const siblings = useMemo(() => {
    if (!module || !allModules) return [];
    const want = new Set(detail?.sameAs ?? []);
    if (!want.size) return [];
    return allModules.items.filter((m) => want.has(m.slug));
  }, [module, allModules, detail]);

  useEffect(() => {
    if (!siblings.length) return;
    let cancelled = false;
    (async () => {
      const entries: Array<[string, CompareTech | null]> = [];
      for (const m of [module!, ...siblings].slice(0, 5)) {
        try {
          const res = await fetch(`/data/details/${encodeURIComponent(m.slug)}.json`);
          const d = await res.json();
          const t = d.tech;
          entries.push([
            m.slug,
            t
              ? {
                  rules: t.rules ?? 0,
                  rewrites: t.rewrites ?? 0,
                  mitm: (t.mitm ?? []).length,
                  scripts: (t.scripts ?? []).length,
                  crons: (t.crons ?? []).length,
                }
              : null,
          ]);
        } catch {
          entries.push([m.slug, null]);
        }
      }
      if (!cancelled) setSiblingTech(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [module, siblings]);

  const comparison = useMemo(() => {
    if (!module || !siblings.length) return [];
    return rankGroup([module, ...siblings], siblingTech);
  }, [module, siblings, siblingTech]);

  const [copied, setCopied] = useState<'config' | null>(null);
  // The raw config is why most people open this sheet — start expanded so it
  // is one less tap. Collapsed again only if the user chooses to (the effect
  // below re-expands when a different module is opened).
  const [showConfig, setShowConfig] = useState(true);

  useEffect(() => {
    setShowConfig(true);
  }, [module?.slug]);

  useEffect(() => {
    if (module) analyticsService.trackModuleView(module.slug);
  }, [module]);

  const latest = versions?.[0];

  const doCopyConfig = async () => {
    const ok = await copyText(rawConfig ?? '');
    if (!ok) return;
    setCopied('config');
    window.setTimeout(() => setCopied(null), 1800);
    toast.show('已复制配置', '这是模块的完整 .sgmodule 文本', 'success');
  };

  const Icon = module ? resolveCategoryIcon(module.category.icon) : null;

  return (
    <BottomSheet
      open
      onClose={onClose}
      height="tall"
      bare
      className="sm:max-w-xl"
    >
      {/* bare sheet: draw the grabber and a real close button ourselves */}
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2.5">
        <span className="w-9" aria-hidden="true" />
        <span className="h-1 w-9 rounded-full bg-line-strong sm:hidden" aria-hidden="true" />
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="-mr-1 inline-flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <X className="size-4.5" strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && !module ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-24 w-full" rounded="md" />
          </div>
        ) : status === 'error' ? (
          <div className="p-5">
            <ErrorState title="模块详情加载失败" error={error} onRetry={reload} />
          </div>
        ) : !module || !Icon ? (
          <div className="p-8 text-center text-[13px] text-faint">找不到这个模块</div>
        ) : (
          <>
            {/* ---- header ---- */}
            <div className="px-5 pb-4 pt-0">
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-line bg-inset text-muted"
                  aria-hidden="true"
                >
                  <Icon className="size-5" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-balance text-[1.25rem] font-semibold leading-[1.2] tracking-[-0.02em]">
                    {module.name}
                  </h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <VersionBadge version={module.version} />
                    {module.isFeatured && (
                      <Badge tone="accent">
                        <Sparkles className="size-2.5" strokeWidth={2.2} aria-hidden="true" />
                        精选
                      </Badge>
                    )}

                  </div>
                </div>
                <FavoriteButton
                  moduleId={module.id}
                  moduleName={module.name}
                  className="-mr-1.5 -mt-1"
                />
              </div>

              {/* metadata strip: category · author · updated */}
              <dl className="mt-4 grid grid-cols-3 gap-2">
                <div className="min-w-0 rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
                  <dt className="flex items-center gap-1 text-[10px] text-faint">
                    <Tag className="size-2.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
                    类别
                  </dt>
                  <dd className="mt-0.5 truncate text-[11.5px] text-fg">
                    {module.category.name}
                  </dd>
                </div>
                <div className="min-w-0 rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
                  <dt className="flex items-center gap-1 text-[10px] text-faint">
                    <FileCode2 className="size-2.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
                    版本
                  </dt>
                  <dd className="mt-0.5 truncate font-mono text-[11.5px] tabular-nums text-fg">
                    v{module.version}
                  </dd>
                </div>
                <div className="min-w-0 rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
                  <dt className="flex items-center gap-1 text-[10px] text-faint">
                    <Calendar className="size-2.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
                    更新
                  </dt>
                  <dd
                    className="mt-0.5 truncate text-[11.5px] tabular-nums text-fg"
                    title={formatDate(module.updatedAt)}
                  >
                    {formatDate(module.updatedAt)}
                  </dd>
                </div>
              </dl>

              {module.health === 'broken' && (
                <div className="mt-3.5 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--line-danger-35)] bg-[var(--tint-danger-10)] px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={2} aria-hidden="true" />
                  <p className="text-[11.5px] leading-relaxed text-danger/90">
                    该模块引用的脚本已失效（上游文件已删除），安装后可能不生效。
                    建议选择其他同类模块。
                  </p>
                </div>
              )}

              <p className="mt-3.5 text-pretty text-[13px] leading-[1.7] text-muted">
                {module.description}
              </p>

              {module.tags.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {module.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full border border-line bg-inset px-2 py-0.5 text-[10.5px] text-faint"
                    >
                      #{tag}
                    </li>
                  ))}
                </ul>
              )}

              {/* What the module actually touches — parsed from its config. */}
              {detail?.tech && (
                <details className="group mt-3.5 rounded-[var(--radius-md)] border border-line bg-inset/60">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[11.5px] text-muted">
                    <span>技术清单</span>
                    <span className="text-[10.5px] text-faint">
                      {detail.tech.rules ? `${detail.tech.rules} 条规则 · ` : ''}
                      {detail.tech.mitm.length} 域名 · {detail.tech.rewrites} 条重写 ·{' '}
                      {detail.tech.scripts.length} 个脚本
                    </span>
                  </summary>
                  <div className="space-y-2.5 border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-faint">
                    {detail.tech.crons.length > 0 && (
                      <p>
                        <span className="text-muted">定时：</span>
                        {detail.tech.crons.join(' / ')}
                      </p>
                    )}
                    {detail.tech.mitm.length > 0 && (
                      <p className="break-all">
                        <span className="text-muted">MITM：</span>
                        {detail.tech.mitm.slice(0, 12).join(', ')}
                        {detail.tech.mitm.length > 12 && ` …等 ${detail.tech.mitm.length} 个`}
                      </p>
                    )}
                    {detail.tech.scripts.length > 0 && (
                      <ul className="space-y-1">
                        <li className="text-muted">脚本：</li>
                        {detail.tech.scripts.map((sc) => (
                          <li key={sc.url} className="break-all">
                            <a
                              href={sc.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="underline-offset-2 hover:text-fg hover:underline"
                            >
                              {sc.name || sc.url.split('/').pop()}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {detail.tech.crons.length === 0 &&
                      detail.tech.mitm.length === 0 &&
                      detail.tech.scripts.length === 0 && <p>无脚本、无 MITM、无定时任务。</p>}
                  </div>
                </details>
              )}

              {/* 同名模块对比 */}
              {comparison.length > 1 && (
                <div className="mt-3.5 rounded-[var(--radius-md)] border border-line bg-inset/60 p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-[11.5px] text-muted">
                    <Layers3 className="size-3" strokeWidth={2} aria-hidden="true" />
                    同名模块 {comparison.length} 个，选哪个？
                  </p>
                  <div className="-mx-1 overflow-x-auto">
                    <table className="w-full min-w-[420px] border-collapse text-[11px]">
                      <thead>
                        <tr className="text-faint">
                          <th className="p-1 text-left font-normal">来源</th>
                          <th className="p-1 text-right font-normal">规则</th>
                          <th className="p-1 text-right font-normal">重写</th>
                          <th className="p-1 text-right font-normal">域名</th>
                          <th className="p-1 text-right font-normal">脚本</th>
                          <th className="p-1 text-right font-normal">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.map((row) => (
                          <tr
                            key={row.module.slug}
                            className={cn(
                              'border-t border-line/60',
                              row.module.slug === module.slug && 'bg-[var(--tint-accent-10)]',
                            )}
                          >
                            <td className="max-w-[132px] truncate p-1 text-muted">
                              {row.recommended && (
                                <span className="mr-1 rounded bg-[var(--tint-accent-16)] px-1 py-0.5 text-[9px] text-accent-soft">
                                  推荐
                                </span>
                              )}
                              {row.module.repositoryUrl?.replace('https://github.com/', '') ??
                                row.module.author}
                            </td>
                            <td className="p-1 text-right tabular-nums text-faint">
                              {row.tech ? row.tech.rules : '—'}
                            </td>
                            <td className="p-1 text-right tabular-nums text-faint">
                              {row.tech ? row.tech.rewrites : '—'}
                            </td>
                            <td className="p-1 text-right tabular-nums text-faint">
                              {row.tech ? row.tech.mitm : '—'}
                            </td>
                            <td className="p-1 text-right tabular-nums text-faint">
                              {row.tech ? row.tech.scripts : '—'}
                            </td>
                            <td className="p-1 text-right">
                              {row.module.health === 'broken' ? (
                                <span className="text-danger">失效</span>
                              ) : row.module.health === 'ok' ? (
                                <span className="text-ok">正常</span>
                              ) : (
                                <span className="text-faint">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
                    按「脚本是否可用 → 拦截面大小 → 更新时间」排序，推荐项可直接安装。
                  </p>
                </div>
              )}

              {/* Share link points at the generated preview page, which carries
                  per-module OG meta so messengers render a real card. */}
              <button
                type="button"
                onClick={async () => {
                  const url = `${location.origin}/p/${module.slug}`;
                  const ok = await copyText(url);
                  toast.show(ok ? '分享链接已复制' : '复制失败', ok ? '对方会看到模块预览卡片' : undefined, ok ? 'success' : 'default');
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-inset px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
              >
                <Share2 className="size-3" strokeWidth={2} aria-hidden="true" />
                分享链接
              </button>

              {/* Change events recorded by the sync job. */}
              {detail?.history && detail.history.length > 0 && (
                <div className="mt-3.5">
                  <p className="mb-1.5 text-[11px] text-faint">变更记录</p>
                  <ul className="space-y-1">
                    {detail.history.slice(0, 4).map((h, i) => (
                      <li key={`${h.at}-${i}`} className="flex items-center gap-2 text-[11px] text-faint">
                        <span className="tabular-nums">{formatDate(h.at)}</span>
                        <span className="text-muted">
                          {h.type === 'added' ? '收录' : h.type === 'removed' ? '下架' : '内容变更'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* ---- raw config ---- */}
            <div className="px-5 py-4">
              <button
                type="button"
                onClick={() => setShowConfig((v) => !v)}
                aria-expanded={showConfig}
                className="flex w-full items-center gap-2 text-left"
              >
                <FileCode2 className="size-4 shrink-0 text-faint" strokeWidth={1.9} aria-hidden="true" />
                <span className="text-[12.5px] font-medium">原始配置</span>
                <span className="font-mono text-[10px] text-faint">.sgmodule</span>
                <span className="ml-auto text-[11px] text-faint">
                  {showConfig ? '收起' : '展开'}
                </span>
              </button>

              {showConfig && (
                <div className="mt-2.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10.5px] text-faint">
                      {rawConfig ? `${rawConfig.split('\n').length} 行` : configStatus === 'loading' ? '加载中…' : '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void doCopyConfig()}
                      disabled={!rawConfig}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-xs)] border px-2 text-[10.5px]',
                        'transition-colors disabled:opacity-40',
                        copied === 'config'
                          ? 'border-[var(--line-ok-26)] bg-[var(--tint-ok-14)] text-ok'
                          : 'border-line bg-raised text-muted hover:border-line-strong hover:text-fg',
                      )}
                    >
                      {copied === 'config' ? (
                        <Check className="size-3" strokeWidth={2.4} aria-hidden="true" />
                      ) : (
                        <Copy className="size-3" strokeWidth={1.9} aria-hidden="true" />
                      )}
                      {copied === 'config' ? '已复制' : '复制配置'}
                    </button>
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-[var(--radius-md)] border border-line bg-[var(--color-inset)] p-3 font-mono text-[10.5px] leading-[1.65] text-muted">
                    {rawConfig || (configStatus === 'loading' ? '加载中…' : '暂无内容')}
                  </pre>
                </div>
              )}

              {/* version history, last three */}
              {versions && versions.length > 0 && (
                <div className="mt-4 border-t border-line pt-3.5">
                  <p className="mb-2 text-[11px] text-faint">版本记录（{versions.length}）</p>
                  <ol className="space-y-1.5">
                    {versions.slice(0, 3).map((v, i) => (
                      <li key={v.version} className="flex items-baseline gap-2 text-[11px]">
                        <span className="font-mono tabular-nums text-fg">v{v.version}</span>
                        {i === 0 && <span className="text-[9.5px] text-ok">当前</span>}
                        <time
                          dateTime={toIsoDate(v.releasedAt)}
                          className="ml-auto shrink-0 font-mono tabular-nums text-faint"
                        >
                          {formatDate(v.releasedAt)}
                        </time>
                      </li>
                    ))}
                  </ol>
                  {latest?.changelog && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted">{latest.changelog}</p>
                  )}
                </div>
              )}

              <p className="mt-4 text-[10.5px] leading-relaxed text-faint">
                安装链接需要 Surge 已安装并登录；未登录时链接不含访问凭证。
                模块最后更新 {formatRelative(module.updatedAt)}。
              </p>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
