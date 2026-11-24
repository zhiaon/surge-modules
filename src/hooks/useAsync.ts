import { useEffect, useRef, useState } from 'react';
import { begin, fromSnapshot, reject, resolve, type AsyncState } from './asyncState';

export type { AsyncState };

/**
 * Optional snapshot binding (see `lib/publicSnapshots.ts`).
 *
 * `key` identifies the exact request. When it changes the hook drops whatever
 * it was rendering and starts from the new key's snapshot — a list built from a
 * different set of favorites is never shown under the new key.
 */
export interface AsyncSnapshot<T> {
  key: string;
  peek: () => T | undefined;
  save: (value: T) => void;
}

/**
 * Minimal async-resource hook.
 *
 * Three behaviours matter for the card lists:
 *  1. A snapshot hit renders as `success` on the very first frame, so coming
 *     back from the bottom tab bar never flashes skeletons.
 *  2. The factory still runs on every mount: the snapshot is refreshed in the
 *     background and the new result replaces it when it arrives (status stays
 *     `success`, `refreshing` is true meanwhile).
 *  3. A changed `key` invalidates the snapshot immediately instead of showing
 *     the previous list until the new request settles.
 */
export function useAsync<T>(
  factory: () => Promise<T>,
  deps: readonly unknown[],
  snapshot?: AsyncSnapshot<T>,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>(() => fromSnapshot(snapshot?.peek()));
  const [nonce, setNonce] = useState(0);
  const [activeKey, setActiveKey] = useState<string | undefined>(snapshot?.key);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const mounted = useRef(true);

  // Render-phase reset on a key change (an allowed derived-state update): the
  // new key's snapshot or nothing at all — never the old key's data.
  if (snapshot?.key !== activeKey) {
    setActiveKey(snapshot?.key);
    setState(fromSnapshot(snapshot?.peek()));
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const binding = snapshotRef.current;
    setState((prev) => begin(prev));
    factoryRef
      .current()
      .then((data) => {
        if (cancelled || !mounted.current) return;
        binding?.save(data);
        setState(resolve(data));
      })
      .catch((err: unknown) => {
        if (cancelled || !mounted.current) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => reject(binding ? prev : fromSnapshot<T>(undefined), error));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, activeKey]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
