import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  Clock,
  Layers,
  Package,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { BottomSheet } from '@/components/common/BottomSheet';
import { GithubAvatar, groupBySource } from './StatSheetShared';
import { warmAvatars } from '@/lib/avatarCache';
import { openModuleSheet, closeModuleSheet } from '@/stores/moduleSheet';
import { closeStatSheet } from '@/stores/statSheet';
import type { ModuleWithMeta } from '@/types';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

/**
 * Four stat sheets over the homepage. All of them read the same static
 * catalogue (passed in as props) — no extra fetch per open, no skeleton wait
 * after the first render.
 */
export function StatSheets({
  kind,
  modules,
  onClose,
}: {
  kind: 'modules' | 'categories' | 'sources' | 'updates' | null;
  modules: ModuleWithMeta[] | undefined;
  onClose: () => void;
}) {
  // Route change must not leave a sheet floating over an unrelated page.
  const key = kind ?? 'none';
  useEffect(() => {
    closeModuleSheet();
  }, [key]);

  if (!kind || !modules) return null;

  const titles = {
    modules: '模块总数',
    categories: '模块分类',
    sources: '模块来源',
    updates: '最近更新',
  } as const;

  return (
    <BottomSheet
      open
      onClose={onClose}
      height="tall"
      bare
      className="sm:max-w-xl"
    >
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

      <div className="px-5 pb-6">
        <h2 className="text-[1.1rem] font-semibold tracking-[-0.02em]">{titles[kind]}</h2>
      </div>

      {kind === 'modules' && <ModulesList modules={modules} />}
      {kind === 'categories' && <CategoriesList modules={modules} />}
      {kind === 'sources' && <SourcesList modules={modules} />}
      {kind === 'updates' && <UpdatesList modules={modules} />}
    </BottomSheet>
  );
}

/* ---------------------------------------------------------------- modules */

function ModulesList({ modules }: { modules: ModuleWithMeta[] }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const PER = 20;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return modules;
    return modules.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.author.toLowerCase().includes(query) ||
        m.description.toLowerCase().includes(q),
    );
  }, [modules, q]);

  useEffect(() => setPage(1), [q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * PER, safePage * PER);

  return (
    <div className="px-5 pb-6">
      <div className="mb-3 flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-inset px-3 py-2">
        <Search className="size-3.5 shrink-0 text-faint" strokeWidth={1.9} aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索模块名称、作者或描述"
          className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
        />
      </div>

      <p className="mb-2 text-[11px] text-faint">
        共 {filtered.length} 个模块 · 第 {safePage}/{totalPages} 页
      </p>

      <ul className="space-y-1.5">
        {slice.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => {
                closeStatSheet();
                setTimeout(() => openModuleSheet(m.slug), 80);
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-line bg-inset p-3',
                'text-left transition-colors hover:border-line-strong hover:bg-raised',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{m.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-faint">
                  {m.category?.name ?? '未分类'} · @{m.author}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">
                v{m.version}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {filtered.length > PER && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-[11px] tabular-nums text-faint">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- categories */

function CategoriesList({ modules }: { modules: ModuleWithMeta[] }) {
  const [openCatId, setOpenCatId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; count: number; items: ModuleWithMeta[] }>();
    for (const m of modules) {
      const key = m.category?.id ?? 'none';
      const name = m.category?.name ?? '未分类';
      const entry = map.get(key) ?? { name, count: 0, items: [] };
      entry.count += 1;
      entry.items.push(m);
      map.set(key, entry);
    }
    return [...map.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count);
  }, [modules]);

  const openCat = openCatId ? grouped.find((c) => c.id === openCatId) : null;
  if (openCat) {
    return (
      <div className="px-5 pb-6">
        <button
          type="button"
          onClick={() => setOpenCatId(null)}
          className={cn(
            'mb-3 inline-flex items-center gap-1.5 text-[12px] text-muted',
            'transition-colors hover:text-fg',
          )}
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
          返回分类
        </button>
        <h3 className="mb-3 text-[14px] font-medium">{openCat.name}</h3>
        <ul className="space-y-1.5">
          {openCat.items.map((m) => (
            <ModuleRow key={m.id} module={m} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="px-5 pb-6">
      <ul className="space-y-2">
        {grouped.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => setOpenCatId(c.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-line bg-inset p-3.5',
                'text-left transition-colors hover:border-line-strong hover:bg-raised',
              )}
            >
              <Layers className="size-4 shrink-0 text-accent" strokeWidth={1.8} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-fg">{c.name}</span>
                <span className="mt-0.5 block text-[11px] text-faint">{c.count} 个模块</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- sources */

function SourcesList({ modules }: { modules: ModuleWithMeta[] }) {
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const sources = useMemo(() => groupBySource(modules), [modules]);

  // Warm every avatar the moment the list mounts: 23 concurrent downloads
  // finish while the user reads the first screen, so scrolling the rest of the
  // list (and opening a detail) never flashes an empty circle.
  useEffect(() => {
    warmAvatars(sources.map((s) => s.owner));
  }, [sources]);
  const active = sources.find((s) => `${s.owner}/${s.repo}` === openRepo);

  if (active) {
    return <SourceDetail source={active} onBack={() => setOpenRepo(null)} />;
  }

  return (
    <div className="px-5 pb-6">
      <p className="mb-3 text-[11px] text-faint">共 {sources.length} 个已接入的上游仓库</p>
      <ul className="space-y-2">
        {sources.map((s) => (
          <li key={`${s.owner}/${s.repo}`}>
            <button
              type="button"
              onClick={() => setOpenRepo(`${s.owner}/${s.repo}`)}
              className={cn(
                'flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-line bg-inset p-3',
                'text-left transition-colors hover:border-line-strong hover:bg-raised',
              )}
            >
              <GithubAvatar owner={s.owner} size={38} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {s.owner}
                </span>
                <span className="block truncate text-[11px] text-faint">
                  {s.owner}/{s.repo}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-[var(--tint-accent-12)] px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-accent-soft">
                {s.count}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceDetail({
  source,
  onBack,
}: {
  source: { owner: string; repo: string; count: number; modules: ModuleWithMeta[] };
  onBack: () => void;
}) {
  const fullName = `${source.owner}/${source.repo}`;
  const repoUrl = `https://github.com/${fullName}`;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const PER = 15;

  // last scan time = newest updatedAt among the repo's modules
  const lastScan = useMemo(() => {
    const times = source.modules.map((m) => m.updatedAt).sort();
    return times[times.length - 1] ?? null;
  }, [source.modules]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return source.modules;
    return source.modules.filter((m) => m.name.toLowerCase().includes(query));
  }, [source.modules, q]);

  useEffect(() => setPage(1), [q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * PER, safePage * PER);

  return (
    <div className="px-5 pb-6">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          'mb-3 inline-flex items-center gap-1.5 text-[12px] text-muted',
          'transition-colors hover:text-fg',
        )}
      >
        <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
        返回来源
      </button>

      {/* repo identity */}
      <div className="flex items-center gap-3">
        <GithubAvatar owner={source.owner} size={46} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-fg">{source.owner}</p>
          <p className="truncate text-[11.5px] text-faint">{fullName}</p>
        </div>
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`在 GitHub 打开 ${fullName}`}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <ExternalLink className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </a>
      </div>

      {/* metadata grid */}
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
          <dt className="flex items-center gap-1 text-[10px] text-faint">
            <Package className="size-2.5" strokeWidth={2.2} aria-hidden="true" />已收录
          </dt>
          <dd className="mt-0.5 text-[12px] tabular-nums text-fg">{source.count} 个</dd>
        </div>
        <div className="rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
          <dt className="flex items-center gap-1 text-[10px] text-faint">
            <GitBranch className="size-2.5" strokeWidth={2.2} aria-hidden="true" />状态
          </dt>
          <dd className="mt-0.5 text-[12px] text-ok">已接入</dd>
        </div>
        <div className="rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
          <dt className="flex items-center gap-1 text-[10px] text-faint">
            <RefreshCw className="size-2.5" strokeWidth={2.2} aria-hidden="true" />最近扫描
          </dt>
          <dd className="mt-0.5 truncate text-[11px] text-fg">
            {lastScan ? formatRelative(lastScan) : '—'}
          </dd>
        </div>
        <div className="rounded-[var(--radius-md)] border border-line bg-inset px-2.5 py-2">
          <dt className="flex items-center gap-1 text-[10px] text-faint">
            <Clock className="size-2.5" strokeWidth={2.2} aria-hidden="true" />接入时间
          </dt>
          <dd className="mt-0.5 truncate text-[11px] text-fg">—</dd>
        </div>
      </dl>

      {/* module list with search + paging */}
      <div className="mt-4">
        <div className="mb-2.5 flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-inset px-3 py-2">
          <Search className="size-3.5 shrink-0 text-faint" strokeWidth={1.9} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索该来源的模块"
            className="w-full bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          />
        </div>

        <p className="mb-2 text-[11px] text-faint">
          {filtered.length} 个模块 · 第 {safePage}/{totalPages} 页
        </p>

        <ul className="space-y-1.5">
          {slice.map((m) => (
            <ModuleRow key={m.id} module={m} />
          ))}
        </ul>

        {filtered.length > PER && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
            >
              上一页
            </button>
            <span className="text-[11px] tabular-nums text-faint">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- updates */

function UpdatesList({ modules }: { modules: ModuleWithMeta[] }) {
  const sorted = useMemo(
    () => [...modules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [modules],
  );
  // Rendering all 1200+ rows at once froze the sheet on open; page it like the
  // catalogue list instead.
  const PER = 30;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PER));
  const safePage = Math.min(page, totalPages);
  const slice = sorted.slice((safePage - 1) * PER, safePage * PER);

  return (
    <div className="px-5 pb-6">
      <p className="mb-3 text-[11px] text-faint">
        按更新时间倒序 · 共 {sorted.length} 个模块 · 第 {safePage}/{totalPages} 页
      </p>
      <ul className="space-y-1.5">
        {slice.map((m) => (
          <ModuleRow key={m.id} module={m} showDate />
        ))}
      </ul>

      {sorted.length > PER && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-[11px] tabular-nums text-faint">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[11.5px] text-muted transition-colors hover:text-fg disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function ModuleRow({ module: m, showDate = false }: { module: ModuleWithMeta; showDate?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          closeStatSheet();
          setTimeout(() => openModuleSheet(m.slug), 80);
        }}
        className={cn(
          'flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-line bg-inset p-3',
          'text-left transition-colors hover:border-line-strong hover:bg-raised',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{m.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-faint">
            {m.category?.name ?? '未分类'} · @{m.author}
            {showDate && (
              <>
                {' · '}
                {formatRelative(m.updatedAt)}
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-faint">v{m.version}</span>
      </button>
    </li>
  );
}
