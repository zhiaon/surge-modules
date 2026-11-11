import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Send } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { Container } from '@/components/common/Container';
import { Logo } from '@/components/navigation/Logo';
import { Divider } from '@/components/common/Divider';
import { api } from '@/services/apiClient';
import { openDonateSheet } from '@/stores/donateSheet';

/**
 * Footer.
 *
 * The old 「项目」 block listed GitHub + email + Telegram as bare text links.
 * It is now a single 「联系作者」 entry — one card-like row, whole surface
 * clickable — whose URL comes from the public settings API
 * (`contact.telegram` in site_settings), editable in the admin panel with no
 * redeploy. An unconfigured link renders as plain text, never a dead anchor.
 *
 * The GitHub entry is gone on purpose: the repository is private, so a link to
 * it was either dead or misleading.
 */
export function SiteFooter() {
  const year = new Date().getFullYear();
  const links = siteConfig.nav.filter((n) => !n.to.includes('#'));

  const [telegram, setTelegram] = useState('');
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setTelegram(s.contactTelegram ?? '');
      })
      .catch(() => {
        /* the footer works without the settings endpoint; the row just
           renders as plain text */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Only https t.me links are accepted — this is a channel DM entry, not a
      free-form URL field, and a wrong scheme must not render as a link. */
  const telegramLink = /^https:\/\/t\.me\/+[A-Za-z0-9_/?=-]+$/.test(telegram.trim())
    ? telegram.trim()
    : '';

  return (
    <footer className="mt-10 border-t border-line bg-surface/30 pb-[calc(var(--tabbar-h)+28px+env(safe-area-inset-bottom))] md:mt-20 md:pb-0">
      <Container size="wide" className="py-12 sm:py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr] lg:gap-14">
          <div className="max-w-sm">
            <Link to="/" className="inline-flex items-center gap-2.5" aria-label={`${siteConfig.name} 首页`}>
              <Logo className="size-6" />
              <span className="text-[14px] font-medium">{siteConfig.name}</span>
            </Link>
            <p className="mt-3.5 text-pretty text-[12.5px] leading-relaxed text-muted">
              {siteConfig.description}
            </p>
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint/80">
              {siteConfig.footer.tagline}
            </p>
          </div>

          <nav aria-label="页脚导航">
            <h2 className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">导航</h2>
            <ul className="space-y-2.5">
              {links.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="tap-target text-[13px] text-muted transition-colors hover:text-fg"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* 联系作者 — the only entry in this column. The whole row is one
              anchor when configured; unconfigured renders inert text so there is
              never a click target that goes nowhere. */}
          <div>
            <h2 className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              联系作者
            </h2>
            {telegramLink ? (
              <a
                href={telegramLink}
                target="_blank"
                rel="noopener noreferrer"
                className="group -mx-2 flex items-center gap-3 rounded-[var(--radius-lg)] border border-line
                           bg-raised px-3.5 py-3 card-spotlight transition-[transform,border-color,background-color]
                           duration-200 hover:border-line-strong hover:bg-raised-hover
                           active:scale-[0.985] sm:-mx-3"
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)]
                             border border-line bg-inset text-muted transition-colors
                             group-hover:border-[var(--line-accent-32)] group-hover:text-accent"
                  aria-hidden="true"
                >
                  <Send className="size-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">联系作者</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-faint">
                    通过 Telegram 频道私信反馈问题或提出建议
                  </span>
                </span>
                <Send
                  className="size-3.5 shrink-0 -rotate-45 text-faint transition-colors group-hover:text-muted"
                  aria-hidden="true"
                />
              </a>
            ) : (
              <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-dashed
                              border-line px-3.5 py-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)]
                             border border-line bg-inset text-faint"
                  aria-hidden="true"
                >
                  <Send className="size-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-muted">联系作者</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-faint">
                    通过 Telegram 频道私信反馈问题或提出建议
                  </span>
                </span>
              </div>
            )}
          </div>

          {/* 支持作者 — opens the WeChat QR sheet; same card style as 联系作者 */}
          <div>
            <h2 className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              支持作者
            </h2>
            <button
              type="button"
              onClick={openDonateSheet}
              className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-[var(--radius-lg)] border border-line
                         bg-raised px-3.5 py-3 text-left card-spotlight transition-[transform,border-color,background-color]
                         duration-200 hover:border-line-strong hover:bg-raised-hover
                         active:scale-[0.985] sm:-mx-3 sm:w-[calc(100%+1.5rem)]"
            >
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)]
                           border border-line bg-inset text-muted transition-colors
                           group-hover:border-[var(--line-danger-35)] group-hover:text-danger"
                aria-hidden="true"
              >
                <Heart className="size-4" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-fg">支持作者</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-faint">
                  请作者喝杯咖啡，微信扫码捐赠
                </span>
              </span>
              <Heart
                className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-danger"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <Divider className="mt-10" />

        <div className="mt-6 flex flex-col gap-3 text-[11px] leading-relaxed text-faint sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <p className="max-w-xl text-pretty">{siteConfig.footer.disclaimer}</p>
          <p className="shrink-0 tabular-nums sm:text-right">
            © {year} {siteConfig.name}
            <span className="mx-2 text-line-strong" aria-hidden="true">
              ·
            </span>
            v{siteConfig.version}
          </p>
        </div>
      </Container>
    </footer>
  );
}
