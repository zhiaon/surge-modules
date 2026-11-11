import { useEffect, useState } from 'react';
import {
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
  const { data: rawConfig, status: configStatus } = useAsync(
    () => (module ? moduleService.getRawConfig(module.slug) : Promise.resolve('')),
    [module?.slug],
  );

  const [copied, setCopied] = useState<'config' | null>(null);
  const [showConfig, setShowConfig] = useState(false);

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
