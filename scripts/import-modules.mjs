/**
 * Import modules from your own GitHub repository into the database.
 *
 * This is the phase-4 "seed with real data" path: it reads each `.sgmodule`
 * through the GitHub Contents API with the same credential the proxy uses, then
 * writes modules + proxy mappings. It is deliberately *not* a full sync engine —
 * sync_jobs/tombstones land in phase 5 — but it produces exactly the rows that
 * engine will produce, so the UI is exercised against real content.
 *
 * Usage:
 *   GITHUB_READ_TOKEN=ghp_xxx node scripts/import-modules.mjs \
 *     --owner zhiaon --repo Modules --branch main [--prefix ""] [--dry-run]
 *
 * Safety:
 *   - never prints the token
 *   - refuses to run without a token
 *   - `--dry-run` shows what would be written
 *   - the repository must be registered in `sources` (created if missing)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(root, '.wrangler', 'local', 'dev.db');

const argv = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const OWNER = flag('--owner', 'zhiaon');
const REPO = flag('--repo', 'Modules');
const BRANCH = flag('--branch', 'main');
const PREFIX = flag('--prefix', '');
const DRY = has('--dry-run');

const TOKEN = process.env.GITHUB_READ_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
if (!TOKEN) {
  console.error('缺少 GITHUB_READ_TOKEN（或用 GITHUB_TOKEN）');
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`找不到数据库 ${DB}\n先运行：npm run dev:local 让它建库`);
  process.exit(1);
}

// --------------------------------------------------------------------- helpers
function sql(query) {
  try {
    return execFileSync('sqlite3', ['-batch', '-noheader', DB, `PRAGMA foreign_keys=ON;\n${query}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // surface which statement failed instead of a bare stack trace
    const detail = err.stderr?.toString().trim() || err.message;
    console.error(`\nSQL 失败：${detail}\n---\n${query.slice(0, 600)}\n---`);
    throw err;
  }
}
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function gh(path, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'surge-modules-import',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return accept.includes('raw') ? res.text() : res.json();
}

/** Parses the `#!key=value` header block that Surge modules carry. */
function parseMeta(text) {
  const meta = {};
  for (const line of text.split('\n').slice(0, 40)) {
    const m = line.match(/^#!([\w-]+)\s*=\s*(.+)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Chinese titles have no ASCII; fall back to the file stem. */
function slugFor(meta, filePath) {
  const stem = filePath.split('/').pop().replace(/\.sgmodule$/, '');
  const fromName = slugify(meta.name ?? '');
  return fromName.length >= 3 ? fromName : slugify(stem);
}

const CATEGORY_MAP = [
  [/去广告|广告|拦截/, 'adblock'],
  [/分流|规则|dns/i, 'rules'],
  [/脚本|script/i, 'scripts'],
  [/净化|清理/, 'clean'],
  [/隐私|防护/, 'privacy'],
  [/网络|ip|面板|解锁|流媒体|工具/, 'tools'],
];

function categoryFor(meta, name) {
  const hay = `${meta.category ?? ''} ${name}`;
  for (const [re, slug] of CATEGORY_MAP) if (re.test(hay)) return slug;
  return 'tools';
}

// ------------------------------------------------------------------------ main
console.log(`仓库 ${OWNER}/${REPO}@${BRANCH}${PREFIX ? ` 前缀 ${PREFIX}` : ''}${DRY ? '  [dry-run]' : ''}\n`);

const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
if (!tree.tree) {
  console.error('读取仓库树失败:', tree.message ?? '未知错误');
  process.exit(1);
}

let files = tree.tree
  .filter((n) => n.type === 'blob' && n.path.endsWith('.sgmodule'))
  .filter((n) => (PREFIX ? n.path.startsWith(PREFIX) : true))
  .map((n) => n.path);
files = [...new Set(files)];

if (files.length === 0) {
  console.error(`仓库里没有 .sgmodule 文件${PREFIX ? `（前缀 ${PREFIX}）` : ''}`);
  process.exit(1);
}
console.log(`发现 ${files.length} 个模块文件\n`);

// source row (the allowlist entry the proxy joins against)
const SOURCE_ID = `src-${OWNER}-${REPO}`.toLowerCase();
const allowPaths = [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/') || ''))]
  .filter(Boolean)
  .join(',');

if (!DRY) {
  sql(`INSERT INTO sources (id, owner, repo, branch, allow_paths, sync_mode, is_enabled, notes)
       VALUES (${q(SOURCE_ID)}, ${q(OWNER)}, ${q(REPO)}, ${q(BRANCH)}, ${q(allowPaths)},
               'manual', 1, 'imported by scripts/import-modules.mjs')
       ON CONFLICT(id) DO UPDATE SET
         owner=excluded.owner, repo=excluded.repo, branch=excluded.branch,
         allow_paths=excluded.allow_paths, is_enabled=1,
         updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
}

// slugs already taken by OTHER modules (the demo seed), so an import never
// silently renames or overwrites something the operator already curated
const usedSlugs = new Set(
  sql("SELECT slug FROM modules WHERE deleted_at IS NULL AND source_id IS NOT 'src-zhiaon-modules'")
    .split('\n')
    .filter(Boolean),
);
let added = 0;
let updated = 0;
let skipped = 0;

for (const filePath of files) {
  const text = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BRANCH}`, 'application/vnd.github.raw');
  const meta = parseMeta(text);
  const name = meta.name ?? filePath.split('/').pop().replace(/\.sgmodule$/, '');
  const slug = slugFor(meta, filePath);
  if (usedSlugs.has(slug)) {
    console.warn(`    ! slug "${slug}" 已被其他来源占用，跳过（请手动改名）`);
    continue;
  }
  usedSlugs.add(slug);

  const categorySlug = categoryFor(meta, name);
  const categoryId = sql(`SELECT id FROM categories WHERE slug=${q(categorySlug)} LIMIT 1`) || 'cat-tools';
  const version = (meta.version ?? meta.desc?.match(/v?(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? '1.0.0').replace(/^v/i, '');
  const description = (meta.desc ?? '').replace(/^V?\d+(\.\d+)*[:：]\s*/i, '').slice(0, 400);
  const author = meta.author ?? OWNER;
  const hash = execFileSync('sh', ['-c', `printf '%s' ${q(text)} | md5sum`], { encoding: 'utf8' }).slice(0, 12);

  const moduleId = `mod-${slug}`;
  // `sql()` returns '' for "no rows", so a truthiness check is required here;
  // `??` would keep the empty string and every later FK would reference ''.
  const existing = sql(`SELECT id FROM modules WHERE slug=${q(slug)} LIMIT 1`) || null;

  console.log(`  ${slug.padEnd(22)} ${name}`);
  console.log(`    ${categoryId.padEnd(14)} v${version.padEnd(8)} ${String(text.length).padStart(6)}B  ${filePath}`);

  if (DRY) continue;

  if (existing) {
    sql(`UPDATE modules SET name=${q(name)}, description=${q(description)}, author=${q(author)},
           category_id=${q(categoryId)}, version=${q(version)}, source_id=${q(SOURCE_ID)},
           source_path=${q(filePath)}, content_hash=${q(hash)},
           updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id=${q(existing)}`);
    updated += 1;
  } else {
    sql(`INSERT INTO modules (id, slug, name, description, author, category_id, version,
             source_id, source_path, content_hash, is_featured, is_published, published_at, synced_at)
           VALUES (${q(moduleId)}, ${q(slug)}, ${q(name)}, ${q(description)}, ${q(author)},
             ${q(categoryId)}, ${q(version)}, ${q(SOURCE_ID)}, ${q(filePath)}, ${q(hash)},
             0, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
    added += 1;
  }

  // tags from the module category + any arguments-free keywords in the name
  const tags = new Set();
  if (meta.category) tags.add(meta.category);
  if (/dns/i.test(name)) tags.add('DNS');
  if (/去广告|广告/.test(name)) tags.add('去广告');
  if (/解锁|流媒体/.test(name)) tags.add('流媒体');
  if (/面板|IP|流量/.test(name)) tags.add('面板');
  if (/缓存|刷新/.test(name)) tags.add('工具');

  const mid = existing ?? moduleId;
  for (const tag of tags) {
    sql(`INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (${q(mid)}, ${q(tag)})`);
  }

  // one version row per content hash
  sql(`INSERT OR IGNORE INTO module_versions (id, module_id, version, content_hash, changelog, released_at)
       VALUES (${q(`${mid}-${hash}`)}, ${q(mid)}, ${q(version)}, ${q(hash)},
               ${q(description.slice(0, 200))}, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);

  // proxy mapping: the only place that knows repo path for this slug
  const mapId = `map-${slug}`;
  sql(`INSERT INTO module_proxy_mappings (id, module_id, public_slug, source_id, file_path, serve_mode, is_enabled, content_hash)
       VALUES (${q(mapId)}, ${q(mid)}, ${q(slug)}, ${q(SOURCE_ID)}, ${q(filePath)}, 'raw', 1, ${q(hash)})
       ON CONFLICT(id) DO UPDATE SET
         file_path=excluded.file_path, content_hash=excluded.content_hash,
         is_enabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
}

console.log(`\n新增 ${added}，更新 ${updated}，跳过 ${skipped}`);
if (!DRY) {
  console.log('\n验证：');
  console.log(sql(`SELECT m.slug || '  ' || p.file_path FROM module_proxy_mappings p JOIN modules m ON m.id=p.module_id ORDER BY m.slug`));
}
