/**
 * User account API client + a tiny subscription store.
 *
 * The session lives in an HttpOnly cookie, so the client never holds a token —
 * it only asks the server "who am I". `useUser()` reads that answer and
 * re-renders on login/logout via a module-level listener set (same pattern as
 * the favourites store, so the whole app shares one source of truth).
 */

import { clearCachedToken, setCachedToken } from '@/lib/credential';
import { i18n } from '@/i18n';

const BASE = '/api/v1/user';

export class UserApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** cooldown seconds, only present on rate-limited send-code responses */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UserApiError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new UserApiError(0, 'network_error', i18n.translate('网络异常，请检查连接'));
  }

  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new UserApiError(res.status, 'not_json', i18n.translate('服务暂时不可用'));
  }

  const body = (await res.json()) as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

  if (!body.ok) {
    throw new UserApiError(res.status, body.error.code, body.error.message);
  }
  return body.data as T;
}

// --------------------------------------------------------------------- types
export interface UserProfile {
  id: string;
  username: string;
  email: string;
  emailMasked: string;
  status: string;
  emailVerified: boolean;
  registeredAt: string;
}

export interface RegistrationModes {
  free: boolean;
  invite: boolean;
  approval: boolean;
  anyOpen: boolean;
  cooldownSeconds: number;
  codeTtlSeconds: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  accessCount: number;
}

export interface CredentialInfo {
  id: string;
  hint: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** most recent reset; null when the key has never been reset */
  resetAt: string | null;
  /** plaintext, owner-only. Empty for keys created before this field existed. */
  token: string;
}

export interface SessionRow {
  id: string;
  isCurrent: boolean;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
}

// --------------------------------------------------------------------- store
type Listener = () => void;
const listeners = new Set<Listener>();

let currentUser: UserProfile | null = null;
let resolved = false;
let inflight: Promise<UserProfile | null> | null = null;

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribeUser(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCurrentUser(): UserProfile | null {
  return currentUser;
}

/** True once /me has answered (the first render is "unknown", not "logged out"). */
export function isUserResolved(): boolean {
  return resolved;
}

export async function refreshUser(): Promise<UserProfile | null> {
  // Collapse concurrent probes (header + page mount both ask on first paint).
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await call<{ user: UserProfile }>('/me');
      currentUser = data.user;
    } catch (err) {
      if (err instanceof UserApiError && (err.status === 401 || err.status === 403)) {
        currentUser = null;
      } else {
        // Network failure must not silently log the user out.
        currentUser = null;
      }
    } finally {
      resolved = true;
      inflight = null;
      emit();
    }
    return currentUser;
  })();
  return inflight;
}

// ----------------------------------------------------------------------- api
export const userApi = {
  settings(): Promise<RegistrationModes> {
    return call('/settings');
  },

  sendCode(email: string): Promise<{ sent: boolean; cooldownSeconds: number }> {
    return call('/send-code', { method: 'POST', body: JSON.stringify({ email }) });
  },

  async register(input: {
    username: string;
    email: string;
    password: string;
    code: string;
    invitation?: string;
  }): Promise<{ registered: boolean; status: string; user?: UserProfile; message?: string }> {
    const res = await call<{
      registered: boolean;
      status: string;
      user?: UserProfile;
      message?: string;
    }>('/register', { method: 'POST', body: JSON.stringify(input) });
    if (res.user) {
      currentUser = res.user;
      resolved = true;
      emit();
      // No credential here: it is created by the backend on the first successful
      // login, not at registration time.
    }
    return res;
  },

  async login(account: string, password: string): Promise<{ user: UserProfile }> {
    const res = await call<{ user: UserProfile; credential?: string | null }>('/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
    currentUser = res.user;
    resolved = true;
    emit();
    // The server returns the key only on the login that created it. Whenever it
    // is absent, the cached one stays untouched — that is what makes the key
    // stable across logins, refreshes and devices.
    if (res.credential) setCachedToken(res.credential);
    // Deliberately does NOT touch credentials. Login used to auto-issue one,
    // which revoked whatever key the user's Surge install was already using —
    // the single cause of "installed fine yesterday, 401 today".
    //
    // A credential is now created in exactly two places, both explicit:
    //   * registration (once, for a brand-new account)
    //   * the 重新生成 button in the account centre
    return res;
  },

  async logout(): Promise<void> {
    await call('/logout', { method: 'POST', body: '{}' });
    // The cached token belongs to the account that just signed out; keeping it
    // would leak that key into the next session on this device.
    clearCachedToken();
    currentUser = null;
    resolved = true;
    emit();
  },

  me(): Promise<{ user: UserProfile; devices: DeviceRow[] }> {
    return call('/me');
  },

  changePassword(current: string, next: string): Promise<{ changed: boolean }> {
    return call('/password', { method: 'POST', body: JSON.stringify({ current, next }) });
  },

  sessions(): Promise<{ items: SessionRow[] }> {
    return call('/sessions');
  },

  /**
   * The single source of truth for "what key should these links carry".
   *
   * Reads it from the server every time instead of trusting a browser cache:
   * a cache can go stale (another device reset, storage cleared, a second tab
   * logged in), and a stale key produces exactly the 401 this project kept
   * hitting.
   */
  async currentToken(): Promise<string> {
    try {
      const res = await call<{ credential: { token?: string } | null }>('/credential');
      const t = res.credential?.token ?? '';
      if (t) setCachedToken(t);
      return t;
    } catch {
      return '';
    }
  },

  devices(): Promise<{
    items: DeviceRow[];
    limit: { enabled: boolean; max: number };
  }> {
    return call('/devices');
  },

  addDevice(name: string): Promise<{ deviceId: string; token: string; hint: string; name: string }> {
    return call('/devices', { method: 'POST', body: JSON.stringify({ name }) });
  },

  removeDevice(id: string): Promise<{ revoked: boolean }> {
    return call(`/devices/${id}`, { method: 'DELETE' });
  },

  credential(): Promise<{
    credential: CredentialInfo | null;
    usage: { total: number; lastAt: string | null };
    proxyBase: string;
  }> {
    return call('/credential');
  },

  /**
   * Fills a missing credential. Not exposed in the UI: the key is created on
   * first login and only an admin can replace it afterwards.
   */
  issueCredential(): Promise<{
    token: string | null;
    hint: string;
    createdAt: string;
    maxDevices: number;
    proxyBase?: string;
  }> {
    return call('/credential', { method: 'POST', body: '{}' });
  },

  revokeCredential(): Promise<{ revoked: boolean }> {
    return call('/credential/revoke', { method: 'POST', body: '{}' });
  },
};
