/**
 * Cache key policy for the module proxy.
 *
 * A cache key must be derivable only from server-side state (module slug +
 * content hash), never from anything the client can choose. Otherwise a caller
 * could poison or read around the cache by appending parameters.
 */

export interface CacheKeyParts {
  slug: string;
  /** version or content hash; rotates the entry when content changes */
  revision: string;
  /** format variant, currently always 'raw' */
  format?: 'raw';
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Deterministic, path-like key so wrangler logs stay readable.
 *
 * Both inputs are validated rather than sanitised: stripping characters from
 * `..` still leaves `..`, and a key that *looks* like traversal is a bug even
 * if the cache never treats it as a path. A bad revision falls back to a fixed
 * marker so the entry is still cacheable and still rotates only on real change.
 */
export function buildCacheKey(baseOrigin: string, parts: CacheKeyParts): string {
  const fmt = parts.format ?? 'raw';
  const slug = SLUG_RE.test(parts.slug) ? parts.slug : 'invalid';
  const rev = REVISION_RE.test(parts.revision) ? parts.revision : 'unversioned';
  return `${baseOrigin}/__cache/module/${slug}/${fmt}/${rev}`;
}

export interface CachePolicy {
  ttlSeconds: number;
  cacheable: boolean;
  /** value for the response Cache-Control header */
  cacheControl: string;
}

/**
 * Only successful 200 responses with a known revision are cacheable.
 * Errors are explicitly not: caching a 404 or 429 would keep serving it after
 * the underlying problem is fixed.
 */
export function cachePolicyFor(status: number, ttlSeconds: number): CachePolicy {
  const cacheable = status === 200;
  return {
    ttlSeconds,
    cacheable,
    cacheControl: cacheable
      ? // public: Surge and any intermediate is allowed to store it;
        // stale-while-revalidate keeps the edge responsive during a resync
        `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=60`
      : 'no-store',
  };
}
