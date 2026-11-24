import { useEffect, useState } from 'react';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';
import { NavLink } from 'react-router-dom';
import { Home, Compass, Bookmark, History } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFavorites } from '@/stores/favorites';
import { useI18n } from '@/i18n';

const TABS = [
  { to: '/', label: '首页', icon: Home, end: true },
  { to: '/discover', label: '发现', icon: Compass, end: false },
  { to: '/favorites', label: '收藏', icon: Bookmark, end: false },
  { to: '/updates', label: '更新', icon: History, end: false },
] as const;

/**
 * iPhone-first bottom navigation.
 *
 * Floating navigation surface: insets 8px from the screen edges, rounds to 26px,
 * sits on a blurred translucent surface. The active item uses a short underline
 * that expands in place, matching the restrained mobile navigation pattern.
 *
 * iOS keyboard handling: when the software keyboard opens, Safari shrinks the
 * *visual* viewport but leaves the *layout* viewport untouched — a fixed
 * element positioned against the layout viewport ends up underneath the
 * keyboard (the "tab bar disappeared" bug). We read `visualViewport` and pin
 * the bar to the visible bottom edge instead, and hide it while typing so it
 * never covers the suggestions bar.
 */
export function MobileTabBar() {
  const favorites = useFavorites();
  const { t } = useI18n();
  // Keyboard: Safari shrinks the *visual* viewport while leaving the layout
  // viewport alone, so a bar pinned to the layout bottom ends up behind the
  // keyboard. Track the visual viewport and pin the bar to its visible bottom
  // edge instead — Egern behaves the same way (its bar never hides).
  const keyboardOpen = useKeyboardOpen();
  const [bottom, setBottom] = useState('calc(4px + env(safe-area-inset-bottom))');

  useEffect(() => {
    const ua = navigator.userAgent;
    const isIos = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Standalone (added to Home Screen) has no browser chrome at all.
    const standalone =
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    // Safari's floating address pill straddles the safe-area inset; a small
    // lift clears it without leaving a visible gap under the bar.
    const chromeLift = isIos && !standalone ? 12 : 0;
    setBottom(`calc(4px + env(safe-area-inset-bottom) + ${chromeLift}px)`);
    // Keep the page's bottom padding in sync so the last card never hides
    // behind the pill (46px = Safari address pill, 8px = the bar's own gap).
    document.documentElement.style.setProperty(
      '--content-bottom',
      `calc(var(--tabbar-h) + ${chromeLift + 36}px + env(safe-area-inset-bottom))`,
    );
  }, []);

  // iOS Safari shrinks the *visual* viewport for the keyboard while the layout
  // viewport stays put. Repositioning the bar against that offset put it in the
  // middle of the screen, so instead the bar fades out while typing — the
  // keyboard owns the bottom edge, and the bar returns the moment it closes.
  // The scroll buttons read the same signal (see ScrollJumps).

  return (
    <nav
      aria-label={t('底部导航')}
      className={cn(
        'fixed inset-x-2 z-40 md:hidden',
        'rounded-[26px] border border-[var(--line-soft)]',
        'bg-[var(--glass-bg)] backdrop-blur-[20px] backdrop-saturate-150',
        'shadow-[0_1px_0_0_var(--glass-highlight)_inset,0_4px_16px_-6px_rgba(0,0,0,0.12)]',
        'transition-opacity duration-200',
        keyboardOpen ? 'pointer-events-none opacity-0' : 'opacity-100',

      )}
      style={{ bottom }}
    >
      <ul className="flex items-stretch justify-around px-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const showBadge = tab.to === '/favorites' && favorites.length > 0;
          return (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                end={tab.end}
                data-own-tap-feedback
                className={({ isActive }) =>
                  cn(
                    'relative flex h-[var(--tabbar-h)] flex-col items-center justify-center gap-1',
                    'text-[10.5px] font-medium tracking-wide transition-colors duration-200',
                    isActive ? 'text-accent' : 'text-faint hover:text-muted',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative z-10">
                      <Icon
                        className="size-[20px]"
                        strokeWidth={isActive ? 1.9 : 1.6}
                        aria-hidden="true"
                      />
                      {showBadge && (
                        <span
                          className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-accent"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span
                      className={cn(
                        'absolute bottom-[5px] left-1/2 h-[3px] -translate-x-1/2 rounded-full',
                        'bg-accent transition-[width,opacity] duration-100 ease-out',
                        isActive ? 'w-10 opacity-100' : 'w-6 opacity-0',
                      )}
                      aria-hidden="true"
                    />
                    <span className="relative z-10">{t(tab.label)}</span>
                    {showBadge && <span className="sr-only">
                      {t('有 {n} 个收藏', { n: favorites.length })}
                    </span>}
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
