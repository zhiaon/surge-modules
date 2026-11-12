/**
 * Shared contract between the site worker, the proxy worker and the frontend.
 * Kept dependency-free so it can be imported from any runtime.
 */

export const API_VERSION = 'v1';

/** Uniform success envelope. `data` shape varies per endpoint. */
export interface ApiOk<T> {
  ok: true;
  data: T;
  meta?: PageMeta | Record<string, unknown>;
}

/** Uniform failure envelope. `code` is stable, `message` is for humans. */
export interface ApiErr {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** optional field-level detail for validation failures */
    fields?: Record<string, string>;
  };
}

export interface PageMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  // A concurrent or repeated action on an already-resolved resource. Without
  // this key `ERROR_STATUS['conflict']` is undefined, Response defaults to 200,
  // and a "refused" outcome looks identical to success on the wire.
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_requests: 429,
  internal_error: 500,
  upstream_error: 502,
  upstream_timeout: 504,
} as const;

export type ApiErrorCode = keyof typeof ERROR_STATUS;

/** Public module shape. Deliberately excludes every backend-only column. */
export interface PublicModule {
  id: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  category: { id: string; name: string; slug: string } | null;
  tags: string[];
  version: string;
  updatedAt: string;
  /** proxy URL (stable, public) — never the upstream GitHub URL */
  rawUrl: string;
  repositoryUrl: string | null;
  isFeatured: boolean;
  /** script health, resolved at build time */
  health?: 'ok' | 'broken' | 'unknown';
  /** pinyin index for search (jingdong → 京东) */
  py?: { full: string; initials: string } | null;
}

export interface PublicModuleDetail extends PublicModule {
  versions: PublicModuleVersion[];
  /** what the module actually does, parsed from its config */
  tech?: {
    rules?: number;
    mitm: string[];
    rewrites: number;
    scripts: Array<{ name: string; url: string }>;
    crons: string[];
  } | null;
  /** change events recorded by the sync job */
  history?: Array<{ at: string; type: 'added' | 'content' | 'removed' }>;
  createdAt: string;
}

export interface PublicModuleVersion {
  version: string;
  changelog: string;
  releasedAt: string;
  commitSha: string | null;
  commitUrl: string | null;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  sortOrder: number;
  moduleCount: number;
}

export interface PublicAnnouncement {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  isPinned: boolean;
  publishedAt: string;
}

export interface PublicSettings {
  /** Telegram channel DM link, empty when not configured */
  contactTelegram: string;
  siteName: string;
  tagline: string;
  description: string;
  locale: string;
  version: string;
  perPageDefault: number;
  perPageMax: number;
  /** base URL of the proxy worker, empty when not configured */
  proxyBase: string;
}

export type ModuleSort = 'updated' | 'name' | 'created' | 'featured';

export interface ModuleListQuery {
  page: number;
  perPage: number;
  search: string;
  category: string;
  tag: string;
  featured: boolean | null;
  sort: ModuleSort;
}

/** Whitelisted analytics events. Anything else is rejected by the API. */
export const ANALYTICS_EVENTS = [
  'page_view',
  'module_view',
  'install_click',
  'copy_click',
  'search',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export const ANALYTICS_LIMITS = {
  maxBodyBytes: 1024,
  maxSubjectLength: 120,
  maxEventsPerWindow: 60,
  windowSeconds: 60,
} as const;
