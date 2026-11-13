/**
 * Module proxy — static edition.
 *
 * The catalogue lives on Cloudflare Pages and every .sgmodule is a real asset
 * there (…/m/<slug>.sgmodule), so this Worker no longer owns a mapping table or
 * touches a database: it validates the slug, applies the client policy (UA
 * blocking) and streams the file from the site origin.
 *
 * Why keep a Worker at all instead of pointing sgmd.zhiaon.top straight at
 * Pages?
 *   - the stable install URL `https://sgmd.zhiaon.top/<slug>` must keep working
 *     for modules already installed on people's devices;
 *   - the UA gate (browsers get a readable 403 instead of raw config) only
 *     exists if something runs before the asset is served.
 *
 * Route: GET <proxy-host>/<slug>  →  <site-origin>/m/<slug>.sgmodule
 */

interface Env {
  /** Origin that serves the static bundle, e.g. https://son.zhiaon.top */
  SITE_ORIGIN: string;
  /** "1" blocks browser navigation; anything else lets it through. */
  UA_BLOCKING?: string;
  CACHE_TTL_SECONDS?: string;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Conservative browser detection: only what a real Surge client never sends. */
const BROWSER_UA = /(Mozilla\/|AppleWebKit\/|Chrome\/|Safari\/)/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function blockedPage(): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问受限</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#0b0d12;color:#e7ebf3;
       font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  .box{max-width:420px;padding:32px 28px;text-align:center}
  h1{margin:0 0 12px;font-size:19px;font-weight:600}
  p{margin:0;color:#828e9e;font-size:13.5px}
  code{background:#151a23;border-radius:6px;padding:2px 6px;font-size:12px}
</style></head>
<body><div class="box">
  <h1>访问受限</h1>
  <p>此地址供 Surge 安装模块使用，不支持浏览器直接访问。<br>
     请在 Surge 中通过 <code>导入</code> 添加模块。</p>
</div></body></html>`;
  return new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}


/* ------------------------------------------------------------------ merge */

/**
 * Merge several modules into one file — used by the collection builder so a
 * collection can be installed from a plain URL (Surge fetches text, not HTML).
 *
 *   GET /merge?m=jd,tieba,netflix-rating
 *
 * Rules: sections are concatenated, duplicate lines (by left-hand key) keep the
 * first occurrence, and every [MITM] hostname is unioned into one %APPEND% line.
 */
function parseModule(text: string): Map<string, string[]> {
  const body = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m) {
      current = m[1].trim();
      if (!body.has(current)) body.set(current, []);
      continue;
    }
    if (line.startsWith('#!') || current === null) continue;
    body.get(current)!.push(line);
  }
  return body;
}

function mergeTexts(parts: Array<{ name: string; text: string }>): string {
  const merged = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  const hosts = new Set<string>();

  for (const part of parts) {
    for (const [section, lines] of parseModule(part.text)) {
      if (section.toLowerCase() === 'mitm') {
        for (const line of lines) {
          const eq = line.indexOf('=');
          if (eq < 0 || line.slice(0, eq).trim().toLowerCase() !== 'hostname') continue;
          for (const h of line.slice(eq + 1).replace(/%APPEND%/gi, '').split(',')) {
            const host = h.trim();
            if (host) hosts.add(host);
          }
        }
        continue;
      }
      if (!merged.has(section)) { merged.set(section, []); seen.set(section, new Set()); }
      const target = merged.get(section)!;
      const keys = seen.get(section)!;
      for (const line of lines) {
        const s = line.trim();
        if (!s || s.startsWith('#') || s.startsWith(';')) continue;
        const eq = s.indexOf('=');
        const key = eq >= 0 ? s.slice(0, eq).trim() : s;
        if (keys.has(key)) continue;
        keys.add(key);
        target.push(line);
      }
    }
  }

  const ORDER = ['General', 'Panel', 'Script', 'URL Rewrite', 'Header Rewrite',
                 'Body Rewrite', 'Map Local', 'Host', 'Rule', 'MITM'];
  const names = [...merged.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const out: string[] = [
    `#!name=Surge 合集（${parts.length} 个模块）`,
    `#!desc=由 Surge Modules 合并：${parts.map((p) => p.name).join('、').slice(0, 180)}`,
    '#!author=Surge Modules 合集',
    '',
  ];
  for (const section of names) {
    const body = merged.get(section)!;
    if (!body.length) continue;
    out.push(`[${section}]`, ...body, '');
  }
  if (hosts.size) out.push('[MITM]', `hostname = %APPEND% ${[...hosts].sort().join(', ')}`, '');
  return out.join('\n');
}

async function handleMerge(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get('m') ?? '';
  const slugs = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (!slugs.length) {
    return json({ ok: false, error: { code: 'bad_request', message: '缺少 m 参数' } }, 400);
  }
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug)) {
      return json({ ok: false, error: { code: 'bad_request', message: `slug 不合法: ${slug}` } }, 400);
    }
  }

  const origin = (env.SITE_ORIGIN || 'https://son.zhiaon.top').replace(/\/+$/, '');
  const parts: Array<{ name: string; text: string }> = [];
  for (const slug of slugs) {
    const res = await fetch(`${origin}/m/${slug}.sgmodule`, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) continue;
    const text = await res.text();
    if (!text.trimStart().startsWith('#!')) continue; // SPA fallback / missing file
    const nameMatch = /^#!\s*name\s*=\s*(.+)$/im.exec(text);
    parts.push({ name: (nameMatch?.[1] ?? slug).trim(), text });
  }

  if (!parts.length) {
    return json({ ok: false, error: { code: 'not_found', message: '所选模块都不存在' } }, 404);
  }

  return new Response(mergeTexts(parts), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '') {
      return new Response('surge-modules proxy\nGET /<module-slug>\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (path === '/merge') {
      return handleMerge(url, env);
    }
    if (path === '/health') {
      return new Response('ok\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: { code: 'method_not_allowed', message: '仅支持 GET' } }, 405);
    }
    if (url.search.length > 0) {
      return json({ ok: false, error: { code: 'bad_request', message: '不支持查询参数' } }, 400);
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length !== 1) {
      return json({ ok: false, error: { code: 'bad_request', message: '路径格式应为 /<slug>' } }, 400);
    }

    const slug = segments[0];
    if (!SLUG_RE.test(slug)) {
      return json({ ok: false, error: { code: 'bad_request', message: 'slug 格式不合法' } }, 400);
    }

    // UA gate before anything else: a browser tab should never see raw config.
    if (env.UA_BLOCKING === '1') {
      const ua = request.headers.get('user-agent') ?? '';
      if (BROWSER_UA.test(ua)) return blockedPage();
    }

    const origin = (env.SITE_ORIGIN || 'https://son.zhiaon.top').replace(/\/+$/, '');
    const cacheTtl = Number.parseInt(env.CACHE_TTL_SECONDS ?? '3600', 10) || 3600;

    const cache = typeof caches !== 'undefined' ? (caches as unknown as CacheStorage).default : undefined;
    const cacheKey = new Request(`${origin}/m/${slug}.sgmodule`, { method: 'GET' });

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const copy = new Response(hit.body, hit);
        copy.headers.set('x-proxy-cache', 'hit');
        return copy;
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(cacheKey, {
        cf: { cacheTtl, cacheEverything: true },
        headers: { accept: 'text/plain' },
      });
    } catch {
      return json({ ok: false, error: { code: 'upstream_error', message: '读取模块失败' } }, 502);
    }

    if (!upstream.ok) {
      // 404 is the honest answer for a slug that is not in the bundle; the
      // Pages SPA fallback would otherwise hand back index.html.
      return json({ ok: false, error: { code: 'not_found', message: '模块不存在' } },
        upstream.status === 404 ? 404 : 502);
    }

    const body = await upstream.text();
    if (!body.trimStart().startsWith('#!')) {
      // Guard against a HTML payload slipping through (wrong path / fallback).
      return json({ ok: false, error: { code: 'not_found', message: '模块不存在' } }, 404);
    }

    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': `public, max-age=${cacheTtl}`,
        'x-proxy-cache': 'miss',
      },
    });

    if (cache) {
      // Store a clone; the original is returned to the client right away.
      await cache.put(cacheKey, response.clone()).catch(() => undefined);
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: response.headers });
    }
    return response;
  },
};
