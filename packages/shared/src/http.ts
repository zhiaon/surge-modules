import { ERROR_STATUS, type ApiErr, type ApiErrorCode, type ApiOk } from './contract';

/**
 * Response helpers. Every worker response goes through these so the JSON shape,
 * status mapping and security headers stay identical across endpoints.
 */

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // API responses are per-request; never let a shared cache hold them
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function jsonOk<T>(
  data: T,
  init?: { status?: number; meta?: ApiOk<T>['meta']; headers?: Record<string, string> },
): Response {
  const body: ApiOk<T> = { ok: true, data };
  if (init?.meta) body.meta = init.meta;
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { ...JSON_HEADERS, ...init?.headers },
  });
}

export function jsonError(
  code: ApiErrorCode,
  message: string,
  extra?: { fields?: Record<string, string>; headers?: Record<string, string> },
): Response {
  const body: ApiErr = {
    ok: false,
    error: { code, message, ...(extra?.fields ? { fields: extra.fields } : {}) },
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...extra?.headers },
  });
}

/** Small helper for the "this method is not part of the contract" case. */
export function methodNotAllowed(allowed: string[]): Response {
  return jsonError('method_not_allowed', `只支持 ${allowed.join(' / ')}`, {
    headers: { allow: allowed.join(', ') },
  });
}

/**
 * Wraps a handler so an unexpected throw becomes a 500 with a generic message.
 * The real error is logged server-side only — stack traces never reach clients.
 */
export async function guard(
  requestId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] unhandled:`, message);
    return jsonError('internal_error', '服务器内部错误');
  }
}

export function requestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
