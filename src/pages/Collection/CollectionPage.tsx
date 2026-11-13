import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Download, Plus, Search, Trash2, X } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { useAsync } from '@/hooks/useAsync';
import { moduleService } from '@/services/moduleService';
import { mergeModules, type MergeSource } from '@/lib/mergeModules';
import { usePageMeta } from '@/hooks/usePageMeta';
import { copyText } from '@/lib/format';
import { toast } from '@/components/feedback/Toast';
import { cn } from '@/lib/cn';
import type { ModuleWithMeta } from '@/types';

/**
 * Collection builder.
 *
 * The selection lives in the URL hash (#slug,slug) so a collection is a
 * shareable link without any backend. Merging happens on demand in the
 * browser: fetch each module's raw text and combine it into one .sgmodule.
 */
export function CollectionPage() {
  usePageMeta({
    title: '模块合集',
    description: '挑选多个模块，一键生成合并后的单个模块。',
    path: '/collection',
  });

  const catalogue = useAsync(() => moduleService.getModules({ perPage: 9999 }), []);
  const [selected, setSelected] = useState<string[]>(() => readHash());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // 'single' = 每个模块一条（Surge 里分开显示）；'merged' = 合成一条
  const [mode, setMode] = useState<'single' | 'merged'>('single');
  const [result, setResult] = useState<string | null>(null);

  // keep the hash in sync so the link is always shareable
  useEffect(() => {
    const next = selected.length ? `#${selected.join(',')}` : '';
    const url = `${location.pathname}${next}`;
    history.replaceState(null, '', url);
  }, [selected]);

  const bySlug = useMemo(() => {
    const map = new Map<string, ModuleWithMeta>();
    for (const m of catalogue.data?.items ?? []) {
      map.set(m.rawUrl.split('/').pop()!.replace('.sgmodule', ''), m);
    }
    return map;
  }, [catalogue.data]);

  const chosen = selected.map((s) => bySlug.get(s)).filter(Boolean) as ModuleWithMeta[];

  const matches = useMemo(() => {
    const items = catalogue.data?.items ?? [];
    const query = q.trim().toLowerCase();
    const pool = query
      ? items.filter(
          (m) =>
            m.name.toLowerCase().includes(query) ||
            m.author.toLowerCase().includes(query) ||
            (m.category?.name ?? '').toLowerCase().includes(query),
        )
      : items;
    return pool.slice(0, 40);
  }, [catalogue.data, q]);

  const toggle = (slug: string) => {
    setResult(null);
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  };

  const installUrl = (m: ModuleWithMeta) =>
    `surge:///install-module?url=${encodeURIComponent(m.rawUrl)}`;

  const copyAll = async () => {
    const text = chosen.map((m) => `${m.name}\n${m.rawUrl}`).join('\n\n');
    const ok = await copyText(text);
    toast.show(ok ? '已复制全部链接' : '复制失败', ok ? `${chosen.length} 个模块` : undefined,
      ok ? 'success' : 'default');
  };

  const build = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const sources: MergeSource[] = [];
      for (const m of chosen) {
        const res = await fetch(m.rawUrl, { credentials: 'omit' });
        if (!res.ok) throw new Error(`读取 ${m.name} 失败`);
        sources.push({ slug: m.rawUrl, name: m.name, text: await res.text() });
      }
      const merged = mergeModules(sources, { name: `Surge 合集（${sources.length} 个模块）` });
      setResult(merged.text);
      toast.show('合集已生成', `${sources.length} 个模块 · ${merged.sections.length} 个段落`, 'success');
    } catch (e) {
      toast.show('生成失败', e instanceof Error ? e.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'surge-collection.sgmodule';
    a.click();
    URL.revokeObjectURL(url);
  };

  const share = async () => {
    const ok = await copyText(`${location.origin}/collection#${selected.join(',')}`);
    toast.show(ok ? '链接已复制' : '复制失败', ok ? '分享后对方打开就能看到同样选择' : undefined, ok ? 'success' : 'default');
  };

  return (
    <Container size="wide" className="pt-8 sm:pt-12">
      <header className="max-w-2xl">
        <span className="eyebrow">合集</span>
        <h1 className="mt-2.5 text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.028em] sm:text-[2.4rem]">
          模块合集
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          挑选任意模块，生成一个合并后的 .sgmodule，一次导入全部生效。
          选择会写进地址栏，可以直接分享给别人。
        </p>
      </header>

      {/* selected */}
      <section className="mt-7">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-medium text-muted">
            已选 <span className="tabular-nums text-fg">{chosen.length}</span> 个
          </h2>
          {chosen.length > 0 && (
            <button
              type="button"
              onClick={() => { setSelected([]); setResult(null); }}
              className="inline-flex items-center gap-1 text-[11.5px] text-faint hover:text-fg"
            >
              <Trash2 className="size-3" strokeWidth={2} aria-hidden="true" />
              清空
            </button>
          )}
        </div>

        {chosen.length === 0 ? (
          <p className="mt-3 rounded-[var(--radius-md)] border border-dashed border-line px-3.5 py-4 text-[12.5px] text-faint">
            还没有选择模块。在下面搜索并点击添加。
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {chosen.map((m) => (
              <li key={m.rawUrl}>
                <button
                  type="button"
                  onClick={() => toggle(m.rawUrl.split('/').pop()!.replace('.sgmodule', ''))}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-inset px-2.5 text-[11px] text-muted hover:border-line-strong hover:text-fg"
                >
                  {m.name.slice(0, 18)}
                  <X className="size-2.5" strokeWidth={2.2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 两种安装方式：逐个装（Surge 里分开显示）/ 合成一条 */}
        <div className="mt-4 inline-flex rounded-[var(--radius-md)] border border-line bg-raised p-0.5">
          {([
            ['single', '逐个安装'],
            ['merged', '合并成一个'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={cn(
                'rounded-[var(--radius-xs)] px-3 py-1.5 text-[11.5px] transition-colors',
                mode === value ? 'bg-raised-hover text-fg shadow-[var(--shadow-card)]' : 'text-faint hover:text-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          {mode === 'single'
            ? '每个模块单独安装，Surge 的模块列表里会分开显示、可以单独开关。'
            : '合成一条模块，Surge 里只显示一条；规则全部生效但无法单独开关。'}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={mode === 'merged' ? build : copyAll}
            disabled={!chosen.length || busy}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-semibold',
              'bg-white text-[#0b0d12] transition-opacity hover:bg-white/90 disabled:opacity-40',
            )}
          >
            {mode === 'merged' ? (
              <Download className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
            )}
            {mode === 'merged' ? (busy ? '生成中…' : '生成合集') : '复制全部链接'}
          </button>
          {mode === 'merged' && result && (
            <>
              <button
                type="button"
                onClick={download}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
              >
                <Download className="size-3.5" strokeWidth={2} aria-hidden="true" />
                下载 .sgmodule
              </button>
              <button
                type="button"
                onClick={() => void share()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
              >
                <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                复制分享链接
              </button>
            </>
          )}
        </div>

        {mode === 'merged' && result && (
          <pre className="mt-3 max-h-72 overflow-auto rounded-[var(--radius-md)] border border-line bg-inset p-3 text-[11px] leading-relaxed text-muted">
            {result.slice(0, 4000)}
          </pre>
        )}
      </section>

      {/* 逐个安装清单 */}
      {mode === 'single' && chosen.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[13px] font-medium text-muted">逐个安装</h2>
          <p className="mt-1 text-[11px] text-faint">点条目右侧按钮即可在 Surge 中安装，装完是独立的一条模块。</p>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-[var(--radius-md)] border border-line">
            {chosen.map((m) => (
              <li key={m.rawUrl} className="flex items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-fg">{m.name}</span>
                  <span className="block truncate text-[10.5px] text-faint">
                    {m.category?.name} · @{m.author}
                  </span>
                </span>
                <a
                  href={installUrl(m)}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white px-3 text-[11.5px] font-semibold text-[#0b0d12]"
                >
                  <Download className="size-3" strokeWidth={2.4} aria-hidden="true" />
                  导入
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyText(m.rawUrl);
                    toast.show(ok ? '已复制链接' : '复制失败', m.name, ok ? 'success' : 'default');
                  }}
                  className="inline-flex h-8 shrink-0 items-center rounded-full border border-line px-2.5 text-[11px] text-muted hover:text-fg"
                  aria-label={`复制 ${m.name} 的安装链接`}
                >
                  链接
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* picker */}
      <section className="mt-8">
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-raised px-3 py-2">
          <Search className="size-4 shrink-0 text-faint" strokeWidth={1.9} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索要加入合集的模块"
            className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </div>

        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-[var(--radius-md)] border border-line">
          {matches.map((m) => {
            const slug = m.rawUrl.split('/').pop()!.replace('.sgmodule', '');
            const on = selected.includes(slug);
            return (
              <li key={m.rawUrl}>
                <button
                  type="button"
                  onClick={() => toggle(slug)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                    on ? 'bg-[var(--tint-accent-10)]' : 'hover:bg-raised',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-fg">{m.name}</span>
                    <span className="block truncate text-[10.5px] text-faint">
                      {m.category?.name} · @{m.author}
                    </span>
                  </span>
                  {on ? (
                    <Check className="size-4 shrink-0 text-accent" strokeWidth={2.4} aria-hidden="true" />
                  ) : (
                    <Plus className="size-4 shrink-0 text-faint" strokeWidth={2} aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-8">
        <Link to="/discover" className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
          返回模块目录
        </Link>
      </div>
    </Container>
  );
}

function readHash(): string[] {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
}
