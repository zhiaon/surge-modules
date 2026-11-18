/**
 * Admin API client for the user system.
 *
 * Mirrors workers/site/admin-users.ts. Types are explicit so the panel has to
 * deal with absent values (a user with no credential, an invitation that never
 * expires) instead of printing `undefined`.
 */

const BASE = '/api/v1/admin/users';

export class AdminUserError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminUserError';
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
    throw new AdminUserError(0, 'network_error', i18n.translate('无法连接服务器'));
  }

  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new AdminUserError(res.status, 'not_json', i18n.translate('接口未就绪'));
  }
  const body = (await res.json()) as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new AdminUserError(res.status, body.error.code, body.error.message);
  return body.data as T;
}

export interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  emailMasked: string;
  status: string;
  registerMethod: string;
  emailVerified: boolean;
  registeredAt: string;
  lastLoginAt: string | null;
  activeCredentials: number;
  lastUsedAt: string | null;
  accessCount: number;
  maxDevices: number | null;
}

export interface InvitationRow {
  code: string;
  maxUses: number;
  usedCount: number;
  remaining: number;
  expiresAt: string | null;
  disabled: boolean;
  note: string;
  createdAt: string;
}

export interface ActivityPayload {
  credentials: Array<{
    id: string;
    hint: string;
    status: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  sessions: Array<{
    id: string;
    userAgent: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }>;
  access: Array<{
    slug: string;
    result: string;
    status: number;
    created_at: string;
    user_agent: string;
  }>;
  events: Array<{
    kind: string;
    actor: string;
    detail: string;
    created_at: string;
  }>;
}

export interface ApplicationRow {
  id: string;
  userId: string | null;
  username: string;
  email: string;
  emailMasked: string;
  status: string;
  note: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  emailVerified: boolean;
}

export const adminUserApi = {
  list(params: { q?: string; status?: string; page?: number; perPage?: number } = {}): Promise<{
    items: AdminUserRow[];
    total: number;
    page: number;
    perPage: number;
  }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return call(`/list${suffix}`);
  },

  setStatus(id: string, status: 'active' | 'banned' | 'pending'): Promise<{ id: string; status: string }> {
    return call(`/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  },

  remove(id: string): Promise<{ deleted: boolean }> {
    return call(`/${id}`, { method: 'DELETE' });
  },

  activity(id: string): Promise<ActivityPayload> {
    return call(`/${id}/activity`);
  },

  revokeCredentials(id: string): Promise<{ revoked: number }> {
    return call(`/${id}/revoke-credentials`, { method: 'POST', body: '{}' });
  },

  userDevices(userId: string): Promise<{
    items: Array<{ id: string; name: string; status: string; firstSeenAt: string; lastSeenAt: string | null; accessCount: number }>;
  }> {
    return call(`/${userId}/devices`);
  },

  createUserDevice(userId: string, name: string): Promise<{
    deviceId: string;
    token: string;
    hint: string;
    name: string;
  }> {
    return call(`/${userId}/devices`, { method: 'POST', body: JSON.stringify({ name }) });
  },

  revokeUserDevice(deviceId: string): Promise<{ revoked: boolean }> {
    return call(`/devices/${deviceId}`, { method: 'DELETE' });
  },

  setUserDeviceLimit(userId: string, maxDevices: number | null): Promise<{ userId: string; maxDevices: number | null }> {
    return call(`/${userId}/device-limit`, { method: 'PUT', body: JSON.stringify({ maxDevices }) });
  },

  bulkDelete(ids: string[]): Promise<{ deleted: number; failed: string[] }> {
    return call('/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
  },

  blacklist(): Promise<{ items: Array<{ email: string; reason: string; createdBy: string; createdAt: string }> }> {
    return call('/blacklist');
  },

  addToBlacklist(email: string, reason?: string): Promise<{ email: string; bannedExistingAccount: boolean }> {
    return call('/blacklist', { method: 'POST', body: JSON.stringify({ email, reason }) });
  },

  removeFromBlacklist(email: string): Promise<{ removed: boolean }> {
    return call(`/blacklist/${encodeURIComponent(email)}`, { method: 'DELETE' });
  },

  devicePolicy(): Promise<{ enabled: boolean; max: number }> {
    return call('/device-policy');
  },

  setDevicePolicy(patch: { enabled?: boolean; max?: number }): Promise<{
    enabled: boolean;
    max: number;
    usersOverLimit: number;
  }> {
    return call('/device-policy', { method: 'PUT', body: JSON.stringify(patch) });
  },

  applications(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending'): Promise<{
    items: ApplicationRow[];
    counts: Record<string, number>;
  }> {
    return call(`/applications?status=${status}`);
  },

  decideApplication(
    id: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<{ id: string; status: string }> {
    return call(`/applications/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    });
  },

  invitations(): Promise<{ items: InvitationRow[] }> {
    return call('/invitations');
  },

  createInvitations(input: {
    count: number;
    maxUses: number;
    validDays: number;
    note?: string;
  }): Promise<{ created: string[] }> {
    return call('/invitations', { method: 'POST', body: JSON.stringify(input) });
  },

  toggleInvitation(code: string, disabled: boolean): Promise<{ code: string; disabled: boolean }> {
    return call(`/invitations/${code}`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
  },

  deleteInvitation(code: string): Promise<{ deleted: boolean }> {
    return call(`/invitations/${code}`, { method: 'DELETE' });
  },
};
import { i18n } from '@/i18n';
