import { Link } from 'react-router-dom';
import { siteConfig } from '@/config/site';
import { Container } from '@/components/common/Container';
import { Logo } from '@/components/navigation/Logo';
import { Divider } from '@/components/common/Divider';
import { useI18n } from '@/i18n';

/**
 * Footer.
 *
 * Two columns: brand, then nav. The contact/donation cards were removed at the
 * owner's request, so nothing here depends on the settings endpoint anymore.
 */
export function SiteFooter() {
  const year = new Date().getFullYear();
  const { t } = useI18n();
  const links = siteConfig.nav.filter((n) => !n.to.includes('#'));

  return (
    <footer className="mt-10 border-t border-line bg-surface/30 pb-[calc(var(--tabbar-h)+28px+env(safe-area-inset-bottom))] md:mt-20 md:pb-0">
      <Container size="wide" className="py-12 sm:py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr] lg:gap-14">
          <div className="max-w-sm">
            <Link to="/" className="inline-flex items-center gap-2.5" aria-label={t('{name} 首页', { name: siteConfig.name })}>
              <Logo className="size-6" />
              <span className="text-[14px] font-medium">{siteConfig.name}</span>
            </Link>
            <p className="mt-3.5 text-pretty text-[12.5px] leading-relaxed text-muted">
              {t(siteConfig.description)}
            </p>
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint/80">
              {t(siteConfig.footer.tagline)}
            </p>
          </div>

          <nav aria-label={t('页脚导航')}>
            <h2 className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              {t('导航')}
            </h2>
            <ul className="space-y-2.5">
              {links.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="tap-target text-[13px] text-muted transition-colors hover:text-fg"
                  >
                    {t(item.label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <Divider className="mt-10" />

        {/* Two tiers. The left column carries the legal text (affiliation, then
            who owns what), the right one is the identity/version stamp. It used
            to be four copyright lines wrapping around a © + version pair, which
            read as one blob on a phone. */}
        <div className="mt-6 flex flex-col gap-3 text-[11px] leading-relaxed text-faint sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <div className="max-w-xl space-y-1.5">
            <p className="text-pretty">{t(siteConfig.footer.disclaimer)}</p>
            <p className="text-pretty">{t(siteConfig.footer.contentLicense)}</p>
          </div>
          <div className="shrink-0 space-y-1 sm:text-right">
            <p className="tabular-nums">
              © {year} {siteConfig.name}
              <span className="mx-2 text-line-strong" aria-hidden="true">
                ·
              </span>
              {t('保留所有权利')}
            </p>
            <p className="tabular-nums text-faint/70">
              {siteConfig.name} v{siteConfig.version}
            </p>
          </div>
        </div>
      </Container>
    </footer>
  );
}
