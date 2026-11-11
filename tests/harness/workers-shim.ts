import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Minimal Cloudflare Workers test harness.
 *
 * workerd cannot start in this sandbox (its musl build needs `__res_init`, which
 * the iSH libc does not export), so the worker handlers are exercised against a
 * shim that implements the subset of the Workers runtime they actually use:
 *
 *   - D1Database: prepare/bind/first/all/run/batch — backed by the `sqlite3` CLI,
 *     i.e. real SQL against the real migrations, not a hand-written fake.
 *   - fetch: interceptable, so the GitHub upstream can be simulated exactly
 *     (200/404/403/429/timeout) without network access.
 *   - caches.default: in-memory Map with the same match/put contract.
 *
 * What this does NOT verify, and should be checked with `wrangler dev` on a real
 * machine: workerd's own behaviour, actual edge caching, and real GitHub calls.
 */

export interface D1ResultLike<T> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

class PreparedStatement {
  private binds: unknown[] = [];

  constructor(
    private readonly handle: () => string,
    private readonly sqlText: string,
  ) {}

  bind(...values: unknown[]): PreparedStatement {
    this.binds = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.rows<T>();
    if (rows.length === 0) return null;
    if (column) {
      const row = rows[0] as Record<string, unknown>;
      return (row[column] as T) ?? null;
    }
    return rows[0];
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return { results: this.rows<T>(), success: true, meta: {} };
  }

  async run(): Promise<D1ResultLike<never>> {
    // `changes()` must be read in the same connection right after the statement,
    // which is exactly what appending the query to the same script does.
    const changes = this.execAndCountChanges();
    return { results: [], success: true, meta: { changes } };
  }

  /** Executes the statement and returns rows actually modified (D1's changes). */
  private execAndCountChanges(): number {
    const script = [
      'PRAGMA foreign_keys=ON;',
      substitute(this.sqlText, this.binds),
    ].join('\n');
    try {
      const out = execFileSync(
        'sqlite3',
        ['-batch', '-noheader', this.handle()],
        // the statement must be terminated before the follow-up query, otherwise
        // sqlite sees "...VALUES (...) SELECT changes();" as one bad statement
        { input: `${script};\nSELECT changes();`, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      const last = out.trim().split('\n').pop() ?? '0';
      const n = Number.parseInt(last, 10);
      return Number.isFinite(n) ? n : 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`D1 shim SQL failed: ${message}\n--- SQL ---\n${script.slice(0, 400)}`);
    }
  }

  private rows<T>(): T[] {
    const script = ['PRAGMA foreign_keys=ON;', substitute(this.sqlText, this.binds)].join('\n');
    const out = execFileSync('sqlite3', ['-batch', '-header', '-json', this.handle(), script], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!out.trim()) return [];
    try {
      return JSON.parse(out) as T[];
    } catch {
      return [];
    }
  }

  private exec(): void {
    const script = ['PRAGMA foreign_keys=ON;', substitute(this.sqlText, this.binds)].join('\n');
    try {
      execFileSync('sqlite3', ['-batch', '-noheader', this.handle(), script], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`D1 shim SQL failed: ${message}\n--- SQL ---\n${script.slice(0, 400)}`);
    }
  }
}

/** Renders `?` placeholders with properly quoted literals for the CLI. */
function substitute(sql: string, binds: unknown[]): string {
  let index = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === '?' && !inString) {
      if (index >= binds.length) throw new Error('D1 shim: not enough binds');
      out += quote(binds[index]);
      index += 1;
      continue;
    }
    out += ch;
  }
  if (index !== binds.length) {
    throw new Error(`D1 shim: ${binds.length - index} unused binds`);
  }
  return out;
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class D1Shim {
  constructor(private readonly dbPath: string) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(() => this.dbPath, sql);
  }

  async batch(statements: PreparedStatement[]): Promise<D1ResultLike<never>[]> {
    const out: D1ResultLike<never>[] = [];
    for (const stmt of statements) out.push(await stmt.run());
    return out;
  }

  async exec(sql: string): Promise<void> {
    execFileSync('sqlite3', [this.dbPath], { input: sql, encoding: 'utf8' });
  }
}

/** Builds a fresh database with every migration + optional seed applied. */
export function createTestDb(seed = false): { db: D1Shim; path: string; raw: (q: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'sm-worker-'));
  const path = join(dir, 'test.db');

  for (const file of [
    'database/migrations/0001_init.sql',
    'database/migrations/0002_seed_reference.sql',
    'database/migrations/0003_backend_schema.sql',
    'database/migrations/0004_seed_settings.sql',
    'database/migrations/0005_admin_and_review.sql',
    'database/migrations/0006_phase6.sql',
    'database/migrations/0007_hooks_and_alerts.sql',
    'database/migrations/0008_third_party.sql',
    'database/migrations/0009_blob_sha.sql',
    'database/migrations/0010_editable_credentials.sql',
    'database/migrations/0011_contact_telegram.sql',
    'database/migrations/0012_third_party_proxy.sql',
    'database/migrations/0013_proxy_source_nullable.sql',
    'database/migrations/0014_review_batches.sql',
    ...(seed ? ['database/seed-dev.sql'] : []),
  ]) {
    execFileSync('sqlite3', [path], {
      input: execFileSync('cat', [file], { encoding: 'utf8' }),
      encoding: 'utf8',
    });
  }

  return {
    db: new D1Shim(path),
    path,
    raw: (q: string) =>
      execFileSync('sqlite3', ['-batch', '-noheader', path, `PRAGMA foreign_keys=ON;\n${q}`], {
        encoding: 'utf8',
      }).trim(),
  };
}

// ------------------------------------------------------------------ fetch shim
export interface FakeResponseInit {
  status?: number;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string;
}

type FetchHandler = (call: FetchCall) => Promise<Response> | Response;

let activeHandler: FetchHandler | null = null;
export const fetchCalls: FetchCall[] = [];

export function installFetch(handler: FetchHandler): void {
  activeHandler = handler;
  fetchCalls.length = 0;
}

export function restoreFetch(): void {
  activeHandler = null;
  fetchCalls.length = 0;
}

export function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  const rawHeaders = new Headers(init?.headers ?? {});
  rawHeaders.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const call: FetchCall = { url, headers, method: init?.method ?? 'GET' };
  fetchCalls.push(call);
  if (!activeHandler) return Promise.reject(new Error('no fetch handler installed'));
  return Promise.resolve(activeHandler(call));
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ------------------------------------------------------------------ cache shim
export class MemoryCache {
  private readonly store = new Map<string, Response>();

  async match(key: string): Promise<Response | undefined> {
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }

  async put(key: string, response: Response): Promise<void> {
    this.store.set(key, response.clone());
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

// ------------------------------------------------------- worker entry invoke
export interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: <T = unknown>() => T;
}

export async function invoke(
  handler: { fetch: (req: Request, env: never) => Promise<Response> },
  request: Request,
  env: Record<string, unknown>,
): Promise<InvokeResult> {
  const response = await handler.fetch(request, env as never);
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    status: response.status,
    headers,
    text,
    json: <T = unknown>() => JSON.parse(text) as T,
  };
}
