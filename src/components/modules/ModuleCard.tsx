import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Download, FileCode2, Link2, Sparkles, Tag } from 'lucide-react';
import { cn } from '@/lib/cn';
import { healthBadge, healthHint } from '@/lib/health';
import { openDonateSheet } from '@/stores/donateSheet';
import { copyText, formatDate, formatRelative, toIsoDate } from '@/lib/format';
import type { ModuleWithMeta } from '@/types';
import { VersionBadge } from '../common/Badge';
import { resolveCategoryIcon } from '@/lib/icons';
import { GithubAvatar } from '@/components/home/StatSheetShared';
import { installDeepLink } from '@/lib/credential';
import { toast } from '@/components/feedback/Toast';
import { openModuleSheet } from '@/stores/moduleSheet';

type Variant = 'default' | 'compact' | 'horizontal' | 'featured';

export interface ModuleCardProps {
  module: ModuleWithMeta;
  variant?: Variant;
  className?: string;
  /** in dense grid lists we skip the description */
  hideTags?: boolean;
}

const CARD_BASE =
  'group relative flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-raised ' +
  'card-hover card-spotlight card-skip-paint';

/**
 * The single card used everywhere a module is listed.
 *
 * Interaction model: one stretched link covers the card body (so the whole
 * surface is clickable and keyboard-reachable as a single tab stop), while the
 * favorite button, the install/copy actions and tag links sit above it in the
 * stacking order as real buttons/links of their own.
 *
 * The install + copy pair lives on the card itself (like a hub listing): the
 * most common action after finding a module is installing it, and forcing a
 * trip through the detail page for that costs a navigation for nothing.
 *
 * Hover: -2px lift + border warm + shadow, desktop only (see .card-hover). Touch
 * devices get a scale-down press instead, because hover never fires there.
 */
function ModuleCardImpl({ module, variant = 'default', className, hideTags }: ModuleCardProps) {
  const featured = variant === 'featured';
  // Only our own upstream gets a donation entry: the QR belongs to the site
  // maintainer, so putting it on someone else's module would misattribute
  // their work.
  const isOwn = (module.repositoryUrl ?? '').includes('github.com/zhiaon/');

  /**
   * A card tap opens the detail sheet — the full detail page no longer exists
   * as a destination from the UI. Modified/middle clicks are left alone so a
   * desktop user can still open a shareable link in a new tab.
   */

  const Icon = resolveCategoryIcon(module.category.icon);
  const repoOwner = module.repositoryUrl
    ?.replace(/^https?:\/\/github\.com\//i, '')
    .split('/')[0];
  const [copied, setCopied] = useState(false);

  const installUrl = module.rawUrl;

  const onCopy = async () => {
    const ok = await copyText(installUrl);
    if (!ok) {
      toast.show('复制失败', '剪贴板不可用，请长按原始链接手动复制');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    toast.show('已复制安装链接', undefined, 'success');
  };

  if (variant === 'compact') {
    return (
      <div
        className={cn(
          'group flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2.5',
          'transition-colors duration-200 hover:bg-raised',
          className,
        )}
      >
        <span
          className="mt-0.5 size-1.5 shrink-0 rounded-full bg-line-strong transition-colors group-hover:bg-accent"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{module.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-faint">{module.author}</span>
        </span>
        <VersionBadge version={module.version} />
      </div>
    );
  }

  /**
   * Card actions.
   *
   * Layout follows the request: the install button is the primary, left-aligned
   * pill; copy and detail are small square icon buttons next to it. All three
   * sit above the stretched title link (z-10) so they keep their own click
   * targets.
   */
  const actions = () => (
    <div className="relative z-10 flex w-full items-center gap-1.5">
      {/* primary: install, left */}
      {(
        <a
          href={installDeepLink(installUrl)}
          className={cn(
            'inline-flex h-8 min-h-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3',
            'bg-white text-[#0b0d12] text-[11px] font-semibold',
            'shadow-[0_1px_0_0_rgba(255,255,255,0.6)_inset,0_4px_14px_-6px_rgba(0,0,0,0.5)]',
            'transition-[transform,background-color] duration-200 hover:bg-white/90 active:scale-[0.97]',
          )}
        >
          <Download className="size-3" strokeWidth={2.4} aria-hidden="true" />
          导入 Surge
        </a>
      )}

      {/* secondary pair, pushed right */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          data-compact
          onClick={() => void onCopy()}
          className={cn(
            'inline-flex h-7 min-h-0 min-w-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5',
            'text-[11px] font-medium transition-colors duration-200',
            'bg-[var(--glass-bg)] backdrop-blur-[12px] backdrop-saturate-150',
            'shadow-[0_1px_0_0_var(--glass-highlight)_inset]',
            copied
              ? 'border-[var(--line-ok-26)] text-ok'
              : 'border-line text-muted hover:border-line-strong hover:text-fg',
          )}
        >
          {copied ? (
            <Check className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
          ) : (
            <Link2 className="size-2.5" strokeWidth={2.2} aria-hidden="true" />
          )}
          {copied ? '已复制' : '复制链接'}
        </button>

        <button
          type="button"
          data-compact
          onClick={() => openModuleSheet(module.slug)}
          className={cn(
            'inline-flex h-7 min-h-0 min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-line px-2.5',
            'text-[11px] font-medium text-muted',
            'bg-[var(--glass-bg)] backdrop-blur-[12px] backdrop-saturate-150',
            'shadow-[0_1px_0_0_var(--glass-highlight)_inset]',
            'transition-colors duration-200 hover:border-line-strong hover:text-fg',
          )}
        >
          <FileCode2 className="size-2.5" strokeWidth={2.1} aria-hidden="true" />
          详情配置
        </button>
      </div>
    </div>
  );

  if (variant === 'horizontal') {
    return (
      <div data-fx-card className={cn(CARD_BASE, 'gap-0 p-4 sm:p-5', className)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="eyebrow">{module.category.name}</span>
              <span className="text-faint/50" aria-hidden="true">
                /
              </span>
              <VersionBadge version={module.version} />
              {(module.dupe ?? 0) > 0 && (
                <span
                  className="inline-flex items-center rounded-full border border-line bg-inset px-1.5 py-0.5 text-[9.5px] text-faint"
                  title={`另有 ${module.dupe} 个同名模块，可在详情里对比`}
                >
                  同名 {(module.dupe ?? 0) + 1}
                </span>
              )}
              {module.health === 'broken' && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--line-danger-35)] bg-[var(--tint-danger-10)] px-1.5 py-0.5 text-[9.5px] text-danger"
                  title={`模块引用的脚本已失效：${healthHint(module.healthReason)}`}
                >
                  <AlertTriangle className="size-2.5" strokeWidth={2.2} aria-hidden="true" />
                  {healthBadge(module.healthReason)}
                </span>
              )}
            </div>
            <h3 className="text-[15px] font-medium leading-snug">{module.name}</h3>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
          {module.description}
        </p>
        <div className="mt-2.5">
          <p className="mb-1.5 text-[11px] text-faint">
            更新于 {formatDate(module.updatedAt)}
          </p>
          {actions()}
        </div>
      </div>
    );
  }

  /* default + featured share a structure; featured gets a wider padding +
     an accent top rule + a visible 精选 marker */
  return (
    <article
      data-fx-card
      className={cn(CARD_BASE, featured ? 'gap-5 p-6 sm:p-7' : 'gap-4 p-5', className)}
    >
      {featured && (
        <span
          className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,var(--color-accent),transparent)]"
          aria-hidden="true"
        />
      )}

      {isOwn && (
        <button
          type="button"
          onClick={openDonateSheet}
          aria-label="捐赠作者"
          title="捐赠作者"
          className="absolute right-3.5 top-3.5 z-20 inline-flex min-h-0 items-center gap-1 rounded-full border border-line bg-raised/80 px-2 py-[5px] text-[10px] leading-none text-muted shadow-[var(--shadow-card)] transition-colors hover:border-[var(--line-danger-35)] hover:text-danger active:scale-[0.97]"
        >
          <span aria-hidden="true">💌</span>
          捐赠作者
        </button>
      )}

      <header className="flex items-start gap-3">
        {/* Author avatar as the card's lead image; the category icon rides on
            it as a small badge so users still see what the module does. Falls
            back to the icon-only tile when there is no GitHub owner. */}
        <span className="relative mt-0.5 shrink-0" aria-hidden="true">
          {repoOwner ? (
            <GithubAvatar
              owner={repoOwner}
              size={36}
              className="transition-transform duration-300 group-hover:scale-[1.04]"
            />
          ) : (
            <span
              className={cn(
                'flex size-9 items-center justify-center rounded-[var(--radius-sm)]',
                'border border-line bg-inset text-muted transition-colors duration-300',
                'group-hover:border-[var(--line-accent-32)] group-hover:text-accent',
              )}
            >
              <Icon className="size-[17px]" strokeWidth={1.7} />
            </span>
          )}

        </span>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pr-16">
            <span className="eyebrow">{module.category.name}</span>
            <VersionBadge version={module.version} />
            {(module.dupe ?? 0) > 0 && (
              <span
                className="inline-flex items-center rounded-full border border-line bg-inset px-1.5 py-0.5 text-[9.5px] text-faint"
                title={`另有 ${module.dupe} 个同名模块，可在详情里对比`}
              >
                同名 {(module.dupe ?? 0) + 1}
              </span>
            )}
            {module.health === 'broken' && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-[var(--line-danger-35)] bg-[var(--tint-danger-10)] px-1.5 py-0.5 text-[9.5px] text-danger"
                title={`模块引用的脚本已失效：${healthHint(module.healthReason)}`}
              >
                <AlertTriangle className="size-2.5" strokeWidth={2.2} aria-hidden="true" />
                {healthBadge(module.healthReason)}
              </span>
            )}
            {featured && (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--line-accent-28)] bg-[var(--tint-accent-12)] px-1.5 py-[3px] text-[10.5px] leading-none text-accent-soft">
                <Sparkles className="size-2.5" strokeWidth={2} aria-hidden="true" />
                精选
              </span>
            )}
          </div>
          <h3
            className={cn(
              'text-balance font-semibold leading-[1.28] tracking-[-0.014em]',
              featured ? 'text-[19px] sm:text-[21px]' : 'text-[16px]',
            )}
          >
            <span className="transition-colors duration-200 group-hover:text-accent-soft">
              {module.name}
            </span>
          </h3>
        </div>

      </header>

      <p
        className={cn(
          'text-pretty leading-relaxed text-muted',
          featured ? 'line-clamp-3 text-[13.5px]' : 'line-clamp-2 text-[13px]',
        )}
      >
        {module.description}
      </p>

      {!hideTags && module.tags.length > 0 && (
        <ul className="relative z-10 flex flex-wrap gap-1.5">
          {module.tags.slice(0, featured ? 4 : 3).map((tag) => (
            <li key={tag}>
              <Link
                to={`/discover?tag=${encodeURIComponent(tag)}`}
                className="tap-target relative z-10 inline-flex items-center gap-1 rounded-[var(--radius-xs)]
                           border border-line bg-inset px-2 py-1 text-[10.5px] leading-none
                           text-faint transition-colors duration-200 hover:border-line-strong hover:text-fg"
              >
                <Tag className="size-2.5" strokeWidth={2} aria-hidden="true" />
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-auto space-y-2.5 border-t border-line pt-3">
        <p className="flex items-center justify-between gap-2 text-[11px] text-faint">
          <time dateTime={toIsoDate(module.updatedAt)} title={formatDate(module.updatedAt)}>
            更新于 {formatDate(module.updatedAt)}
          </time>
          <span className="shrink-0">{formatRelative(module.updatedAt)}</span>
        </p>
        {actions()}
      </footer>
    </article>
  );
}

/**
 * Memoised on the fields that actually affect the render. Filtering and paging
 * rebuild the list array every keystroke, and without this every card re-runs
 * its avatar/date/credential work on each pass.
 */
export const ModuleCard = memo(ModuleCardImpl, (a, b) =>
  a.module.id === b.module.id &&
  a.module.updatedAt === b.module.updatedAt &&
  a.module.version === b.module.version &&
  a.variant === b.variant &&
  a.className === b.className &&
  a.hideTags === b.hideTags,
);
