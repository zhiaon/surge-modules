import { forwardRef, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** called on Enter */
  onSubmit?: (value: string) => void;
  onClear?: () => void;
  className?: string;
  inputClassName?: string;
  size?: 'md' | 'lg';
  autoFocus?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
  'aria-activedescendant'?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /** IME composition hooks — parents need these to avoid submitting mid-word */
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** keyboard hint on desktop */
  shortcut?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  {
    value,
    onChange,
    placeholder,
    onSubmit,
    onClear,
    className,
    inputClassName,
    size = 'md',
    autoFocus,
    id,
    onKeyDown,
    onCompositionStart,
    onCompositionEnd,
    shortcut,
    ...aria
  },
  ref,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t('搜索模块、作者或标签…');

  const clear = () => {
    onChange('');
    onClear?.();
    innerRef.current?.focus();
  };

  return (
    <div
      className={cn(
        'group relative flex items-center border border-line',
        'transition-colors duration-200 hover:border-line-strong focus-within:border-[var(--color-accent)]',
        size === 'lg'
          ? // 大号：明显的胶囊搜索框 —— 更高、圆角更大、浮起来一层
            'h-[3.5rem] rounded-[18px] bg-[var(--color-raised)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]'
          : 'h-11 rounded-[var(--radius-md)] bg-inset',
        className,
      )}
    >
      <Search
        className={cn(
          'pointer-events-none shrink-0 text-faint transition-colors group-focus-within:text-muted',
          size === 'lg' ? 'ml-4 size-[1.15rem]' : 'ml-3.5 size-4',
        )}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <input
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        id={id}
        type="search"
        role="searchbox"
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={resolvedPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.(value);
          else if (e.key === 'Escape' && value) {
            e.stopPropagation();
            clear();
          }
          onKeyDown?.(e);
        }}
        className={cn(
          'h-full w-full min-w-0 flex-1 bg-transparent px-2.5 text-fg outline-none',
          'placeholder:text-faint [&::-webkit-search-cancel-button]:appearance-none',
          size === 'lg' ? 'text-[15px]' : 'text-[14px]',
          inputClassName,
        )}
        {...aria}
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label={t('清空搜索')}
          className="mr-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-faint transition-colors hover:bg-surface hover:text-fg"
        >
          <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      ) : shortcut ? (
        <kbd className="mr-3 hidden shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-faint sm:inline-block">
          {shortcut}
        </kbd>
      ) : null}
    </div>
  );
});
