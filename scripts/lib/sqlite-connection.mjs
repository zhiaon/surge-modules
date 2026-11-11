/**
 * Minimal persistent SQLite connection.
 *
 * The obvious implementation (spawn `sqlite3` per query) allocates a new V8
 * isolate plus a native process for every API request, which this device cannot
 * afford — it OOMs after a few dozen calls. Instead one long-lived `sqlite3`
 * child process is kept open and spoken to over stdin/stdout using a marker
 * protocol:
 *
 *   sent:     <sql>\n;SELECT '<<END:<id>>';\n
 *   received: ...rows...\n<<END:<id>>\n
 *
 * The child runs with `-batch -header -json`? No: a single child cannot switch
 * output mode per query, so it runs in plain list mode with a field separator
 * and re-emits JSON from the host side. That keeps parsing cheap and streaming.
 */

import { spawn } from 'node:child_process';

const SEP = '\u001f';
const ROW_SEP = '\u001e';

export class SqliteConnection {
  #child;
  #buffer = '';
  #seq = 0;
  #pending = new Map();
  #columns = new Map();
  #ready;

  #dbPath;

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#child = spawn('sqlite3', ['-batch', '-noheader', `-separator`, SEP, dbPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk));

    this.#child.on('exit', (code) => {
      for (const { reject } of this.#pending.values()) {
        reject(new Error(`sqlite3 exited (${code})`));
      }
      this.#pending.clear();
    });

    this.#ready = this.#write('PRAGMA foreign_keys=ON;');
  }

  #write(sql) {
    return new Promise((resolve) => {
      this.#child.stdin.write(`${sql}\n`, () => resolve());
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    // a response ends with the marker line for its id
    for (const [id, entry] of [...this.#pending.entries()]) {
      const marker = `<<END:${id}>>`;
      const at = this.#buffer.indexOf(marker);
      if (at === -1) continue;
      const payload = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + marker.length).replace(/^\r?\n/, '');
      entry.resolve(payload);
      this.#pending.delete(id);
    }
  }

  /** Runs SQL and returns parsed rows. Empty result ⇒ []. */
  async query(sql) {
    await this.#ready;
    const id = ++this.#seq;
    const marker = `<<END:${id}>>`;
    // `.mode list` + explicit terminator so multi-statement input is safe;
    // `-separator` applies to the child, so rows arrive already split
    const script = `PRAGMA foreign_keys=ON;\n${sql};\nSELECT '${marker}';\n`;

    const payload = await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(script, (err) => {
        if (err) {
          this.#pending.delete(id);
          reject(err);
        }
      });
    });

    return parseRows(payload, marker);
  }

  async run(sql) {
    await this.query(sql);
  }

  /**
   * Column names for a query.
   *
   * `SELECT * FROM (q) LIMIT 0` yields no rows and therefore no keys, so a
   * LIMIT 1 probe is used instead: the CLI is asked for JSON, and the keys of
   * the first object *are* the column names. When the query legitimately has no
   * rows, `pragma_table_info` is not applicable either, so an empty projection
   * is signalled by returning null and the caller treats the result as [].
   */
  async columnsFor(sql) {
    const cached = this.#columns.get(sql);
    if (cached !== undefined) return cached;

    const probe = `SELECT * FROM (${sql}) LIMIT 1;`;
    const out = await this.rawCli(probe);
    let cols = null;
    const trimmed = out.trim();
    if (trimmed.startsWith('[')) {
      try {
        const rows = JSON.parse(trimmed);
        if (Array.isArray(rows) && rows.length > 0) cols = Object.keys(rows[0]);
        else cols = null;
      } catch {
        cols = null;
      }
    }
    if (cols) this.#columns.set(sql, cols);
    return cols;
  }

  /** One-off query through a short-lived CLI call, used only for schema probes. */
  async rawCli(sql) {
    await this.#ready;
    const { execFileSync } = await import('node:child_process');
    try {
      return execFileSync('sqlite3', ['-batch', '-json', this.#dbPath, sql], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  }

  /** Sends a script and returns everything up to the marker. */
  /** Sends a script and returns everything up to the marker. */
  close() {
    this.#child.kill();
  }
}

function parseRows(payload, marker) {
  const text = payload.split(marker).join('').trim();
  if (!text) return [];

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line.includes(marker)) continue;
    const cells = line.split(SEP);
    rows.push(cells);
  }
  return rows;
}

/** Renders a JS value as a SQL literal. */
export function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Safely quotes an identifier for interpolation into SQL. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export { SEP, ROW_SEP };
