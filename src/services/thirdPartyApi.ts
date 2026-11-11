/**
 * Third-party repository API client.
 *
 * Mirrors `workers/site/admin-third-party.ts`. Types are written by hand rather
 * than inferred so the UI is forced to deal with optional fields — most of this
 * data is "not yet checked" or "never notified" for a brand-new repository, and
 * rendering `undefined` as a real value is how dashboards start lying.
 */

const BASE = '/api/v1/admin/third-party';

export class ThirdPartyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ThirdPartyError';
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
    throw new ThirdPartyError(0, 'network_error', '无法连接服务器');
  }

  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ThirdPartyError(res.status, 'not_json', '接口未就绪');
  }

  const body = (await res.json()) as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

  if (!body.ok) throw new ThirdPartyError(res.status, body.error.code, body.error.message);
  return body.data as T;
}

// --------------------------------------------------------------------- types
export interface Repository {
  id: string;
  name: string;
  owner: string;
  repository: string;
  repositoryUrl: string;
  defaultBranch: string;
  description: string;
  categoryId: string | null;
  notes: string;
  enabled: boolean;
  webhookEnabled: boolean;
  cronEnabled: boolean;
  manualCheckEnabled: boolean;
  hasWebhookSecret: boolean;
  webhookSecretHint: string;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastCheckStatus: string | null;
  lastCheckError: string;
  consecutiveFailures: number;
  autoReviewNew: boolean;
  autoReviewUpdate: boolean;
  discoveredModules: number;
  publishedModules: number;
  pendingNew: number;
  pendingUpdates: number;
  createdAt: string;
}

export interface RepositoryStats {
  total: number;
  enabled: number;
  disabled: number;
  discoveredModules: number;
  pendingNew: number;
  pendingUpdates: number;
  pendingDeletes: number;
  lastCheckedAt: string | null;
  lastCheckStatus: string | null;
}

export interface CheckOutcome {
  path: string;
  status: 'new' | 'updated' | 'deleted' | 'unchanged' | 'failed' | 'skipped';
  reason?: string;
  taskId?: string;
  version?: string;
  commitSha?: string;
}

export interface CheckResponse {
  ok: boolean;
  logId: string;
  branch: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  newModules: number;
  updatedModules: number;
  deletedModules: number;
  unchanged: number;
  failed: number;
  filesScanned: number;
  error: string;
  outcomes: CheckOutcome[];
}

export interface CheckLog {
  id: string;
  detection_method: string;
  check_status: string;
  new_modules_count: number;
  updated_modules_count: number;
  deleted_modules_count: number;
  unchanged_modules_count: number;
  failed_count: number;
  files_scanned: number;
  branch: string;
  error_message: string;
  started_at: string;
  finished_at: string | null;
}

export interface RepoModule {
  id: string;
  module_name: string;
  file_path: string;
  branch: string;
  current_version: string;
  published: number;
  is_deleted_upstream: number;
  last_seen_at: string | null;
  updated_at: string;
  module_slug: string | null;
  module_published: number | null;
}

export interface ReviewStats {
  pendingNew: number;
  pendingUpdates: number;
  pendingDeletes: number;
  approved: number;
  rejected: number;
  total: number;
  oldestPendingAt: string | null;
}

export interface ReviewSummary {
  id: string;
  taskType: 'new' | 'update' | 'delete';
  detectionMethod: 'webhook' | 'manual' | 'cron';
  reviewStatus: string;
  filePath: string;
  branch: string;
  oldVersion: string;
  newVersion: string;
  commitSha: string;
  contentSha: string;
  repositoryId: string;
  repositoryName: string | null;
  owner: string | null;
  repository: string | null;
  moduleId: string | null;
  moduleName: string | null;
  moduleSlug: string | null;
  liveVersion: string | null;
  rejectionReason: string;
  reviewer: string | null;
  reviewedAt: string | null;
  createdAt: string;
  notifyStatus: string;
}

export interface ReviewDetail extends ReviewSummary {
  oldContent: string;
  newContent: string;
  liveSha: string | null;
  note: string;
  notifyError: string;
  supersededBy: string | null;
  overrides: {
    name: string | null;
    description: string | null;
    categoryId: string | null;
    icon: string | null;
    featured: boolean | null;
  };
  audits: Array<{
    action: string;
    operator: string;
    source: string;
    details: string;
    created_at: string;
  }>;
}

export interface ReviewList {
  items: ReviewSummary[];
  total: number;
  page: number;
  perPage: number;
  stats: ReviewStats;
}

export interface ThirdPartySettings {
  settings: {
    autoEnabled: boolean;
    defaultInterval: number;
    cronExpression: string;
    maxReposPerRun: number;
    maxFilesPerRun: number;
    maxRunSeconds: number;
    maxRetries: number;
    notifyOnCheck: boolean;
    notifyNew: boolean;
    notifyUpdate: boolean;
    notifyDelete: boolean;
    notifyFailure: boolean;
    notifyReviewed: boolean;
  };
  telegram: {
    hasToken: boolean;
    adminIdConfigured: boolean;
    adminIdHint: string;
  };
  github: { hasToken: boolean };
  encryptionKey: { configured: boolean };
}

/** A credential is never returned; this is what the panel may show about it. */
export interface CredentialStatus {
  fromPanel: boolean;
  usable: boolean;
  hint: string;
  hasFallback: boolean;
}

export interface SchedulerResult {
  ran: boolean;
  reason?: string;
  reposChecked: number;
  newModules: number;
  updatedModules: number;
  deletedModules: number;
  failed: number;
  durationMs: number;
}

// ----------------------------------------------------------------------- api
export const thirdPartyApi = {
  repositories(): Promise<{ items: Repository[]; stats: RepositoryStats }> {
    return call('/repositories');
  },

  create(payload: Record<string, unknown>): Promise<{ id: string; defaultBranch: string; repositoryWarning?: string }> {
    return call('/repositories', { method: 'POST', body: JSON.stringify(payload) });
  },

  update(id: string, patch: Record<string, unknown>): Promise<{ id: string }> {
    return call(`/repositories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  /**
   * Deleting a repo requires typing its name back. That value goes in a header,
   * and `purge` (which also hides published modules) is a separate opt-in.
   */
  remove(id: string, confirmName: string, purge = false): Promise<{ purged: boolean; modulesHidden: number }> {
    return call(`/repositories/${id}${purge ? '?purge=1' : ''}`, {
      method: 'DELETE',
      headers: { 'x-confirm-delete': confirmName },
    });
  },

  verify(id: string): Promise<{
    ok: boolean;
    error?: string;
    hint?: string;
    defaultBranch?: string;
    private?: boolean;
    sgmoduleCount?: number | null;
    listingError?: string;
  }> {
    return call(`/repositories/${id}/verify`, { method: 'POST', body: '{}' });
  },

  check(
    id: string,
    options: { branch?: string; filePath?: string; pathPrefix?: string } = {},
  ): Promise<CheckResponse> {
    return call(`/repositories/${id}/check`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  logs(id: string, limit = 30): Promise<{ items: CheckLog[] }> {
    return call(`/repositories/${id}/logs?limit=${limit}`);
  },

  modules(id: string): Promise<{ items: RepoModule[] }> {
    return call(`/repositories/${id}/modules`);
  },

  setSecret(id: string, secret: string): Promise<{ hint?: string; cleared?: boolean }> {
    return call(`/repositories/${id}/secret`, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
  },

  settings(): Promise<ThirdPartySettings> {
    return call('/settings');
  },

  updateSettings(patch: Record<string, unknown>): Promise<{ updated: number }> {
    return call('/settings', { method: 'PUT', body: JSON.stringify(patch) });
  },

  runScheduler(): Promise<SchedulerResult> {
    return call('/scheduler/run', { method: 'POST', body: '{}' });
  },

  reviews(params: {
    status?: string;
    type?: string;
    method?: string;
    repositoryId?: string;
    q?: string;
    page?: number;
    perPage?: number;
    sort?: 'newest' | 'oldest';
  } = {}): Promise<ReviewList> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return call(`/reviews${suffix}`);
  },

  review(id: string): Promise<{ task: ReviewDetail; audits: ReviewDetail['audits'] }> {
    return call(`/reviews/${id}`);
  },

  /** Bulk approve/reject through the same engine the Telegram bot uses. */
  batchDecide(
    ids: string[],
    action: 'approve' | 'reject',
    reason?: string,
  ): Promise<{
    batchId: string;
    action: string;
    succeeded: number;
    failed: number;
    skipped: number;
    detail: Array<{ id: string; name: string; ok: boolean; outcome: string; message?: string }>;
  }> {
    return call(`/reviews/batch`, {
      method: 'POST',
      body: JSON.stringify({ ids, action, reason }),
    });
  },

  decide(
    id: string,
    decision: 'approve' | 'reject' | 'hold',
    options: {
      reason?: string;
      note?: string;
      overrides?: {
        name?: string;
        description?: string;
        categoryId?: string;
        featured?: boolean;
      };
    } = {},
  ): Promise<{ status: string; published: boolean; moduleId?: string; slug?: string }> {
    return call(`/reviews/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, ...options }),
    });
  },

  credentials(): Promise<{
    githubReadToken: CredentialStatus;
    telegramBotToken: CredentialStatus;
    encryptionKey: CredentialStatus;
    telegramAdminId: string;
  }> {
    return call('/credentials');
  },

  saveCredentials(patch: {
    githubReadToken?: string;
    telegramBotToken?: string;
    telegramAdminId?: string;
  }): Promise<{ saved: string[]; rejected: string[] }> {
    return call('/credentials', { method: 'PUT', body: JSON.stringify(patch) });
  },

  testTelegram(): Promise<{ sent: boolean; messageId: number | null }> {
    return call('/credentials/test-telegram', { method: 'POST', body: '{}' });
  },

  resendNotification(id: string): Promise<{ sent: boolean; error?: string }> {
    return call(`/reviews/${id}/resend`, { method: 'POST', body: '{}' });
  },
};

/** Webhook URL shown to the admin. Contains the repository id, nothing secret. */
export function webhookUrl(repositoryId: string): string {
  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : 'https://son.zhiaon.top';
  return `${origin}/api/v1/webhook/github/${repositoryId}`;
}
