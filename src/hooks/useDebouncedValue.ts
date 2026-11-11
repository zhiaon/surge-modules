import { useEffect, useState } from 'react';

/** Debounce any fast-changing value (search input → query). */
export function useDebouncedValue<T>(value: T, delay = 160): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
