// packages/shared/src/cache.ts
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var REVISION_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function buildCacheKey(baseOrigin, parts) {
  const fmt = parts.format ?? "raw";
  const slug = SLUG_RE.test(parts.slug) ? parts.slug : "invalid";
  const rev = REVISION_RE.test(parts.revision) ? parts.revision : "unversioned";
  return `${baseOrigin}/__cache/module/${slug}/${fmt}/${rev}`;
}
function cachePolicyFor(status, ttlSeconds) {
  const cacheable = status === 200;
  return {
    ttlSeconds,
    cacheable,
    cacheControl: cacheable ? (
      // public: Surge and any intermediate is allowed to store it;
      // stale-while-revalidate keeps the edge responsive during a resync
      `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=60`
    ) : "no-store"
  };
}

// packages/shared/src/contract.ts
var ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_requests: 429,
  internal_error: 500,
  upstream_error: 502,
  upstream_timeout: 504
};

// packages/shared/src/http.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // API responses are per-request; never let a shared cache hold them
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
function jsonError(code, message, extra) {
  const body = {
    ok: false,
    error: { code, message, ...extra?.fields ? { fields: extra.fields } : {} }
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...extra?.headers }
  });
}
function methodNotAllowed(allowed) {
  return jsonError("method_not_allowed", `\u53EA\u652F\u6301 ${allowed.join(" / ")}`, {
    headers: { allow: allowed.join(", ") }
  });
}

// packages/shared/src/query.ts
var LIMITS = {
  perPageMax: 60,
  perPageDefault: 20,
  searchMaxLength: 80,
  tagMaxLength: 40,
  slugMaxLength: 80
};
var SLUG_RE2 = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validSlug(value) {
  if (!value) return null;
  const v = value.trim();
  if (v.length === 0 || v.length > LIMITS.slugMaxLength) return null;
  if (!SLUG_RE2.test(v)) return null;
  return v;
}

// workers/module-proxy/github.ts
var GITHUB_API = "https://api.github.com";
var GITHUB_API_VERSION = "2022-11-28";
function isSafeRepoPath(path) {
  if (!path || path.length > 512) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  if (path.includes("..")) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  if (/[\u0000-\u001f]/.test(path)) return false;
  return /^[\w./@+-]+$/.test(path);
}
function isSafeSegment(value, max = 100) {
  return value.length > 0 && value.length <= max && /^[\w.-]+$/.test(value);
}
function encodePath(path) {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
async function fetchModuleContent(target, opts) {
  if (!isSafeRepoPath(target.filePath)) return { kind: "not_found" };
  if (!isSafeSegment(target.owner) || !isSafeSegment(target.repo) || !isSafeSegment(target.branch)) {
    return { kind: "not_found" };
  }
  const url = `${GITHUB_API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodePath(target.filePath)}?ref=${encodeURIComponent(target.branch)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github.raw",
        authorization: `Bearer ${opts.token}`,
        "x-github-api-version": GITHUB_API_VERSION,
        // identifies the integration; no secret material in the UA
        "user-agent": "surge-modules-proxy/1.0"
      },
      signal: controller.signal,
      // never let a runtime-level cache hold an authenticated response
      cf: { cacheEverything: false }
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { kind: "timeout" };
    return { kind: "upstream", status: 0 };
  }
  clearTimeout(timer);
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: "not_found" };
  }
  if (response.status === 401 || response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "0", 10);
    await response.body?.cancel();
    if (remaining === "0") {
      return { kind: "rate_limited", retryAfterSeconds: retryAfter > 0 ? retryAfter : 60 };
    }
    return { kind: "unauthorized" };
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
    await response.body?.cancel();
    return { kind: "rate_limited", retryAfterSeconds: retryAfter > 0 ? retryAfter : 60 };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "upstream", status: response.status };
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declared > opts.maxBytes) {
    await response.body?.cancel();
    return { kind: "too_large" };
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > opts.maxBytes) return { kind: "too_large" };
  return {
    kind: "ok",
    body,
    etag: response.headers.get("etag"),
    sha: response.headers.get("etag")?.replace(/"/g, "") ?? null
  };
}

// workers/module-proxy/index.ts
var DEFAULT_TTL = 300;
var DEFAULT_MAX_BYTES = 262144;
var DEFAULT_TIMEOUT_MS = 8e3;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/" || path === "") {
      return plainText(200, "surge-modules proxy\nGET /<module-slug>\n", { "cache-control": "no-store" });
    }
    if (path === "/health") {
      return plainText(200, "ok\n", { "cache-control": "no-store" });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    if (url.search.length > 0) {
      return jsonError("bad_request", "\u4E0D\u652F\u6301\u67E5\u8BE2\u53C2\u6570");
    }
    const segments = path.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return jsonError("bad_request", "\u8DEF\u5F84\u683C\u5F0F\u5E94\u4E3A /<module-slug>");
    }
    const slug = validSlug(segments[0]);
    if (!slug) {
      return jsonError("bad_request", "slug \u683C\u5F0F\u4E0D\u5408\u6CD5");
    }
    if (!env.DB) return jsonError("internal_error", "\u6570\u636E\u5E93\u672A\u914D\u7F6E");
    const row = await env.DB.prepare(
      `SELECT p.public_slug, p.file_path, p.content_hash,
              s.owner, s.repo, s.branch, s.allow_paths
         FROM module_proxy_mappings p
         JOIN sources s ON s.id = p.source_id
        WHERE p.public_slug = ?
          AND p.deleted_at IS NULL AND p.is_enabled = 1
          AND s.deleted_at IS NULL AND s.is_enabled = 1
        LIMIT 1`
    ).bind(slug).first();
    if (!row) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
    if (!isSafeSegment(row.owner) || !isSafeSegment(row.repo) || !isSafeSegment(row.branch)) {
      return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
    }
    if (!isSafeRepoPath(row.file_path)) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
    if (!allowedByPrefix(row.file_path, row.allow_paths)) {
      return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
    }
    if (!env.GITHUB_READ_TOKEN) return jsonError("internal_error", "\u672A\u914D\u7F6E\u8BFB\u53D6\u51ED\u636E");
    const target = {
      slug: row.public_slug,
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
      filePath: row.file_path,
      contentHash: row.content_hash
    };
    const ttl = intFromEnv(env.CACHE_TTL_SECONDS, DEFAULT_TTL, 30, 86400);
    const maxBytes = intFromEnv(env.MAX_MODULE_BYTES, DEFAULT_MAX_BYTES, 1024, 4194304);
    const timeoutMs = intFromEnv(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1e3, 25e3);
    const revision = (row.content_hash ?? "v0").slice(0, 64);
    const origin = env.PUBLIC_BASE ?? url.origin;
    const cacheKey = buildCacheKey(origin, { slug, revision, format: "raw" });
    const cache = typeof caches !== "undefined" ? caches.default : void 0;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        return withHeaders(hit, { "x-proxy-cache": "hit" }, request.method === "HEAD");
      }
    }
    const outcome = await fetchModuleContent(target, {
      token: env.GITHUB_READ_TOKEN,
      maxBytes,
      timeoutMs
    });
    switch (outcome.kind) {
      case "not_found":
        return jsonError("not_found", "\u6E90\u6587\u4EF6\u4E0D\u5B58\u5728");
      case "unauthorized":
        return jsonError("forbidden", "\u65E0\u6743\u8BFB\u53D6\u6E90\u6587\u4EF6");
      case "rate_limited":
        return jsonError("too_many_requests", "\u6E90\u7AD9\u9650\u6D41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", {
          headers: { "retry-after": String(outcome.retryAfterSeconds) }
        });
      case "too_large":
        return jsonError("payload_too_large", "\u6A21\u5757\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650");
      case "timeout":
        return jsonError("upstream_timeout", "\u6E90\u7AD9\u54CD\u5E94\u8D85\u65F6");
      case "upstream":
        return jsonError("upstream_error", "\u6E90\u7AD9\u8FD4\u56DE\u5F02\u5E38");
      case "ok":
        break;
    }
    const policy = cachePolicyFor(200, ttl);
    const headers = {
      // text/plain + nosniff: module content is never allowed to be parsed as HTML
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      "cache-control": policy.cacheControl,
      "x-proxy-cache": "miss",
      // expose the revision so clients can reason about staleness
      etag: `"${revision}"`,
      "x-module-revision": revision
    };
    const response = new Response(request.method === "HEAD" ? null : outcome.body, {
      status: 200,
      headers
    });
    if (cache && policy.cacheable) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
      }
    }
    return response;
  }
};
function allowedByPrefix(filePath, allowPaths) {
  const prefixes = allowPaths.split(",").map((p) => p.trim()).filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+/, "");
    return filePath === clean || filePath.startsWith(clean.endsWith("/") ? clean : `${clean}/`);
  });
}
function intFromEnv(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
function plainText(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}
function withHeaders(source, extra, headOnly) {
  const headers = new Headers(source.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(headOnly ? null : source.body, { status: source.status, headers });
}
export {
  index_default as default
};
