/**
 * Admin HTTP client.
 *
 * Every call goes through `/api/v1/admin/*` with `credentials: 'same-origin'` so
 * the HttpOnly session cookie rides along. There is no token, no localStorage,
 * no Authorization header on the client — by design, since the server holds the
 * only credential that matters (the GitHub token) and the browser never sees it.
 */

const BASE = '/api/v1/admin';

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
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
    throw new AdminApiError(0, 'network_error', '无法连接服务器');
  }

  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new AdminApiError(res.status, 'not_json', '接口未就绪');
  }

  const body = (await res.json()) as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

  if (!body.ok) throw new AdminApiError(res.status, body.error.code, body.error.message);
  return body.data as T;
}

// ------------------------------------------------------------------- shapes
export interface AdminIdentity {
  id: string;
  username: string;
  displayName: string;
  role: 'super' | 'editor';
}

export interface DashboardCounts {
  total?: number;
  published?: number;
  hidden?: number;
  pending?: number;
  sources?: number;
  sources_on?: number;
  mappings?: number;
  mappings_on?: number;
}

export interface DashboardData {
  counts: DashboardCounts;
  syncFailures: number;
  recentSyncs: Array<Record<string, unknown>>;
  analytics: Array<{ event: string; n: number }>;
  proxy: { hits: number; misses: number; errors: number };
}

export interface AdminModuleRow {
  id: string;
  slug: string;
  name: string;
  author: string;
  version: string;
  is_published: number;
  is_featured: number;
  review_status: string;
  updated_at: string;
  category_name: string | null;
  overrides: number;
  mappings: number;
}

export interface AdminMappingRow {
  id: string;
  public_slug: string;
  file_path: string;
  is_enabled: number;
  content_hash: string | null;
  ttl_seconds: number;
  last_fetched_at: string | null;
  last_status: string | null;
  last_error: string | null;
  source_id: string;
  owner: string;
  repo: string;
  branch: string;
  source_enabled: number;
  module_name: string | null;
  is_published: number | null;
  hits: number | null;
  misses: number | null;
  errors: number | null;
}

export interface AdminSourceRow {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  allow_paths: string;
  sync_mode: string;
  is_enabled: number;
  notes: string;
  last_synced_at: string | null;
  last_status: string | null;
  locked: number;
  modules: number;
  failures: number;
}

export interface SyncJobRow {
  id: string;
  source_id: string | null;
  trigger: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
}

export interface ReviewRow {
  id: string;
  kind: string;
  status: string;
  source_path: string;
  proposed: string;
  baseline: string;
  created_at: string;
  module_name: string | null;
  slug: string | null;
  source_repo: string | null;
}

export interface AdminCategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  sort_order: number;
  is_visible: number;
  module_count: number;
}

export interface AdminAnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: string;
  is_pinned: number;
  is_published: number;
  published_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  value_type: string;
  scope: string;
}

// --------------------------------------------------------------------- api
export const adminApi = {
  session(): Promise<{ admin: AdminIdentity }> {
    return call('/session');
  },

  login(username: string, password: string): Promise<{ admin: AdminIdentity }> {
    return call('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },

  bootstrap(username: string, password: string): Promise<{ id: string }> {
    return call('/bootstrap', { method: 'POST', body: JSON.stringify({ username, password }) });
  },

  logout(): Promise<{ ok: boolean }> {
    return call('/logout', { method: 'POST', body: '{}' });
  },

  dashboard(): Promise<DashboardData> {
    return call('/dashboard');
  },

  modules(params: { q?: string; status?: string; page?: number } = {}): Promise<{
    items: AdminModuleRow[];
  }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    const suffix = qs.toString() ? `?${qs}` : '';
    return call(`/modules${suffix}`);
  },

  module(id: string): Promise<{
    module: Record<string, unknown>;
    tags: string[];
    overrides: Array<{ field: string; value: string }>;
    versions: Array<Record<string, unknown>>;
    mapping: Record<string, unknown> | null;
  }> {
    return call(`/modules/${id}`);
  },

  updateModule(id: string, patch: Record<string, unknown>): Promise<{ applied: string[] }> {
    return call(`/modules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  moduleAction(id: string, action: string): Promise<unknown> {
    return call(`/modules/${id}/${action}`, { method: 'POST', body: '{}' });
  },

  deleteModule(id: string): Promise<unknown> {
    return call(`/modules/${id}`, { method: 'DELETE' });
  },

  mappings(): Promise<{ items: AdminMappingRow[]; publicBase: string }> {
    return call('/mappings');
  },

  updateMapping(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return call(`/mappings/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  deleteMapping(id: string): Promise<unknown> {
    return call(`/mappings/${id}`, { method: 'DELETE' });
  },

  refreshMapping(id: string): Promise<{ slug: string; revision: string }> {
    return call(`/mappings/${id}/refresh`, { method: 'POST', body: '{}' });
  },

  sources(): Promise<{ items: AdminSourceRow[] }> {
    return call('/sources');
  },

  createSource(data: Record<string, unknown>): Promise<{ id: string }> {
    return call('/sources', { method: 'POST', body: JSON.stringify(data) });
  },

  updateSource(id: string, data: Record<string, unknown>): Promise<{ id: string }> {
    return call(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },

  verifySource(id: string): Promise<{ ok: boolean; reason: string }> {
    return call(`/sources/${id}/verify`, { method: 'POST', body: '{}' });
  },

  runSync(id: string | 'all'): Promise<{
    results: Array<{
      sourceId: string;
      status: string;
      scanned: number;
      added: number;
      updated: number;
      unchanged: number;
      failed: number;
      message: string;
    }>;
  }> {
    return call(`/sync/${id}`, { method: 'POST', body: '{}' });
  },

  syncJobs(sourceId?: string): Promise<{ items: SyncJobRow[] }> {
    return call(`/sync-jobs${sourceId ? `?source=${sourceId}` : ''}`);
  },

  syncLogs(jobId: string): Promise<{ items: Array<Record<string, string>> }> {
    return call(`/sync-jobs/${jobId}/logs`);
  },

  review(): Promise<{ items: ReviewRow[] }> {
    return call('/review');
  },

  decideReview(id: string, decision: 'approve' | 'reject'): Promise<unknown> {
    return call(`/review/${id}/${decision}`, { method: 'POST', body: '{}' });
  },

  categories(): Promise<{ items: AdminCategoryRow[] }> {
    return call('/categories');
  },

  createCategory(data: Record<string, unknown>): Promise<{ id: string }> {
    return call('/categories', { method: 'POST', body: JSON.stringify(data) });
  },

  updateCategory(id: string, data: Record<string, unknown>): Promise<{ id: string }> {
    return call(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },

  announcements(): Promise<{ items: AdminAnnouncementRow[] }> {
    return call('/announcements');
  },

  createAnnouncement(data: Record<string, unknown>): Promise<{ id: string }> {
    return call('/announcements', { method: 'POST', body: JSON.stringify(data) });
  },

  updateAnnouncement(id: string, data: Record<string, unknown>): Promise<{ id: string }> {
    return call(`/announcements/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },

  settings(): Promise<{ items: SettingRow[] }> {
    return call('/settings');
  },

  saveSettings(items: Array<{ key: string; value: string }>): Promise<{ updated: number }> {
    return call('/settings', { method: 'PATCH', body: JSON.stringify({ items }) });
  },

  analytics(): Promise<{
    events: Array<{ event: string; day: string; n: number }>;
    proxy: Array<{ day: string; hits: number; misses: number; errors: number }>;
  }> {
    return call('/analytics');
  },

  audit(): Promise<{ items: Array<Record<string, string>> }> {
    return call('/audit');
  },

  // ---- phase 6 ----
  createModule(data: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    return call('/modules', { method: 'POST', body: JSON.stringify(data) });
  },

  deleteCategory(id: string): Promise<unknown> {
    return call(`/categories/${id}/delete`, { method: 'POST', body: '{}' });
  },

  deleteSource(id: string): Promise<unknown> {
    return call(`/sources/${id}/delete`, { method: 'POST', body: '{}' });
  },

  deleteAnnouncement(id: string): Promise<unknown> {
    return call(`/announcements/${id}/delete`, { method: 'POST', body: '{}' });
  },

  updateLogs(): Promise<{ items: Array<Record<string, string | number>> }> {
    return call('/update-logs');
  },

  createUpdateLog(data: Record<string, unknown>): Promise<{ id: string }> {
    return call('/update-logs', { method: 'POST', body: JSON.stringify(data) });
  },

  deleteUpdateLog(id: string): Promise<unknown> {
    return call(`/update-logs/${id}`, { method: 'DELETE' });
  },

  backups(): Promise<{
    items: Array<{
      id: string;
      label: string;
      scope: string;
      bytes: number;
      row_counts: string;
      created_by: string;
      created_at: string;
    }>;
  }> {
    return call('/backups');
  },

  createBackup(label: string): Promise<{ id: string; bytes: number; rowCounts: Record<string, number> }> {
    return call('/backups', { method: 'POST', body: JSON.stringify({ label }) });
  },

  /** Triggered by a normal navigation so the browser handles the download. */
  downloadBackup(id: string): void {
    window.location.href = `/api/v1/admin/backups/${id}/download`;
  },

  restoreBackup(
    id: string,
    payload: { dryRun?: boolean; confirm?: string },
  ): Promise<{ dryRun?: boolean; wouldWrite: Record<string, number>; restored?: boolean; written?: number }> {
    return call(`/backups/${id}/restore`, { method: 'POST', body: JSON.stringify(payload) });
  },

  deleteBackup(id: string): Promise<unknown> {
    return call(`/backups/${id}`, { method: 'DELETE' });
  },

  operationLogs(): Promise<{
    items: Array<{ actor: string; action: string; target: string | null; result: string; created_at: string }>;
  }> {
    return call('/operation-logs');
  },

  exportConfig(): Promise<{ version: number; settings: unknown[]; categories: unknown[] }> {
    return call('/config/export');
  },

  importConfig(config: Record<string, unknown>): Promise<{ settingsWritten: number }> {
    return call('/config/import', { method: 'POST', body: JSON.stringify(config) });
  },

  // ---- hooks & alerts ----
  hooks(): Promise<{
    plans: Array<{
      sourceId: string;
      owner: string;
      repo: string;
      action: 'create' | 'update' | 'ok' | 'skip' | 'error';
      reason?: string;
      hookId?: number;
    }>;
    publicOrigin: string;
  }> {
    return call('/hooks');
  },

  applyHooks(sourceId: string): Promise<{
    results: Array<{ action: string; hookId?: number; reason?: string }>;
  }> {
    return call(`/hooks/${sourceId}/apply`, { method: 'POST', body: '{}' });
  },

  alerts(): Promise<{
    items: Array<{
      id: number;
      kind: string;
      message: string;
      acknowledged: number;
      created_at: string;
      source: string | null;
    }>;
  }> {
    return call('/alerts');
  },

  acknowledgeAlert(id: string): Promise<unknown> {
    return call(`/alerts/${id}/ack`, { method: 'POST', body: '{}' });
  },
};
