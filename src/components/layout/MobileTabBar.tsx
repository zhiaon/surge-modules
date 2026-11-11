import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Home, Compass, Bookmark, History } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFavorites } from '@/stores/favorites';

const TABS = [
  { to: '/', label: '首页', icon: Home, end: true },
  { to: '/discover', label: '发现', icon: Compass, end: false },
  { to: '/favorites', label: '收藏', icon: Bookmark, end: false },
  { to: '/updates', label: '更新', icon: History, end: false },
] as const;

/**
 * iPhone-first bottom navigation.
 *
 * Floating pill: insets 8px from the screen edges, rounds to 26px, sits on a
 * blurred translucent surface.
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
  // Keyboard: Safari shrinks the *visual* viewport while leaving the layout
  // viewport alone, so a bar pinned to the layout bottom ends up behind the
  // keyboard. Track the visual viewport and pin the bar to its visible bottom
  // edge instead — Egern behaves the same way (its bar never hides).
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [bottom, setBottom] = useState('calc(8px + env(safe-area-inset-bottom))');

  useEffect(() => {
    const ua = navigator.userAgent;
    const isIos = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Standalone (added to Home Screen) has no browser chrome at all.
    const standalone =
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    // Safari's floating address pill straddles the safe-area inset; ~46px clears
    // it. Other iOS browsers (Chrome/Firefox) use the same WebKit chrome.
    const chromeLift = isIos && !standalone ? 18 : 0;
    setBottom(`calc(8px + env(safe-area-inset-bottom) + ${chromeLift}px)`);
    // Keep the page's bottom padding in sync so the last card never hides
    // behind the pill (46px = Safari address pill, 8px = the bar's own gap).
    document.documentElement.style.setProperty(
      '--content-bottom',
      `calc(var(--tabbar-h) + ${chromeLift + 40}px + env(safe-area-inset-bottom))`,
    );
  }, []);

  // iOS Safari shrinks the *visual* viewport for the keyboard while the layout
  // viewport stays put. Repositioning the bar against that offset put it in the
  // middle of the screen, so instead the bar fades out while typing — the
  // keyboard owns the bottom edge, and the bar returns the moment it closes.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const update = () => {
      const covered = Math.max(
        0,
        document.documentElement.clientHeight - (vv.height + vv.offsetTop),
      );
      setKeyboardOpen(covered > 120);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <nav
      aria-label="底部导航"
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
                    {isActive && (
                      <span
                        className="absolute inset-x-2.5 top-1.5 h-[calc(var(--tabbar-h)-0.75rem)] rounded-[18px] bg-[var(--tint-accent-12)]"
                        aria-hidden="true"
                      />
                    )}
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
                    <span className="relative z-10">{tab.label}</span>
                    {showBadge && <span className="sr-only">有 {favorites.length} 个收藏</span>}
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
