/**
 * Local API server.
 *
 * Why this exists: `wrangler dev` cannot start in this environment (the bundled
 * workerd binary is a musl build that needs `__res_init`, which the sandbox libc
 * does not export). Rather than leave the frontend with no API to talk to, this
 * runs **the same worker modules** on plain Node:
 *
 *   - `workers/site/index.ts` and `workers/module-proxy/index.ts` are imported
 *     unchanged — no forked logic, no second implementation to drift.
 *   - D1 is emulated over SQLite through one long-lived connection (spawning a
 *     process per query exhausted this device's memory).
 *   - `caches.default` is an in-memory Map.
 *   - static files come from ./dist, with SPA fallback, so refresh works.
 *   - when no GITHUB_READ_TOKEN is set, the proxy is pointed at a local fixture
 *     so the UI can be reviewed end to end. That path is dev-server-only and is
 *     never present in the deployed worker.
 *
 * Usage: npm run dev:local
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteConnection, quote, quoteIdent } from './lib/sqlite-connection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SITE_PORT = Number(argOf('--port', '8787'));
const PROXY_PORT = Number(argOf('--proxy-port', '8788'));

const DB_DIR = join(root, '.wrangler', 'local');
const DB_PATH = join(DB_DIR, 'dev.db');

// ------------------------------------------------------------------ database
function applyMigrations(db) {
  mkdirSync(DB_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    console.log('[db] reusing', DB_PATH);
    return;
  }
  const files = [
    '0001_init.sql',
    '0002_seed_reference.sql',
    '0003_backend_schema.sql',
    '0004_seed_settings.sql',
  ].map((f) => join(root, 'database', 'migrations', f));

  for (const file of files) {
    // migrations are single-shot (they rebuild tables), so they run through the
    // CLI once against the fresh file, then the long-lived connection takes over
    execFileSync('sqlite3', [DB_PATH], { input: readFileSync(file, 'utf8') });
  }
  console.log('[db] created', DB_PATH);

  const seed = join(root, 'database', 'seed-dev.sql');
  if (existsSync(seed)) {
    execFileSync('sqlite3', [DB_PATH], { input: readFileSync(seed, 'utf8') });
    execFileSync('sqlite3', [
      DB_PATH,
      "UPDATE sources SET is_enabled = 1 WHERE id = 'src-demo'",
    ]);
    console.log('[db] seeded demo module (proxy source enabled for local use)');
  }
}

// --------------------------------------------------------------------- D1 shim
class Statement {
  constructor(conn, sql) {
    this.conn = conn;
    this.sql = sql;
    this.params = [];
  }

  bind(...values) {
    this.params = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  #render() {
    let i = 0;
    let out = '';
    let inStr = false;
    for (const ch of this.sql) {
      if (ch === "'") inStr = !inStr;
      if (ch === '?' && !inStr) {
        if (i >= this.params.length) throw new Error('D1 shim: missing bind');
        out += quote(this.params[i++]);
      } else {
        out += ch;
      }
    }
    if (i !== this.params.length) throw new Error('D1 shim: unused binds');
    return out;
  }

  /**
   * Rows are reconstructed as JSON by SQLite itself. The column list is read
   * once per distinct query text and cached, so the extra round trip is paid
   * only on the first call.
   */
  async #rows() {
    const sql = this.#render();
    // JSON mode needs explicit column names; the probe runs the query with
    // LIMIT 1 to learn them. A query that legitimately returns no rows yields no
    // columns — that is an empty result, not an error.
    const cols = await this.conn.columnsFor(sql);
    if (!cols) return [];
    const projection = cols.map((c) => `'${c}', ${quoteIdent(c)}`).join(', ');
    const rows = await this.conn.query(
      `SELECT json_group_array(json_object(${projection})) FROM (${sql})`,
    );
    if (rows.length === 0 || !rows[0][0] || rows[0][0] === 'null') return [];
    return JSON.parse(rows[0][0]);
  }

  async first(column) {
    const rows = await this.#rows();
    if (rows.length === 0) return null;
    return column ? (rows[0][column] ?? null) : rows[0];
  }

  async all() {
    return { results: await this.#rows(), success: true, meta: {} };
  }

  async run() {
    await this.conn.run(this.#render());
    return { results: [], success: true, meta: { changes: 1 } };
  }
}

class D1Shim {
  constructor(conn) {
    this.conn = conn;
  }
  prepare(sql) {
    return new Statement(this.conn, sql);
  }
  async batch(statements) {
    return Promise.all(statements.map((s) => s.run()));
  }
}

// ----------------------------------------------------------- in-memory cache
class MemoryCache {
  #map = new Map();
  async match(key) {
    const hit = this.#map.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(key, res) {
    this.#map.set(key, res.clone());
  }
  async delete(key) {
    return this.#map.delete(key);
  }
}

// --------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const DIST = join(root, 'dist');

function serveAsset(pathname) {
  if (!existsSync(DIST)) {
    return new Response('前端未构建。先运行：npm run build', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, clean);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const asIndex = join(filePath, 'index.html');
    filePath = existsSync(asIndex) ? asIndex : join(DIST, 'index.html');
  }
  if (!filePath.startsWith(DIST)) return new Response('forbidden', { status: 403 });
  if (!existsSync(filePath)) return new Response('not found', { status: 404 });

  return new Response(readFileSync(filePath), {
    status: 200,
    headers: { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' },
  });
}

// ------------------------------------------------------------------ bundling
/**
 * Loads a pre-bundled worker.
 *
 * Bundling inside this process kept an esbuild service alive per run; a handful
 * of restarts left seven of them resident and the OS started killing the dev
 * server with std::bad_alloc. Bundling now happens once (`npm run
 * build:workers`) and this only imports the artifact.
 */
async function loadWorker(outName) {
  const outfile = join(root, '.devbuild', `${outName}.mjs`);
  if (!existsSync(outfile)) {
    throw new Error(
      `缺少 ${outfile}\n先运行：npm run build:workers`,
    );
  }
  return import(`${outfile}?t=${Date.now()}`);
}

// ------------------------------------------------------------ dev-only fixture
/**
 * Stands in for GitHub when no token is configured, so the module detail page
 * can be reviewed with real content. Compiled out of the deployed worker — this
 * lives only in the dev server.
 */
function fixtureFetch(url) {
  const body = `#!name=演示模块
#!desc=仅用于界面展示的占位配置，不对应任何真实服务
#!author=demo
#!category=adblock
#!version=1.2.0

[Rule]
DOMAIN-SUFFIX,ads.example.com,REJECT
DOMAIN-SUFFIX,track.example.net,REJECT
DOMAIN,pagead.example.org,REJECT
DOMAIN-SUFFIX,metrics.example.edu,REJECT

[URL Rewrite]
^https?:\\\\/\\\\/api\\\\.example\\\\.com\\\\/v1\\\\/promo - reject

[MITM]
hostname = %APPEND% api.example.com, m.example.net
`;
  if (url.includes('/contents/')) {
    return Promise.resolve(
      new Response(body, { status: 200, headers: { etag: '"fixture-v1"' } }),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

// ------------------------------------------------------------------- servers
function toRequest(req, base) {
  const url = new URL(req.url ?? '/', base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    // undici refuses a stream body without this; without it every POST throws
    init.body = req;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function main() {
  // the DB file has to exist (and be migrated) before the connection opens
  applyMigrations();
  const conn = new SqliteConnection(DB_PATH);

  const db = new D1Shim(conn);
  globalThis.caches = { default: new MemoryCache() };

  const siteModule = await loadWorker('site');
  const proxyModule = await loadWorker('proxy');

  const token = process.env.GITHUB_READ_TOKEN ?? '';
  if (!token) {
    globalThis.fetch = fixtureFetch;
    console.log('[proxy] 未设置 GITHUB_READ_TOKEN，使用本地 fixture 提供模块原文');
  }

  const siteEnv = {
    ASSETS: { fetch: (request) => Promise.resolve(serveAsset(new URL(request.url).pathname)) },
    DB: db,
    ENVIRONMENT: 'development',
    RATE_LIMIT_SALT: process.env.RATE_LIMIT_SALT ?? 'local-dev-salt',
  };

  const proxyEnv = {
    DB: db,
    // a placeholder token so the "operator forgot to configure" branch does not
    // fire locally; requests never leave the machine because fetch is shimmed
    GITHUB_READ_TOKEN: token || 'local-fixture-token',
    PUBLIC_BASE: `http://localhost:${PROXY_PORT}`,
    ENVIRONMENT: 'development',
    CACHE_TTL_SECONDS: '60',
    MAX_MODULE_BYTES: '262144',
    UPSTREAM_TIMEOUT_MS: '8000',
  };

  /**
 * Requests are serialized: this device has very little headroom, and a handful
 * of concurrent handlers (each holding a parsed response) was enough to abort
 * the process with std::bad_alloc. A dev server does not need concurrency.
 */
let gate = Promise.resolve();
function serialize(task) {
  const run = gate.then(task, task);
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const site = createServer(async (req, res) => {
    try {
      const response = await siteModule.default.fetch(toRequest(req, `http://localhost:${SITE_PORT}`), siteEnv);
      await writeResponse(res, response);
    } catch (err) {
      console.error('[site]', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: 'dev server error' } }));
    }
  });

  const proxy = createServer(async (req, res) => {
    try {
      await serialize(async () => {
        const response = await proxyModule.default.fetch(
          toRequest(req, `http://localhost:${PROXY_PORT}`),
          proxyEnv,
        );
        await writeResponse(res, response);
      });
    } catch (err) {
      console.error('[proxy]', err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dev server error\n');
    }
  });

  site.listen(SITE_PORT, () => {
    console.log(`\n  site   http://localhost:${SITE_PORT}`);
    console.log(`  proxy  http://localhost:${PROXY_PORT}`);
    console.log(`  db     ${DB_PATH}\n`);
  });
  proxy.listen(PROXY_PORT);

  const shutdown = () => {
    conn.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
