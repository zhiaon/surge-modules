import { Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import { MobileTabBar } from './MobileTabBar';
import { ModuleDetailSheet } from '@/components/modules/ModuleDetailSheet';
import { closeModuleSheet, useModuleSheet } from '@/stores/moduleSheet';
import { analyticsService } from '@/services/analyticsService';
import { ScrollToTop } from './ScrollToTop';
import { DonateSheet } from './DonateSheet';
import { useI18n } from '@/i18n';

export function RootLayout() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { slug: sheetSlug } = useModuleSheet();

  // A route change (back button, direct link, search result) must not leave the
  // sheet floating over an unrelated page.
  useEffect(() => {
    closeModuleSheet();
  }, [pathname]);

  useEffect(() => {
    analyticsService.trackPageView();
  }, [pathname]);

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100]
                   focus:rounded-[var(--radius-sm)] focus:border focus:border-line focus:bg-raised
                   focus:px-4 focus:py-2 focus:text-[13px]"
      >
        {t('跳到主要内容')}
      </a>

      <SiteHeader />

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <SiteFooter />


      <MobileTabBar />

      {/* Detail sheet: opened by card taps and legacy /modules/:slug links. */}
      {sheetSlug && <ModuleDetailSheet slug={sheetSlug} onClose={closeModuleSheet} />}

      <DonateSheet />
      <ScrollToTop />
    </div>
  );
}
