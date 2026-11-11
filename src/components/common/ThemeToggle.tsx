import { useEffect, useId, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTheme } from '@/hooks/useTheme';
import type { ThemeMode } from '@/types';

const OPTIONS: Array<{ value: ThemeMode; label: string; hint: string; icon: typeof Sun }> = [
  { value: 'dark', label: '深色', hint: '始终使用深色', icon: Moon },
  { value: 'light', label: '浅色', hint: '始终使用浅色', icon: Sun },
  { value: 'system', label: '跟随系统', hint: '随设备外观自动切换', icon: Monitor },
];

/**
 * Theme switcher.
 *
 * Three modes, not a binary toggle: the product defaults to dark, but someone
 * who wants the OS to decide needs a real third option that keeps reacting to
 * `prefers-color-scheme`. The menu is a disclosure (aria-expanded + listbox),
 * not a native select, so it can show an icon per mode.
 *
 * Switching only touches <html data-theme>; nothing remounts, so there is no
 * flash and no scroll jump.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, resolved, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const Current = mode === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
  const label =
    mode === 'system' ? `主题：跟随系统（当前${resolved === 'dark' ? '深色' : '浅色'}）` : `主题：${mode === 'dark' ? '深色' : '浅色'}`;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={label}
        className={cn(
          'inline-flex size-10 items-center justify-center rounded-[var(--radius-sm)]',
          'border border-transparent text-muted transition-colors duration-200',
          'hover:border-line hover:bg-raised hover:text-fg',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          open && 'border-line bg-raised text-fg',
        )}
      >
        <Current className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="选择外观"
          className={cn(
            'absolute right-0 top-[calc(100%+0.5rem)] z-[70] w-52 overflow-hidden',
            'rounded-[var(--radius-lg)] border border-line bg-float p-1.5',
            'shadow-[var(--shadow-pop)]',
          )}
          style={{ animation: 'enter-up 140ms var(--ease-out-soft) both' }}
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[10.5px] uppercase tracking-[0.12em] text-faint">
            外观
          </p>
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  setMode(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[var(--radius-xs)] px-2.5 py-2 text-left',
                  'transition-colors duration-150',
                  active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/70 hover:text-fg',
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-tight">{opt.label}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-tight text-faint">
                    {opt.hint}
                  </span>
                </span>
                {active && (
                  <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2.2} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
