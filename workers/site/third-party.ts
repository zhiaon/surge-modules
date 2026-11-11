/**
 * Third-party GitHub repository integration.
 *
 * One engine, three triggers — this is the whole point of the phase. Whether a
 * change arrives by webhook, by an admin pressing 「立即检查」, or by the Cron
 * trigger, it walks the same path:
 *
 *   detect → identify module → fetch content → compare version
 *   → create review task → notify Telegram → admin approves → publish
 *
 * Because the three entry points funnel into `inspectFiles`, a repo without a
 * webhook still gets new-module detection, and a webhook push cannot publish
 * anything a manual check would not have.
 *
 * Invariants that must never be broken:
 *   1. Nothing reaches `modules` / `module_proxy_mappings` without an approved
 *      review task. Unreviewed content only ever lives in `module_review_tasks`.
 *   2. A stale approval can never overwrite a newer version — publish checks
 *      the task's content_sha against the module's current sha first.
 *   3. Dedupe is structural: the UNIQUE index on
 *      (repository_id, file_path, content_sha, task_type) makes a duplicate
 *      insert a no-op rather than a second pending task.
 */

import type { ParsedMeta } from './sync';
import { parseModuleMeta, sha256, slugify } from './sync';
import { notifyReviewTask } from './telegram';

// ---------------------------------------------------------------- constants
const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_REPO = 2000;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_BRANCH = 'main';

export type DetectionMethod = 'webhook' | 'manual' | 'cron';
export type TaskType = 'new' | 'update' | 'delete';

export interface ThirdPartyEnv {
  DB: D1Database;
  GITHUB_READ_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ID?: string;
  /** base64 32-byte key used to encrypt per-repo webhook secrets */
  WEBHOOK_SECRET_KEY?: string;
  ENVIRONMENT?: string;
}

export interface RepositoryRow {
  id: string;
  name: string;
  owner: string;
  repository: string;
  repository_url: string;
  default_branch: string;
  description: string;
  category_id: string | null;
  notes: string;
  enabled: number;
  webhook_enabled: number;
  cron_enabled: number;
  manual_check_enabled: number;
  webhook_secret_enc: string | null;
  webhook_secret_hint: string;
  check_interval_hours: number;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_check_status: string | null;
  last_check_error: string;
  consecutive_failures: number;
  auto_review_new: number;
  auto_review_update: number;
  discovered_modules: number;
  pending_new: number;
  pending_updates: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ------------------------------------------------------------------ helpers
const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z');

const SEGMENT_RE = /^[\w.-]{1,100}$/;

/** Owner / repo / branch must be a single path segment — no traversal. */
export function safeSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && value !== '..' && value !== '.';
}

/** File paths inside the repo: no leading slash, no `..`, no control chars. */
export function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 400) return false;
  if (path.startsWith('/')) return false;
  if (/[\u0000-\u001f\\]/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function isSgmodule(path: string): boolean {
  return path.toLowerCase().endsWith('.sgmodule');
}

/**
 * Parses a GitHub URL into owner/repo. Accepts https, ssh (git@github.com:o/r)
 * and bare `owner/repo`. Returns null when it cannot be determined — the caller
 * shows a field error instead of inventing a repo.
 */
export function parseRepoUrl(
  input: string,
): { owner: string; repo: string; url: string } | null {
  const raw = input.trim();
  if (!raw) return null;

  const bare = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (bare) {
    const [, owner, repo] = bare;
    if (safeSegment(owner) && safeSegment(repo)) {
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }

  const ssh = raw.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (ssh) {
    const [, owner, repo] = ssh;
    if (safeSegment(owner) && safeSegment(repo)) {
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }

  try {
    const u = new URL(raw);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    const owner = parts[0] ?? '';
    const repo = (parts[1] ?? '').replace(/\.git$/, '');
    if (!safeSegment(owner) || !safeSegment(repo)) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

/** JSON body reader with a hard size cap (webhook payloads can be megabytes). */
export async function readJsonCapped(
  request: Request,
  maxBytes: number,
): Promise<{ data: unknown } | { error: string }> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > maxBytes) return { error: '请求体过大' };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: '请求体读取失败' };
  }
  if (text.length > maxBytes) return { error: '请求体过大' };
  // GitHub sends a JSON body; a non-JSON body is a probe, not an event
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('json') && !type.includes('form-urlencoded')) {
    return { error: '不支持的 Content-Type' };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    // `payload=` form encoding, used by older hook setups
    const form = new URLSearchParams(text).get('payload');
    if (form) {
      try {
        return { data: JSON.parse(form) };
      } catch {
        /* fall through */
      }
    }
    return { error: '请求体不是合法 JSON' };
  }
}

// ------------------------------------------------------------- webhook crypto
/**
 * Per-repository webhook secrets are stored encrypted. The key lives in a Worker
 * Secret (WEBHOOK_SECRET_KEY), never in D1 and never in the bundle, so a leaked
 * database dump does not yield signing keys.
 */
async function importAesKey(secretKey: string): Promise<CryptoKey> {
  // accept base64 or raw text; pad/truncate to exactly 32 bytes (AES-256)
  let bytes: Uint8Array;
  try {
    const bin = atob(secretKey);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    bytes = new TextEncoder().encode(secretKey);
  }
  const key = new Uint8Array(32);
  key.set(bytes.slice(0, 32));
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
};

const unb64 = (value: string): Uint8Array => {
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function encryptSecret(plain: string, secretKey: string): Promise<string> {
  const key = await importAesKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain),
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(cipher).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return b64(combined);
}

export async function decryptSecret(
  payload: string,
  secretKey: string,
): Promise<string | null> {
  try {
    const combined = unb64(payload);
    if (combined.length <= 12) return null;
    const key = await importAesKey(secretKey);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12) },
      key,
      combined.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Constant-time hex comparison for HMAC signatures. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies `X-Hub-Signature-256`. The RAW body must be used — re-serialising the
 * JSON changes key order and whitespace and would break every valid signature.
 */
export async function verifyGithubSignature(
  rawBody: string,
  headerSignature: string | null,
  secret: string,
): Promise<boolean> {
  if (!headerSignature) return false;
  const expectedPrefix = 'sha256=';
  if (!headerSignature.startsWith(expectedPrefix)) return false;
  const provided = headerSignature.slice(expectedPrefix.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqualHex(hex, provided);
}

// ---------------------------------------------------------------- GitHub API
interface GhOptions {
  token?: string;
  /** raw body instead of JSON */
  raw?: boolean;
  timeoutMs?: number;
}

export interface GhResult {
  ok: boolean;
  status: number;
  text?: string;
  json?: unknown;
  error?: string;
  retryAfter?: number;
}

export async function ghRequest(path: string, options: GhOptions = {}): Promise<GhResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  try {
    const headers: Record<string, string> = {
      accept: options.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'surge-modules-third-party',
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    const res = await fetch(`${GITHUB_API}${path}`, { headers, signal: controller.signal });

    if (res.status === 401) return { ok: false, status: 401, error: 'GitHub 凭据无效' };
    if (res.status === 404) {
      return { ok: false, status: 404, error: '仓库、分支或文件不存在，或当前凭据无权访问' };
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '60', 10) || 60;
      return {
        ok: false,
        status: res.status,
        error:
          remaining === '0'
            ? `GitHub API 限流，建议 ${retryAfter}s 后重试`
            : '无权访问该仓库（可能是私有仓库或 Token 权限不足）',
        retryAfter,
      };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: `GitHub 服务异常 ${res.status}` };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `GitHub 返回 ${res.status}` };

    if (options.raw) {
      const declared = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
      if (declared > MAX_FILE_BYTES) return { ok: false, status: 200, error: '文件超过大小上限' };
      const text = await res.text();
      if (text.length > MAX_FILE_BYTES) {
        return { ok: false, status: 200, error: '文件超过大小上限' };
      }
      return { ok: true, status: res.status, text };
    }

    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: aborted ? 'GitHub 请求超时' : 'GitHub 请求失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RepoInfo {
  defaultBranch: string;
  description: string;
  fullName: string;
  private: boolean;
}

/** Reads repository metadata — used when adding a repo and by 「验证」. */
export async function fetchRepoInfo(
  owner: string,
  repo: string,
  token?: string,
): Promise<{ info: RepoInfo } | { error: string }> {
  if (!safeSegment(owner) || !safeSegment(repo)) return { error: '仓库标识不合法' };
  const res = await ghRequest(`/repos/${owner}/${repo}`, { token });
  if (!res.ok) return { error: res.error ?? '无法读取仓库' };
  const body = res.json as {
    default_branch?: string;
    description?: string | null;
    full_name?: string;
    private?: boolean;
  };
  return {
    info: {
      defaultBranch: body.default_branch || DEFAULT_BRANCH,
      description: (body.description ?? '').slice(0, 500),
      fullName: body.full_name ?? `${owner}/${repo}`,
      private: Boolean(body.private),
    },
  };
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

/**
 * Lists `.sgmodule` blobs with their blob SHA.
 *
 * The SHA is what makes cheap change detection possible: comparing it against
 * the recorded one tells us whether the content moved WITHOUT downloading the
 * file. Only changed files are then fetched in full.
 */
export async function listSgmoduleFiles(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
  pathPrefix = '',
): Promise<{ files: TreeEntry[]; truncated: boolean } | { error: string }> {
  if (!safeSegment(owner) || !safeSegment(repo) || !safeSegment(branch)) {
    return { error: '仓库标识不合法' };
  }
  const res = await ghRequest(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { token },
  );
  if (!res.ok) return { error: res.error ?? '无法读取文件列表' };

  const body = res.json as {
    tree?: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated?: boolean;
  };

  const prefix = pathPrefix.trim().replace(/^\/+|\/+$/g, '');

  const files = (body.tree ?? [])
    .filter((n) => n.type === 'blob')
    .filter((n) => isSgmodule(n.path))
    .filter((n) => safePath(n.path))
    .filter((n) => !prefix || n.path === prefix || n.path.startsWith(`${prefix}/`))
    .map((n) => ({ path: n.path, sha: n.sha, size: n.size ?? 0 }))
    .slice(0, MAX_FILES_PER_REPO);

  return { files, truncated: Boolean(body.truncated) };
}

/**
 * Fetches one file. `ref` may be a branch OR a commit SHA — passing the SHA from
 * a webhook push is what guarantees we read the version that actually changed,
 * not whatever the branch points at by the time the request lands.
 */
export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<{ text: string } | { error: string }> {
  if (!safePath(path)) return { error: '路径不合法' };
  if (!safeSegment(ref)) return { error: '引用不合法' };
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await ghRequest(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    { token, raw: true },
  );
  if (!res.ok) return { error: res.error ?? '读取文件失败' };
  return { text: res.text ?? '' };
}

// --------------------------------------------------------------- comparisons
/** Extracts a comparable version. Falls back to a content hash prefix. */
export function versionOf(meta: ParsedMeta, fallbackSha: string): string {
  const v = meta.version?.trim();
  if (v && /^[\w.\-+]{1,32}$/.test(v)) return v;
  return `0.0.0+${fallbackSha.slice(0, 7)}`;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  /** blob sha reported by the tree API (absent for removals) */
  sha: string;
  /** commit sha of the push that introduced this state, when known */
  commitSha: string;
}

/**
 * Diffs a Push payload into a file-level change list.
 *
 * A single push can carry several commits, and the same path can appear in more
 * than one of them. The LAST occurrence for a path wins (that is the final state
 * of the push), and removed-then-re-added ends up as `modified`, which is what
 * the review should reflect.
 */
export function changesFromPush(payload: {
  commits?: Array<{
    id?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  head_commit?: { id?: string } | null;
  after?: string;
}): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const headSha = payload.head_commit?.id ?? payload.after ?? '';

  for (const commit of commits) {
    const sha = commit.id ?? headSha;
    for (const p of commit.added ?? []) {
      if (!isSgmodule(p) || !safePath(p)) continue;
      const prior = byPath.get(p);
      // added after a removal within the same push is really a modification
      byPath.set(p, {
        path: p,
        status: prior ? 'modified' : 'added',
        sha: '',
        commitSha: sha,
      });
    }
    for (const p of commit.modified ?? []) {
      if (!isSgmodule(p) || !safePath(p)) continue;
      byPath.set(p, { path: p, status: 'modified', sha: '', commitSha: sha });
    }
    for (const p of commit.removed ?? []) {
      if (!isSgmodule(p) || !safePath(p)) continue;
      byPath.set(p, { path: p, status: 'removed', sha: '', commitSha: sha });
    }
  }

  return [...byPath.values()];
}

// ------------------------------------------------------------------ DB reads
export async function getRepository(
  db: D1Database,
  id: string,
): Promise<RepositoryRow | null> {
  return db
    .prepare('SELECT * FROM third_party_repositories WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<RepositoryRow>();
}

export async function listRepositories(
  db: D1Database,
  filter: { enabledOnly?: boolean } = {},
): Promise<RepositoryRow[]> {
  const sql = filter.enabledOnly
    ? `SELECT * FROM third_party_repositories
        WHERE deleted_at IS NULL AND enabled = 1
        ORDER BY created_at DESC`
    : `SELECT * FROM third_party_repositories
        WHERE deleted_at IS NULL ORDER BY created_at DESC`;
  const rows = await db.prepare(sql).all<RepositoryRow>();
  return rows.results ?? [];
}

interface ThirdPartyModuleRow {
  id: string;
  repository_id: string;
  module_id: string | null;
  module_name: string;
  file_path: string;
  branch: string;
  module_description: string;
  author: string;
  current_version: string;
  current_content: string;
  current_content_sha: string;
  current_blob_sha: string;
  source_commit_sha: string;
  published: number;
  is_deleted_upstream: number;
  last_seen_at: string | null;
}

export async function getThirdPartyModule(
  db: D1Database,
  repositoryId: string,
  branch: string,
  filePath: string,
): Promise<ThirdPartyModuleRow | null> {
  return db
    .prepare(
      `SELECT * FROM third_party_modules
        WHERE repository_id = ? AND branch = ? AND file_path = ?`,
    )
    .bind(repositoryId, branch, filePath)
    .first<ThirdPartyModuleRow>();
}


// ------------------------------------------------------------- D1 budget
// The free D1 plan allows 5M row reads/day. A first scan of a large repo costs
// roughly files×3 reads after the 0020 indexes; a runaway retry loop used to
// burn the whole day's budget and take the whole platform read-only for hours.
// We keep our own tally in site_settings: cheap, dependency-free, and only
// meant to catch the pathological case (a normal day uses <1% of the budget).
export const D1_BUDGET_KEY = 'third_party.d1_budget';
export const D1_BUDGET_LIMIT = 4_000_000; // 80% of the daily free tier
export const today = (): string => iso().slice(0, 10);

export async function readBudget(db: D1Database): Promise<{ date: string; used: number }> {
  const row = await db
    .prepare('SELECT value FROM site_settings WHERE key = ?')
    .bind(D1_BUDGET_KEY)
    .first<{ value: string }>();
  try {
    const parsed = JSON.parse(row?.value ?? '') as { date: string; used: number };
    if (parsed && parsed.date === today() && typeof parsed.used === 'number') return parsed;
  } catch {
    // missing or malformed → fresh budget
  }
  return { date: today(), used: 0 };
}

export async function addBudget(db: D1Database, amount: number): Promise<void> {
  const b = await readBudget(db);
  const used = b.date === today() ? b.used + amount : amount;
  await db
    .prepare(
      `INSERT INTO site_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(D1_BUDGET_KEY, JSON.stringify({ date: today(), used }))
    .run();
}

// ------------------------------------------------------------------- results
export interface FileOutcome {
  path: string;
  status: 'new' | 'updated' | 'deleted' | 'unchanged' | 'failed' | 'skipped';
  reason?: string;
  taskId?: string;
  version?: string;
  commitSha?: string;
}

export interface CheckResult {
  logId: string;
  repositoryId: string;
  branch: string;
  status: 'ok' | 'partial' | 'failed';
  newModules: number;
  updatedModules: number;
  deletedModules: number;
  unchanged: number;
  failed: number;
  filesScanned: number;
  error: string;
  outcomes: FileOutcome[];
  startedAt: string;
  finishedAt: string;
}

// ------------------------------------------------------------- task creation
export interface TaskInput {
  repositoryId: string;
  moduleId: string | null;
  thirdPartyModuleId: string | null;
  taskType: TaskType;
  detectionMethod: DetectionMethod;
  filePath: string;
  branch: string;
  oldVersion: string;
  newVersion: string;
  oldContent: string;
  newContent: string;
  contentSha: string;
  commitSha: string;
}

/**
 * Inserts a review task, relying on the partial UNIQUE index for dedupe.
 *
 * `INSERT OR IGNORE` is deliberate: concurrent detection (a webhook landing
 * while cron is mid-scan) must produce ONE pending task, not two, and the second
 * insert has to be a silent no-op rather than an error the caller has to handle.
 * Returns null when the task already existed.
 */
export async function createReviewTask(
  db: D1Database,
  input: TaskInput,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO module_review_tasks
        (id, module_id, third_party_module_id, repository_id, task_type,
         detection_method, file_path, branch, old_version, new_version,
         old_content, new_content, content_sha, commit_sha, review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      id,
      input.moduleId,
      input.thirdPartyModuleId,
      input.repositoryId,
      input.taskType,
      input.detectionMethod,
      input.filePath,
      input.branch,
      input.oldVersion,
      input.newVersion,
      // content is capped: an audit trail of every byte is not worth the rows,
      // and the module file itself is bounded to 256 KB anyway
      input.oldContent.slice(0, 120_000),
      input.newContent.slice(0, 120_000),
      input.contentSha,
      input.commitSha,
    )
    .run();

  const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) return null;
  return id;
}

/**
 * Supersedes any other pending task for the same file, so an older pending
 * version can never be approved over a newer one. Called after a successful
 * insert of a NEW task.
 */
async function supersedeOlderTasks(
  db: D1Database,
  repositoryId: string,
  filePath: string,
  keepTaskId: string,
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE module_review_tasks
          SET review_status = 'superseded',
              superseded_by = ?,
              updated_at = ?
        WHERE repository_id = ? AND file_path = ?
          AND review_status IN ('pending', 'on_hold')
          AND id <> ?`,
    )
    .bind(keepTaskId, iso(), repositoryId, filePath, keepTaskId)
    .run();
  return (res.meta as { changes?: number } | undefined)?.changes ?? 0;
}

// ---------------------------------------------------------------- the engine
export interface InspectOptions {
  method: DetectionMethod;
  /** restrict to one branch (defaults to the repo's default branch) */
  branch?: string;
  /** restrict to a single file path */
  filePath?: string;
  /** restrict to files under this prefix */
  pathPrefix?: string;
  /** read content at this commit instead of the branch head */
  commitSha?: string;
  /** explicit change list (webhook); when absent the tree is diffed */
  changes?: ChangedFile[];
  /** hard cap for this run */
  maxFiles?: number;
  /** unix ms deadline — stop cleanly instead of being killed by the platform */
  deadline?: number;
  /** skip Telegram side effects (tests) */
  silent?: boolean;
}

/**
 * The single entry point for all three detection methods.
 *
 * Returns counts plus a per-file outcome list, which is what the admin UI shows
 * after 「立即检查」 and what the check log stores.
 */
export async function inspectRepository(
  env: ThirdPartyEnv,
  repository: RepositoryRow,
  options: InspectOptions,
): Promise<CheckResult> {
  const db = env.DB;
  const startedAt = iso();
  const startedMs = Date.parse(startedAt);
  const branch = options.branch || repository.default_branch;
  const token = env.GITHUB_READ_TOKEN;
  const outcomes: FileOutcome[] = [];

  // maxFiles 0 = unlimited: fall through to the repository hard cap (2000),
  // which is still a meaningful safety net against a runaway repo.
  const requested = options.maxFiles ?? 200;
  const limit = requested === 0 ? MAX_FILES_PER_REPO : Math.min(requested, MAX_FILES_PER_REPO);
  const deadline = options.deadline ?? startedMs + 50_000;
  const timeLeft = () => Date.parse(iso()) < deadline;

  let filesScanned = 0;
  let error = '';

  if (!safeSegment(repository.owner) || !safeSegment(repository.repository)) {
    error = '仓库标识不合法';
    return failEarly('仓库标识不合法');
  }

  // ---- decide which files to look at -------------------------------------
  let candidates: ChangedFile[] | null = options.changes ?? null;

  if (!candidates) {
    const listing = await listSgmoduleFiles(
      repository.owner,
      repository.repository,
      branch,
      token,
      options.pathPrefix ?? '',
    );
    if ('error' in listing) {
      error = listing.error;
      return failEarly(listing.error);
    }
    filesScanned = listing.files.length;

    const existingRows = await db
      .prepare(
        `SELECT file_path, module_id, current_content_sha, current_blob_sha,
                current_version, published, is_deleted_upstream
           FROM third_party_modules
          WHERE repository_id = ? AND branch = ?`,
      )
      .bind(repository.id, branch)
      .all<{
        file_path: string;
        module_id: string | null;
        current_content_sha: string;
        current_blob_sha: string;
        current_version: string;
        published: number;
        is_deleted_upstream: number;
      }>();

    const known = new Map((existingRows.results ?? []).map((r) => [r.file_path, r]));

    // Self-heal: rows recorded before identity matching have no module_id even
    // though the module is already live from the first-party sync. Link them
    // now, otherwise every scan would keep treating the file as a new candidate
    // in a repo that was connected earlier.
    //
    // Hard-bounded: each attempt costs two D1 queries, and a 700-file repo with
    // many unlinkable rows (a pure third-party source never matches a
    // first-party path) used to fire 1000+ subrequests in one run — the free
    // plan caps those at 50 per invocation, so the whole check 500'd. Twenty
    // attempts per run is plenty: linking is a one-off repair, and a repo that
    // cannot link simply stops being retried beyond this budget.
    // Self-heal is a one-off migration chore, not part of a normal scan. It is
    // skipped for single-file checks (pointless) and budgeted to 3 attempts:
    // each attempt costs 2 queries over the whole modules table, and rows from
    // a pure third-party source can NEVER link (no first-party path exists),
    // so an unbounded loop burned 20×2×543 rows on every single request —
    // 218 requests was enough to exhaust the whole day's D1 read quota.
    let healBudget = options.filePath ? 0 : 3;
    for (const file of listing.files) {
      if (healBudget <= 0) break;
      const row = known.get(file.path);
      if (!row || row.module_id !== null) continue;
      healBudget -= 1;
      const linked = await findExistingModule(
        db,
        repository.owner,
        repository.repository,
        file.path,
      );
      if (!linked) continue;
      await db.prepare(
        `UPDATE third_party_modules SET module_id = ?, updated_at = ?
          WHERE repository_id = ? AND branch = ? AND file_path = ?`,
      )
        .bind(linked, iso(), repository.id, branch, file.path)
        .run();
      row.module_id = linked;
    }
    const present = new Set(listing.files.map((f) => f.path));

    candidates = [];
    for (const file of listing.files) {
      if (options.filePath && file.path !== options.filePath) continue;
      const record = known.get(file.path);
      if (!record) {
        candidates.push({ path: file.path, status: 'added', sha: file.sha, commitSha: '' });
      } else if (record.current_blob_sha !== file.sha || record.is_deleted_upstream === 1) {
        // Git blob SHA changed → the file changed. Comparing blob-to-blob is the
        // cheap check: no download for the ~99% of files that did not move.
        // (Comparing the git blob SHA to a SHA-256 of the text never matches, so
        // that version silently re-downloaded every file on every scan.)
        candidates.push({
          path: file.path,
          status: record.is_deleted_upstream === 1 ? 'added' : 'modified',
          sha: file.sha,
          commitSha: '',
        });
      } else {
        outcomes.push({ path: file.path, status: 'unchanged' });
      }
    }

    // files that vanished from the tree → upstream deletions
    for (const [path, record] of known) {
      if (present.has(path) || record.is_deleted_upstream === 1) continue;
      if (options.filePath && path !== options.filePath) continue;
      candidates.push({ path, status: 'removed', sha: '', commitSha: '' });
    }
  }

  if (options.filePath) {
    candidates = candidates.filter((c) => c.path === options.filePath);
  }

  // process changed files, bounded by the deadline. Fresh files (not yet in
  // third_party_modules) go first: a deadline cut-off used to land on the tail
  // of the alphabetical tree, and because skipped files are retried from the
  // top next run, newly added repos with many files could starve — every run
  // spent its budget on the same head slice. Sorting new-first guarantees each
  // run makes permanent progress before time runs out.
  const rank = (c: ChangedFile): number => (c.status === 'added' ? 0 : 1);
  const queue = candidates
    .filter((c) => c.status !== ('unchanged' as const))
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    .slice(0, limit);

  for (const change of queue) {
    if (!timeLeft()) {
      outcomes.push({ path: change.path, status: 'skipped', reason: '本次运行时间已达上限' });
      continue;
    }
    try {
      const outcome = await inspectFile(env, repository, {
        branch,
        change,
        method: options.method,
        commitSha: options.commitSha || change.commitSha,
        silent: options.silent,
      });
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        path: change.path,
        status: 'failed',
        reason: err instanceof Error ? err.message : '处理失败',
      });
    }
  }

  // ---- aggregate ---------------------------------------------------------
  const newModules = outcomes.filter((o) => o.status === 'new').length;
  const updatedModules = outcomes.filter((o) => o.status === 'updated').length;
  const deletedModules = outcomes.filter((o) => o.status === 'deleted').length;
  const unchanged = outcomes.filter((o) => o.status === 'unchanged').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;

  const status: CheckResult['status'] =
    failed > 0 && newModules + updatedModules + deletedModules === 0
      ? 'failed'
      : failed > 0
        ? 'partial'
        : 'ok';

  /**
   * Builds a failed result for paths that abort before any file is examined.
   * Kept separate from `finish` because the counters below are `const` and are
   * not initialised yet at those points (calling `finish` there throws).
   */
  function failEarly(message: string): CheckResult {
    return {
      logId: '',
      repositoryId: repository.id,
      branch,
      status: 'failed',
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      unchanged: 0,
      failed: 0,
      filesScanned: 0,
      error: message,
      outcomes,
      startedAt,
      finishedAt: iso(),
    };
  }

  return finish(status);

  function finish(finalStatus: CheckResult['status']): CheckResult {
    // NOTE: the log row and the repository counters are written by the caller
    // (recordCheck) so that a thrown error above still gets logged.
    return {
      logId: '',
      repositoryId: repository.id,
      branch,
      status: finalStatus,
      newModules,
      updatedModules,
      deletedModules,
      unchanged,
      failed,
      filesScanned,
      error,
      outcomes,
      startedAt,
      finishedAt: iso(),
    };
  }
}

/** Inspects one file and creates the matching review task. */
/**
 * Finds a module row that already represents this file, from any source.
 *
 * A repository may already be connected to the first-party sync engine, in which
 * case its modules are live with `source_path` set. Treating those as "new"
 * would create a duplicate entry with a `-2` slug — the same file published
 * twice under two names. Matching on upstream_url / source_path links the
 * third-party record to the existing module instead.
 */
async function findExistingModule(
  db: D1Database,
  owner: string,
  repo: string,
  filePath: string,
): Promise<string | null> {
  // `source_path` alone is the reliable key: the first-party sync records the
  // repo-relative path but may leave upstream_url / repository_url NULL (rows
  // imported before those columns were populated). Requiring a URL match made
  // every already-live module look "new", which then published a duplicate.
  const byPath = await db
    .prepare(
      `SELECT id FROM modules
        WHERE deleted_at IS NULL AND source_path = ?
        LIMIT 1`,
    )
    .bind(filePath)
    .first<{ id: string }>();
  if (byPath) return byPath.id;

  // Fall back to the URL only when the path did not match at all.
  // The LIKE pattern is capped because D1 refuses patterns that are too
  // complex (SQLITE_MAX_LIKE_PATTERN_LENGTH) — a deep third-party path with a
  // long filename used to fail the whole lookup with D1_ERROR and the file
  // could never be imported. The tail match keeps the same intent for
  // realistic URLs and simply finds nothing for pathological ones.
  const repoUrl = `https://github.com/${owner}/${repo}`;
  // D1's LIKE implementation chokes on a long literal run right after a
  // wildcard: "/%"+50 literal chars already fails. Cap the literal tail at 40
  // chars — shorter than any real filename needs to stay unique, and matched
  // rows are additionally filtered in JS below.
  const fileName = filePath.split('/').pop() ?? '';
  const tail = `/%${fileName.slice(-40)}`;
  const byUrlRow = await db
    .prepare(
      `SELECT id, upstream_url FROM modules
        WHERE deleted_at IS NULL
          AND (repository_url = ? OR upstream_url LIKE ?)
        LIMIT 5`,
    )
    .bind(repoUrl, tail.length <= 45 ? tail : repoUrl)
    .all<{ id: string; upstream_url: string | null }>();
  // LIKE on the trimmed tail can over-match (two long filenames sharing the
  // last 40 chars); disambiguate in JS against the full file name.
  for (const row of byUrlRow.results ?? []) {
    if (row.upstream_url && row.upstream_url.endsWith(`/${fileName}`)) return row.id;
  }
  return null;
}

async function inspectFile(
  env: ThirdPartyEnv,
  repository: RepositoryRow,
  args: {
    branch: string;
    change: ChangedFile;
    method: DetectionMethod;
    commitSha: string;
    silent?: boolean;
  },
): Promise<FileOutcome> {
  const { DB } = env;
  const { change, branch, method } = args;
  const token = env.GITHUB_READ_TOKEN;

  const existing = await getThirdPartyModule(DB, repository.id, branch, change.path);

  // ---------------------------------------------------------- deletion
  if (change.status === 'removed') {
    if (!existing) {
      return { path: change.path, status: 'unchanged' };
    }
    if (existing.is_deleted_upstream === 1) {
      return { path: change.path, status: 'unchanged' };
    }

    // A deleted file never removes a live module by itself. It records the fact
    // upstream and raises a delete task for a human to decide on.
    await DB.prepare(
      `UPDATE third_party_modules
          SET is_deleted_upstream = 1, updated_at = ?
        WHERE id = ?`,
    )
      .bind(iso(), existing.id)
      .run();

    const contentSha = `del:${existing.current_content_sha}`;
    const taskId = await createReviewTask(DB, {
      repositoryId: repository.id,
      moduleId: existing.module_id,
      thirdPartyModuleId: existing.id,
      taskType: 'delete',
      detectionMethod: method,
      filePath: change.path,
      branch,
      oldVersion: existing.current_version,
      newVersion: '',
      oldContent: existing.current_content,
      newContent: '',
      contentSha,
      commitSha: args.commitSha,
    });
    if (taskId) {
      await supersedeOlderTasks(DB, repository.id, change.path, taskId);
      if (!args.silent) {
        await notifyReviewTask(env, taskId, 'delete');
      }
    }
    return { path: change.path, status: 'deleted', taskId: taskId ?? undefined };
  }

  // A push payload has no blob sha. Fetch the authoritative one so the next
  // tree scan can compare blob-to-blob instead of always re-downloading.
  let blobSha = change.sha;
  if (!blobSha) {
    const tree = await listSgmoduleFiles(
      repository.owner,
      repository.repository,
      args.commitSha && safeSegment(args.commitSha) ? args.commitSha : branch,
      token,
    );
    if (!('error' in tree)) {
      blobSha = tree.files.find((f) => f.path === change.path)?.sha ?? '';
    }
  }

  // ------------------------------------------------------- fetch content
  // The ref is the push SHA when we have one, otherwise the branch. Reading by
  // SHA is what makes a webhook review match the commit that triggered it.
  const ref = args.commitSha && safeSegment(args.commitSha) ? args.commitSha : branch;
  const fetched = await fetchFileContent(
    repository.owner,
    repository.repository,
    change.path,
    ref,
    token,
  );
  if ('error' in fetched) {
    // An oversized file is a *policy skip*, not a failure: the repo is fine,
    // the file is simply not importable. Marking it 'failed' used to flip the
    // whole repository's check_status to failed on every cron pass, ringing
    // alarm bells for a file we already decided to exclude.
    if (fetched.error === '文件超过大小上限') {
      return { path: change.path, status: 'skipped', reason: '文件超过大小上限' };
    }
    return { path: change.path, status: 'failed', reason: fetched.error };
  }

  const text = fetched.text;
  if (!text.trim()) {
    return { path: change.path, status: 'failed', reason: '文件内容为空' };
  }

  const contentSha = await sha256(text);

  // Same content as what is already recorded → nothing to review, regardless of
  // what the webhook claimed (force-push to the same tree, re-tag, etc).
  if (existing && existing.current_content_sha === contentSha) {
    if (existing.is_deleted_upstream === 1) {
      await DB.prepare('UPDATE third_party_modules SET is_deleted_upstream = 0 WHERE id = ?')
        .bind(existing.id)
        .run();
    }
    return { path: change.path, status: 'unchanged' };
  }

  const fallbackName =
    change.path.split('/').pop()?.replace(/\.sgmodule$/i, '') ?? change.path;
  let meta: ParsedMeta;
  try {
    meta = parseModuleMeta(text, fallbackName);
  } catch {
    return { path: change.path, status: 'failed', reason: '模块内容无法解析' };
  }

  const newVersion = versionOf(meta, contentSha);

  // ------------------------------------------------------ new module
  if (!existing) {
    if (repository.auto_review_new !== 1) {
      return { path: change.path, status: 'skipped', reason: '该仓库已关闭新模块自动送审' };
    }

    // If this exact file is already live (e.g. the repo is also wired to the
    // first-party sync), do not create a second module for it: link the record
    // and treat the change as an update instead.
    const linkedId = await findExistingModule(
      DB,
      repository.owner,
      repository.repository,
      change.path,
    );
    if (linkedId) {
      const liveRow = await DB.prepare(
        'SELECT version, content_hash FROM modules WHERE id = ?',
      )
        .bind(linkedId)
        .first<{ version: string; content_hash: string | null }>();

      if (liveRow?.content_hash === contentSha) {
        // already identical — just record the link, nothing to review
        await DB.prepare(
          `INSERT OR IGNORE INTO third_party_modules
            (id, repository_id, module_id, module_name, file_path, branch,
             module_description, author, current_version, current_content,
             current_content_sha, current_blob_sha, source_commit_sha, published, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
          .bind(
            crypto.randomUUID(),
            repository.id,
            linkedId,
            (meta.name || fallbackName).slice(0, 120),
            change.path,
            branch,
            (meta.description ?? '').slice(0, 500),
            (meta.author ?? '').slice(0, 80),
            liveRow.version,
            text.slice(0, 120_000),
            contentSha,
            blobSha,
            args.commitSha,
            iso(),
          )
          .run();
        return { path: change.path, status: 'unchanged' };
      }
    }

    // record the discovery so the next scan does not re-detect it, but keep it
    // unpublished: publishing happens only on approval
    const tpmId = crypto.randomUUID();
    await DB.prepare(
      `INSERT OR IGNORE INTO third_party_modules
        (id, repository_id, module_id, module_name, file_path, branch,
         module_description, author, current_version, current_content,
         current_content_sha, current_blob_sha, source_commit_sha, published, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
      .bind(
        tpmId,
        repository.id,
        linkedId,
        (meta.name || fallbackName).slice(0, 120),
        change.path,
        branch,
        (meta.description ?? '').slice(0, 500),
        (meta.author ?? '').slice(0, 80),
        newVersion,
        text.slice(0, 120_000),
        contentSha,
        blobSha,
        args.commitSha,
        iso(),
      )
      .run();

    const row = await getThirdPartyModule(DB, repository.id, branch, change.path);

    const taskId = await createReviewTask(DB, {
      repositoryId: repository.id,
      moduleId: linkedId,
      thirdPartyModuleId: row?.id ?? tpmId,
      taskType: linkedId ? 'update' : 'new',
      detectionMethod: method,
      filePath: change.path,
      branch,
      oldVersion: '',
      newVersion,
      oldContent: '',
      newContent: text,
      contentSha,
      commitSha: args.commitSha,
    });

    if (taskId) {
      await supersedeOlderTasks(DB, repository.id, change.path, taskId);
      if (!args.silent) await notifyReviewTask(env, taskId, 'new');
    }
    return {
      path: change.path,
      status: taskId ? 'new' : 'unchanged',
      taskId: taskId ?? undefined,
      version: newVersion,
      commitSha: args.commitSha,
    };
  }

  // --------------------------------------------------- existing module
  if (existing.current_content_sha === contentSha) {
    return { path: change.path, status: 'unchanged' };
  }
  if (repository.auto_review_update !== 1) {
    return { path: change.path, status: 'skipped', reason: '该仓库已关闭更新自动送审' };
  }

  // Refresh the discovery record but DO NOT touch the live module: the pending
  // content lives in the task until an admin approves it.
  await DB.prepare(
    `UPDATE third_party_modules
        SET module_name = ?, module_description = ?, author = ?,
            current_blob_sha = ?, source_commit_sha = ?, is_deleted_upstream = 0,
            last_seen_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      (meta.name || existing.module_name).slice(0, 120),
      (meta.description ?? existing.module_description).slice(0, 500),
      (meta.author ?? existing.author).slice(0, 80),
      blobSha,
      args.commitSha,
      iso(),
      iso(),
      existing.id,
    )
    .run();

  // An update must point at a live module. `existing.module_id` can be null when
  // the discovery row was created before the first approval (or when an earlier
  // "new" task was rejected), so resolve it now instead of publishing nothing.
  const updateModuleId =
    existing.module_id ??
    (await findExistingModule(DB, repository.owner, repository.repository, change.path));

  if (updateModuleId && updateModuleId !== existing.module_id) {
    await DB.prepare(
      'UPDATE third_party_modules SET module_id = ?, updated_at = ? WHERE id = ?',
    )
      .bind(updateModuleId, iso(), existing.id)
      .run();
  }

  const taskId = await createReviewTask(DB, {
    repositoryId: repository.id,
    moduleId: updateModuleId,
    thirdPartyModuleId: existing.id,
    taskType: 'update',
    detectionMethod: method,
    filePath: change.path,
    branch,
    oldVersion: existing.current_version,
    newVersion,
    oldContent: existing.current_content,
    newContent: text,
    contentSha,
    commitSha: args.commitSha,
  });

  if (taskId) {
    await supersedeOlderTasks(DB, repository.id, change.path, taskId);
    if (!args.silent) await notifyReviewTask(env, taskId, 'update');
    return {
      path: change.path,
      status: 'updated',
      taskId,
      version: newVersion,
      commitSha: args.commitSha,
    };
  }

  return { path: change.path, status: 'unchanged' };
}

// ------------------------------------------------------------- persistence
/** Writes the check log and updates the repository's status/counters. */
export async function recordCheck(
  db: D1Database,
  repository: RepositoryRow,
  result: CheckResult,
  method: DetectionMethod,
): Promise<string> {
  const logId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO repository_check_logs
        (id, repository_id, detection_method, check_status, new_modules_count,
         updated_modules_count, deleted_modules_count, unchanged_modules_count,
         failed_count, files_scanned, branch, error_message, detail,
         started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      logId,
      repository.id,
      method,
      result.status,
      result.newModules,
      result.updatedModules,
      result.deletedModules,
      result.unchanged,
      result.failed,
      result.filesScanned,
      result.branch,
      result.error.slice(0, 1000),
      JSON.stringify(result.outcomes.slice(0, 300)).slice(0, 60_000),
      result.startedAt,
      result.finishedAt,
    )
    .run();

  const failures = result.status === 'failed' ? repository.consecutive_failures + 1 : 0;
  const nextAt = new Date(
    Date.now() + Math.max(1, repository.check_interval_hours) * 3600_000,
  );

  await db
    .prepare(
      `UPDATE third_party_repositories
          SET last_checked_at = ?, next_check_at = ?, last_check_status = ?,
              last_check_error = ?, consecutive_failures = ?,
              pending_new = (
                SELECT COUNT(*) FROM module_review_tasks
                 WHERE repository_id = ? AND review_status = 'pending' AND task_type = 'new'
              ),
              pending_updates = (
                SELECT COUNT(*) FROM module_review_tasks
                 WHERE repository_id = ? AND review_status = 'pending' AND task_type = 'update'
              ),
              discovered_modules = (
                SELECT COUNT(*) FROM third_party_modules WHERE repository_id = ?
              ),
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      result.finishedAt,
      iso(nextAt),
      result.status,
      (result.error || '').slice(0, 500),
      failures,
      repository.id,
      repository.id,
      repository.id,
      iso(),
      repository.id,
    )
    .run();

  return logId;
}
