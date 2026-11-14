import { useEffect, useRef, useState } from 'react';
import { SearchInput, type SearchInputProps } from './SearchInput';

interface Props extends Omit<SearchInputProps, 'value' | 'onChange'> {
  /** committed query (already debounced, lives in the parent) */
  value: string;
  onChange: (value: string) => void;
  /** ms of quiet before the parent is told about a new query */
  delay?: number;
}

/**
 * Search box that keeps its keystrokes to itself.
 *
 * The parent re-renders a 1400-module grid; if every keystroke re-rendered it,
 * iOS Safari would drop characters and interrupt Chinese IME composition.
 * So: local text state here, parent notified only after the user pauses, and
 * nothing is committed while a composition session is in progress.
 */
export function DebouncedSearchInput({ value, onChange, delay = 240, ...rest }: Props) {
  const [text, setText] = useState(value);
  const textRef = useRef(value);
  const composing = useRef(false);
  const timer = useRef<number | null>(null);
  const lastPushed = useRef(value);

  textRef.current = text;

  const cancel = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // External resets (back/forward, 清除全部, shared link) must win over the
  // local buffer — but our own pushes echo back and must be ignored.
  useEffect(() => {
    if (value === lastPushed.current) return;
    lastPushed.current = value;
    cancel();
    setText(value);
  }, [value]);

  const schedule = (next: string) => {
    cancel();
    timer.current = window.setTimeout(() => {
      lastPushed.current = next;
      onChange(next);
    }, delay);
  };

  useEffect(() => cancel, []);

  const commit = (next: string) => {
    cancel();
    lastPushed.current = next;
    onChange(next);
  };

  return (
    <SearchInput
      {...rest}
      value={text}
      onChange={(next) => {
        setText(next);
        // 组字未结束时不提交：否则一提交就会触发整页重渲染，把候选框顶掉。
        if (!composing.current) schedule(next);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        schedule(textRef.current);
      }}
      onSubmit={commit}
      onClear={() => commit('')}
    />
  );
}
