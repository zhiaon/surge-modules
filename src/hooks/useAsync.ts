import { useEffect, useRef, useState } from 'react';

type AsyncState<T> =
  | { status: 'idle'; data: undefined; error: undefined }
  | { status: 'loading'; data: T | undefined; error: undefined }
  | { status: 'success'; data: T; error: undefined }
  | { status: 'error'; data: undefined; error: Error };

/**
 * Minimal async-resource hook. Keeps the previous data while refetching so
 * filtered lists don't flash to a skeleton on every keystroke.
 */
export function useAsync<T>(
  factory: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    status: 'idle',
    data: undefined,
    error: undefined,
  });
  const [nonce, setNonce] = useState(0);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({
      status: 'loading',
      data: prev.status === 'success' ? prev.data : undefined,
      error: undefined,
    }));
    factoryRef
      .current()
      .then((data) => {
        if (!cancelled && mounted.current) setState({ status: 'success', data, error: undefined });
      })
      .catch((err: unknown) => {
        if (!cancelled && mounted.current) {
          setState({
            status: 'error',
            data: undefined,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
