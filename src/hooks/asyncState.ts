/**
 * State transitions for `useAsync`, kept pure so they can be tested without a
 * renderer.
 *
 * The important distinction is *why* a request is running:
 *  - `loading` — nothing to show yet, the page renders skeletons;
 *  - `success` + `refreshing` — a list is already on screen (from a snapshot or
 *    a previous fetch) and a background refresh is in flight. Pages must not
 *    fall back to a skeleton here, so the status stays `success`.
 *
 * Errors follow the same logic: a first load that fails is an `error` state
 * (with a retry button), while a background refresh that fails keeps the last
 * good list and only records `refreshError`.
 */

export type AsyncState<T> =
  | { status: 'idle'; data: undefined; error: undefined; refreshing: false }
  | { status: 'loading'; data: undefined; error: undefined; refreshing: true }
  | {
      status: 'success';
      data: T;
      error: undefined;
      refreshing: boolean;
      /** set when a background refresh failed while `data` stayed on screen */
      refreshError?: Error;
    }
  | { status: 'error'; data: undefined; error: Error; refreshing: false };

export function idle<T>(): AsyncState<T> {
  return { status: 'idle', data: undefined, error: undefined, refreshing: false };
}

/**
 * Initial state from a snapshot read. `undefined` means "never fetched"; an
 * empty array is a real result (it must render the empty state immediately,
 * not a skeleton).
 */
export function fromSnapshot<T>(value: T | undefined): AsyncState<T> {
  if (value === undefined) return idle<T>();
  return { status: 'success', data: value, error: undefined, refreshing: true };
}

/** A request is starting: keep a list that is already on screen. */
export function begin<T>(prev: AsyncState<T>): AsyncState<T> {
  if (prev.status === 'success') {
    return { status: 'success', data: prev.data, error: undefined, refreshing: true };
  }
  return { status: 'loading', data: undefined, error: undefined, refreshing: true };
}

export function resolve<T>(value: T): AsyncState<T> {
  return { status: 'success', data: value, error: undefined, refreshing: false };
}

export function reject<T>(prev: AsyncState<T>, error: Error): AsyncState<T> {
  if (prev.status === 'success') {
    return {
      status: 'success',
      data: prev.data,
      error: undefined,
      refreshing: false,
      refreshError: error,
    };
  }
  return { status: 'error', data: undefined, error, refreshing: false };
}
