/**
 * GitHub content fetch for the proxy worker.
 *
 * Security posture
 * ----------------
 * The caller can only ever supply a module slug. owner/repo/branch/path come
 * from D1 rows that an operator inserted. There is no code path that accepts a
 * URL, a host, an owner, a repo or a path from the request, so the classic
 * SSRF / open-proxy failure modes are structurally impossible rather than
 * filtered against.
 *
 * Private repositories are read through the GitHub Contents API with the
 * `application/vnd.github.raw` media type. Anonymous raw.githubusercontent.com
 * URLs do not work for private repos, so they are not used.
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface ProxyTarget {
  slug: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  contentHash: string | null;
}

export type FetchOutcome =
  | { kind: 'ok'; body: ArrayBuffer; etag: string | null; sha: string | null }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'upstream'; status: number };

export interface FetchOptions {
  token: string;
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Rejects anything that is not a plain relative path inside the repo.
 * Belt-and-braces: values come from D1, but a bad admin row must not be able to
 * escape the repo or reach another host.
 */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  if (path.includes('..')) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  // Spaces and non-ASCII letters are legal in GitHub paths (e.g. "historical
  // price.sgmodule", "modules/奶茶多合一签到.sgmodule"); encodePath
  // percent-encodes each segment before hitting the API. Underscore included
  // explicitly — \p{L}\p{N} alone dropped it.
  return /^[\p{L}\p{N}./@+_\-\s]+$/u.test(path);
}

export function isSafeSegment(value: string, max = 100): boolean {
  return value.length > 0 && value.length <= max && /^[\w.-]+$/.test(value);
}

/** Percent-encodes each path segment but keeps the separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export async function fetchModuleContent(
  target: ProxyTarget,
  opts: FetchOptions,
): Promise<FetchOutcome> {
  if (!isSafeRepoPath(target.filePath)) return { kind: 'not_found' };
  if (!isSafeSegment(target.owner) || !isSafeSegment(target.repo) || !isSafeSegment(target.branch)) {
    return { kind: 'not_found' };
  }

  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
    `/contents/${encodePath(target.filePath)}?ref=${encodeURIComponent(target.branch)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github.raw',
        authorization: `Bearer ${opts.token}`,
        'x-github-api-version': GITHUB_API_VERSION,
        // identifies the integration; no secret material in the UA
        'user-agent': 'surge-modules-proxy/1.0',
      },
      signal: controller.signal,
      // never let a runtime-level cache hold an authenticated response
      cf: { cacheEverything: false },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'upstream', status: 0 };
  }
  clearTimeout(timer);

  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: 'not_found' };
  }
  if (response.status === 401 || response.status === 403) {
    // 403 from GitHub is ambiguous (permissions vs. rate limit); the
    // X-RateLimit-Remaining header disambiguates.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10);
    await response.body?.cancel();
    if (remaining === '0') {
      return { kind: 'rate_limited', retryAfterSeconds: retryAfter > 0 ? retryAfter : 60 };
    }
    return { kind: 'unauthorized' };
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '60', 10);
    await response.body?.cancel();
    return { kind: 'rate_limited', retryAfterSeconds: retryAfter > 0 ? retryAfter : 60 };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'upstream', status: response.status };
  }

  const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  if (declared > opts.maxBytes) {
    await response.body?.cancel();
    return { kind: 'too_large' };
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > opts.maxBytes) return { kind: 'too_large' };

  return {
    kind: 'ok',
    body,
    etag: response.headers.get('etag'),
    sha: response.headers.get('etag')?.replace(/"/g, '') ?? null,
  };
}
