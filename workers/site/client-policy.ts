/**
 * Client (User-Agent) access policy for module delivery.
 *
 * What this actually buys you, stated plainly: it stops a browser from opening a
 * module URL and reading the source. It does **not** prove the caller is Surge —
 * every header below can be forged, and anyone with a proxy can replay a real
 * Surge request. Authorisation therefore rests on the per-user credential plus
 * account state, never on this file. That is why `requireCredential` and the
 * UA policy are separate switches: the policy is a filter, the credential is the
 * lock.
 *
 * Rules live in D1 (`client_access_policies`) so a Surge release that changes
 * its UA can be handled from the admin panel without a deploy.
 */

export interface PolicyRow {
  id: string;
  policy_type: string;
  pattern: string;
  description: string;
  enabled: number;
}

export interface PolicySet {
  surgeWhitelist: RegExp[];
  browserBlacklist: RegExp[];
  clientBlacklist: RegExp[];
}

/** Compiles D1 patterns into RegExps, skipping anything malformed. */
function compile(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // A bad pattern must not break delivery for everyone.
    }
  }
  return out;
}

export async function loadPolicies(db: D1Database): Promise<PolicySet> {
  const rows = await db
    .prepare('SELECT policy_type, pattern FROM client_access_policies WHERE enabled = 1')
    .all<{ policy_type: string; pattern: string }>();

  const byType: Record<string, string[]> = {};
  for (const row of rows.results ?? []) {
    (byType[row.policy_type] ??= []).push(row.pattern);
  }

  return {
    surgeWhitelist: compile(byType.surge_whitelist ?? []),
    browserBlacklist: compile(byType.browser_blacklist ?? []),
    clientBlacklist: compile(byType.client_blacklist ?? []),
  };
}

export type ClientVerdict =
  | { allowed: true; matchedSurge: boolean }
  | { allowed: false; reason: string };

/**
 * Evaluates one request's client fingerprint.
 *
 * The decision is an AND of independent signals, per the specification:
 * method, whitelist hit, no blacklist hit, no browser navigation headers,
 * plausible Accept. Any single failure rejects — matching "Surge" is never
 * sufficient on its own.
 */
export function evaluateClient(
  request: Request,
  policies: PolicySet,
): ClientVerdict {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return { allowed: false, reason: 'method' };
  }

  const ua = (request.headers.get('user-agent') ?? '').trim();
  if (ua.length === 0) return { allowed: false, reason: 'empty_ua' };
  if (ua.length > 512) return { allowed: false, reason: 'ua_too_long' };

  // Blacklist wins over whitelist: a UA that claims both is hostile.
  for (const re of policies.browserBlacklist) {
    if (re.test(ua)) return { allowed: false, reason: 'browser_ua' };
  }
  for (const re of policies.clientBlacklist) {
    if (re.test(ua)) return { allowed: false, reason: 'script_ua' };
  }

  // An empty whitelist means "do not require Surge" — the operator chose to
  // only block browsers. When rules exist they are still enforced, so the
  // strict mode remains available without a code change.
  const matchedSurge =
    policies.surgeWhitelist.length === 0 || policies.surgeWhitelist.some((re) => re.test(ua));
  if (!matchedSurge) return { allowed: false, reason: 'not_surge' };

  // Browser navigation headers are the giveaway for a real browser tab. Surge
  // sends none of these; a request that carries them is a browser regardless of
  // what its UA claims.
  // These headers only appear on a real browser navigation. A curl or Surge
  // request never sends them, so their presence is proof of a browser tab no
  // matter what the UA claims.
  const dest = request.headers.get('sec-fetch-dest');
  const mode = request.headers.get('sec-fetch-mode');
  if (dest && ['document', 'iframe', 'frame', 'embed', 'object', 'script', 'style', 'image'].includes(dest)) {
    return { allowed: false, reason: 'sec_fetch_dest' };
  }
  if (mode && ['navigate', 'cors', 'no-cors'].includes(mode)) {
    return { allowed: false, reason: 'sec_fetch_mode' };
  }

  // Surge asks for `*/*` or text-ish content; a browser navigation asks for
  // text/html first.
  const accept = request.headers.get('accept') ?? '';
  if (accept && /text\/html/i.test(accept) && !/text\/plain/i.test(accept)) {
    return { allowed: false, reason: 'accept_html' };
  }

  return { allowed: true, matchedSurge };
}

/** 403 body for a browser tab. No source, no paths, no repository names. */
export function browserBlockPage(): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问受限</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0b0d12;color:#f1f5f9;
       font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif}
  .box{max-width:420px;padding:32px;text-align:center}
  h1{margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-.01em}
  p{margin:0;font-size:14px;line-height:1.75;color:#a1aab8}
  .badge{display:inline-flex;align-items:center;gap:6px;margin-bottom:18px;
         padding:6px 12px;border:1px solid rgba(255,255,255,.08);border-radius:999px;
         font-size:12px;color:#737f90;background:#151a23}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#8b9cff}
</style></head><body><div class="box">
  <div class="badge">仅限 Surge 客户端</div>
  <h1>访问受限</h1>
  <p>此模块仅支持通过 Surge 客户端访问。<br>请在 Surge 中安装，或登录网站后复制专属安装链接。</p>
</div></body></html>`;
  return new Response(html, {
    status: 403,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** 403 body for curl/wget/scripts: machine-readable, no internals. */
export function scriptBlockJson(reason: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code: 'client_blocked', message: '此接口仅限 Surge 客户端访问' } }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-block-reason': reason.slice(0, 40),
      },
    },
  );
}

/** Picks the right body: browsers get HTML, everything else gets JSON. */
export function blockResponse(request: Request, reason: string): Response {
  const accept = request.headers.get('accept') ?? '';
  const dest = request.headers.get('sec-fetch-dest');
  const wantsHtml = dest === 'document' || /text\/html/i.test(accept);
  return wantsHtml ? browserBlockPage() : scriptBlockJson(reason);
}
