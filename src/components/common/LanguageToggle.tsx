import { useEffect, useId, useRef, useState } from 'react';
import { Check, Monitor } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useI18n, type LangMode } from '@/i18n';

/**
 * Language switcher — three modes, like the theme switcher next to it.
 *
 * 'system' follows the device language (and keeps following it: the hook listens
 * for `languagechange`). The two explicit choices pin it for that device only.
 *
 * Two surfaces share this logic:
 *   • the header control, which shows the current language and opens the menu
 *   • the menu itself, which lives in a popover
 *
 * Option labels are never translated: a language picker has to be readable by
 * someone who cannot read the language currently in effect.
 */
const OPTIONS: Array<{ value: LangMode; label: string; hint: string }> = [
  { value: 'system', label: '跟随系统语言', hint: 'Follow the device language' },
  { value: 'zh', label: '简体中文', hint: 'Chinese' },
  { value: 'en', label: 'English', hint: 'English' },
];

export function LanguageToggle({ className }: { className?: string }) {
  const { mode, lang, setMode, t } = useI18n();
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

  // A two-letter marker, not a flag: flags stand for countries and a language is
  // not one. It also keeps the control inside its 40px box on a 320px phone.
  const short = mode === 'system' ? 'A' : lang === 'zh' ? '中' : 'EN';
  const currentLabel =
    mode === 'system' ? t('跟随系统语言') : lang === 'zh' ? '简体中文' : 'English';
  const label = t('切换语言，当前{lang}', { lang: currentLabel });

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
        <span
          className="text-[12px] font-semibold leading-none tracking-[-0.02em]"
          aria-hidden="true"
        >
          {short}
        </span>
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('选择语言')}
          className={cn(
            'absolute right-0 top-[calc(100%+0.5rem)] z-[70] w-52 overflow-hidden',
            'rounded-[var(--radius-lg)] border border-line bg-float p-1.5',
            'shadow-[var(--shadow-pop)]',
          )}
          style={{ animation: 'enter-up 140ms var(--ease-out-soft) both' }}
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[10.5px] uppercase tracking-[0.12em] text-faint">
            {t('语言')}
          </p>
          {OPTIONS.map((opt) => {
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
                {opt.value === 'system' ? (
                  <Monitor className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <span
                    className="w-3.5 shrink-0 text-center text-[10px] font-semibold text-faint"
                    aria-hidden="true"
                  >
                    {opt.value === 'zh' ? '中' : 'EN'}
                  </span>
                )}
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
