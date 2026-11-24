import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Download, Link2, Plus, Search, Trash2, X } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { useAsync } from '@/hooks/useAsync';
import { moduleService } from '@/services/moduleService';
import { snapshots } from '@/lib/publicSnapshots';
import { mergeModules, type MergeSource } from '@/lib/mergeModules';
import { usePageMeta } from '@/hooks/usePageMeta';
import { useI18n } from '@/i18n';
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
  const { t } = useI18n();
  usePageMeta({
    title: t('模块合集'),
    description: t('挑选多个模块，一键生成合并后的单个模块。'),
    path: '/collection',
  });

  const navigate = useNavigate();
  // Same catalogue snapshot as Home and Discover: arriving here from either
  // page paints the picker list immediately and refreshes it behind the scenes.
  const catalogue = useAsync(
    () => moduleService.getModules({ perPage: 9999 }),
    [],
    snapshots.catalogue(),
  );
  const [selected, setSelected] = useState<string[]>(() => readHash());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
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

  const build = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const sources: MergeSource[] = [];
      for (const m of chosen) {
        const res = await fetch(m.rawUrl, { credentials: 'omit' });
        if (!res.ok) throw new Error(t('读取 {name} 失败', { name: m.name }));
        sources.push({ slug: m.rawUrl, name: m.name, text: await res.text() });
      }
      const merged = mergeModules(sources, { name: t('Surge 合集（{n} 个模块）', { n: sources.length }) });
      setResult(merged.text);
      toast.show(
        t('{n} 个模块 · {m} 个段落', { n: sources.length, m: merged.sections.length }),
        undefined,
        'success',
      );
    } catch (e) {
      toast.show(t('生成失败'), e instanceof Error ? e.message : t('请稍后重试'));
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

  /** Installable URL: the proxy worker merges server-side, so Surge can fetch
      it directly instead of downloading a file first. */
  const mergeUrl = () => `https://sgmd.zhiaon.top/merge?m=${selected.join(',')}`;

  const copyInstall = async () => {
    const ok = await copyText(mergeUrl());
    toast.show(
      ok ? t('已复制安装链接') : t('复制失败'),
      ok ? t('在 Surge 里粘贴这个链接即可安装') : undefined,
      ok ? 'success' : 'default',
    );
  };

  const share = async () => {
    const ok = await copyText(`${location.origin}/collection#${selected.join(',')}`);
    toast.show(
        ok ? t('已复制') : t('复制失败'),
        ok ? t('分享后对方打开就能看到同样选择') : undefined,
        ok ? 'success' : 'default',
      );
  };

  return (
    <Container size="wide" className="pt-8 sm:pt-12">
      <button
        type="button"
        onClick={() => (history.length > 1 ? history.back() : navigate('/discover'))}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
        {t('返回')}
      </button>

      <header className="max-w-2xl">
        <span className="eyebrow">{t('合集')}</span>
        <h1 className="mt-2.5 text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.028em] sm:text-[2.4rem]">
          {t('模块合集')}
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          {t('挑选任意模块，生成一个合并后的 .sgmodule，一次导入全部生效。')}
          {t('选择会写进地址栏，可以直接分享给别人。')}
        </p>
      </header>

      {/* selected */}
      <section className="mt-7">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-medium text-muted">
            {t('已选')} <span className="tabular-nums text-fg">{chosen.length}</span>
          </h2>
          {chosen.length > 0 && (
            <button
              type="button"
              onClick={() => { setSelected([]); setResult(null); }}
              className="inline-flex items-center gap-1 text-[11.5px] text-faint hover:text-fg"
            >
              <Trash2 className="size-3" strokeWidth={2} aria-hidden="true" />
              {t('清空')}
            </button>
          )}
        </div>

        {chosen.length === 0 ? (
          <p className="mt-3 rounded-[var(--radius-md)] border border-dashed border-line px-3.5 py-4 text-[12.5px] text-faint">
            {t('还没有选择模块。在下面搜索并点击添加。')}
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

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={build}
            disabled={!chosen.length || busy}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-semibold',
              'bg-white text-[#0b0d12] transition-opacity hover:bg-white/90 disabled:opacity-40',
            )}
          >
            <Download className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
            {busy ? t('生成中…') : t('生成合集')}
          </button>
          {result && (
            <>
              <button
                type="button"
                onClick={download}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
              >
                <Download className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {t('下载 .sgmodule')}
              </button>
              <button
                type="button"
                onClick={() => void copyInstall()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
              >
                <Link2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {t('复制安装链接')}
              </button>
              <button
                type="button"
                onClick={() => void share()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
              >
                <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {t('分享此页')}
              </button>
            </>
          )}
        </div>

        {result && (
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            {t('「安装链接」是真正的模块地址，可直接粘进 Surge；「分享此页」是网页，')}
            {t('对方打开后能自己查看并下载，不能直接导入。')}
          </p>
        )}

        {result && (
          <pre className="mt-3 max-h-72 overflow-auto rounded-[var(--radius-md)] border border-line bg-inset p-3 text-[11px] leading-relaxed text-muted">
            {result.slice(0, 4000)}
          </pre>
        )}
      </section>

      {/* picker */}
      <section className="mt-8">
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-raised px-3 py-2">
          <Search className="size-4 shrink-0 text-faint" strokeWidth={1.9} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索要加入合集的模块')}
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
                      {t(m.category?.name ?? '')} · @{m.author}
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
          {t('返回模块目录')}
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
