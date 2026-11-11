/**
 * Credential cache + link building.
 *
 * The access token plaintext exists in exactly two places: the response that
 * creates it, and this browser. D1 only keeps a SHA-256 hash, so the server
 * cannot rebuild a user's link later — it must come from the client.
 *
 * Storing it in localStorage is a deliberate trade-off, matching how the
 * favourites already work:
 *   - without it, every install would require the user to hand-assemble a URL
 *     containing a 43-character token (and get the `@` in the right place)
 *   - the token is revocable in one tap, so an XSS-sized leak is recoverable
 *   - the site loads no third-party scripts, so the realistic XSS surface is
 *     our own rendering, which is text-only
 *
 * Keys are namespaced per user id so switching accounts on one device does not
 * hand one user another user's credential.
 */

import { getCurrentUser } from '@/services/userApi';

const STORAGE_PREFIX = 'surge-modules:credential:v1';

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

/** Returns the cached token for the signed-in user, if any. */
export function getCachedToken(): string | null {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    return window.localStorage.getItem(keyFor(user.id));
  } catch {
    return null;
  }
}

/** Replaces the cache after an explicit reset (the old key is now dead). */
export function replaceCachedToken(token: string): void {
  setCachedToken(token);
}

export function setCachedToken(token: string): void {
  const user = getCurrentUser();
  if (!user) return;
  try {
    window.localStorage.setItem(keyFor(user.id), token);
  } catch {
    /* private mode / quota — the link falls back to the public form */
  }
}

export function clearCachedToken(): void {
  const user = getCurrentUser();
  if (!user) return;
  try {
    window.localStorage.removeItem(keyFor(user.id));
  } catch {
    /* ignore */
  }
}

/**
 * Injects the token into a proxy URL.
 *
 * `https://sgmd.zhiaon.top/qimao` → `https://<token>@sgmd.zhiaon.top/qimao`
 *
 * Returns the original URL when there is no token, so a visitor who is not
 * signed in still sees a (public-mode) working link instead of a broken one.
 */
export function withCredential(rawUrl: string, token = getCachedToken()): string {
  if (!token || !rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.endsWith('zhiaon.top')) return rawUrl;
    if (url.username) return rawUrl; // already carries a credential
    url.username = token;
    // Deliberately no password part: `https://token@host` is what the proxy
    // accepts, and it keeps the string copy-paste friendly.
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** Splits a proxy URL into its parts so the UI can show the slug separately. */
export function proxySlug(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/** The `surge:///install-module?url=` deeplink for a given proxy URL. */
export function installDeepLink(proxyUrl: string): string {
  // Surge needs an absolute URL: a bare /m/x.sgmodule has no host to fetch from.
  // Resolve against the current origin so the link works on pages.dev, a
  // preview deployment and the final custom domain without a rebuild.
  let absolute = proxyUrl;
  try {
    absolute = new URL(proxyUrl, window.location.origin).toString();
  } catch {
    /* leave as-is if it cannot be parsed */
  }
  return `surge:///install-module?url=${encodeURIComponent(absolute)}`;
}
