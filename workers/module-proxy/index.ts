import {
  buildCacheKey,
  cachePolicyFor,
} from '../../packages/shared/src/cache';
import { jsonError, methodNotAllowed } from '../../packages/shared/src/http';
import { validSlug } from '../../packages/shared/src/query';
import { fetchModuleContent, isSafeRepoPath, isSafeSegment, type ProxyTarget } from './github';
import {
  authenticate,
  basicToken,
  credentialMode,
  forbidden,
  recordAccess,
  unauthorized,
} from './auth';
import { blockResponse, evaluateClient, loadPolicies } from '../site/client-policy';

export interface Env {
  DB?: D1Database;
  /** secret: read-only Contents permission, scoped to the operator's repos */
  GITHUB_READ_TOKEN?: string;
  /** base URL of this worker, e.g. https://raw.example.com */
  PUBLIC_BASE?: string;
  ENVIRONMENT?: string;
  CACHE_TTL_SECONDS?: string;
  MAX_MODULE_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

interface MappingRow {
  public_slug: string;
  file_path: string;
  content_hash: string | null;
  owner: string;
  repo: string;
  branch: string;
  allow_paths: string;
}

/**
 * Reads the UA-blocking switch. Lives in `user_settings` so the admin panel can
 * toggle it without editing this worker; a missing column (pre-migration) means
 * "off", which keeps the worker safe on an old database.
 */
async function uaBlockingEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT ua_blocking FROM user_settings WHERE id = 1')
      .first<{ ua_blocking: number }>();
    return Number(row?.ua_blocking ?? 0) === 1;
  } catch {
    return false;
  }
}

const DEFAULT_TTL = 300;
const DEFAULT_MAX_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Module proxy worker.
 *
 * Route: GET <proxy-host>/<slug>
 *
 * There is exactly one route shape. Everything that is not a bare slug is
 * rejected before any database access, and the slug must resolve to a row that
 * is enabled *and* points at an enabled source — the allowlist lives in the
 * database, not in the request.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '') {
      return plainText(200, 'surge-modules proxy\nGET /<module-slug>\n', { 'cache-control': 'no-store' });
    }

    if (path === '/health') {
      return plainText(200, 'ok\n', { 'cache-control': 'no-store' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return methodNotAllowed(['GET', 'HEAD']);
    }

    // Reject any query string outright: the slug is the only input, and allowing
    // ?ref= or ?path= would be the beginning of a general-purpose proxy.
    if (url.search.length > 0) {
      return jsonError('bad_request', '不支持查询参数');
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length !== 1) {
      return jsonError('bad_request', '路径格式应为 /<module-slug>');
    }

    const slug = validSlug(segments[0]);
    if (!slug) {
      return jsonError('bad_request', 'slug 格式不合法');
    }

    if (!env.DB) return jsonError('internal_error', '数据库未配置');

    // ---- client policy (browser / script blocking) ----------------------
    // Runs before the credential gate so a browser tab gets a readable 403 page
    // without ever reaching the key check. Off by default: the switch lives in
    // user_settings.ua_blocking and an admin can enable it without a deploy.
    const uaEnabled = await uaBlockingEnabled(env.DB);
    let clientOk = true;
    if (uaEnabled) {
      const policies = await loadPolicies(env.DB);
      const verdict = evaluateClient(request, policies);
      if (!verdict.allowed) {
        clientOk = false;
        await recordAccess(
          { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
          {
            slug,
            method: request.method,
            userAgent: request.headers.get('user-agent') ?? '',
            status: 403,
            result: `client_blocked:${verdict.reason}`,
            ip: request.headers.get('cf-connecting-ip') ?? '0.0.0.0',
          },
        );
        return blockResponse(request, verdict.reason);
      }
    }

    // ---- credential gate ------------------------------------------------
    // Runs BEFORE the slug lookup. A request without a valid key must not learn
    // whether a slug exists, so 401 is answered without touching the mapping
    // table. When the switch is off this block is skipped entirely and the
    // worker behaves exactly as before.
    const mode = await credentialMode(env.DB);
    let authed: { userId: string; username: string; credentialId: string } | null = null;

    if (mode === 'required') {
      const outcome = await authenticate(
        { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
        request,
        slug,
      );

      if (outcome.kind !== 'ok') {
        const status = outcome.kind === 'none' || outcome.kind === 'invalid' ? 401 : 403;
        await recordAccess(
          { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
          {
            slug,
            method: request.method,
            userAgent: request.headers.get('user-agent') ?? '',
            status,
            result: outcome.kind === 'none' ? 'no_credential' : outcome.kind,
            ip: request.headers.get('cf-connecting-ip') ?? '0.0.0.0',
          },
        );
        if (outcome.kind === 'banned') return forbidden('账号已被封禁');
        if (outcome.kind === 'no_access') return forbidden('没有该模块的访问权限');
        if (outcome.kind === 'revoked') return unauthorized('访问凭证已失效');
        return unauthorized();
      }
      authed = outcome.user;
    } else if (basicToken(request)) {
      // Mode off but a key was sent: still validate it, so a wrong key is caught
      // by the user instead of silently "working" until the switch is flipped.
      const outcome = await authenticate(
        { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
        request,
        slug,
      );
      if (outcome.kind === 'ok') authed = outcome.user;
    }

    // ---- resolve slug → allowlisted source + path (single indexed lookup)
    // Resolution runs before the credential check on purpose: a missing token is
    // an operator error, and answering 500 for an unknown slug would confirm to
    // a prober that the slug exists. Unknown/disabled slugs must stay 404 even
    // when the deployment is misconfigured.
    // Two origins share one routing table: first-party repos resolve through
    // `sources`, third-party repos through the review-published mapping (owner/
    // repo/branch stored on the mapping itself). A slug belongs to exactly one
    // of them, so LEFT JOIN both and let COALESCE pick.
    const row = await env.DB.prepare(
      `SELECT p.public_slug, p.file_path, p.content_hash,
              s.owner            AS s_owner,
              s.repo             AS s_repo,
              s.branch           AS s_branch,
              s.allow_paths      AS s_allow_paths,
              s.is_enabled       AS s_enabled,
              s.deleted_at       AS s_deleted,
              t.owner            AS t_owner,
              t.repository       AS t_repo,
              t.default_branch   AS t_branch,
              t.enabled          AS t_enabled,
              t.deleted_at       AS t_deleted
         FROM module_proxy_mappings p
         LEFT JOIN sources s ON s.id = p.source_id
         LEFT JOIN third_party_repositories t ON t.id = p.third_party_repository_id
        WHERE p.public_slug = ?
          AND p.deleted_at IS NULL AND p.is_enabled = 1
        LIMIT 1`,
    )
      .bind(slug)
      .first<Record<string, string | number | null>>();

    // Normalise the two origins into one routing shape; a row whose backing
    // repository is disabled/deleted stays a 404, same as an unknown slug.
    let mapped: MappingRow | null = null;
    if (row) {
      if (row.s_owner) {
        mapped =
          row.s_enabled === 1 && row.s_deleted === null
            ? {
                public_slug: row.public_slug as string,
                file_path: row.file_path as string,
                content_hash: (row.content_hash as string) ?? null,
                owner: row.s_owner as string,
                repo: row.s_repo as string,
                branch: row.s_branch as string,
                allow_paths: (row.s_allow_paths as string) ?? '',
              }
            : null;
      } else if (row.t_owner) {
        mapped =
          row.t_enabled === 1 && row.t_deleted === null
            ? {
                public_slug: row.public_slug as string,
                file_path: row.file_path as string,
                content_hash: (row.content_hash as string) ?? null,
                owner: row.t_owner as string,
                repo: row.t_repo as string,
                branch: row.t_branch as string,
                allow_paths: '',
              }
            : null;
      }
    }

    // Unknown, disabled or orphaned mappings are indistinguishable to the client.
    if (!mapped) return jsonError('not_found', '模块不存在');

    if (!isSafeSegment(mapped.owner) || !isSafeSegment(mapped.repo) || !isSafeSegment(mapped.branch)) {
      return jsonError('not_found', '模块不存在');
    }
    if (!isSafeRepoPath(mapped.file_path)) return jsonError('not_found', '模块不存在');
    if (!allowedByPrefix(mapped.file_path, mapped.allow_paths)) {
      return jsonError('not_found', '模块不存在');
    }

    if (!env.GITHUB_READ_TOKEN) return jsonError('internal_error', '未配置读取凭据');

    const target: ProxyTarget = {
      slug: mapped.public_slug,
      owner: mapped.owner,
      repo: mapped.repo,
      branch: mapped.branch,
      filePath: mapped.file_path,
      contentHash: mapped.content_hash,
    };

    // ---- cache
    const ttl = intFromEnv(env.CACHE_TTL_SECONDS, DEFAULT_TTL, 30, 86_400);
    const maxBytes = intFromEnv(env.MAX_MODULE_BYTES, DEFAULT_MAX_BYTES, 1024, 4_194_304);
    const timeoutMs = intFromEnv(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 25_000);

    const revision = (row.content_hash ?? 'v0').slice(0, 64);
    const origin = env.PUBLIC_BASE ?? url.origin;
    // In credential mode the cache key must include the user, otherwise one
    // user's authorised response could be served to another (or to an expired
    // credential) for the whole TTL. `authed` is null when the gate is off, so
    // public mode keeps its original, shareable key.
    const cacheScope = authed ? `u:${authed.userId}` : 'public';
    const cacheKey = buildCacheKey(origin, {
      slug,
      revision,
      format: `raw:${cacheScope}`,
    });

    const cache = typeof caches !== 'undefined' ? (caches as CacheStorage).default : undefined;

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        return withHeaders(hit, { 'x-proxy-cache': 'hit' }, request.method === 'HEAD');
      }
    }

    // ---- upstream
    const outcome = await fetchModuleContent(target, {
      token: env.GITHUB_READ_TOKEN,
      maxBytes,
      timeoutMs,
    });

    switch (outcome.kind) {
      case 'not_found':
        return jsonError('not_found', '源文件不存在');
      case 'unauthorized':
        // deliberately vague: never reveal whether the repo exists or is private
        return jsonError('forbidden', '无权读取源文件');
      case 'rate_limited':
        return jsonError('too_many_requests', '源站限流，请稍后重试', {
          headers: { 'retry-after': String(outcome.retryAfterSeconds) },
        });
      case 'too_large':
        return jsonError('payload_too_large', '模块文件超过大小上限');
      case 'timeout':
        return jsonError('upstream_timeout', '源站响应超时');
      case 'upstream':
        return jsonError('upstream_error', '源站返回异常');
      case 'ok':
        break;
    }

    const policy = cachePolicyFor(200, ttl);
    // A credentialed response is never public: it is tied to one account and
    // must not be stored by a shared cache. no-store also keeps a revoked key
    // from working until the TTL expires.
    const cacheControl = authed
      ? 'private, no-store, max-age=0'
      : policy.cacheControl;
    const headers: Record<string, string> = {
      // text/plain + nosniff: module content is never allowed to be parsed as HTML
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'cache-control': cacheControl,
      'x-proxy-cache': 'miss',
      // expose the revision so clients can reason about staleness
      etag: `"${revision}"`,
      'x-module-revision': revision,
    };

    const response = new Response(request.method === 'HEAD' ? null : outcome.body, {
      status: 200,
      headers,
    });

    if (authed) {
      // Best-effort; never blocks the response.
      void recordAccess(
        { DB: env.DB, RATE_LIMIT_SALT: env.RATE_LIMIT_SALT },
        {
          slug,
          method: request.method,
          userAgent: request.headers.get('user-agent') ?? '',
          status: 200,
          result: 'ok',
          userId: authed.userId,
          credentialId: authed.credentialId,
          ip: request.headers.get('cf-connecting-ip') ?? '0.0.0.0',
        },
      );
    }

    if (cache && policy.cacheable && !authed) {
      // `waitUntil` is not available here, so the copy is awaited: correctness
      // over a few hundred microseconds.
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        /* cache write failures must never fail the request */
      }
    }

    return response;
  },
} satisfies ExportedHandler<Env>;

function allowedByPrefix(filePath: string, allowPaths: string): boolean {
  const prefixes = allowPaths
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // empty allowlist means "anywhere inside the repo" — still inside the repo
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+/, '');
    return filePath === clean || filePath.startsWith(clean.endsWith('/') ? clean : `${clean}/`);
  });
}

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function plainText(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/** Copies a cached response, forcing the cache-status header and HEAD semantics. */
function withHeaders(
  source: Response,
  extra: Record<string, string>,
  headOnly: boolean,
): Response {
  const headers = new Headers(source.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(headOnly ? null : source.body, { status: source.status, headers });
}
