import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Github, Heart } from 'lucide-react';
import { siteConfig, hasLink } from '@/config/site';
import { Container } from '@/components/common/Container';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { LanguageToggle } from '@/components/common/LanguageToggle';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/navigation/Logo';
import { openDonateSheet } from '@/stores/donateSheet';
import { useI18n } from '@/i18n';

/**
 * Top navigation.
 *
 * Desktop: brand, six links, search / theme / GitHub / admin.
 * Mobile: brand, search, theme, menu — the six links move into a right-hand
 * drawer, which is the only place the two secondary entries (分类, 关于) can
 * exist without overflowing a 320px bar.
 *
 * Scrolling past 8px swaps a transparent bar for a glass one; the attribute is
 * driven by a passive scroll listener so it never blocks the compositor.
 */
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const { pathname, hash } = useLocation();
  const { t } = useI18n();


  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Anchor destinations (e.g. Categories) share a pathname with Discover.
  const activeTo = siteConfig.nav.find((item) => item.to === pathname + hash)?.to
    ?? siteConfig.nav.find((item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(`${item.to}/`)))?.to;

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-50 border-b border-transparent',
          'transition-[background-color,border-color,box-shadow] duration-300',
          scrolled ? 'glass border-b shadow-[0_1px_0_0_var(--color-line)]' : 'bg-transparent',
        )}
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <Container size="wide">
          <div className="flex h-16 items-center gap-3">
            {/* brand */}
            <Link
              to="/"
              className="flex shrink-0 items-center gap-2.5 rounded-[var(--radius-xs)] py-1"
              aria-label={t('{name} 首页', { name: siteConfig.name })}
            >
              <Logo className="size-7" />
              <span className="whitespace-nowrap text-[14.5px] font-semibold tracking-[-0.015em]">
                {siteConfig.name}
              </span>
            </Link>

            {/* desktop links */}
            <nav className="ml-2 hidden items-center gap-0.5 md:flex" aria-label={t('主导航')}>
              {siteConfig.nav.map((item) => {
                const active = item.to === activeTo;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? (item.to.includes('#') ? 'location' : 'page') : undefined}
                    className={cn(
                      'relative inline-flex h-9 items-center whitespace-nowrap rounded-[var(--radius-sm)] px-3',
                      'text-[13px] transition-colors duration-200',
                      active ? 'text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
                    )}
                  >
                    {t(item.label)}
                    {active && (
                      <span
                        className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent"
                        aria-hidden="true"
                      />
                    )}
                  </Link>
                );
              })}
            </nav>

            <div className="ml-auto flex items-center gap-1">
              {/* Donation entry kept in the header so it is visible without
                  scrolling — the footer card alone was easy to miss. */}
              <button
                type="button"
                onClick={openDonateSheet}
                aria-label={t('支持作者')}
                title={t('支持作者')}
                className="inline-flex size-10 items-center justify-center rounded-[var(--radius-sm)] text-muted transition-colors hover:bg-raised hover:text-danger"
              >
                <Heart className="size-[17px]" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <LanguageToggle />
              <ThemeToggle />

              {hasLink(siteConfig.githubUrl) ? (
                <a
                  href={siteConfig.githubUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={t('GitHub 仓库')}
                  className="hidden size-10 items-center justify-center rounded-[var(--radius-sm)] text-muted transition-colors hover:bg-raised hover:text-fg lg:inline-flex"
                >
                  <Github className="size-[17px]" strokeWidth={1.75} aria-hidden="true" />
                </a>
              ) : null}

              {/* No admin link in the public header: the entry is reachable by
                  URL only. */}

            </div>
          </div>
        </Container>
      </header>
    </>
  );
}
