var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// workers/site/sync.ts
function safeSegment(value) {
  return SEGMENT_RE.test(value) && value !== "." && value !== "..";
}
function safePath(path) {
  if (!path || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("..")) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  return /^[\w./@+-]+$/.test(path);
}
function allowedByPrefix(filePath, allowPaths) {
  const prefixes = allowPaths.split(",").map((p) => p.trim()).filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+/, "");
    return filePath === clean || filePath.startsWith(clean.endsWith("/") ? clean : `${clean}/`);
  });
}
function parseModuleMeta(text, fallbackName) {
  const meta = {};
  const lines = text.split("\n").slice(0, 60);
  for (const line of lines) {
    const m = line.match(/^#!([\w-]+)\s*=\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const desc = (meta.desc ?? meta.description ?? "").replace(/^V?\d+(\.\d+)*[:：]\s*/i, "").slice(0, 400);
  const versionFromDesc = (meta.desc ?? "").match(/^V?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  return {
    name: (meta.name ?? fallbackName).slice(0, 80),
    description: desc,
    author: (meta.author ?? "").slice(0, 60),
    category: (meta.category ?? "").slice(0, 40),
    version: (meta.version ?? versionFromDesc ?? "1.0.0").replace(/^v/i, "").slice(0, 20),
    icon: (meta.icon ?? "").slice(0, 200),
    homepage: (meta.homepage ?? "").slice(0, 200),
    openUrl: (meta["openurl"] ?? "").slice(0, 200)
  };
}
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function categorySlugFor(meta, name) {
  const hay = `${meta.category} ${name}`;
  if (/去广告|广告|拦截/.test(hay)) return "adblock";
  if (/分流|规则|dns|DNS/.test(hay)) return "rules";
  if (/脚本|script/i.test(hay)) return "scripts";
  if (/净化|清理/.test(hay)) return "clean";
  if (/隐私|防护/.test(hay)) return "privacy";
  return "tools";
}
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function ghFetch(path, token, accept = "application/vnd.github+json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "surge-modules-sync"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
async function listFiles(source, token) {
  if (!safeSegment(source.owner) || !safeSegment(source.repo) || !safeSegment(source.branch)) {
    return { error: "\u4ED3\u5E93\u6807\u8BC6\u4E0D\u5408\u6CD5" };
  }
  const res = await ghFetch(
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(source.branch)}?recursive=1`,
    token
  );
  if (res.status === 404) return { error: "\u4ED3\u5E93\u6216\u5206\u652F\u4E0D\u5B58\u5728\uFF0C\u6216\u5F53\u524D\u51ED\u636E\u65E0\u6743\u8BBF\u95EE" };
  if (res.status === 401) return { error: "\u51ED\u636E\u65E0\u6548" };
  if (res.status === 403 || res.status === 429) {
    const retry = res.headers.get("retry-after") ?? "60";
    return { error: `GitHub \u9650\u6D41\uFF0C\u5EFA\u8BAE ${retry}s \u540E\u91CD\u8BD5` };
  }
  if (!res.ok) return { error: `GitHub \u8FD4\u56DE ${res.status}` };
  const body = await res.json();
  const files = (body.tree ?? []).filter((n) => n.type === "blob").filter((n) => n.path.endsWith(".sgmodule")).filter((n) => safePath(n.path)).filter((n) => allowedByPrefix(n.path, source.allow_paths)).map((n) => n.path).slice(0, MAX_FILES);
  return { files };
}
async function fetchFile(source, path, token) {
  if (!safePath(path)) return { error: "\u8DEF\u5F84\u4E0D\u5408\u6CD5" };
  const res = await ghFetch(
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(source.branch)}`,
    token,
    "application/vnd.github.raw"
  );
  if (res.status === 404) return { error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
  if (res.status === 403) return { error: "\u65E0\u6743\u8BFB\u53D6\u8BE5\u6587\u4EF6" };
  if (res.status === 429) return { error: "GitHub \u9650\u6D41" };
  if (!res.ok) return { error: `GitHub \u8FD4\u56DE ${res.status}` };
  const declared = Number.parseInt(res.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_FILE_BYTES) return { error: "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650" };
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) return { error: "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650" };
  return { text };
}
async function acquireLock(db, sourceId, token) {
  const now = Date.now();
  const stale = new Date(now - LOCK_TTL_MS).toISOString().replace(/\.\d+Z$/, "Z");
  const iso5 = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
  const res = await db.prepare(
    `UPDATE sources SET sync_lock = ?, sync_lock_at = ?
        WHERE id = ?
          AND (sync_lock IS NULL OR sync_lock_at IS NULL OR sync_lock_at < ?)`
  ).bind(token, iso5, sourceId, stale).run();
  const changed = res.meta?.changes ?? 0;
  return changed > 0;
}
async function releaseLock(db, sourceId, token) {
  await db.prepare("UPDATE sources SET sync_lock = NULL, sync_lock_at = NULL WHERE id = ? AND sync_lock = ?").bind(sourceId, token).run();
}
async function syncSource(env, sourceId, trigger) {
  const { DB } = env;
  const jobId = crypto.randomUUID();
  const startedAt = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const empty = {
    jobId,
    scanned: 0,
    added: 0,
    updated: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0
  };
  const source = await DB.prepare(
    `SELECT id, owner, repo, branch, allow_paths, is_enabled, sync_lock, sync_lock_at,
            sync_cursor, sync_total, consecutive_failures
       FROM sources WHERE id = ? AND deleted_at IS NULL`
  ).bind(sourceId).first();
  if (!source) {
    return { ...empty, status: "failed", message: "\u6570\u636E\u6E90\u4E0D\u5B58\u5728" };
  }
  if (source.is_enabled !== 1) {
    return { ...empty, status: "skipped", message: "\u6570\u636E\u6E90\u5DF2\u505C\u7528" };
  }
  if (!env.GITHUB_READ_TOKEN) {
    await DB.prepare(
      `INSERT INTO sync_jobs (id, source_id, trigger, status, started_at, finished_at, error)
       VALUES (?, ?, ?, 'failed', ?, ?, '\u672A\u914D\u7F6E GITHUB_READ_TOKEN')`
    ).bind(jobId, sourceId, trigger, startedAt, startedAt).run();
    return { ...empty, status: "failed", message: "\u672A\u914D\u7F6E GITHUB_READ_TOKEN" };
  }
  const lockToken = crypto.randomUUID();
  if (!await acquireLock(DB, sourceId, lockToken)) {
    return { ...empty, status: "skipped", message: "\u8BE5\u6570\u636E\u6E90\u5DF2\u6709\u540C\u6B65\u4EFB\u52A1\u5728\u8FD0\u884C" };
  }
  await DB.prepare(
    `INSERT INTO sync_jobs (id, source_id, trigger, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`
  ).bind(jobId, sourceId, trigger, startedAt).run();
  const log = async (level, path, message) => {
    await DB.prepare(
      "INSERT INTO sync_logs (job_id, level, path, message) VALUES (?, ?, ?, ?)"
    ).bind(jobId, level, path, message.slice(0, 500)).run();
  };
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const listing = await listFiles(source, env.GITHUB_READ_TOKEN);
    if ("error" in listing) {
      await log("error", null, listing.error);
      throw new Error(listing.error);
    }
    const tombstones = new Set(
      (await DB.prepare("SELECT source_path FROM module_tombstones WHERE source_id = ?").bind(sourceId).all()).results?.map((r) => r.source_path) ?? []
    );
    const existing = new Map(
      (await DB.prepare(
        `SELECT id, slug, source_path, content_hash FROM modules
            WHERE source_id = ? AND deleted_at IS NULL`
      ).bind(sourceId).all()).results?.map((r) => [r.source_path, r]) ?? []
    );
    const overrides = /* @__PURE__ */ new Map();
    for (const row of (await DB.prepare(
      `SELECT o.module_id, o.field FROM module_overrides o
           JOIN modules m ON m.id = o.module_id WHERE m.source_id = ?`
    ).bind(sourceId).all()).results ?? []) {
      if (!overrides.has(row.module_id)) overrides.set(row.module_id, /* @__PURE__ */ new Set());
      overrides.get(row.module_id).add(row.field);
    }
    const usedSlugs = new Set(
      (await DB.prepare("SELECT slug FROM modules WHERE deleted_at IS NULL").all()).results?.map((r) => r.slug) ?? []
    );
    const totalFiles = listing.files.length;
    const countChanged = source.sync_total !== totalFiles;
    const cursor = countChanged ? 0 : source.sync_cursor;
    const batch = listing.files.slice(cursor, cursor + BATCH_SIZE);
    const nextCursor = cursor + batch.length;
    const partial = nextCursor < totalFiles;
    await DB.prepare("UPDATE sources SET sync_total = ?, sync_cursor = ? WHERE id = ?").bind(totalFiles, partial ? nextCursor : 0, sourceId).run();
    for (const path of batch) {
      scanned += 1;
      if (tombstones.has(path)) {
        skipped += 1;
        await log("info", path, "\u5DF2\u5FFD\u7565\uFF08tombstone\uFF09");
        continue;
      }
      const fetched = await fetchFile(source, path, env.GITHUB_READ_TOKEN);
      if ("error" in fetched) {
        failed += 1;
        await log("error", path, fetched.error);
        continue;
      }
      const hash = await sha256(fetched.text);
      const prev = existing.get(path);
      if (prev && prev.content_hash === hash) {
        unchanged += 1;
        continue;
      }
      const fallbackName = path.split("/").pop().replace(/\.sgmodule$/, "");
      const meta = parseModuleMeta(fetched.text, fallbackName);
      const categorySlug = categorySlugFor(meta, meta.name);
      const category = await DB.prepare("SELECT id FROM categories WHERE slug = ? AND deleted_at IS NULL").bind(categorySlug).first();
      if (prev) {
        const ov = overrides.get(prev.id) ?? /* @__PURE__ */ new Set();
        const sets = [];
        const binds = [];
        const maybe = (field, value) => {
          if (ov.has(field)) return;
          sets.push(`${field} = ?`);
          binds.push(value);
        };
        maybe("name", meta.name);
        maybe("description", meta.description);
        maybe("author", meta.author || source.owner);
        maybe("category_id", category?.id ?? null);
        maybe("version", meta.version);
        sets.push("content_hash = ?", "synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
        binds.push(hash);
        await DB.prepare(`UPDATE modules SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, prev.id).run();
        await DB.prepare(
          `INSERT OR IGNORE INTO module_versions
             (id, module_id, version, content_hash, changelog, released_at)
           VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
        ).bind(
          `${prev.id}-${hash.slice(0, 12)}`,
          prev.id,
          meta.version,
          hash,
          meta.description.slice(0, 200)
        ).run();
        updated += 1;
        changed += 1;
        await log("info", path, `\u66F4\u65B0 ${prev.slug} \u2192 v${meta.version}`);
        continue;
      }
      let slug = slugify(meta.name);
      if (slug.length < 3) slug = slugify(fallbackName);
      if (usedSlugs.has(slug)) {
        const alt = slugify(`${slug}-${fallbackName}`);
        if (usedSlugs.has(alt)) {
          skipped += 1;
          await log("warn", path, `slug \u51B2\u7A81\uFF08${slug}\uFF09\uFF0C\u8DF3\u8FC7`);
          continue;
        }
        slug = alt;
      }
      usedSlugs.add(slug);
      const moduleId = `mod-${slug}`;
      await DB.prepare(
        `INSERT INTO modules
           (id, slug, name, description, author, category_id, version,
            source_id, source_path, content_hash, is_featured, is_published,
            review_status, published_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
      ).bind(
        moduleId,
        slug,
        meta.name,
        meta.description,
        meta.author || source.owner,
        category?.id ?? null,
        meta.version,
        sourceId,
        path,
        hash
      ).run();
      for (const tag of deriveTags(meta, meta.name)) {
        await DB.prepare("INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)").bind(moduleId, tag).run();
      }
      await DB.prepare(
        `INSERT INTO module_versions (id, module_id, version, content_hash, changelog, released_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
      ).bind(
        `${moduleId}-${hash.slice(0, 12)}`,
        moduleId,
        meta.version,
        hash,
        meta.description.slice(0, 200)
      ).run();
      await DB.prepare(
        `INSERT INTO module_proxy_mappings
           (id, module_id, public_slug, source_id, file_path, serve_mode,
            is_enabled, content_hash)
         VALUES (?, ?, ?, ?, ?, 'raw', 0, ?)`
      ).bind(`map-${slug}`, moduleId, slug, sourceId, path, hash).run();
      await DB.prepare(
        `INSERT INTO review_items (id, module_id, kind, status, source_id, source_path, proposed, baseline)
         VALUES (?, ?, 'new', 'pending', ?, ?, ?, '{}')`
      ).bind(
        crypto.randomUUID(),
        moduleId,
        sourceId,
        path,
        JSON.stringify({ name: meta.name, version: meta.version, category: categorySlug })
      ).run();
      added += 1;
      await log("info", path, `\u65B0\u589E ${slug}\uFF08\u5F85\u5BA1\u6838\uFF09`);
    }
    await DB.prepare(
      `UPDATE sync_jobs SET status = 'ok', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              scanned = ?, added = ?, updated = ?, skipped = ?, failed = ?
        WHERE id = ?`
    ).bind(scanned, added, updated, skipped, failed, jobId).run();
    await DB.prepare(
      `UPDATE sources SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              last_status = ?, consecutive_failures = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
    ).bind(failed > 0 ? "partial" : "ok", sourceId).run();
    if (source.consecutive_failures >= ALERT_THRESHOLD) {
      await DB.prepare(
        `INSERT INTO sync_alerts (source_id, kind, message) VALUES (?, 'recovered', ?)`
      ).bind(sourceId, `\u540C\u6B65\u6062\u590D\uFF1A${source.owner}/${source.repo}`).run();
    }
    if (partial) {
      await log(
        "info",
        null,
        `\u5206\u6279\u5904\u7406\uFF1A${nextCursor}/${totalFiles}\uFF0C\u4E0B\u6B21\u4ECE\u7B2C ${nextCursor} \u4E2A\u6587\u4EF6\u7EE7\u7EED`
      );
    }
    return {
      jobId,
      status: "ok",
      scanned,
      added,
      updated,
      changed,
      unchanged,
      skipped,
      failed,
      partial,
      totalFiles,
      processed: batch.length,
      message: partial ? `\u672C\u6279 ${batch.length}/${totalFiles} \u4E2A\u6587\u4EF6\uFF1A\u65B0\u589E ${added}\uFF0C\u66F4\u65B0 ${updated}\uFF0C\u672A\u53D8 ${unchanged}\uFF0C\u5931\u8D25 ${failed}` : `\u626B\u63CF ${scanned}\uFF0C\u65B0\u589E ${added}\uFF0C\u66F4\u65B0 ${updated}\uFF0C\u672A\u53D8 ${unchanged}\uFF0C\u5931\u8D25 ${failed}`
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("error", null, message);
    await DB.prepare(
      `UPDATE sync_jobs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              scanned = ?, added = ?, updated = ?, skipped = ?, failed = ?, error = ?
        WHERE id = ?`
    ).bind(scanned, added, updated, skipped, failed + 1, message.slice(0, 500), jobId).run();
    await DB.prepare(
      `UPDATE sources SET last_status = 'failed',
              consecutive_failures = consecutive_failures + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
    ).bind(sourceId).run();
    const after = await DB.prepare(
      "SELECT consecutive_failures FROM sources WHERE id = ?"
    ).bind(sourceId).first();
    if ((after?.consecutive_failures ?? 0) === ALERT_THRESHOLD) {
      await DB.prepare(
        `INSERT INTO sync_alerts (source_id, kind, message) VALUES (?, 'failure', ?)`
      ).bind(
        sourceId,
        `\u540C\u6B65\u8FDE\u7EED\u5931\u8D25 ${ALERT_THRESHOLD} \u6B21\uFF1A${message.slice(0, 200)}`
      ).run();
    }
    return {
      jobId,
      status: "failed",
      scanned,
      added,
      updated,
      changed,
      unchanged,
      skipped,
      failed: failed + 1,
      message
    };
  } finally {
    await releaseLock(DB, sourceId, lockToken);
  }
}
function deriveTags(meta, name) {
  const tags = /* @__PURE__ */ new Set();
  if (meta.category) tags.add(meta.category.slice(0, 20));
  if (/dns/i.test(name)) tags.add("DNS");
  if (/去广告|广告/.test(name)) tags.add("\u53BB\u5E7F\u544A");
  if (/解锁|流媒体/.test(name)) tags.add("\u6D41\u5A92\u4F53");
  if (/面板|IP|流量/.test(name)) tags.add("\u9762\u677F");
  if (/缓存|刷新/.test(name)) tags.add("\u5DE5\u5177");
  return [...tags].slice(0, 6);
}
var GITHUB_API, MAX_FILE_BYTES, MAX_FILES, FETCH_TIMEOUT_MS, LOCK_TTL_MS, BATCH_SIZE, ALERT_THRESHOLD, SEGMENT_RE;
var init_sync = __esm({
  "workers/site/sync.ts"() {
    "use strict";
    GITHUB_API = "https://api.github.com";
    MAX_FILE_BYTES = 256 * 1024;
    MAX_FILES = 500;
    FETCH_TIMEOUT_MS = 15e3;
    LOCK_TTL_MS = 10 * 60 * 1e3;
    BATCH_SIZE = 6;
    ALERT_THRESHOLD = 2;
    SEGMENT_RE = /^[\w.-]{1,100}$/;
  }
});

// workers/site/telegram.ts
var telegram_exports = {};
__export(telegram_exports, {
  buildTaskMessage: () => buildTaskMessage,
  handleTelegramWebhook: () => handleTelegramWebhook,
  isAdminTelegram: () => isAdminTelegram,
  notifyAudit: () => notifyAudit,
  notifyOps: () => notifyOps,
  notifyReviewTask: () => notifyReviewTask
});
async function tgCall(token, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12e3);
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      return { ok: false, description: json.description ?? `HTTP ${res.status}` };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : "Telegram \u8BF7\u6C42\u5931\u8D25"
    };
  } finally {
    clearTimeout(timer);
  }
}
async function resolvedAdminId(env) {
  if (env.TELEGRAM_ADMIN_ID?.trim()) return env.TELEGRAM_ADMIN_ID.trim();
  const row = await env.DB.prepare(
    "SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'"
  ).first();
  return (row?.value ?? "").trim();
}
async function settingOn(env, key) {
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(key).first();
  return (row?.value ?? "1") !== "0";
}
async function isAdminTelegram(env, fromId) {
  if (fromId === void 0 || fromId === null) return false;
  const allowed = await resolvedAdminId(env);
  if (!allowed) return false;
  return String(fromId) === allowed;
}
async function loadTaskContext(env, taskId) {
  return env.DB.prepare(
    `SELECT t.id, t.task_type, t.detection_method, t.file_path, t.branch,
            t.old_version, t.new_version, t.commit_sha, t.new_content,
            r.name AS repository_name, r.owner, r.repository
       FROM module_review_tasks t
       LEFT JOIN third_party_repositories r ON r.id = t.repository_id
      WHERE t.id = ?`
  ).bind(taskId).first();
}
function moduleNameFrom(filePath, content) {
  const m = content.match(/^#!\s*name\s*=\s*(.+)$/im);
  if (m) return m[1].trim().slice(0, 80);
  return (filePath.split("/").pop() ?? filePath).replace(/\.sgmodule$/i, "");
}
function moduleDescFrom(content) {
  const m = content.match(/^#!\s*desc(?:ription)?\s*=\s*(.+)$/im);
  return m ? m[1].trim().replace(/^V?\d+(\.\d+)*[:：]\s*/i, "").slice(0, 200) : "";
}
function moduleAuthorFrom(content) {
  const m = content.match(/^#!\s*author\s*=\s*(.+)$/im);
  return m ? m[1].trim().slice(0, 60) : "";
}
function buildTaskMessage(task) {
  const name = moduleNameFrom(task.file_path, task.new_content ?? "");
  const desc = moduleDescFrom(task.new_content ?? "");
  const author = moduleAuthorFrom(task.new_content ?? "");
  const repoFull = `${task.owner ?? "?"}/${task.repository ?? "?"}`;
  const githubUrl = `https://github.com/${repoFull}/blob/${task.branch || "main"}/${task.file_path.split("/").map(encodeURIComponent).join("/")}`;
  const title = task.task_type === "new" ? "\u53D1\u73B0\u7B2C\u4E09\u65B9\u65B0\u6A21\u5757\uFF0C\u7B49\u5F85\u5BA1\u6838" : task.task_type === "update" ? "\u53D1\u73B0\u7B2C\u4E09\u65B9\u6A21\u5757\u66F4\u65B0\uFF0C\u7B49\u5F85\u5BA1\u6838" : "\u7B2C\u4E09\u65B9\u4ED3\u5E93\u5220\u9664\u4E86\u6A21\u5757\u6587\u4EF6\uFF0C\u9700\u8981\u5904\u7406";
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    "",
    `<b>\u6A21\u5757</b>\uFF1A${escapeHtml(name)}`
  ];
  if (desc) lines.push(`<b>\u63CF\u8FF0</b>\uFF1A${escapeHtml(desc)}`);
  if (author) lines.push(`<b>\u4F5C\u8005</b>\uFF1A${escapeHtml(author)}`);
  lines.push(`<b>\u6765\u6E90</b>\uFF1A${escapeHtml(task.repository_name ?? repoFull)}`);
  lines.push(`<b>\u4ED3\u5E93</b>\uFF1A<code>${escapeHtml(repoFull)}</code>`);
  lines.push(`<b>\u5206\u652F</b>\uFF1A<code>${escapeHtml(task.branch || "main")}</code>`);
  lines.push(`<b>\u8DEF\u5F84</b>\uFF1A<code>${escapeHtml(task.file_path)}</code>`);
  if (task.task_type === "update") {
    lines.push(`<b>\u5F53\u524D\u7EBF\u4E0A\u7248\u672C</b>\uFF1A<code>${escapeHtml(task.old_version || "\u2014")}</code>`);
    lines.push(`<b>\u5F85\u5BA1\u6838\u7248\u672C</b>\uFF1A<code>${escapeHtml(task.new_version || "\u2014")}</code>`);
  } else if (task.task_type === "new") {
    lines.push(`<b>\u7248\u672C</b>\uFF1A<code>${escapeHtml(task.new_version || "\u2014")}</code>`);
  }
  if (task.commit_sha) {
    lines.push(`<b>Commit</b>\uFF1A<code>${escapeHtml(task.commit_sha.slice(0, 10))}</code>`);
  }
  lines.push(`<b>\u68C0\u6D4B\u65B9\u5F0F</b>\uFF1A${escapeHtml(METHOD_LABEL[task.detection_method] ?? task.detection_method)}`);
  lines.push(`<b>\u4EFB\u52A1\u7C7B\u578B</b>\uFF1A${escapeHtml(TYPE_LABEL[task.task_type] ?? task.task_type)}`);
  const text = lines.join("\n").slice(0, MAX_TEXT);
  const rows = [];
  const siteUrl = "https://son.zhiaon.top/admin";
  if (task.task_type === "delete") {
    rows.push([
      { text: "\u4FDD\u7559\u7EBF\u4E0A\u6A21\u5757", callback_data: `d:k:${task.id}` },
      { text: "\u9690\u85CF\u6A21\u5757", callback_data: `d:h:${task.id}` }
    ]);
    rows.push([
      { text: "\u4E0B\u67B6\u6A21\u5757", callback_data: `d:u:${task.id}` },
      { text: "\u786E\u8BA4\u5220\u9664", callback_data: `d:x:${task.id}` }
    ]);
  } else {
    rows.push([
      { text: task.task_type === "update" ? "\u2705 \u901A\u8FC7\u66F4\u65B0" : "\u2705 \u901A\u8FC7\u5BA1\u6838", callback_data: `a:${task.id}` },
      { text: task.task_type === "update" ? "\u274C \u62D2\u7EDD\u66F4\u65B0" : "\u274C \u62D2\u7EDD\u53D1\u5E03", callback_data: `r:${task.id}` }
    ]);
  }
  rows.push([
    { text: "\u67E5\u770B\u8BE6\u60C5", url: `${siteUrl}?review=${encodeURIComponent(task.id)}` },
    { text: "\u67E5\u770B GitHub", url: githubUrl }
  ]);
  return { text, keyboard: { inline_keyboard: rows } };
}
async function notifyReviewTask(env, taskId, kind) {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: false, error: "\u672A\u914D\u7F6E TELEGRAM_BOT_TOKEN" };
  const gateKey = kind === "new" ? "third_party.notify_new" : kind === "update" ? "third_party.notify_update" : "third_party.notify_delete";
  if (!await settingOn(env, gateKey)) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'skipped', updated_at = ? WHERE id = ?`
    ).bind(iso(), taskId).run();
    return { sent: false, error: "\u8BE5\u7C7B\u578B\u901A\u77E5\u5DF2\u5173\u95ED" };
  }
  const adminId = await resolvedAdminId(env);
  if (!adminId) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'failed',
              notify_error = '\u672A\u914D\u7F6E TELEGRAM_ADMIN_ID', updated_at = ? WHERE id = ?`
    ).bind(iso(), taskId).run();
    return { sent: false, error: "\u672A\u914D\u7F6E TELEGRAM_ADMIN_ID" };
  }
  const claim = await env.DB.prepare(
    `UPDATE module_review_tasks SET notify_status = 'sending', updated_at = ?
      WHERE id = ? AND notify_status IN ('pending', 'failed')`
  ).bind(iso(), taskId).run();
  if ((claim.meta?.changes ?? 0) === 0) {
    return { sent: false, error: "\u8BE5\u4EFB\u52A1\u5DF2\u901A\u77E5\u8FC7" };
  }
  const task = await loadTaskContext(env, taskId);
  if (!task) return { sent: false, error: "\u4EFB\u52A1\u4E0D\u5B58\u5728" };
  const { text, keyboard } = buildTaskMessage(task);
  const res = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: adminId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
  if (!res.ok) {
    await env.DB.prepare(
      `UPDATE module_review_tasks SET notify_status = 'failed', notify_error = ?, updated_at = ?
        WHERE id = ?`
    ).bind((res.description ?? "\u53D1\u9001\u5931\u8D25").slice(0, 300), iso(), taskId).run();
    return { sent: false, error: res.description };
  }
  await env.DB.prepare(
    `UPDATE module_review_tasks SET notify_status = 'sent', notify_error = '',
            notify_message_id = ?, notified_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(String(res.result?.message_id ?? ""), iso(), iso(), taskId).run();
  return { sent: true };
}
async function notifyAudit(env, outcome, task, operator, reason) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (!await settingOn(env, "third_party.notify_reviewed")) return;
  const adminId = await resolvedAdminId(env);
  if (!adminId) return;
  const name = (task.file_path.split("/").pop() ?? task.file_path).replace(/\.sgmodule$/i, "");
  const head = outcome === "approved" ? "\u2705 \u5DF2\u901A\u8FC7\u5BA1\u6838" : "\u{1F6AB} \u5DF2\u62D2\u7EDD";
  const lines = [
    `<b>${head}</b>`,
    "",
    `\u6A21\u5757\uFF1A<code>${escapeHtml(name)}</code>`,
    `\u7C7B\u578B\uFF1A${escapeHtml(TYPE_LABEL[task.task_type] ?? task.task_type)}`,
    task.new_version ? `\u7248\u672C\uFF1A<code>${escapeHtml(task.new_version)}</code>` : "",
    `\u64CD\u4F5C\u4EBA\uFF1A${escapeHtml(operator)}`,
    reason ? `\u539F\u56E0\uFF1A${escapeHtml(reason)}` : "",
    `\u65F6\u95F4\uFF1A${escapeHtml(iso().replace("T", " ").replace("Z", " UTC"))}`
  ].filter(Boolean);
  await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: adminId,
    text: lines.join("\n").slice(0, MAX_TEXT),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}
async function notifyOps(env, title, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (!await settingOn(env, "third_party.notify_failure")) return;
  const adminId = await resolvedAdminId(env);
  if (!adminId) return;
  await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: adminId,
    text: `<b>${escapeHtml(title)}</b>

${escapeHtml(body).slice(0, 2600)}`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}
async function answerCallback(token, callbackId, text, alert = false) {
  await tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 190),
    show_alert: alert
  });
}
async function handleTelegramWebhook(env, update, deps) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: 500, body: { ok: false, error: "bot token missing" } };
  const cq = update.callback_query;
  if (cq) {
    const adminOk = await isAdminTelegram(env, cq.from?.id);
    if (!adminOk) {
      await answerCallback(token, cq.id, "\u65E0\u6743\u64CD\u4F5C");
      return { status: 200, body: { ok: true, ignored: "not_admin" } };
    }
    const data = cq.data ?? "";
    const [action, arg, taskId] = data.split(":");
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    const originalText = cq.message?.text ?? "";
    if (action === "c" && arg && taskId) {
      const confirmKind = arg;
      const result = await deps.decide({
        taskId,
        decision: "reject",
        operator: `telegram:${cq.from.id}`,
        source: "telegram",
        reason: confirmKind === "x" ? "\u786E\u8BA4\u5220\u9664" : "Telegram \u5185\u62D2\u7EDD",
        note: confirmKind === "x" ? "delete" : ""
      });
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, "\u8BE5\u4EFB\u52A1\u5DF2\u5904\u7406");
      } else {
        await answerCallback(token, cq.id, "");
        if (chatId && messageId) {
          await tgCall(token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }
    if (action === "a") {
      const result = await deps.decide({
        taskId: taskId ?? arg,
        decision: "approve",
        operator: `telegram:${cq.from.id}`,
        source: "telegram"
      });
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, "\u8BE5\u4EFB\u52A1\u5DF2\u5904\u7406");
      } else {
        await answerCallback(token, cq.id, "");
        if (chatId && messageId) {
          await tgCall(token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }
    if (action === "r") {
      await tgCall(token, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "\u786E\u8BA4\u62D2\u7EDD", callback_data: `c:r:${taskId ?? arg}` },
              { text: "\u53D6\u6D88", callback_data: `n:${taskId ?? arg}` }
            ]
          ]
        }
      });
      await answerCallback(token, cq.id, "\u8BF7\u518D\u6B21\u786E\u8BA4\u62D2\u7EDD");
      return { status: 200, body: { ok: true, awaitingConfirm: true } };
    }
    if (action === "n") {
      const task = await loadTaskContext(env, taskId ?? arg);
      if (task) {
        const built = buildTaskMessage(task);
        await tgCall(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: built.keyboard
        });
      }
      await answerCallback(token, cq.id, "\u5DF2\u53D6\u6D88");
      return { status: 200, body: { ok: true, cancelled: true } };
    }
    if (action === "d") {
      const choice = arg;
      const id = taskId;
      if (!id) {
        await answerCallback(token, cq.id, "\u4EFB\u52A1\u6807\u8BC6\u7F3A\u5931");
        return { status: 200, body: { ok: false } };
      }
      if (choice === "x") {
        await tgCall(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "\u786E\u8BA4\u5220\u9664\u6A21\u5757", callback_data: `c:x:${id}` },
                { text: "\u53D6\u6D88", callback_data: `n:${id}` }
              ]
            ]
          }
        });
        await answerCallback(token, cq.id, "\u5220\u9664\u4E0D\u53EF\u64A4\u9500\uFF0C\u8BF7\u786E\u8BA4");
        return { status: 200, body: { ok: true, awaitingConfirm: true } };
      }
      const noteMap = {
        k: "keep",
        h: "hide",
        u: "unpublish"
      };
      const result = await deps.decide({
        taskId: id,
        decision: "approve",
        operator: `telegram:${cq.from.id}`,
        source: "telegram",
        note: noteMap[choice] ?? "hide"
      });
      if (!result.ok && result.message) {
        await answerCallback(token, cq.id, result.message, true);
      } else if (!result.ok) {
        await answerCallback(token, cq.id, "\u8BE5\u4EFB\u52A1\u5DF2\u5904\u7406");
      } else {
        await answerCallback(token, cq.id, "");
        if (chatId && messageId) {
          await tgCall(token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
          });
        }
      }
      return { status: 200, body: { ok: true, decided: result.ok } };
    }
    await answerCallback(token, cq.id, "\u672A\u77E5\u64CD\u4F5C");
    return { status: 200, body: { ok: true, ignored: "unknown_action" } };
  }
  const msg = update.message;
  if (msg) {
    const adminOk = await isAdminTelegram(env, msg.from?.id);
    if (!adminOk) return { status: 200, body: { ok: true, ignored: "not_admin" } };
    const text = (msg.text ?? "").trim();
    if (text === "/start" || text === "/help") {
      await tgCall(token, "sendMessage", {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text: "<b>Surge Modules \u5BA1\u6838\u673A\u5668\u4EBA</b>\n\n\u53D1\u73B0\u7B2C\u4E09\u65B9\u65B0\u6A21\u5757\u6216\u66F4\u65B0\u65F6\uFF0C\u4F1A\u81EA\u52A8\u63A8\u9001\u5F85\u5BA1\u6838\u6D88\u606F\u5230\u8FD9\u91CC\u3002\n\u6D88\u606F\u91CC\u7684\u6309\u94AE\u53EF\u4EE5\u76F4\u63A5\u901A\u8FC7\u6216\u62D2\u7EDD\uFF0C\u65E0\u9700\u6253\u5F00\u7F51\u7AD9\u3002\n\n<b>\u53EF\u7528\u547D\u4EE4</b>\n/pending \u2014 \u67E5\u770B\u5F85\u5BA1\u6838\u6570\u91CF\n/status \u2014 \u67E5\u770B\u68C0\u6D4B\u4E0E\u901A\u77E5\u72B6\u6001",
        parse_mode: "HTML"
      });
      return { status: 200, body: { ok: true, replied: "help" } };
    }
    if (text === "/pending") {
      const row = await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN task_type='new' THEN 1 ELSE 0 END) AS n,
           SUM(CASE WHEN task_type='update' THEN 1 ELSE 0 END) AS u,
           SUM(CASE WHEN task_type='delete' THEN 1 ELSE 0 END) AS d
         FROM module_review_tasks WHERE review_status='pending'`
      ).first();
      await tgCall(token, "sendMessage", {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text: `\u5F85\u5BA1\u6838\uFF1A\u65B0\u6A21\u5757 <b>${row?.n ?? 0}</b> \xB7 \u66F4\u65B0 <b>${row?.u ?? 0}</b> \xB7 \u5220\u9664 <b>${row?.d ?? 0}</b>`,
        parse_mode: "HTML"
      });
      return { status: 200, body: { ok: true, replied: "pending" } };
    }
    if (text === "/status") {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS on_,
                SUM(CASE WHEN last_check_status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM third_party_repositories WHERE deleted_at IS NULL`
      ).first();
      await tgCall(token, "sendMessage", {
        chat_id: msg.chat?.id ?? msg.from?.id,
        text: `<b>\u7B2C\u4E09\u65B9\u4ED3\u5E93</b>
\u603B\u6570 ${row?.total ?? 0} \xB7 \u542F\u7528 ${row?.on_ ?? 0}
\u6700\u8FD1\u5931\u8D25 ${row?.failed ?? 0}
Bot \u5DF2\u8FDE\u63A5\u3002`,
        parse_mode: "HTML"
      });
      return { status: 200, body: { ok: true, replied: "status" } };
    }
  }
  return { status: 200, body: { ok: true, ignored: true } };
}
var TG_API, MAX_TEXT, iso, escapeHtml, METHOD_LABEL, TYPE_LABEL;
var init_telegram = __esm({
  "workers/site/telegram.ts"() {
    "use strict";
    TG_API = "https://api.telegram.org";
    MAX_TEXT = 3800;
    iso = (d = /* @__PURE__ */ new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");
    escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    METHOD_LABEL = {
      webhook: "Webhook \u5B9E\u65F6\u63A8\u9001",
      manual: "\u540E\u53F0\u624B\u52A8\u68C0\u67E5",
      cron: "Cron \u5B9A\u65F6\u6293\u53D6"
    };
    TYPE_LABEL = {
      new: "\u65B0\u6A21\u5757",
      update: "\u6A21\u5757\u66F4\u65B0",
      delete: "\u6587\u4EF6\u5220\u9664"
    };
  }
});

// workers/site/third-party.ts
var third_party_exports = {};
__export(third_party_exports, {
  changesFromPush: () => changesFromPush,
  createReviewTask: () => createReviewTask,
  decryptSecret: () => decryptSecret,
  encryptSecret: () => encryptSecret,
  fetchFileContent: () => fetchFileContent,
  fetchRepoInfo: () => fetchRepoInfo,
  getRepository: () => getRepository,
  getThirdPartyModule: () => getThirdPartyModule,
  ghRequest: () => ghRequest,
  inspectRepository: () => inspectRepository,
  isSgmodule: () => isSgmodule,
  listRepositories: () => listRepositories,
  listSgmoduleFiles: () => listSgmoduleFiles,
  parseRepoUrl: () => parseRepoUrl,
  readJsonCapped: () => readJsonCapped,
  recordCheck: () => recordCheck,
  safePath: () => safePath2,
  safeSegment: () => safeSegment2,
  verifyGithubSignature: () => verifyGithubSignature,
  versionOf: () => versionOf
});
function safeSegment2(value) {
  return SEGMENT_RE2.test(value) && value !== ".." && value !== ".";
}
function safePath2(path) {
  if (path.length === 0 || path.length > 400) return false;
  if (path.startsWith("/")) return false;
  if (/[\u0000-\u001f\\]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
function isSgmodule(path) {
  return path.toLowerCase().endsWith(".sgmodule");
}
function parseRepoUrl(input) {
  const raw = input.trim();
  if (!raw) return null;
  const bare = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (bare) {
    const [, owner, repo] = bare;
    if (safeSegment2(owner) && safeSegment2(repo)) {
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }
  const ssh = raw.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (ssh) {
    const [, owner, repo] = ssh;
    if (safeSegment2(owner) && safeSegment2(repo)) {
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }
  try {
    const u = new URL(raw);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    const owner = parts[0] ?? "";
    const repo = (parts[1] ?? "").replace(/\.git$/, "");
    if (!safeSegment2(owner) || !safeSegment2(repo)) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}
async function readJsonCapped(request, maxBytes) {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > maxBytes) return { error: "\u8BF7\u6C42\u4F53\u8FC7\u5927" };
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "\u8BF7\u6C42\u4F53\u8BFB\u53D6\u5931\u8D25" };
  }
  if (text.length > maxBytes) return { error: "\u8BF7\u6C42\u4F53\u8FC7\u5927" };
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("json") && !type.includes("form-urlencoded")) {
    return { error: "\u4E0D\u652F\u6301\u7684 Content-Type" };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    const form = new URLSearchParams(text).get("payload");
    if (form) {
      try {
        return { data: JSON.parse(form) };
      } catch {
      }
    }
    return { error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" };
  }
}
async function importAesKey(secretKey) {
  let bytes;
  try {
    const bin = atob(secretKey);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    bytes = new TextEncoder().encode(secretKey);
  }
  const key = new Uint8Array(32);
  key.set(bytes.slice(0, 32));
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}
async function encryptSecret(plain, secretKey) {
  const key = await importAesKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(cipher).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return b64(combined);
}
async function decryptSecret(payload, secretKey) {
  try {
    const combined = unb64(payload);
    if (combined.length <= 12) return null;
    const key = await importAesKey(secretKey);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      key,
      combined.slice(12)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyGithubSignature(rawBody, headerSignature, secret) {
  if (!headerSignature) return false;
  const expectedPrefix = "sha256=";
  if (!headerSignature.startsWith(expectedPrefix)) return false;
  const provided = headerSignature.slice(expectedPrefix.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(hex, provided);
}
async function ghRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? FETCH_TIMEOUT_MS2
  );
  try {
    const headers = {
      accept: options.raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "surge-modules-third-party"
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetch(`${GITHUB_API3}${path}`, { headers, signal: controller.signal });
    if (res.status === 401) return { ok: false, status: 401, error: "GitHub \u51ED\u636E\u65E0\u6548" };
    if (res.status === 404) {
      return { ok: false, status: 404, error: "\u4ED3\u5E93\u3001\u5206\u652F\u6216\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u6216\u5F53\u524D\u51ED\u636E\u65E0\u6743\u8BBF\u95EE" };
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "60", 10) || 60;
      return {
        ok: false,
        status: res.status,
        error: remaining === "0" ? `GitHub API \u9650\u6D41\uFF0C\u5EFA\u8BAE ${retryAfter}s \u540E\u91CD\u8BD5` : "\u65E0\u6743\u8BBF\u95EE\u8BE5\u4ED3\u5E93\uFF08\u53EF\u80FD\u662F\u79C1\u6709\u4ED3\u5E93\u6216 Token \u6743\u9650\u4E0D\u8DB3\uFF09",
        retryAfter
      };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: `GitHub \u670D\u52A1\u5F02\u5E38 ${res.status}` };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `GitHub \u8FD4\u56DE ${res.status}` };
    if (options.raw) {
      const declared = Number.parseInt(res.headers.get("content-length") ?? "0", 10);
      if (declared > MAX_FILE_BYTES2) return { ok: false, status: 200, error: "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650" };
      const text = await res.text();
      if (text.length > MAX_FILE_BYTES2) {
        return { ok: false, status: 200, error: "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650" };
      }
      return { ok: true, status: res.status, text };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: aborted ? "GitHub \u8BF7\u6C42\u8D85\u65F6" : "GitHub \u8BF7\u6C42\u5931\u8D25"
    };
  } finally {
    clearTimeout(timer);
  }
}
async function fetchRepoInfo(owner, repo, token) {
  if (!safeSegment2(owner) || !safeSegment2(repo)) return { error: "\u4ED3\u5E93\u6807\u8BC6\u4E0D\u5408\u6CD5" };
  const res = await ghRequest(`/repos/${owner}/${repo}`, { token });
  if (!res.ok) return { error: res.error ?? "\u65E0\u6CD5\u8BFB\u53D6\u4ED3\u5E93" };
  const body = res.json;
  return {
    info: {
      defaultBranch: body.default_branch || DEFAULT_BRANCH,
      description: (body.description ?? "").slice(0, 500),
      fullName: body.full_name ?? `${owner}/${repo}`,
      private: Boolean(body.private)
    }
  };
}
async function listSgmoduleFiles(owner, repo, branch, token, pathPrefix = "") {
  if (!safeSegment2(owner) || !safeSegment2(repo) || !safeSegment2(branch)) {
    return { error: "\u4ED3\u5E93\u6807\u8BC6\u4E0D\u5408\u6CD5" };
  }
  const res = await ghRequest(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { token }
  );
  if (!res.ok) return { error: res.error ?? "\u65E0\u6CD5\u8BFB\u53D6\u6587\u4EF6\u5217\u8868" };
  const body = res.json;
  const prefix = pathPrefix.trim().replace(/^\/+|\/+$/g, "");
  const files = (body.tree ?? []).filter((n) => n.type === "blob").filter((n) => isSgmodule(n.path)).filter((n) => safePath2(n.path)).filter((n) => !prefix || n.path === prefix || n.path.startsWith(`${prefix}/`)).map((n) => ({ path: n.path, sha: n.sha, size: n.size ?? 0 })).slice(0, MAX_FILES_PER_REPO);
  return { files, truncated: Boolean(body.truncated) };
}
async function fetchFileContent(owner, repo, path, ref, token) {
  if (!safePath2(path)) return { error: "\u8DEF\u5F84\u4E0D\u5408\u6CD5" };
  if (!safeSegment2(ref)) return { error: "\u5F15\u7528\u4E0D\u5408\u6CD5" };
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await ghRequest(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    { token, raw: true }
  );
  if (!res.ok) return { error: res.error ?? "\u8BFB\u53D6\u6587\u4EF6\u5931\u8D25" };
  return { text: res.text ?? "" };
}
function versionOf(meta, fallbackSha) {
  const v = meta.version?.trim();
  if (v && /^[\w.\-+]{1,32}$/.test(v)) return v;
  return `0.0.0+${fallbackSha.slice(0, 7)}`;
}
function changesFromPush(payload) {
  const byPath = /* @__PURE__ */ new Map();
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const headSha = payload.head_commit?.id ?? payload.after ?? "";
  for (const commit of commits) {
    const sha = commit.id ?? headSha;
    for (const p of commit.added ?? []) {
      if (!isSgmodule(p) || !safePath2(p)) continue;
      const prior = byPath.get(p);
      byPath.set(p, {
        path: p,
        status: prior ? "modified" : "added",
        sha: "",
        commitSha: sha
      });
    }
    for (const p of commit.modified ?? []) {
      if (!isSgmodule(p) || !safePath2(p)) continue;
      byPath.set(p, { path: p, status: "modified", sha: "", commitSha: sha });
    }
    for (const p of commit.removed ?? []) {
      if (!isSgmodule(p) || !safePath2(p)) continue;
      byPath.set(p, { path: p, status: "removed", sha: "", commitSha: sha });
    }
  }
  return [...byPath.values()];
}
async function getRepository(db, id) {
  return db.prepare("SELECT * FROM third_party_repositories WHERE id = ? AND deleted_at IS NULL").bind(id).first();
}
async function listRepositories(db, filter = {}) {
  const sql = filter.enabledOnly ? `SELECT * FROM third_party_repositories
        WHERE deleted_at IS NULL AND enabled = 1
        ORDER BY created_at DESC` : `SELECT * FROM third_party_repositories
        WHERE deleted_at IS NULL ORDER BY created_at DESC`;
  const rows = await db.prepare(sql).all();
  return rows.results ?? [];
}
async function getThirdPartyModule(db, repositoryId, branch, filePath) {
  return db.prepare(
    `SELECT * FROM third_party_modules
        WHERE repository_id = ? AND branch = ? AND file_path = ?`
  ).bind(repositoryId, branch, filePath).first();
}
async function createReviewTask(db, input) {
  const id = crypto.randomUUID();
  const res = await db.prepare(
    `INSERT OR IGNORE INTO module_review_tasks
        (id, module_id, third_party_module_id, repository_id, task_type,
         detection_method, file_path, branch, old_version, new_version,
         old_content, new_content, content_sha, commit_sha, review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
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
    input.oldContent.slice(0, 12e4),
    input.newContent.slice(0, 12e4),
    input.contentSha,
    input.commitSha
  ).run();
  const changes = res.meta?.changes ?? 0;
  if (changes === 0) return null;
  return id;
}
async function supersedeOlderTasks(db, repositoryId, filePath, keepTaskId) {
  const res = await db.prepare(
    `UPDATE module_review_tasks
          SET review_status = 'superseded',
              superseded_by = ?,
              updated_at = ?
        WHERE repository_id = ? AND file_path = ?
          AND review_status IN ('pending', 'on_hold')
          AND id <> ?`
  ).bind(keepTaskId, iso2(), repositoryId, filePath, keepTaskId).run();
  return res.meta?.changes ?? 0;
}
async function inspectRepository(env, repository, options) {
  const db = env.DB;
  const startedAt = iso2();
  const startedMs = Date.parse(startedAt);
  const branch = options.branch || repository.default_branch;
  const token = env.GITHUB_READ_TOKEN;
  const outcomes = [];
  const limit = Math.min(options.maxFiles ?? 200, MAX_FILES_PER_REPO);
  const deadline = options.deadline ?? startedMs + 5e4;
  const timeLeft = () => Date.parse(iso2()) < deadline;
  let filesScanned = 0;
  let error = "";
  if (!safeSegment2(repository.owner) || !safeSegment2(repository.repository)) {
    error = "\u4ED3\u5E93\u6807\u8BC6\u4E0D\u5408\u6CD5";
    return failEarly("\u4ED3\u5E93\u6807\u8BC6\u4E0D\u5408\u6CD5");
  }
  let candidates = options.changes ?? null;
  if (!candidates) {
    const listing = await listSgmoduleFiles(
      repository.owner,
      repository.repository,
      branch,
      token,
      options.pathPrefix ?? ""
    );
    if ("error" in listing) {
      error = listing.error;
      return failEarly(listing.error);
    }
    filesScanned = listing.files.length;
    const existingRows = await db.prepare(
      `SELECT file_path, module_id, current_content_sha, current_blob_sha,
                current_version, published, is_deleted_upstream
           FROM third_party_modules
          WHERE repository_id = ? AND branch = ?`
    ).bind(repository.id, branch).all();
    const known = new Map((existingRows.results ?? []).map((r) => [r.file_path, r]));
    for (const file of listing.files) {
      const row = known.get(file.path);
      if (!row || row.module_id !== null) continue;
      const linked = await findExistingModule(
        db,
        repository.owner,
        repository.repository,
        file.path
      );
      if (!linked) continue;
      await db.prepare(
        `UPDATE third_party_modules SET module_id = ?, updated_at = ?
          WHERE repository_id = ? AND branch = ? AND file_path = ?`
      ).bind(linked, iso2(), repository.id, branch, file.path).run();
      row.module_id = linked;
    }
    const present = new Set(listing.files.map((f) => f.path));
    candidates = [];
    for (const file of listing.files) {
      if (options.filePath && file.path !== options.filePath) continue;
      const record = known.get(file.path);
      if (!record) {
        candidates.push({ path: file.path, status: "added", sha: file.sha, commitSha: "" });
      } else if (record.current_blob_sha !== file.sha || record.is_deleted_upstream === 1) {
        candidates.push({
          path: file.path,
          status: record.is_deleted_upstream === 1 ? "added" : "modified",
          sha: file.sha,
          commitSha: ""
        });
      } else {
        outcomes.push({ path: file.path, status: "unchanged" });
      }
    }
    for (const [path, record] of known) {
      if (present.has(path) || record.is_deleted_upstream === 1) continue;
      if (options.filePath && path !== options.filePath) continue;
      candidates.push({ path, status: "removed", sha: "", commitSha: "" });
    }
  }
  if (options.filePath) {
    candidates = candidates.filter((c) => c.path === options.filePath);
  }
  const queue = candidates.filter((c) => c.status !== "unchanged").slice(0, limit);
  for (const change of queue) {
    if (!timeLeft()) {
      outcomes.push({ path: change.path, status: "skipped", reason: "\u672C\u6B21\u8FD0\u884C\u65F6\u95F4\u5DF2\u8FBE\u4E0A\u9650" });
      continue;
    }
    try {
      const outcome = await inspectFile(env, repository, {
        branch,
        change,
        method: options.method,
        commitSha: options.commitSha || change.commitSha,
        silent: options.silent
      });
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        path: change.path,
        status: "failed",
        reason: err instanceof Error ? err.message : "\u5904\u7406\u5931\u8D25"
      });
    }
  }
  const newModules = outcomes.filter((o) => o.status === "new").length;
  const updatedModules = outcomes.filter((o) => o.status === "updated").length;
  const deletedModules = outcomes.filter((o) => o.status === "deleted").length;
  const unchanged = outcomes.filter((o) => o.status === "unchanged").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const status = failed > 0 && newModules + updatedModules + deletedModules === 0 ? "failed" : failed > 0 ? "partial" : "ok";
  function failEarly(message) {
    return {
      logId: "",
      repositoryId: repository.id,
      branch,
      status: "failed",
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      unchanged: 0,
      failed: 0,
      filesScanned: 0,
      error: message,
      outcomes,
      startedAt,
      finishedAt: iso2()
    };
  }
  return finish(status);
  function finish(finalStatus) {
    return {
      logId: "",
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
      finishedAt: iso2()
    };
  }
}
async function findExistingModule(db, owner, repo, filePath) {
  const byPath = await db.prepare(
    `SELECT id FROM modules
        WHERE deleted_at IS NULL AND source_path = ?
        LIMIT 1`
  ).bind(filePath).first();
  if (byPath) return byPath.id;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const byUrl = await db.prepare(
    `SELECT id FROM modules
        WHERE deleted_at IS NULL
          AND (repository_url = ? OR upstream_url LIKE ?)
        LIMIT 1`
  ).bind(repoUrl, `%/${repo}/%${filePath.split("/").pop() ?? ""}`).first();
  return byUrl?.id ?? null;
}
async function inspectFile(env, repository, args) {
  const { DB } = env;
  const { change, branch, method } = args;
  const token = env.GITHUB_READ_TOKEN;
  const existing = await getThirdPartyModule(DB, repository.id, branch, change.path);
  if (change.status === "removed") {
    if (!existing) {
      return { path: change.path, status: "unchanged" };
    }
    if (existing.is_deleted_upstream === 1) {
      return { path: change.path, status: "unchanged" };
    }
    await DB.prepare(
      `UPDATE third_party_modules
          SET is_deleted_upstream = 1, updated_at = ?
        WHERE id = ?`
    ).bind(iso2(), existing.id).run();
    const contentSha2 = `del:${existing.current_content_sha}`;
    const taskId2 = await createReviewTask(DB, {
      repositoryId: repository.id,
      moduleId: existing.module_id,
      thirdPartyModuleId: existing.id,
      taskType: "delete",
      detectionMethod: method,
      filePath: change.path,
      branch,
      oldVersion: existing.current_version,
      newVersion: "",
      oldContent: existing.current_content,
      newContent: "",
      contentSha: contentSha2,
      commitSha: args.commitSha
    });
    if (taskId2) {
      await supersedeOlderTasks(DB, repository.id, change.path, taskId2);
      if (!args.silent) {
        await notifyReviewTask(env, taskId2, "delete");
      }
    }
    return { path: change.path, status: "deleted", taskId: taskId2 ?? void 0 };
  }
  let blobSha = change.sha;
  if (!blobSha) {
    const tree = await listSgmoduleFiles(
      repository.owner,
      repository.repository,
      args.commitSha && safeSegment2(args.commitSha) ? args.commitSha : branch,
      token
    );
    if (!("error" in tree)) {
      blobSha = tree.files.find((f) => f.path === change.path)?.sha ?? "";
    }
  }
  const ref = args.commitSha && safeSegment2(args.commitSha) ? args.commitSha : branch;
  const fetched = await fetchFileContent(
    repository.owner,
    repository.repository,
    change.path,
    ref,
    token
  );
  if ("error" in fetched) {
    return { path: change.path, status: "failed", reason: fetched.error };
  }
  const text = fetched.text;
  if (!text.trim()) {
    return { path: change.path, status: "failed", reason: "\u6587\u4EF6\u5185\u5BB9\u4E3A\u7A7A" };
  }
  const contentSha = await sha256(text);
  if (existing && existing.current_content_sha === contentSha) {
    if (existing.is_deleted_upstream === 1) {
      await DB.prepare("UPDATE third_party_modules SET is_deleted_upstream = 0 WHERE id = ?").bind(existing.id).run();
    }
    return { path: change.path, status: "unchanged" };
  }
  const fallbackName = change.path.split("/").pop()?.replace(/\.sgmodule$/i, "") ?? change.path;
  let meta;
  try {
    meta = parseModuleMeta(text, fallbackName);
  } catch {
    return { path: change.path, status: "failed", reason: "\u6A21\u5757\u5185\u5BB9\u65E0\u6CD5\u89E3\u6790" };
  }
  const newVersion = versionOf(meta, contentSha);
  if (!existing) {
    if (repository.auto_review_new !== 1) {
      return { path: change.path, status: "skipped", reason: "\u8BE5\u4ED3\u5E93\u5DF2\u5173\u95ED\u65B0\u6A21\u5757\u81EA\u52A8\u9001\u5BA1" };
    }
    const linkedId = await findExistingModule(
      DB,
      repository.owner,
      repository.repository,
      change.path
    );
    if (linkedId) {
      const liveRow = await DB.prepare(
        "SELECT version, content_hash FROM modules WHERE id = ?"
      ).bind(linkedId).first();
      if (liveRow?.content_hash === contentSha) {
        await DB.prepare(
          `INSERT OR IGNORE INTO third_party_modules
            (id, repository_id, module_id, module_name, file_path, branch,
             module_description, author, current_version, current_content,
             current_content_sha, current_blob_sha, source_commit_sha, published, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).bind(
          crypto.randomUUID(),
          repository.id,
          linkedId,
          (meta.name || fallbackName).slice(0, 120),
          change.path,
          branch,
          (meta.description ?? "").slice(0, 500),
          (meta.author ?? "").slice(0, 80),
          liveRow.version,
          text.slice(0, 12e4),
          contentSha,
          blobSha,
          args.commitSha,
          iso2()
        ).run();
        return { path: change.path, status: "unchanged" };
      }
    }
    const tpmId = crypto.randomUUID();
    await DB.prepare(
      `INSERT OR IGNORE INTO third_party_modules
        (id, repository_id, module_id, module_name, file_path, branch,
         module_description, author, current_version, current_content,
         current_content_sha, current_blob_sha, source_commit_sha, published, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(
      tpmId,
      repository.id,
      linkedId,
      (meta.name || fallbackName).slice(0, 120),
      change.path,
      branch,
      (meta.description ?? "").slice(0, 500),
      (meta.author ?? "").slice(0, 80),
      newVersion,
      text.slice(0, 12e4),
      contentSha,
      blobSha,
      args.commitSha,
      iso2()
    ).run();
    const row = await getThirdPartyModule(DB, repository.id, branch, change.path);
    const taskId2 = await createReviewTask(DB, {
      repositoryId: repository.id,
      moduleId: linkedId,
      thirdPartyModuleId: row?.id ?? tpmId,
      taskType: linkedId ? "update" : "new",
      detectionMethod: method,
      filePath: change.path,
      branch,
      oldVersion: "",
      newVersion,
      oldContent: "",
      newContent: text,
      contentSha,
      commitSha: args.commitSha
    });
    if (taskId2) {
      await supersedeOlderTasks(DB, repository.id, change.path, taskId2);
      if (!args.silent) await notifyReviewTask(env, taskId2, "new");
    }
    return {
      path: change.path,
      status: taskId2 ? "new" : "unchanged",
      taskId: taskId2 ?? void 0,
      version: newVersion,
      commitSha: args.commitSha
    };
  }
  if (existing.current_content_sha === contentSha) {
    return { path: change.path, status: "unchanged" };
  }
  if (repository.auto_review_update !== 1) {
    return { path: change.path, status: "skipped", reason: "\u8BE5\u4ED3\u5E93\u5DF2\u5173\u95ED\u66F4\u65B0\u81EA\u52A8\u9001\u5BA1" };
  }
  await DB.prepare(
    `UPDATE third_party_modules
        SET module_name = ?, module_description = ?, author = ?,
            current_blob_sha = ?, source_commit_sha = ?, is_deleted_upstream = 0,
            last_seen_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    (meta.name || existing.module_name).slice(0, 120),
    (meta.description ?? existing.module_description).slice(0, 500),
    (meta.author ?? existing.author).slice(0, 80),
    blobSha,
    args.commitSha,
    iso2(),
    iso2(),
    existing.id
  ).run();
  const updateModuleId = existing.module_id ?? await findExistingModule(DB, repository.owner, repository.repository, change.path);
  if (updateModuleId && updateModuleId !== existing.module_id) {
    await DB.prepare(
      "UPDATE third_party_modules SET module_id = ?, updated_at = ? WHERE id = ?"
    ).bind(updateModuleId, iso2(), existing.id).run();
  }
  const taskId = await createReviewTask(DB, {
    repositoryId: repository.id,
    moduleId: updateModuleId,
    thirdPartyModuleId: existing.id,
    taskType: "update",
    detectionMethod: method,
    filePath: change.path,
    branch,
    oldVersion: existing.current_version,
    newVersion,
    oldContent: existing.current_content,
    newContent: text,
    contentSha,
    commitSha: args.commitSha
  });
  if (taskId) {
    await supersedeOlderTasks(DB, repository.id, change.path, taskId);
    if (!args.silent) await notifyReviewTask(env, taskId, "update");
    return {
      path: change.path,
      status: "updated",
      taskId,
      version: newVersion,
      commitSha: args.commitSha
    };
  }
  return { path: change.path, status: "unchanged" };
}
async function recordCheck(db, repository, result, method) {
  const logId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO repository_check_logs
        (id, repository_id, detection_method, check_status, new_modules_count,
         updated_modules_count, deleted_modules_count, unchanged_modules_count,
         failed_count, files_scanned, branch, error_message, detail,
         started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
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
    result.error.slice(0, 1e3),
    JSON.stringify(result.outcomes.slice(0, 300)).slice(0, 6e4),
    result.startedAt,
    result.finishedAt
  ).run();
  const failures = result.status === "failed" ? repository.consecutive_failures + 1 : 0;
  const nextAt = new Date(
    Date.now() + Math.max(1, repository.check_interval_hours) * 36e5
  );
  await db.prepare(
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
        WHERE id = ?`
  ).bind(
    result.finishedAt,
    iso2(nextAt),
    result.status,
    (result.error || "").slice(0, 500),
    failures,
    repository.id,
    repository.id,
    repository.id,
    iso2(),
    repository.id
  ).run();
  return logId;
}
var GITHUB_API3, MAX_FILE_BYTES2, MAX_FILES_PER_REPO, FETCH_TIMEOUT_MS2, DEFAULT_BRANCH, iso2, SEGMENT_RE2, b64, unb64;
var init_third_party = __esm({
  "workers/site/third-party.ts"() {
    "use strict";
    init_sync();
    init_telegram();
    GITHUB_API3 = "https://api.github.com";
    MAX_FILE_BYTES2 = 256 * 1024;
    MAX_FILES_PER_REPO = 2e3;
    FETCH_TIMEOUT_MS2 = 15e3;
    DEFAULT_BRANCH = "main";
    iso2 = (d = /* @__PURE__ */ new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");
    SEGMENT_RE2 = /^[\w.-]{1,100}$/;
    b64 = (buf) => {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let out = "";
      for (const b of bytes) out += String.fromCharCode(b);
      return btoa(out);
    };
    unb64 = (value) => {
      const bin = atob(value);
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };
  }
});

// packages/shared/src/contract.ts
var ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_requests: 429,
  internal_error: 500,
  upstream_error: 502,
  upstream_timeout: 504
};
var ANALYTICS_EVENTS = [
  "page_view",
  "module_view",
  "install_click",
  "copy_click",
  "search"
];
var ANALYTICS_LIMITS = {
  maxBodyBytes: 1024,
  maxSubjectLength: 120,
  maxEventsPerWindow: 60,
  windowSeconds: 60
};

// packages/shared/src/http.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // API responses are per-request; never let a shared cache hold them
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
function jsonOk(data, init) {
  const body = { ok: true, data };
  if (init?.meta) body.meta = init.meta;
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { ...JSON_HEADERS, ...init?.headers }
  });
}
function jsonError(code, message, extra) {
  const body = {
    ok: false,
    error: { code, message, ...extra?.fields ? { fields: extra.fields } : {} }
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...extra?.headers }
  });
}
function methodNotAllowed(allowed) {
  return jsonError("method_not_allowed", `\u53EA\u652F\u6301 ${allowed.join(" / ")}`, {
    headers: { allow: allowed.join(", ") }
  });
}
async function guard(requestId2, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId2}] unhandled:`, message);
    return jsonError("internal_error", "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF");
  }
}
function requestId() {
  return crypto.randomUUID().slice(0, 8);
}

// packages/shared/src/query.ts
var LIMITS = {
  perPageMax: 60,
  perPageDefault: 20,
  searchMaxLength: 80,
  tagMaxLength: 40,
  slugMaxLength: 80
};
var SORTS = ["updated", "name", "created", "featured"];
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function parseModuleListQuery(params) {
  const pageRaw = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 1e4) : 1;
  const perPageRaw = Number.parseInt(params.get("perPage") ?? "", 10);
  const perPage = clamp(
    Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : LIMITS.perPageDefault,
    1,
    LIMITS.perPageMax
  );
  const search = (params.get("q") ?? "").trim().slice(0, LIMITS.searchMaxLength);
  const category = validSlug(params.get("category")) ? params.get("category").trim() : "";
  const tag = (params.get("tag") ?? "").trim().slice(0, LIMITS.tagMaxLength);
  const featuredRaw = params.get("featured");
  const featured = featuredRaw === "1" || featuredRaw === "true" ? true : null;
  const sortRaw = params.get("sort");
  const sort = sortRaw && SORTS.includes(sortRaw) ? sortRaw : "updated";
  return { page, perPage, search, category, tag, featured, sort };
}
function validSlug(value) {
  if (!value) return null;
  const v = value.trim();
  if (v.length === 0 || v.length > LIMITS.slugMaxLength) return null;
  if (!SLUG_RE.test(v)) return null;
  return v;
}
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function likeEscape(value) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
function tokenize(value) {
  return value.toLowerCase().split(/[\s,，、]+/).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 6);
}

// workers/site/db.ts
var SETTING_KEYS = {
  siteName: "site.name",
  tagline: "site.tagline",
  description: "site.description",
  locale: "site.locale",
  version: "site.version",
  perPageDefault: "modules.per_page_default",
  perPageMax: "modules.per_page_max",
  proxyBase: "proxy.public_base"
};
var DEFAULTS = {
  siteName: "Surge Modules",
  tagline: "",
  description: "",
  locale: "zh-CN",
  version: "0.0.0",
  perPageDefault: 20,
  perPageMax: 60,
  proxyBase: ""
};
async function loadSettings(db) {
  const { results } = await db.prepare("SELECT key, value, value_type FROM site_settings WHERE scope = 'public'").all();
  const byKey = /* @__PURE__ */ new Map();
  for (const row of results ?? []) byKey.set(row.key, { value: row.value, type: row.value_type });
  const out = { ...DEFAULTS };
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    const hit = byKey.get(key);
    if (!hit) continue;
    if (field === "perPageDefault" || field === "perPageMax") {
      const n = Number.parseInt(hit.value, 10);
      if (Number.isFinite(n) && n > 0) out[field] = n;
    } else {
      out[field] = hit.value;
    }
  }
  return out;
}
function toPublicSettings(s) {
  return {
    siteName: s.siteName,
    tagline: s.tagline,
    description: s.description,
    locale: s.locale,
    version: s.version,
    perPageDefault: s.perPageDefault,
    perPageMax: s.perPageMax,
    proxyBase: s.proxyBase
  };
}
function proxyUrlFor(settings, slug) {
  const base = settings.proxyBase.trim();
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/${slug}`;
}
function rowToModule(row, settings, tags) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    author: row.author,
    category: row.category_id && row.category_name && row.category_slug ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
    tags,
    version: row.version,
    updatedAt: row.updated_at,
    rawUrl: proxyUrlFor(settings, row.slug),
    repositoryUrl: row.repository_url,
    isFeatured: row.is_featured === 1
  };
}
var MODULE_SELECT = `
  SELECT m.id, m.slug, m.name, m.description, m.author, m.version,
         m.updated_at, m.created_at, m.repository_url, m.is_featured,
         m.category_id, c.name AS category_name, c.slug AS category_slug
    FROM modules m
    LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
   WHERE m.deleted_at IS NULL AND m.is_published = 1
`;
async function tagsFor(db, ids) {
  const out = /* @__PURE__ */ new Map();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT module_id, tag FROM module_tags WHERE module_id IN (${placeholders})`).bind(...ids).all();
  for (const row of results ?? []) {
    const list = out.get(row.module_id) ?? [];
    list.push(row.tag);
    out.set(row.module_id, list);
  }
  return out;
}
async function listModules(db, settings, query) {
  const where = [];
  const binds = [];
  if (query.category) {
    where.push("c.slug = ?");
    binds.push(query.category);
  }
  if (query.featured !== null) {
    where.push("m.is_featured = ?");
    binds.push(query.featured ? 1 : 0);
  }
  if (query.tag) {
    where.push(
      "EXISTS (SELECT 1 FROM module_tags t WHERE t.module_id = m.id AND LOWER(t.tag) = LOWER(?))"
    );
    binds.push(query.tag);
  }
  for (const token of tokenize(query.search)) {
    where.push(
      `(m.name LIKE ? ESCAPE '\\' OR m.author LIKE ? ESCAPE '\\'
        OR m.description LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM module_tags t2 WHERE t2.module_id = m.id
                   AND t2.tag LIKE ? ESCAPE '\\'))`
    );
    const pattern = `%${likeEscape(token)}%`;
    binds.push(pattern, pattern, pattern, pattern);
  }
  const whereSql = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
  const countRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM modules m
         LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
        WHERE m.deleted_at IS NULL AND m.is_published = 1${whereSql}`
  ).bind(...binds).first();
  const total = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.perPage));
  const page = Math.min(query.page, totalPages);
  const orderSql = query.sort === "name" ? "m.name COLLATE NOCASE ASC" : query.sort === "created" ? "m.created_at DESC" : query.sort === "featured" ? "m.is_featured DESC, m.updated_at DESC" : "m.updated_at DESC";
  const { results } = await db.prepare(`${MODULE_SELECT}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).bind(...binds, query.perPage, (page - 1) * query.perPage).all();
  const rows = results ?? [];
  const tagMap = await tagsFor(
    db,
    rows.map((r) => r.id)
  );
  return {
    items: rows.map((r) => rowToModule(r, settings, tagMap.get(r.id) ?? [])),
    meta: { page, perPage: query.perPage, total, totalPages }
  };
}
async function getModuleBySlug(db, settings, slug) {
  const row = await db.prepare(`${MODULE_SELECT} AND m.slug = ? LIMIT 1`).bind(slug).first();
  if (!row) return null;
  const tagMap = await tagsFor(db, [row.id]);
  const base = rowToModule(row, settings, tagMap.get(row.id) ?? []);
  const { results: versionRows } = await db.prepare(
    `SELECT version, changelog, released_at, commit_sha, commit_url
         FROM module_versions WHERE module_id = ?
        ORDER BY released_at DESC LIMIT 50`
  ).bind(row.id).all();
  const versions = (versionRows ?? []).map((v) => ({
    version: v.version,
    changelog: v.changelog,
    releasedAt: v.released_at,
    commitSha: v.commit_sha,
    commitUrl: v.commit_url
  }));
  return { ...base, versions, createdAt: row.created_at };
}
async function listVersions(db, slug, limit) {
  const moduleRow = await db.prepare(
    "SELECT id FROM modules WHERE slug = ? AND deleted_at IS NULL AND is_published = 1 LIMIT 1"
  ).bind(slug).first();
  if (!moduleRow) return null;
  const { results } = await db.prepare(
    `SELECT version, changelog, released_at, commit_sha, commit_url
         FROM module_versions WHERE module_id = ?
        ORDER BY released_at DESC LIMIT ?`
  ).bind(moduleRow.id, limit).all();
  return (results ?? []).map((v) => ({
    version: v.version,
    changelog: v.changelog,
    releasedAt: v.released_at,
    commitSha: v.commit_sha,
    commitUrl: v.commit_url
  }));
}
async function listCategories(db) {
  const { results } = await db.prepare(
    `SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order,
              (SELECT COUNT(*) FROM modules m
                WHERE m.category_id = c.id AND m.deleted_at IS NULL AND m.is_published = 1) AS module_count
         FROM categories c
        WHERE c.deleted_at IS NULL AND c.is_visible = 1
        ORDER BY c.sort_order ASC, c.name ASC`
  ).all();
  return (results ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    icon: c.icon,
    sortOrder: c.sort_order,
    moduleCount: c.module_count
  }));
}
async function listAnnouncements(db) {
  const { results } = await db.prepare(
    `SELECT id, title, body, level, is_pinned, published_at
         FROM announcements
        WHERE deleted_at IS NULL AND is_published = 1
        ORDER BY is_pinned DESC, published_at DESC
        LIMIT 20`
  ).all();
  return (results ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    level: a.level === "warning" || a.level === "critical" ? a.level : "info",
    isPinned: a.is_pinned === 1,
    publishedAt: a.published_at
  }));
}

// workers/site/analytics.ts
function parseEvents(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const list = raw.events;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length > 10) return null;
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry;
    const name = e.event;
    if (typeof name !== "string") return null;
    if (!ANALYTICS_EVENTS.includes(name)) return null;
    const subject = typeof e.subject === "string" ? e.subject.slice(0, ANALYTICS_LIMITS.maxSubjectLength) : void 0;
    if (subject && !/^[a-zA-Z0-9/_.-]+$/.test(subject)) return null;
    out.push({ event: name, subject });
  }
  return out;
}
async function checkRateLimit(db, salt, clientKey, limit, windowSeconds) {
  const now = /* @__PURE__ */ new Date();
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  const slot = Math.floor(now.getUTCMinutes() / minutes) * minutes;
  const windowId = `${now.toISOString().slice(0, 13)}:${String(slot).padStart(2, "0")}`;
  const bucket = `analytics:${await hashShort(`${salt}:${clientKey}:${windowId}`)}`;
  await db.prepare(
    `INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1`
  ).bind(bucket, windowId).run();
  const row = await db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window = ?").bind(bucket, windowId).first();
  const used = row?.count ?? 1;
  if (Math.random() < 0.02) {
    const cutoff = new Date(now.getTime() - 6 * 3600 * 1e3).toISOString().slice(0, 16);
    await db.prepare("DELETE FROM rate_limits WHERE window < ?").bind(cutoff).run().catch(() => void 0);
  }
  return used <= limit;
}
async function insertEvents(db, events) {
  if (events.length === 0) return 0;
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const stmt = db.prepare(
    "INSERT INTO analytics_events (event, subject, day) VALUES (?, ?, ?)"
  );
  await db.batch(
    events.map((e) => stmt.bind(e.event, e.subject ?? null, day))
  );
  return events.length;
}
async function hashShort(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// workers/site/admin.ts
init_sync();

// workers/site/hooks.ts
var GITHUB_API2 = "https://api.github.com";
var HOOK_PATH = "/api/v1/webhook/github";
function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 40);
}
async function gh(path, token, init) {
  const res = await fetch(`${GITHUB_API2}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "surge-modules-hook-manager",
      ...init?.body ? { "content-type": "application/json" } : {}
    },
    body: init?.body ? JSON.stringify(init.body) : void 0
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}
async function listHooks(owner, repo, token) {
  const { status, data } = await gh(`/repos/${owner}/${repo}/hooks?per_page=100`, token);
  if (status === 404) return { error: "\u4ED3\u5E93\u4E0D\u5B58\u5728\u6216\u65E0\u6743\u8BBF\u95EE", status };
  if (status === 403) return { error: "Token \u7F3A\u5C11 admin:repo_hook \u6743\u9650", status };
  if (status === 401) return { error: "Token \u65E0\u6548", status };
  if (status !== 200) return { error: `GitHub \u8FD4\u56DE ${status}`, status };
  return { hooks: Array.isArray(data) ? data : [] };
}
async function ensureHook(env, source, options = {}) {
  if (!env.GITHUB_READ_TOKEN) return { action: "error", reason: "\u672A\u914D\u7F6E GitHub Token" };
  const origin = (env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  if (!origin) return { action: "skip", reason: "\u672A\u914D\u7F6E PUBLIC_ORIGIN\uFF0C\u65E0\u6CD5\u751F\u6210\u56DE\u8C03\u5730\u5740" };
  const payloadUrl = `${origin}${HOOK_PATH}`;
  const listed = await listHooks(source.owner, source.repo, env.GITHUB_READ_TOKEN);
  if ("error" in listed) return { action: "error", reason: listed.error };
  let secret = source.webhook_secret;
  const needsNewSecret = !secret;
  const existing = listed.hooks.find(
    (h) => (h.config?.url ?? "").replace(/\/+$/, "") === payloadUrl
  );
  if (existing) {
    const matchesEvents = existing.events.length === 1 && existing.events[0] === "push";
    const matchesType = existing.config?.content_type === "json";
    if (existing.active && matchesEvents && matchesType && secret) {
      return { action: "ok", hookId: existing.id };
    }
    if (options.dryRun) {
      return { action: "update", hookId: existing.id, reason: "\u4E8B\u4EF6\u7C7B\u578B\u6216\u542F\u7528\u72B6\u6001\u4E0D\u4E00\u81F4" };
    }
    if (needsNewSecret || !secret) {
      secret = generateSecret();
    }
    const { status: status2 } = await gh(
      `/repos/${source.owner}/${source.repo}/hooks/${existing.id}`,
      env.GITHUB_READ_TOKEN,
      {
        method: "PATCH",
        body: {
          active: true,
          events: ["push"],
          config: { url: payloadUrl, content_type: "json", secret, insecure_ssl: "0" }
        }
      }
    );
    if (status2 >= 400) return { action: "error", reason: `\u66F4\u65B0\u5931\u8D25\uFF1AGitHub ${status2}` };
    await persistSecret(env.DB, source.id, secret);
    return { action: "update", hookId: existing.id };
  }
  if (options.dryRun) {
    return { action: "create", reason: `\u5C06\u521B\u5EFA ${payloadUrl}` };
  }
  if (!secret) secret = generateSecret();
  const { status, data } = await gh(`/repos/${source.owner}/${source.repo}/hooks`, env.GITHUB_READ_TOKEN, {
    method: "POST",
    body: {
      name: "web",
      active: true,
      events: ["push"],
      config: { url: payloadUrl, content_type: "json", secret, insecure_ssl: "0" }
    }
  });
  if (status === 422) return { action: "error", reason: "GitHub \u62D2\u7EDD\uFF1A\u8BE5\u4ED3\u5E93\u53EF\u80FD\u5DF2\u6709\u76F8\u540C URL \u7684 hook" };
  if (status >= 400) return { action: "error", reason: `\u521B\u5EFA\u5931\u8D25\uFF1AGitHub ${status}` };
  await persistSecret(env.DB, source.id, secret);
  const hookId = data?.id;
  return { action: "create", hookId };
}
async function persistSecret(db, sourceId, secret) {
  await db.prepare("UPDATE sources SET webhook_secret = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").bind(secret, sourceId).run();
}
async function planHooks(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, owner, repo, webhook_secret, is_enabled
       FROM sources WHERE deleted_at IS NULL ORDER BY owner, repo`
  ).all();
  const plans = [];
  for (const row of results ?? []) {
    if (row.is_enabled !== 1) {
      plans.push({
        sourceId: row.id,
        owner: row.owner,
        repo: row.repo,
        action: "skip",
        reason: "\u6570\u636E\u6E90\u672A\u542F\u7528"
      });
      continue;
    }
    const outcome = await ensureHook(env, row, { dryRun: true });
    plans.push({
      sourceId: row.id,
      owner: row.owner,
      repo: row.repo,
      action: outcome.action,
      reason: outcome.reason,
      hookId: outcome.hookId
    });
  }
  return plans;
}
async function applyHooks(env, sourceId = "all") {
  const rows = sourceId === "all" ? (await env.DB.prepare(
    `SELECT id, owner, repo, webhook_secret FROM sources
              WHERE deleted_at IS NULL AND is_enabled = 1 ORDER BY owner, repo`
  ).all()).results ?? [] : (await env.DB.prepare(
    "SELECT id, owner, repo, webhook_secret FROM sources WHERE id = ? AND deleted_at IS NULL"
  ).bind(sourceId).all()).results ?? [];
  const out = [];
  for (const row of rows) {
    out.push(await ensureHook(env, row));
  }
  return out;
}

// workers/site/admin-phase6.ts
var MAX_BODY = 256 * 1024;
async function readJson(request) {
  if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
async function logOp(db, actor, action, target, result, detail) {
  await db.prepare(
    `INSERT INTO operation_logs (actor, action, target, result, detail) VALUES (?, ?, ?, ?, ?)`
  ).bind(
    actor,
    action,
    target,
    result,
    detail === void 0 ? null : JSON.stringify(detail).slice(0, 2e3)
  ).run();
}
var SLUG_RE2 = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
async function createModule(ctx) {
  const body = await readJson(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) return jsonError("bad_request", "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const rawSlug = body.slug === void 0 ? "" : String(body.slug).trim();
  const slug = rawSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!SLUG_RE2.test(slug)) {
    return jsonError("bad_request", "slug \u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u5355\u4E2A\u8FDE\u5B57\u7B26");
  }
  const exists = await ctx.db.prepare("SELECT id FROM modules WHERE slug = ? AND deleted_at IS NULL").bind(slug).first();
  if (exists) return jsonError("bad_request", `slug\u300C${slug}\u300D\u5DF2\u88AB\u5360\u7528`);
  const id = `mod-${slug}`;
  const version = String(body.version ?? "1.0.0").slice(0, 20);
  const categoryId = String(body.category_id ?? "") || null;
  const sourceId = String(body.source_id ?? "") || null;
  const sourcePath = String(body.source_path ?? "").slice(0, 300) || null;
  const published = body.is_published ? 1 : 0;
  await ctx.db.prepare(
    `INSERT INTO modules
         (id, slug, name, description, author, category_id, version, source_id,
          source_path, is_featured, is_published, review_status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`
  ).bind(
    id,
    slug,
    name,
    String(body.description ?? "").slice(0, 400),
    String(body.author ?? "").slice(0, 60),
    categoryId,
    version,
    sourceId,
    sourcePath,
    body.is_featured ? 1 : 0,
    published,
    published ? (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z") : null
  ).run();
  if (Array.isArray(body.tags)) {
    for (const tag of body.tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 12)) {
      await ctx.db.prepare("INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)").bind(id, tag).run();
    }
  }
  await ctx.db.prepare(
    `INSERT INTO module_versions (id, module_id, version, changelog, released_at)
       VALUES (?, ?, ?, '\u624B\u5DE5\u521B\u5EFA', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).bind(`${id}-manual`, id, version).run();
  await logOp(ctx.db, ctx.admin.username, "module.create", id, "ok", { slug, name });
  return jsonOk({ id, slug });
}
async function deleteCategory(ctx, id) {
  const row = await ctx.db.prepare("SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!row) return jsonError("not_found", "\u5206\u7C7B\u4E0D\u5B58\u5728");
  const used = await ctx.db.prepare("SELECT COUNT(*) AS n FROM modules WHERE category_id = ? AND deleted_at IS NULL").bind(id).first();
  if ((used?.n ?? 0) > 0) {
    return jsonError("bad_request", `\u8BE5\u5206\u7C7B\u4E0B\u8FD8\u6709 ${used?.n} \u4E2A\u6A21\u5757\uFF0C\u8BF7\u5148\u79FB\u52A8\u6216\u5220\u9664\u5B83\u4EEC`);
  }
  await ctx.db.prepare(`UPDATE categories SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "category.delete", id, "ok", { name: row.name });
  return jsonOk({ id, deleted: true });
}
async function deleteSource(ctx, id) {
  const row = await ctx.db.prepare("SELECT id, owner, repo FROM sources WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!row) return jsonError("not_found", "\u6570\u636E\u6E90\u4E0D\u5B58\u5728");
  const modules = await ctx.db.prepare("SELECT COUNT(*) AS n FROM modules WHERE source_id = ? AND deleted_at IS NULL").bind(id).first();
  if ((modules?.n ?? 0) > 0) {
    return jsonError("bad_request", `\u8BE5\u4ED3\u5E93\u4E0B\u8FD8\u6709 ${modules?.n} \u4E2A\u6A21\u5757\uFF0C\u8BF7\u5148\u5220\u9664\u6A21\u5757\u6216\u6539\u7528\u5176\u4ED6\u6570\u636E\u6E90`);
  }
  await ctx.db.prepare(
    `UPDATE module_proxy_mappings SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0
        WHERE source_id = ? AND deleted_at IS NULL`
  ).bind(id).run();
  await ctx.db.prepare(
    `UPDATE sources SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0 WHERE id = ?`
  ).bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "source.delete", id, "ok", {
    repo: `${row.owner}/${row.repo}`
  });
  return jsonOk({ id, deleted: true });
}
async function deleteAnnouncement(ctx, id) {
  const row = await ctx.db.prepare("SELECT id, title FROM announcements WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!row) return jsonError("not_found", "\u516C\u544A\u4E0D\u5B58\u5728");
  await ctx.db.prepare(`UPDATE announcements SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "announcement.delete", id, "ok", { title: row.title });
  return jsonOk({ id, deleted: true });
}
async function listUpdateLogs(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT id, version, title, body, kind, is_published, published_at
         FROM update_logs WHERE deleted_at IS NULL
        ORDER BY published_at DESC LIMIT 100`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function upsertUpdateLog(ctx, id) {
  const body = await readJson(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!title) return jsonError("bad_request", "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  const kind = ["feature", "fix", "security", "chore"].includes(String(body.kind)) ? String(body.kind) : "feature";
  if (id) {
    await ctx.db.prepare(
      `UPDATE update_logs SET version = ?, title = ?, body = ?, kind = ?, is_published = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`
    ).bind(
      String(body.version ?? "").slice(0, 20),
      title,
      String(body.body ?? "").slice(0, 4e3),
      kind,
      body.is_published === false ? 0 : 1,
      id
    ).run();
    await logOp(ctx.db, ctx.admin.username, "update_log.update", id, "ok", { title });
    return jsonOk({ id });
  }
  const newId = crypto.randomUUID();
  await ctx.db.prepare(
    `INSERT INTO update_logs (id, version, title, body, kind, is_published, published_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).bind(
    newId,
    String(body.version ?? "").slice(0, 20),
    title,
    String(body.body ?? "").slice(0, 4e3),
    kind,
    body.is_published === false ? 0 : 1
  ).run();
  await logOp(ctx.db, ctx.admin.username, "update_log.create", newId, "ok", { title });
  return jsonOk({ id: newId });
}
async function deleteUpdateLog(ctx, id) {
  await ctx.db.prepare(`UPDATE update_logs SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "update_log.delete", id, "ok");
  return jsonOk({ id, deleted: true });
}
var BACKUP_TABLES = [
  "modules",
  "module_tags",
  "module_versions",
  "categories",
  "sources",
  "module_proxy_mappings",
  "announcements",
  "update_logs",
  "site_settings",
  "module_overrides"
];
var REDACTED = /* @__PURE__ */ new Set([
  "password_hash",
  "token_hash",
  "github_token",
  "secret",
  "webhook_secret",
  "api_key"
]);
async function createBackup(ctx) {
  const body = await readJson(ctx.request);
  const label = String(body?.label ?? "").slice(0, 80);
  const snapshot = {};
  const counts = {};
  for (const table of BACKUP_TABLES) {
    try {
      const { results } = await ctx.db.prepare(`SELECT * FROM ${table}`).all();
      const rows = (results ?? []).map((row) => {
        const clean = {};
        for (const [k, v] of Object.entries(row)) {
          if (!REDACTED.has(k)) clean[k] = v;
        }
        return clean;
      });
      snapshot[table] = rows;
      counts[table] = rows.length;
    } catch {
      snapshot[table] = [];
      counts[table] = 0;
    }
  }
  const payload = JSON.stringify({
    version: 1,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    tables: snapshot
  });
  const id = crypto.randomUUID();
  await ctx.db.prepare(
    `INSERT INTO backups (id, label, scope, payload, bytes, row_counts, created_by)
       VALUES (?, ?, 'content', ?, ?, ?, ?)`
  ).bind(id, label || "\u672A\u547D\u540D\u5907\u4EFD", payload, payload.length, JSON.stringify(counts), ctx.admin.username).run();
  await logOp(ctx.db, ctx.admin.username, "backup.create", id, "ok", counts);
  return jsonOk({ id, bytes: payload.length, rowCounts: counts });
}
async function listBackups(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT id, label, scope, bytes, row_counts, created_by, created_at
         FROM backups ORDER BY created_at DESC LIMIT 50`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function downloadBackup(ctx, id) {
  const row = await ctx.db.prepare("SELECT payload, label, created_at FROM backups WHERE id = ?").bind(id).first();
  if (!row) return jsonError("not_found", "\u5907\u4EFD\u4E0D\u5B58\u5728");
  const stamp = row.created_at.replace(/[:.]/g, "-");
  const filename = `surge-modules-${stamp}.json`;
  await logOp(ctx.db, ctx.admin.username, "backup.download", id, "ok");
  return new Response(row.payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
async function deleteBackup(ctx, id) {
  await ctx.db.prepare("DELETE FROM backups WHERE id = ?").bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "backup.delete", id, "ok");
  return jsonOk({ id, deleted: true });
}
async function restoreBackup(ctx, id) {
  const body = await readJson(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const row = await ctx.db.prepare("SELECT payload FROM backups WHERE id = ?").bind(id).first();
  if (!row) return jsonError("not_found", "\u5907\u4EFD\u4E0D\u5B58\u5728");
  let parsed;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return jsonError("bad_request", "\u5907\u4EFD\u6587\u4EF6\u5DF2\u635F\u574F");
  }
  const tables = parsed.tables ?? {};
  const counts = {};
  for (const table of BACKUP_TABLES) counts[table] = tables[table]?.length ?? 0;
  if (body.dryRun === true) {
    return jsonOk({ dryRun: true, wouldWrite: counts });
  }
  if (String(body.confirm ?? "") !== id) {
    return jsonError("bad_request", "\u6062\u590D\u9700\u8981\u663E\u5F0F\u786E\u8BA4\uFF1A\u5148\u4EE5 dryRun \u67E5\u770B\u5F71\u54CD\uFF0C\u518D\u4F20 confirm=<\u5907\u4EFD ID>");
  }
  let written = 0;
  for (const table of BACKUP_TABLES) {
    const rows = tables[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const rowObj = raw;
      const cols = Object.keys(rowObj).filter((c) => !REDACTED.has(c));
      if (cols.length === 0) continue;
      const placeholders = cols.map(() => "?").join(", ");
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
      try {
        await ctx.db.prepare(sql).bind(...cols.map((c) => rowObj[c])).run();
        written += 1;
      } catch {
      }
    }
  }
  await logOp(ctx.db, ctx.admin.username, "backup.restore", id, "ok", { written });
  return jsonOk({ restored: true, written });
}
async function listOperationLogs(ctx, url) {
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100)
  );
  const rows = await ctx.db.prepare(
    `SELECT actor, action, target, result, detail, created_at
         FROM operation_logs ORDER BY id DESC LIMIT ?`
  ).bind(limit).all();
  const items = (rows.results ?? []).map((row) => {
    const copy = { ...row };
    if (typeof copy.detail === "string") {
      copy.detail = copy.detail.replace(/ghp_[A-Za-z0-9]{20,}/g, "[redacted]").replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]");
    }
    return copy;
  });
  return jsonOk({ items });
}
async function exportConfig(ctx) {
  const [settings, categories] = await Promise.all([
    ctx.db.prepare("SELECT key, value, value_type FROM site_settings WHERE scope = 'public'").all(),
    ctx.db.prepare(
      "SELECT id, name, slug, description, icon, sort_order, is_visible FROM categories WHERE deleted_at IS NULL"
    ).all()
  ]);
  await logOp(ctx.db, ctx.admin.username, "config.export", null, "ok");
  return jsonOk({
    version: 1,
    settings: settings.results ?? [],
    categories: categories.results ?? []
  });
}
async function importConfig(ctx) {
  const body = await readJson(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  let settingsWritten = 0;
  if (Array.isArray(body.settings)) {
    for (const entry of body.settings.slice(0, 200)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { key, value } = entry;
      if (typeof key !== "string" || typeof value !== "string") continue;
      await ctx.db.prepare(
        `UPDATE site_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE key = ?`
      ).bind(value.slice(0, 500), key).run();
      settingsWritten += 1;
    }
  }
  await logOp(ctx.db, ctx.admin.username, "config.import", null, "ok", { settingsWritten });
  return jsonOk({ settingsWritten });
}
async function listAlerts(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT a.id, a.kind, a.message, a.acknowledged, a.created_at,
              s.owner || '/' || s.repo AS source
         FROM sync_alerts a
         LEFT JOIN sources s ON s.id = a.source_id
        ORDER BY a.acknowledged ASC, a.id DESC LIMIT 50`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function acknowledgeAlert(ctx, id) {
  await ctx.db.prepare("UPDATE sync_alerts SET acknowledged = 1 WHERE id = ?").bind(id).run();
  await logOp(ctx.db, ctx.admin.username, "alert.acknowledge", id, "ok");
  return jsonOk({ id, acknowledged: true });
}
async function inspectHooks(ctx) {
  const plans = await planHooks({
    DB: ctx.db,
    GITHUB_READ_TOKEN: ctx.githubToken,
    PUBLIC_ORIGIN: ctx.publicOrigin
  });
  return jsonOk({ plans, publicOrigin: ctx.publicOrigin ?? "" });
}
async function syncHooks(ctx, sourceId) {
  const results = await applyHooks(
    {
      DB: ctx.db,
      GITHUB_READ_TOKEN: ctx.githubToken,
      PUBLIC_ORIGIN: ctx.publicOrigin
    },
    sourceId
  );
  await logOp(ctx.db, ctx.admin.username, "hook.apply", sourceId, "ok", results);
  return jsonOk({ results });
}
async function handlePhase6(ctx, path, method, url) {
  if (path === "/modules" && method === "POST") return createModule(ctx);
  const catDelete = path.match(/^\/categories\/([\w-]+)\/delete$/);
  if (catDelete && method === "POST") return deleteCategory(ctx, catDelete[1]);
  const srcDelete = path.match(/^\/sources\/([\w-]+)\/delete$/);
  if (srcDelete && method === "POST") return deleteSource(ctx, srcDelete[1]);
  const annDelete = path.match(/^\/announcements\/([\w-]+)\/delete$/);
  if (annDelete && method === "POST") return deleteAnnouncement(ctx, annDelete[1]);
  if (path === "/update-logs") {
    if (method === "GET") return listUpdateLogs(ctx);
    if (method === "POST") return upsertUpdateLog(ctx, null);
    return methodNotAllowed(["GET", "POST"]);
  }
  const updMatch = path.match(/^\/update-logs\/([\w-]+)$/);
  if (updMatch) {
    if (method === "PATCH") return upsertUpdateLog(ctx, updMatch[1]);
    if (method === "DELETE") return deleteUpdateLog(ctx, updMatch[1]);
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  if (path === "/backups") {
    if (method === "GET") return listBackups(ctx);
    if (method === "POST") return createBackup(ctx);
    return methodNotAllowed(["GET", "POST"]);
  }
  const bkDownload = path.match(/^\/backups\/([\w-]+)\/download$/);
  if (bkDownload && method === "GET") return downloadBackup(ctx, bkDownload[1]);
  const bkRestore = path.match(/^\/backups\/([\w-]+)\/restore$/);
  if (bkRestore && method === "POST") return restoreBackup(ctx, bkRestore[1]);
  const bkDelete = path.match(/^\/backups\/([\w-]+)$/);
  if (bkDelete && method === "DELETE") return deleteBackup(ctx, bkDelete[1]);
  if (path === "/operation-logs") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listOperationLogs(ctx, url);
  }
  if (path === "/alerts") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listAlerts(ctx);
  }
  const ackMatch = path.match(/^\/alerts\/([\w-]+)\/ack$/);
  if (ackMatch && method === "POST") return acknowledgeAlert(ctx, ackMatch[1]);
  if (path === "/hooks") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return inspectHooks(ctx);
  }
  const hookApply = path.match(/^\/hooks\/([\w-]+)\/apply$/);
  if (hookApply && method === "POST") return syncHooks(ctx, hookApply[1]);
  if (path === "/config/export") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return exportConfig(ctx);
  }
  if (path === "/config/import") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return importConfig(ctx);
  }
  return null;
}

// workers/site/admin-third-party.ts
init_third_party();

// workers/site/review.ts
init_sync();
init_telegram();
var iso3 = (d = /* @__PURE__ */ new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");
var SELECT_TASK = `
  SELECT t.*, r.name AS repository_name, r.owner, r.repository,
         m.name AS module_name, m.slug AS module_slug,
         m.version AS module_live_version, m.content_hash AS module_live_sha,
         m.is_published AS module_live_published
    FROM module_review_tasks t
    LEFT JOIN third_party_repositories r ON r.id = t.repository_id
    LEFT JOIN modules m ON m.id = t.module_id
`;
async function listTasks(db, filter) {
  const where = [];
  const binds = [];
  if (filter.status && filter.status !== "all") {
    where.push("t.review_status = ?");
    binds.push(filter.status);
  }
  if (filter.type && filter.type !== "all") {
    where.push("t.task_type = ?");
    binds.push(filter.type);
  }
  if (filter.method && filter.method !== "all") {
    where.push("t.detection_method = ?");
    binds.push(filter.method);
  }
  if (filter.repositoryId) {
    where.push("t.repository_id = ?");
    binds.push(filter.repositoryId);
  }
  if (filter.search) {
    where.push("(t.file_path LIKE ? OR m.name LIKE ? OR r.name LIKE ?)");
    const like = `%${filter.search.slice(0, 60)}%`;
    binds.push(like, like, like);
  }
  if (filter.from) {
    where.push("t.created_at >= ?");
    binds.push(filter.from);
  }
  if (filter.to) {
    where.push("t.created_at <= ?");
    binds.push(filter.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const perPage = Math.min(Math.max(filter.perPage ?? 20, 1), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const order = filter.sort === "oldest" ? "ASC" : "DESC";
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM module_review_tasks t
         LEFT JOIN modules m ON m.id = t.module_id
         LEFT JOIN third_party_repositories r ON r.id = t.repository_id
         ${clause}`
  ).bind(...binds).first();
  const rows = await db.prepare(`${SELECT_TASK} ${clause} ORDER BY t.created_at ${order} LIMIT ? OFFSET ?`).bind(...binds, perPage, (page - 1) * perPage).all();
  return {
    items: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    perPage
  };
}
async function getTask(db, id) {
  return db.prepare(`${SELECT_TASK} WHERE t.id = ?`).bind(id).first();
}
async function logAudit(db, args) {
  try {
    await db.prepare(
      `INSERT INTO module_audit_logs (task_id, action, operator, source, details)
         VALUES (?, ?, ?, ?, ?)`
    ).bind(
      args.taskId,
      args.action,
      args.operator.slice(0, 80),
      args.source,
      JSON.stringify(args.details ?? {}).slice(0, 4e3)
    ).run();
  } catch (err) {
    console.error(
      "[audit] failed to write",
      args.action,
      args.taskId,
      err instanceof Error ? err.message : String(err)
    );
  }
}
async function decideTask(env, input) {
  const { DB } = env;
  const task = await getTask(DB, input.taskId);
  if (!task) return { ok: false, code: "not_found", message: "\u5BA1\u6838\u4EFB\u52A1\u4E0D\u5B58\u5728" };
  if (task.review_status === "approved") {
    return { ok: false, code: "conflict", message: "" };
  }
  if (task.review_status === "rejected") {
    return { ok: false, code: "conflict", message: "" };
  }
  if (task.review_status === "superseded") {
    return { ok: false, code: "conflict", message: "" };
  }
  if (task.review_status !== "pending" && task.review_status !== "on_hold") {
    return { ok: false, code: "conflict", message: `\u5F53\u524D\u72B6\u6001\u4E0D\u53EF\u64CD\u4F5C\uFF08${task.review_status}\uFF09` };
  }
  if (input.decision === "hold") {
    const res = await DB.prepare(
      `UPDATE module_review_tasks
          SET review_status = 'on_hold', note = ?, updated_at = ?
        WHERE id = ? AND review_status IN ('pending', 'on_hold')`
    ).bind((input.note ?? task.note ?? "").slice(0, 1e3), iso3(), task.id).run();
    if ((res.meta.changes ?? 0) === 0) {
      return { ok: false, code: "conflict", message: "\u4EFB\u52A1\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" };
    }
    await refreshRepositoryCounters(DB, task.repository_id);
    await logAudit(DB, {
      taskId: task.id,
      action: "review.hold",
      operator: input.operator,
      source: input.source,
      details: { note: input.note }
    });
    return { ok: true, status: "on_hold" };
  }
  if (input.decision === "reject") {
    const res = await DB.prepare(
      `UPDATE module_review_tasks
          SET review_status = 'rejected', rejection_reason = ?, reviewer = ?,
              reviewed_at = ?, note = ?, updated_at = ?
        WHERE id = ? AND review_status IN ('pending', 'on_hold')`
    ).bind(
      (input.reason ?? "").slice(0, 1e3),
      input.operator,
      iso3(),
      (input.note ?? task.note ?? "").slice(0, 1e3),
      iso3(),
      task.id
    ).run();
    if ((res.meta?.changes ?? 0) === 0) {
      return { ok: false, code: "conflict", message: "\u4EFB\u52A1\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" };
    }
    if (task.task_type === "new") {
      await DB.prepare(
        `UPDATE third_party_modules SET published = 0, updated_at = ?
          WHERE id = ?`
      ).bind(iso3(), task.third_party_module_id).run();
    }
    await refreshRepositoryCounters(DB, task.repository_id);
    await logAudit(DB, {
      taskId: task.id,
      action: "review.reject",
      operator: input.operator,
      source: input.source,
      details: { reason: input.reason, taskType: task.task_type }
    });
    if (env.TELEGRAM_BOT_TOKEN) {
      await notifyAudit(env, "rejected", task, input.operator, input.reason ?? "");
    }
    return { ok: true, status: "rejected" };
  }
  return approveTask(env, task, input);
}
async function approveTask(env, task, input) {
  const { DB } = env;
  if (task.task_type === "update" && task.module_id) {
    const live = await DB.prepare(
      "SELECT version, content_hash, is_published FROM modules WHERE id = ?"
    ).bind(task.module_id).first();
    if (!live) {
      return { ok: false, code: "conflict", message: "\u5173\u8054\u6A21\u5757\u5DF2\u4E0D\u5B58\u5728" };
    }
    if (live.content_hash && live.content_hash === task.content_sha) {
      await DB.prepare(
        `UPDATE module_review_tasks
            SET review_status = 'approved', reviewer = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND review_status IN ('pending','on_hold')`
      ).bind(input.operator, iso3(), iso3(), task.id).run();
      return { ok: true, status: "approved", published: false, moduleId: task.module_id };
    }
  }
  const claim = await DB.prepare(
    `UPDATE module_review_tasks
        SET review_status = 'approved', reviewer = ?, reviewed_at = ?,
            rejection_reason = '', note = ?, updated_at = ?
      WHERE id = ? AND review_status IN ('pending', 'on_hold')`
  ).bind(
    input.operator,
    iso3(),
    (input.note ?? task.note ?? "").slice(0, 1e3),
    iso3(),
    task.id
  ).run();
  const claimed = (claim.meta?.changes ?? 0) > 0;
  if (!claimed) {
    return { ok: false, code: "conflict", message: "\u4EFB\u52A1\u5DF2\u88AB\u5904\u7406\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" };
  }
  try {
    if (task.task_type === "delete") {
      const result2 = await approveDelete(env, task, input);
      await finishAudit(env, task, input, result2);
      return result2;
    }
    const result = task.task_type === "new" ? await approveNew(env, task, input) : await approveUpdate(env, task, input);
    await finishAudit(env, task, input, result);
    return result;
  } catch (err) {
    await DB.prepare(
      `UPDATE module_review_tasks SET review_status = 'pending', reviewer = NULL,
              reviewed_at = NULL, updated_at = ?
        WHERE id = ?`
    ).bind(iso3(), task.id).run();
    return {
      ok: false,
      code: "internal",
      message: err instanceof Error ? err.message : "\u53D1\u5E03\u5931\u8D25"
    };
  }
}
async function finishAudit(env, task, input, result) {
  await refreshRepositoryCounters(env.DB, task.repository_id);
  await logAudit(env.DB, {
    taskId: task.id,
    action: "review.approve",
    operator: input.operator,
    source: input.source,
    details: result.ok ? { moduleId: result.moduleId, slug: result.slug, published: result.published } : { error: "message" in result ? result.message : "unknown" }
  });
  if (env.TELEGRAM_BOT_TOKEN && result.ok) {
    await notifyAudit(env, "approved", task, input.operator, "");
  }
}
function deriveNewModule(task, overrides) {
  const fallback = task.file_path.split("/").pop()?.replace(/\.sgmodule$/i, "") ?? "module";
  const meta = parseModuleMeta(task.new_content || "", fallback);
  return {
    name: (overrides?.name || meta.name || fallback).slice(0, 120),
    description: (overrides?.description || meta.description || "").slice(0, 500),
    author: (meta.author || task.owner || "").slice(0, 80),
    version: task.new_version || "1.0.0",
    categoryId: overrides?.categoryId || null,
    featured: overrides?.featured === true
  };
}
async function allocateSlug(db, base, filePath = "") {
  const fileStem = (filePath.split("/").pop() ?? "").replace(/\.sgmodule$/i, "");
  const root = slugify(fileStem).slice(0, 60) || slugify(base).slice(0, 60) || "module";
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? root : `${root}-${n + 1}`;
    const hit = await db.prepare("SELECT 1 AS x FROM modules WHERE slug = ? AND deleted_at IS NULL").bind(candidate).first();
    if (!hit) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}
async function approveNew(env, task, input) {
  const { DB } = env;
  const info = deriveNewModule(task, input.overrides);
  const slug = await allocateSlug(DB, info.name || task.file_path, task.file_path);
  const moduleId = crypto.randomUUID();
  const contentSha = await sha256(task.new_content || "");
  const categoryId = info.categoryId ?? (await DB.prepare(
    "SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY sort_order LIMIT 1"
  ).first())?.id ?? null;
  const sourceUrl = `https://github.com/${task.owner}/${task.repository}/blob/${encodeURIComponent(
    task.branch || "main"
  )}/${task.file_path.split("/").map(encodeURIComponent).join("/")}`;
  await DB.prepare(
    `INSERT INTO modules
      (id, slug, name, description, author, category_id, version, source_id,
       source_path, content_hash, upstream_url, repository_url, is_featured,
       is_published, published_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(
    moduleId,
    slug,
    info.name,
    info.description,
    info.author,
    categoryId,
    info.version,
    task.file_path,
    contentSha,
    sourceUrl,
    `https://github.com/${task.owner}/${task.repository}`,
    info.featured ? 1 : 0,
    iso3(),
    iso3()
  ).run();
  await DB.prepare(
    `INSERT INTO module_versions
      (id, module_id, version, content_hash, changelog, commit_sha, released_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    moduleId,
    info.version,
    contentSha,
    "\u9996\u6B21\u6536\u5F55\uFF08\u7B2C\u4E09\u65B9\u4ED3\u5E93\u5BA1\u6838\u901A\u8FC7\uFF09",
    task.commit_sha,
    iso3(),
    iso3()
  ).run();
  await DB.prepare(
    `INSERT INTO module_version_history
      (id, module_id, third_party_module_id, version, content, content_sha,
       commit_sha, source_url, published_at, reviewed_by, review_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    moduleId,
    task.third_party_module_id,
    info.version,
    (task.new_content || "").slice(0, 12e4),
    contentSha,
    task.commit_sha,
    sourceUrl,
    iso3(),
    input.operator,
    task.id
  ).run();
  if (task.third_party_module_id) {
    await DB.prepare(
      `UPDATE third_party_modules
          SET module_id = ?, published = 1, current_version = ?,
              current_content = ?, current_content_sha = ?,
              source_commit_sha = ?, module_name = ?, module_description = ?,
              author = ?, is_deleted_upstream = 0, updated_at = ?
        WHERE id = ?`
    ).bind(
      moduleId,
      info.version,
      (task.new_content || "").slice(0, 12e4),
      contentSha,
      task.commit_sha,
      info.name,
      info.description,
      info.author,
      iso3(),
      task.third_party_module_id
    ).run();
  }
  await DB.prepare("UPDATE module_review_tasks SET module_id = ? WHERE id = ?").bind(moduleId, task.id).run();
  return { ok: true, status: "approved", published: true, moduleId, slug };
}
async function approveUpdate(env, task, input) {
  const { DB } = env;
  if (!task.module_id) {
    return { ok: false, code: "invalid", message: "\u66F4\u65B0\u4EFB\u52A1\u7F3A\u5C11\u5173\u8054\u6A21\u5757" };
  }
  const contentSha = await sha256(task.new_content || "");
  const live = await DB.prepare(
    "SELECT id, slug, version, content_hash, name, description FROM modules WHERE id = ?"
  ).bind(task.module_id).first();
  if (!live) return { ok: false, code: "not_found", message: "\u5173\u8054\u6A21\u5757\u4E0D\u5B58\u5728" };
  if (live.content_hash === contentSha) {
    return { ok: true, status: "approved", published: false, moduleId: live.id, slug: live.slug };
  }
  if (task.old_version && live.version && task.old_version !== live.version) {
    const newer = await DB.prepare(
      `SELECT 1 AS x FROM module_review_tasks
        WHERE module_id = ? AND review_status = 'pending' AND id <> ?
        LIMIT 1`
    ).bind(task.module_id, task.id).first();
    if (newer) {
      return {
        ok: false,
        code: "conflict",
        message: `\u7EBF\u4E0A\u7248\u672C\u5DF2\u53D8\u4E3A ${live.version}\uFF0C\u5F53\u524D\u4EFB\u52A1\u57FA\u4E8E ${task.old_version}\uFF0C\u5DF2\u5931\u6548`
      };
    }
  }
  const meta = parseModuleMeta(task.new_content || "", live.name);
  const name = (input.overrides?.name || meta.name || live.name).slice(0, 120);
  const description = (input.overrides?.description || meta.description || live.description).slice(
    0,
    500
  );
  await DB.prepare(
    `UPDATE modules
        SET version = ?, content_hash = ?, name = ?, description = ?,
            is_published = 1, synced_at = ?, updated_at = ?,
            published_at = COALESCE(published_at, ?)
      WHERE id = ?`
  ).bind(
    task.new_version || live.version,
    contentSha,
    name,
    description,
    iso3(),
    iso3(),
    iso3(),
    live.id
  ).run();
  if (input.overrides?.featured !== void 0) {
    await DB.prepare("UPDATE modules SET is_featured = ? WHERE id = ?").bind(input.overrides.featured ? 1 : 0, live.id).run();
  }
  if (input.overrides?.categoryId) {
    await DB.prepare("UPDATE modules SET category_id = ? WHERE id = ?").bind(input.overrides.categoryId, live.id).run();
  }
  await DB.prepare(
    `INSERT INTO module_versions
      (id, module_id, version, content_hash, changelog, commit_sha, released_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    live.id,
    task.new_version || live.version,
    contentSha,
    `\u7B2C\u4E09\u65B9\u4ED3\u5E93\u66F4\u65B0\uFF08${task.detection_method}\uFF09`,
    task.commit_sha,
    iso3(),
    iso3()
  ).run();
  await DB.prepare(
    `INSERT INTO module_version_history
      (id, module_id, third_party_module_id, version, content, content_sha,
       commit_sha, source_url, published_at, reviewed_by, review_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    live.id,
    task.third_party_module_id,
    task.new_version || live.version,
    (task.new_content || "").slice(0, 12e4),
    contentSha,
    task.commit_sha,
    `https://github.com/${task.owner}/${task.repository}/commit/${task.commit_sha}`,
    iso3(),
    input.operator,
    task.id
  ).run();
  if (task.third_party_module_id) {
    await DB.prepare(
      `UPDATE third_party_modules
          SET current_version = ?, current_content = ?, current_content_sha = ?,
              source_commit_sha = ?, published = 1, is_deleted_upstream = 0,
              module_name = ?, module_description = ?, updated_at = ?
        WHERE id = ?`
    ).bind(
      task.new_version || live.version,
      (task.new_content || "").slice(0, 12e4),
      contentSha,
      task.commit_sha,
      name,
      description,
      iso3(),
      task.third_party_module_id
    ).run();
  }
  return { ok: true, status: "approved", published: true, moduleId: live.id, slug: live.slug };
}
async function approveDelete(env, task, input) {
  const { DB } = env;
  const action = (input.note ?? "").trim() || "hide";
  if (!task.module_id) {
    return { ok: true, status: "approved", published: false };
  }
  if (action === "keep") {
    return { ok: true, status: "approved", published: false, moduleId: task.module_id };
  }
  if (action === "hide" || action === "unpublish") {
    await DB.prepare(
      "UPDATE modules SET is_published = 0, updated_at = ? WHERE id = ?"
    ).bind(iso3(), task.module_id).run();
    await DB.prepare(
      "UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ? AND deleted_at IS NULL"
    ).bind(task.module_id).run();
    return { ok: true, status: "approved", published: false, moduleId: task.module_id };
  }
  await DB.prepare(
    "UPDATE modules SET is_published = 0, deleted_at = ?, updated_at = ? WHERE id = ?"
  ).bind(iso3(), iso3(), task.module_id).run();
  await DB.prepare(
    "UPDATE module_proxy_mappings SET is_enabled = 0, deleted_at = ? WHERE module_id = ? AND deleted_at IS NULL"
  ).bind(iso3(), task.module_id).run();
  await DB.prepare(
    `INSERT OR IGNORE INTO module_tombstones (slug, module_id, reason)
     SELECT slug, id, '\u7B2C\u4E09\u65B9\u4ED3\u5E93\u5220\u9664\u5E76\u7ECF\u7BA1\u7406\u5458\u786E\u8BA4' FROM modules WHERE id = ?`
  ).bind(task.module_id).run();
  return { ok: true, status: "approved", published: false, moduleId: task.module_id };
}
async function refreshRepositoryCounters(db, repositoryId) {
  if (!repositoryId) return;
  await db.prepare(
    `UPDATE third_party_repositories
          SET pending_new = (
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
        WHERE id = ?`
  ).bind(repositoryId, repositoryId, repositoryId, iso3(), repositoryId).run();
}
async function reviewStats(db) {
  const row = await db.prepare(
    `SELECT
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'new' THEN 1 ELSE 0 END) AS pendingNew,
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'update' THEN 1 ELSE 0 END) AS pendingUpdates,
         SUM(CASE WHEN review_status = 'pending' AND task_type = 'delete' THEN 1 ELSE 0 END) AS pendingDeletes,
         SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         COUNT(*) AS total,
         MIN(CASE WHEN review_status = 'pending' THEN created_at END) AS oldestPendingAt
       FROM module_review_tasks`
  ).first();
  return {
    pendingNew: Number(row?.pendingNew ?? 0),
    pendingUpdates: Number(row?.pendingUpdates ?? 0),
    pendingDeletes: Number(row?.pendingDeletes ?? 0),
    approved: Number(row?.approved ?? 0),
    rejected: Number(row?.rejected ?? 0),
    total: Number(row?.total ?? 0),
    oldestPendingAt: row?.oldestPendingAt ?? null
  };
}

// workers/site/admin-third-party.ts
init_telegram();

// workers/site/credentials.ts
init_third_party();
var KEY_PREFIX = "secret.";
var ENC_PREFIX = "enc:v1:";
async function readStored(db, name) {
  const row = await db.prepare("SELECT value, value_type FROM site_settings WHERE key = ?").bind(`${KEY_PREFIX}${name}`).first();
  if (!row) return "";
  if (row.value_type !== "encrypted" || !row.value.startsWith(ENC_PREFIX)) return "";
  return row.value;
}
async function resolveCredential(env, name, fallback, encKey) {
  const stored = await readStored(env.DB, name);
  if (stored) {
    const key = encKey ?? (await resolveCredential(env, "webhook_secret_key") || env.WEBHOOK_SECRET_KEY);
    if (key) {
      const plain = await decryptSecret(stored.slice(ENC_PREFIX.length), key);
      if (plain) return plain;
    }
  }
  return (fallback ?? "").trim();
}
async function saveCredential(env, name, plain, encKey) {
  const value = plain.trim();
  if (!value) {
    await env.DB.prepare(
      `UPDATE site_settings SET value = '', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE key = ?`
    ).bind(`${KEY_PREFIX}${name}`).run();
    return;
  }
  const enc = `${ENC_PREFIX}${await encryptSecret(value, encKey)}`;
  await env.DB.prepare(
    `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
     VALUES (?, ?, 'encrypted', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       value_type = 'encrypted', updated_at = excluded.updated_at`
  ).bind(`${KEY_PREFIX}${name}`, enc).run();
}
async function resolveAll(env) {
  const encryptionKey = (env.WEBHOOK_SECRET_KEY ?? "").trim();
  const [githubReadToken, telegramBotToken, telegramAdminId] = await Promise.all([
    resolveCredential(env, "github_read_token", env.GITHUB_READ_TOKEN, encryptionKey),
    resolveCredential(env, "telegram_bot_token", env.TELEGRAM_BOT_TOKEN, encryptionKey),
    // The admin id is not secret; it stays a plain setting.
    (async () => {
      const row = await env.DB.prepare(
        "SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'"
      ).first();
      return (env.TELEGRAM_ADMIN_ID ?? "").trim() || (row?.value ?? "").trim();
    })()
  ]);
  return { githubReadToken, telegramBotToken, telegramAdminId, encryptionKey };
}
async function credentialStatus(env, name) {
  const stored = await readStored(env.DB, name);
  const key = (env.WEBHOOK_SECRET_KEY ?? "").trim();
  let usable = false;
  let hint = "";
  if (stored && key) {
    const plain = await decryptSecret(stored.slice(ENC_PREFIX.length), key);
    if (plain) {
      usable = true;
      hint = plain.length > 12 ? `${plain.slice(0, 4)}\u2026${plain.slice(-4)}` : "\u5DF2\u8BBE\u7F6E";
    }
  }
  return { fromPanel: Boolean(stored), hasFallback: false, usable, hint };
}

// workers/site/admin-third-party.ts
var iso4 = (d = /* @__PURE__ */ new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");
var str = (v, max = 200) => typeof v === "string" ? v.trim().slice(0, max) : "";
var bool = (v, fallback = true) => {
  if (v === void 0 || v === null) return fallback ? 1 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "0" || v === 0 || v === "false") return 0;
  return 1;
};
var num = (v, fallback, min, max) => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};
async function readBody(request) {
  const capped = await readJsonCapped(request, 128 * 1024);
  if ("error" in capped) return null;
  const data = capped.data;
  return typeof data === "object" && data !== null ? data : null;
}
async function listRepos(ctx) {
  const repos = await listRepositories(ctx.db);
  const stats = await reviewStats(ctx.db);
  const rows = await Promise.all(
    repos.map(async (r) => {
      const counts = await ctx.db.prepare(
        `SELECT
             SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END) AS published,
             COUNT(*) AS total
           FROM third_party_modules WHERE repository_id = ?`
      ).bind(r.id).first();
      return {
        id: r.id,
        name: r.name,
        owner: r.owner,
        repository: r.repository,
        repositoryUrl: r.repository_url,
        defaultBranch: r.default_branch,
        description: r.description,
        categoryId: r.category_id,
        notes: r.notes,
        enabled: r.enabled === 1,
        webhookEnabled: r.webhook_enabled === 1,
        cronEnabled: r.cron_enabled === 1,
        manualCheckEnabled: r.manual_check_enabled === 1,
        hasWebhookSecret: Boolean(r.webhook_secret_enc),
        webhookSecretHint: r.webhook_secret_hint,
        checkIntervalHours: r.check_interval_hours,
        lastCheckedAt: r.last_checked_at,
        nextCheckAt: r.next_check_at,
        lastCheckStatus: r.last_check_status,
        lastCheckError: r.last_check_error,
        consecutiveFailures: r.consecutive_failures,
        autoReviewNew: r.auto_review_new === 1,
        autoReviewUpdate: r.auto_review_update === 1,
        discoveredModules: counts?.total ?? 0,
        publishedModules: counts?.published ?? 0,
        pendingNew: r.pending_new,
        pendingUpdates: r.pending_updates,
        createdAt: r.created_at
      };
    })
  );
  return jsonOk({
    items: rows,
    stats: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      disabled: rows.filter((r) => !r.enabled).length,
      discoveredModules: rows.reduce((s, r) => s + r.discoveredModules, 0),
      pendingNew: stats.pendingNew,
      pendingUpdates: stats.pendingUpdates,
      pendingDeletes: stats.pendingDeletes,
      lastCheckedAt: rows.map((r) => r.lastCheckedAt).filter(Boolean).sort().pop() ?? null,
      lastCheckStatus: rows.find((r) => r.lastCheckedAt === rows.map((x) => x.lastCheckedAt).filter(Boolean).sort().pop())?.lastCheckStatus ?? null
    }
  });
}
async function createRepo(ctx) {
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const input = str(body.repositoryUrl ?? body.url, 300);
  const parsed = parseRepoUrl(input);
  if (!parsed) {
    return jsonError("bad_request", "\u65E0\u6CD5\u89E3\u6790\u4ED3\u5E93\u5730\u5740\uFF0C\u8BF7\u586B\u5199 https://github.com/owner/repo");
  }
  const existing = await ctx.db.prepare(
    `SELECT id FROM third_party_repositories
        WHERE owner = ? AND repository = ? AND deleted_at IS NULL`
  ).bind(parsed.owner, parsed.repo).first();
  if (existing) return jsonError("conflict", "\u8BE5\u4ED3\u5E93\u5DF2\u5B58\u5728");
  const info = await fetchRepoInfo(parsed.owner, parsed.repo, ctx.env.GITHUB_READ_TOKEN);
  const defaultBranch = str(body.defaultBranch, 100) || (!("error" in info) ? info.info.defaultBranch : "main");
  if (!safeSegment2(defaultBranch)) return jsonError("bad_request", "\u5206\u652F\u540D\u4E0D\u5408\u6CD5");
  const id = crypto.randomUUID();
  const name = str(body.name, 120) || (!("error" in info) ? info.info.fullName : `${parsed.owner}/${parsed.repo}`);
  const description = str(body.description, 500) || (!("error" in info) ? info.info.description : "");
  await ctx.db.prepare(
    `INSERT INTO third_party_repositories
        (id, name, owner, repository, repository_url, default_branch, description,
         category_id, notes, enabled, webhook_enabled, cron_enabled,
         manual_check_enabled, check_interval_hours, next_check_at,
         auto_review_new, auto_review_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    name,
    parsed.owner,
    parsed.repo,
    parsed.url,
    defaultBranch,
    description,
    str(body.categoryId, 60) || null,
    str(body.notes, 1e3),
    bool(body.enabled),
    bool(body.webhookEnabled),
    bool(body.cronEnabled),
    bool(body.manualCheckEnabled),
    num(body.checkIntervalHours, 6, 1, 720),
    iso4(new Date(Date.now() + 6 * 36e5)),
    bool(body.autoReviewNew),
    bool(body.autoReviewUpdate)
  ).run();
  await logAudit(ctx.db, {
    taskId: null,
    action: "repo.create",
    operator: ctx.admin.username,
    source: "web",
    details: { repositoryId: id, repo: `${parsed.owner}/${parsed.repo}` }
  });
  return jsonOk({
    id,
    repositoryUrl: parsed.url,
    defaultBranch,
    repositoryWarning: "error" in info ? info.error : void 0
  });
}
async function updateRepo(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const sets = [];
  const binds = [];
  const push = (frag, value) => {
    sets.push(frag);
    binds.push(value);
  };
  if (body.name !== void 0) push("name = ?", str(body.name, 120) || repo.name);
  if (body.defaultBranch !== void 0) {
    const b = str(body.defaultBranch, 100);
    if (!b || !safeSegment2(b)) return jsonError("bad_request", "\u5206\u652F\u540D\u4E0D\u5408\u6CD5");
    push("default_branch = ?", b);
  }
  if (body.description !== void 0) push("description = ?", str(body.description, 500));
  if (body.notes !== void 0) push("notes = ?", str(body.notes, 1e3));
  if (body.categoryId !== void 0) push("category_id = ?", str(body.categoryId, 60) || null);
  if (body.enabled !== void 0) push("enabled = ?", bool(body.enabled));
  if (body.webhookEnabled !== void 0) push("webhook_enabled = ?", bool(body.webhookEnabled));
  if (body.cronEnabled !== void 0) push("cron_enabled = ?", bool(body.cronEnabled));
  if (body.manualCheckEnabled !== void 0)
    push("manual_check_enabled = ?", bool(body.manualCheckEnabled));
  if (body.checkIntervalHours !== void 0) {
    push("check_interval_hours = ?", num(body.checkIntervalHours, 6, 1, 720));
    push("next_check_at = ?", iso4(new Date(Date.now() + num(body.checkIntervalHours, 6, 1, 720) * 36e5)));
  }
  if (body.autoReviewNew !== void 0) push("auto_review_new = ?", bool(body.autoReviewNew));
  if (body.autoReviewUpdate !== void 0)
    push("auto_review_update = ?", bool(body.autoReviewUpdate));
  if (sets.length === 0) return jsonError("bad_request", "\u6CA1\u6709\u53EF\u66F4\u65B0\u7684\u5B57\u6BB5");
  push("updated_at = ?", iso4());
  binds.push(id);
  await ctx.db.prepare(`UPDATE third_party_repositories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(ctx.db, {
    taskId: null,
    action: "repo.update",
    operator: ctx.admin.username,
    source: "web",
    details: { repositoryId: id, fields: Object.keys(body) }
  });
  return jsonOk({ id });
}
async function deleteRepo(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const purge = ctx.url.searchParams.get("purge") === "1";
  const confirm = ctx.request.headers.get("x-confirm-delete");
  if (confirm !== repo.repository) {
    return jsonError(
      "bad_request",
      `\u5220\u9664\u4ED3\u5E93\u9700\u8981\u786E\u8BA4\uFF1A\u8BF7\u5728\u8BF7\u6C42\u5934 X-Confirm-Delete \u586B\u5199\u4ED3\u5E93\u540D\u300C${repo.repository}\u300D`
    );
  }
  await ctx.db.prepare("UPDATE third_party_repositories SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?").bind(iso4(), iso4(), id).run();
  await ctx.db.prepare(
    `UPDATE module_review_tasks SET review_status = 'superseded', updated_at = ?
        WHERE repository_id = ? AND review_status IN ('pending','on_hold')`
  ).bind(iso4(), id).run();
  let affected = 0;
  if (purge) {
    const res = await ctx.db.prepare(
      `UPDATE modules SET is_published = 0, updated_at = ?
          WHERE id IN (SELECT module_id FROM third_party_modules
                        WHERE repository_id = ? AND module_id IS NOT NULL)`
    ).bind(iso4(), id).run();
    affected = res.meta?.changes ?? 0;
  }
  await logAudit(ctx.db, {
    taskId: null,
    action: "repo.delete",
    operator: ctx.admin.username,
    source: "web",
    details: { repositoryId: id, purge, modulesHidden: affected }
  });
  return jsonOk({ id, purged: purge, modulesHidden: affected });
}
async function verifyRepo(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const info = await fetchRepoInfo(repo.owner, repo.repository, ctx.env.GITHUB_READ_TOKEN);
  if ("error" in info) {
    return jsonOk({
      ok: false,
      error: info.error,
      hint: "\u5982\u679C\u8FD9\u662F\u79C1\u6709\u4ED3\u5E93\uFF0C\u9700\u8981\u5728 Worker Secret \u4E2D\u914D\u7F6E\u6709\u6743\u9650\u7684 GITHUB_READ_TOKEN"
    });
  }
  const listing = await listSgmoduleFiles(
    repo.owner,
    repo.repository,
    repo.default_branch,
    ctx.env.GITHUB_READ_TOKEN
  );
  return jsonOk({
    ok: true,
    defaultBranch: info.info.defaultBranch,
    private: info.info.private,
    description: info.info.description,
    sgmoduleCount: "files" in listing ? listing.files.length : null,
    listingError: "error" in listing ? listing.error : void 0
  });
}
async function setWebhookSecret(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const key = ctx.env.WEBHOOK_SECRET_KEY;
  if (!key) {
    return jsonError(
      "bad_request",
      "\u672A\u914D\u7F6E WEBHOOK_SECRET_KEY\uFF0C\u65E0\u6CD5\u52A0\u5BC6\u4FDD\u5B58\u4ED3\u5E93 Secret\u3002\u8BF7\u5148\u8FD0\u884C wrangler secret put WEBHOOK_SECRET_KEY"
    );
  }
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const plain = str(body.secret, 200);
  if (!plain) {
    await ctx.db.prepare(
      "UPDATE third_party_repositories SET webhook_secret_enc = NULL, webhook_secret_hint = '', updated_at = ? WHERE id = ?"
    ).bind(iso4(), id).run();
    return jsonOk({ cleared: true });
  }
  if (plain.length < 16) {
    return jsonError("bad_request", "Webhook Secret \u81F3\u5C11 16 \u4F4D");
  }
  const enc = await encryptSecret(plain, key);
  const hint = `${plain.slice(0, 6)}\u2026${plain.slice(-4)}`;
  await ctx.db.prepare(
    "UPDATE third_party_repositories SET webhook_secret_enc = ?, webhook_secret_hint = ?, updated_at = ? WHERE id = ?"
  ).bind(enc, hint, iso4(), id).run();
  await logAudit(ctx.db, {
    taskId: null,
    action: "repo.webhook_secret",
    operator: ctx.admin.username,
    source: "web",
    details: { repositoryId: id, hint }
  });
  return jsonOk({ hint });
}
async function triggerCheck(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  if (repo.manual_check_enabled !== 1) {
    return jsonError("forbidden", "\u8BE5\u4ED3\u5E93\u5DF2\u5173\u95ED\u624B\u52A8\u68C0\u67E5");
  }
  const body = await readBody(ctx.request) ?? {};
  const branch = str(body.branch, 100) || repo.default_branch;
  if (!safeSegment2(branch)) return jsonError("bad_request", "\u5206\u652F\u540D\u4E0D\u5408\u6CD5");
  const filePath = str(body.filePath, 400);
  if (filePath && !filePath.toLowerCase().endsWith(".sgmodule")) {
    return jsonError("bad_request", "\u53EA\u80FD\u68C0\u67E5 .sgmodule \u6587\u4EF6");
  }
  const result = await runCheck(ctx.env, repo, {
    method: "manual",
    branch,
    filePath: filePath || void 0,
    pathPrefix: str(body.pathPrefix, 200) || void 0,
    maxFiles: num(body.maxFiles, 200, 1, 2e3),
    silent: false
  });
  await logAudit(ctx.db, {
    taskId: null,
    action: "repo.check",
    operator: ctx.admin.username,
    source: "web",
    details: {
      repositoryId: id,
      branch,
      status: result.status,
      new: result.newModules,
      updated: result.updatedModules,
      deleted: result.deletedModules
    }
  });
  if (result.status === "failed" && result.error) {
    await notifyOps(
      ctx.env,
      "\u7B2C\u4E09\u65B9\u4ED3\u5E93\u68C0\u67E5\u5931\u8D25",
      `${repo.name}\uFF08${repo.owner}/${repo.repository}\uFF09
${result.error}`
    );
  }
  return jsonOk({
    ok: result.status !== "failed",
    logId: result.logId,
    branch: result.branch,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    newModules: result.newModules,
    updatedModules: result.updatedModules,
    deletedModules: result.deletedModules,
    unchanged: result.unchanged,
    failed: result.failed,
    filesScanned: result.filesScanned,
    error: result.error,
    outcomes: result.outcomes.slice(0, 100)
  });
}
async function runCheck(env, repo, options) {
  let result;
  try {
    result = await inspectRepository(env, repo, options);
  } catch (err) {
    result = {
      logId: "",
      repositoryId: repo.id,
      branch: options.branch || repo.default_branch,
      status: "failed",
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      unchanged: 0,
      failed: 0,
      filesScanned: 0,
      error: err instanceof Error ? err.message : "\u68C0\u67E5\u5F02\u5E38",
      outcomes: [],
      startedAt: iso4(),
      finishedAt: iso4()
    };
  }
  const logId = await recordCheck(env.DB, repo, result, options.method);
  return { ...result, logId };
}
async function repoLogs(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const limit = num(ctx.url.searchParams.get("limit"), 30, 1, 100);
  const rows = await ctx.db.prepare(
    `SELECT id, detection_method, check_status, new_modules_count, updated_modules_count,
              deleted_modules_count, unchanged_modules_count, failed_count,
              files_scanned, branch, error_message, started_at, finished_at
         FROM repository_check_logs
        WHERE repository_id = ?
        ORDER BY started_at DESC LIMIT ?`
  ).bind(id, limit).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function repoModules(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const rows = await ctx.db.prepare(
    `SELECT t.id, t.module_name, t.file_path, t.branch, t.current_version,
              t.published, t.is_deleted_upstream, t.last_seen_at, t.updated_at,
              m.slug AS module_slug, m.is_published AS module_published
         FROM third_party_modules t
         LEFT JOIN modules m ON m.id = t.module_id
        WHERE t.repository_id = ?
        ORDER BY t.published DESC, t.updated_at DESC LIMIT 500`
  ).bind(id).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function getCredentials(ctx) {
  const status = async (name, fallback) => {
    const s = await credentialStatus(ctx.env, name);
    return {
      fromPanel: s.fromPanel,
      usable: s.usable,
      hint: s.hint,
      hasFallback: fallback
    };
  };
  return jsonOk({
    githubReadToken: await status("github_read_token", Boolean(ctx.env.GITHUB_READ_TOKEN)),
    telegramBotToken: await status("telegram_bot_token", Boolean(ctx.env.TELEGRAM_BOT_TOKEN)),
    // Editable and reported, but only as "configured"
    encryptionKey: {
      fromPanel: false,
      usable: Boolean(ctx.env.WEBHOOK_SECRET_KEY),
      hint: ctx.env.WEBHOOK_SECRET_KEY ? "\u7531 Worker Secret \u63D0\u4F9B" : "",
      hasFallback: Boolean(ctx.env.WEBHOOK_SECRET_KEY)
    },
    telegramAdminId: (await ctx.db.prepare("SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'").first())?.value ?? ""
  });
}
async function saveCredentials(ctx) {
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const key = (ctx.env.WEBHOOK_SECRET_KEY ?? "").trim();
  if (!key) {
    return jsonError(
      "bad_request",
      "\u672A\u914D\u7F6E WEBHOOK_SECRET_KEY\uFF0C\u65E0\u6CD5\u52A0\u5BC6\u4FDD\u5B58\u51ED\u636E\u3002\u8BF7\u5148\u8BBE\u7F6E\u8BE5 Worker Secret\u3002"
    );
  }
  const saved = [];
  const rejected = [];
  const write = async (name, value) => {
    if (value === void 0) return;
    const plain = typeof value === "string" ? value.trim() : "";
    if (plain) {
      if (name === "github_read_token" && !/^(gh[pousr]_|github_pat_)/.test(plain)) {
        rejected.push("GitHub Token \u683C\u5F0F\u4E0D\u6B63\u786E\uFF08\u5E94\u4EE5 ghp_ / github_pat_ \u5F00\u5934\uFF09");
        return;
      }
      if (name === "telegram_bot_token" && !/^\d{6,}:[\w-]{30,}$/.test(plain)) {
        rejected.push("Telegram Bot Token \u683C\u5F0F\u4E0D\u6B63\u786E\uFF08\u5E94\u4E3A \u6570\u5B57:\u5B57\u6BCD\u6570\u5B57\uFF09");
        return;
      }
    }
    await saveCredential(ctx.env, name, plain, key);
    saved.push(name);
  };
  await write("github_read_token", body.githubReadToken);
  await write("telegram_bot_token", body.telegramBotToken);
  await write("webhook_secret_key", body.webhookSecretKey);
  if (body.telegramAdminId !== void 0) {
    const id = str(body.telegramAdminId, 40);
    if (id && !/^-?\d{5,20}$/.test(id)) {
      rejected.push("Telegram \u7BA1\u7406\u5458 ID \u5FC5\u987B\u662F\u7EAF\u6570\u5B57");
    } else {
      await ctx.db.prepare(
        `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
           VALUES ('third_party.telegram_admin_id', ?, 'string', 'admin', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(id, iso4()).run();
      saved.push("telegram_admin_id");
    }
  }
  if (rejected.length > 0 && saved.length === 0) {
    return jsonError("bad_request", rejected.join("\uFF1B"));
  }
  await logAudit(ctx.db, {
    taskId: null,
    action: "thirdparty.credentials",
    operator: ctx.admin.username,
    source: "web",
    // names only — a credential must never reach the audit log
    details: { saved }
  });
  return jsonOk({ saved, rejected });
}
async function testTelegram(ctx) {
  const token = (ctx.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) return jsonError("bad_request", "\u672A\u914D\u7F6E Telegram Bot Token");
  const adminRow = await ctx.db.prepare("SELECT value FROM site_settings WHERE key = 'third_party.telegram_admin_id'").first();
  const adminId = (ctx.env.TELEGRAM_ADMIN_ID ?? "").trim() || (adminRow?.value ?? "").trim();
  if (!adminId) return jsonError("bad_request", "\u672A\u914D\u7F6E Telegram \u7BA1\u7406\u5458 ID");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: adminId,
      text: "<b>Surge Modules</b>\n\n\u8FD9\u662F\u4E00\u6761\u6D4B\u8BD5\u6D88\u606F\uFF1ABot \u4E0E\u7BA1\u7406\u5458 ID \u90FD\u5DF2\u8FDE\u901A\u3002",
      parse_mode: "HTML"
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    return jsonError("bad_request", body.description ?? "Telegram \u62D2\u7EDD\u4E86\u8FD9\u6761\u6D88\u606F");
  }
  return jsonOk({ sent: true, messageId: body.result?.message_id ?? null });
}
async function getSettings(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT key, value FROM site_settings WHERE key LIKE 'third_party.%' ORDER BY key`
  ).all();
  const map = {};
  for (const row of rows.results ?? []) map[row.key.replace("third_party.", "")] = row.value;
  const hasToken = Boolean(ctx.env.TELEGRAM_BOT_TOKEN);
  const resolvedAdmin = ctx.env.TELEGRAM_ADMIN_ID?.trim() || map.telegram_admin_id || "";
  return jsonOk({
    settings: {
      autoEnabled: map.auto_enabled !== "0",
      defaultInterval: Number.parseInt(map.default_interval ?? "6", 10) || 6,
      cronExpression: map.cron_expression ?? "0 */6 * * *",
      maxReposPerRun: Number.parseInt(map.max_repos_per_run ?? "10", 10) || 10,
      maxFilesPerRun: Number.parseInt(map.max_files_per_run ?? "80", 10) || 80,
      maxRunSeconds: Number.parseInt(map.max_run_seconds ?? "50", 10) || 50,
      maxRetries: Number.parseInt(map.max_retries ?? "2", 10) || 2,
      notifyOnCheck: map.notify_on_check !== "0",
      notifyNew: map.notify_new !== "0",
      notifyUpdate: map.notify_update !== "0",
      notifyDelete: map.notify_delete !== "0",
      notifyFailure: map.notify_failure !== "0",
      notifyReviewed: map.notify_reviewed !== "0"
    },
    telegram: {
      hasToken,
      adminIdConfigured: Boolean(resolvedAdmin),
      adminIdHint: resolvedAdmin ? `${resolvedAdmin.slice(0, 4)}\u2026` : ""
      // the token itself is never returned, in any form
    },
    github: { hasToken: Boolean(ctx.env.GITHUB_READ_TOKEN) },
    encryptionKey: { configured: Boolean(ctx.env.WEBHOOK_SECRET_KEY) }
  });
}
async function updateSettings(ctx) {
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const writable = [];
  const put = (key, value, type) => {
    if (value === void 0) return;
    let v;
    if (type === "boolean") v = bool(value) ? "1" : "0";
    else if (type === "number") v = String(num(value, 6, 1, 86400));
    else v = str(value, 200);
    writable.push([key, v]);
  };
  put("auto_enabled", body.autoEnabled, "boolean");
  put("default_interval", body.defaultInterval, "number");
  put("cron_expression", body.cronExpression, "string");
  put("max_repos_per_run", body.maxReposPerRun, "number");
  put("max_files_per_run", body.maxFilesPerRun, "number");
  put("max_run_seconds", body.maxRunSeconds, "number");
  put("max_retries", body.maxRetries, "number");
  put("notify_on_check", body.notifyOnCheck, "boolean");
  put("notify_new", body.notifyNew, "boolean");
  put("notify_update", body.notifyUpdate, "boolean");
  put("notify_delete", body.notifyDelete, "boolean");
  put("notify_failure", body.notifyFailure, "boolean");
  put("notify_reviewed", body.notifyReviewed, "boolean");
  if (body.telegramAdminId !== void 0) {
    if (ctx.admin.role !== "super") {
      return jsonError("forbidden", "\u53EA\u6709\u8D85\u7EA7\u7BA1\u7406\u5458\u53EF\u4EE5\u4FEE\u6539 Telegram \u7BA1\u7406\u5458 ID");
    }
    const id = str(body.telegramAdminId, 40);
    if (id && !/^-?\d{5,20}$/.test(id)) {
      return jsonError("bad_request", "Telegram \u7BA1\u7406\u5458 ID \u5FC5\u987B\u662F\u7EAF\u6570\u5B57\uFF08\u7528\u6237 ID\uFF0C\u4E0D\u662F\u7528\u6237\u540D\uFF09");
    }
    writable.push(["telegram_admin_id", id]);
  }
  for (const [key, value] of writable) {
    await ctx.db.prepare(
      `INSERT INTO site_settings (key, value, value_type, scope, updated_at)
         VALUES (?, ?, 'string', 'admin', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(`third_party.${key}`, value, iso4()).run();
  }
  await logAudit(ctx.db, {
    taskId: null,
    action: "thirdparty.settings",
    operator: ctx.admin.username,
    source: "web",
    details: { keys: writable.map(([k]) => k) }
  });
  return jsonOk({ updated: writable.length });
}
async function runSchedulerNow(ctx) {
  const result = await runScheduler(ctx.env, { force: true, trigger: "manual" });
  await logAudit(ctx.db, {
    taskId: null,
    action: "thirdparty.scheduler",
    operator: ctx.admin.username,
    source: "web",
    details: result
  });
  return jsonOk(result);
}
async function runScheduler(env, options) {
  const startedMs = Date.now();
  const settings = await env.DB.prepare(
    `SELECT key, value FROM site_settings WHERE key LIKE 'third_party.%'`
  ).all();
  const cfg = {};
  for (const row of settings.results ?? []) cfg[row.key.replace("third_party.", "")] = row.value;
  if (cfg.auto_enabled === "0" && !options.force) {
    return {
      ran: false,
      reason: "\u5168\u5C40\u81EA\u52A8\u68C0\u6D4B\u5DF2\u5173\u95ED",
      reposChecked: 0,
      newModules: 0,
      updatedModules: 0,
      deletedModules: 0,
      failed: 0,
      durationMs: 0
    };
  }
  const maxRepos = Number.parseInt(cfg.max_repos_per_run ?? "10", 10) || 10;
  const maxFiles = Number.parseInt(cfg.max_files_per_run ?? "80", 10) || 80;
  const maxSeconds = Number.parseInt(cfg.max_run_seconds ?? "50", 10) || 50;
  const deadline = startedMs + maxSeconds * 1e3;
  const now = iso4();
  const due = await env.DB.prepare(
    `SELECT * FROM third_party_repositories
      WHERE deleted_at IS NULL AND enabled = 1 AND cron_enabled = 1
        AND (next_check_at IS NULL OR next_check_at <= ?)
      ORDER BY COALESCE(next_check_at, '1970-01-01T00:00:00Z') ASC
      LIMIT ?`
  ).bind(now, maxRepos).all();
  const repos = due.results ?? [];
  let newModules = 0;
  let updatedModules = 0;
  let deletedModules = 0;
  let failed = 0;
  let checked = 0;
  for (const repo of repos) {
    if (Date.now() > deadline) break;
    const result = await runCheck(env, repo, {
      method: "cron",
      maxFiles,
      deadline,
      silent: false
    });
    checked += 1;
    newModules += result.newModules;
    updatedModules += result.updatedModules;
    deletedModules += result.deletedModules;
    if (result.status === "failed") {
      failed += 1;
      if (result.error) {
        await notifyOps(
          env,
          "\u5B9A\u65F6\u68C0\u6D4B\u5931\u8D25",
          `${repo.name}\uFF08${repo.owner}/${repo.repository}\uFF09
${result.error}`
        );
      }
    }
  }
  return {
    ran: true,
    reposChecked: checked,
    newModules,
    updatedModules,
    deletedModules,
    failed,
    durationMs: Date.now() - startedMs
  };
}
async function listReviews(ctx) {
  const q = ctx.url.searchParams;
  const result = await listTasks(ctx.db, {
    status: q.get("status") ?? "pending",
    type: q.get("type") ?? void 0,
    method: q.get("method") ?? void 0,
    repositoryId: q.get("repositoryId") ?? void 0,
    search: q.get("q") ?? void 0,
    from: q.get("from") ?? void 0,
    to: q.get("to") ?? void 0,
    page: num(q.get("page"), 1, 1, 1e4),
    perPage: num(q.get("perPage"), 20, 1, 100),
    sort: q.get("sort") === "oldest" ? "oldest" : "newest"
  });
  const stats = await reviewStats(ctx.db);
  return jsonOk({
    items: result.items.map((t) => ({
      id: t.id,
      taskType: t.task_type,
      detectionMethod: t.detection_method,
      reviewStatus: t.review_status,
      filePath: t.file_path,
      branch: t.branch,
      oldVersion: t.old_version,
      newVersion: t.new_version,
      commitSha: t.commit_sha,
      contentSha: t.content_sha,
      repositoryId: t.repository_id,
      repositoryName: t.repository_name,
      owner: t.owner,
      repository: t.repository,
      moduleId: t.module_id,
      moduleName: t.module_name,
      moduleSlug: t.module_slug,
      liveVersion: t.module_live_version,
      rejectionReason: t.rejection_reason,
      reviewer: t.reviewer,
      reviewedAt: t.reviewed_at,
      createdAt: t.created_at,
      notifyStatus: t.notify_status
    })),
    total: result.total,
    page: result.page,
    perPage: result.perPage,
    stats
  });
}
async function getReview(ctx, id) {
  const task = await getTask(ctx.db, id);
  if (!task) return jsonError("not_found", "\u5BA1\u6838\u4EFB\u52A1\u4E0D\u5B58\u5728");
  const audits = await ctx.db.prepare(
    `SELECT action, operator, source, details, created_at
         FROM module_audit_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 30`
  ).bind(id).all();
  return jsonOk({
    task: {
      id: task.id,
      taskType: task.task_type,
      detectionMethod: task.detection_method,
      reviewStatus: task.review_status,
      filePath: task.file_path,
      branch: task.branch,
      oldVersion: task.old_version,
      newVersion: task.new_version,
      oldContent: task.old_content,
      newContent: task.new_content,
      contentSha: task.content_sha,
      commitSha: task.commit_sha,
      repositoryId: task.repository_id,
      repositoryName: task.repository_name,
      owner: task.owner,
      repository: task.repository,
      moduleId: task.module_id,
      moduleName: task.module_name,
      moduleSlug: task.module_slug,
      liveVersion: task.module_live_version,
      liveSha: task.module_live_sha,
      rejectionReason: task.rejection_reason,
      reviewer: task.reviewer,
      reviewedAt: task.reviewed_at,
      note: task.note,
      notifyStatus: task.notify_status,
      notifyError: task.notify_error,
      createdAt: task.created_at,
      supersededBy: task.superseded_by,
      overrides: {
        name: task.override_name,
        description: task.override_description,
        categoryId: task.override_category_id,
        icon: task.override_icon,
        featured: task.override_featured === null ? null : task.override_featured === 1
      }
    },
    audits: audits.results ?? []
  });
}
async function decideReview(ctx, id) {
  const body = await readBody(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const decision = str(body.decision, 20);
  if (!["approve", "reject", "hold"].includes(decision)) {
    return jsonError("bad_request", "\u672A\u77E5\u64CD\u4F5C");
  }
  const overridesRaw = typeof body.overrides === "object" && body.overrides !== null ? body.overrides : {};
  const input = {
    taskId: id,
    decision,
    operator: ctx.admin.username,
    source: "web",
    reason: str(body.reason, 1e3),
    note: str(body.note, 1e3),
    overrides: {
      name: str(overridesRaw.name, 120) || void 0,
      description: str(overridesRaw.description, 500) || void 0,
      categoryId: str(overridesRaw.categoryId, 60) || void 0,
      icon: str(overridesRaw.icon, 200) || void 0,
      featured: overridesRaw.featured === void 0 ? void 0 : bool(overridesRaw.featured) === 1
    }
  };
  const result = await decideTask(ctx.env, input);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : result.code === "invalid" ? 400 : 500;
    return jsonError(result.code, result.message, { status });
  }
  return jsonOk({
    id,
    status: result.status,
    published: result.published ?? false,
    moduleId: result.moduleId,
    slug: result.slug
  });
}
async function resendNotification(ctx, id) {
  const task = await getTask(ctx.db, id);
  if (!task) return jsonError("not_found", "\u5BA1\u6838\u4EFB\u52A1\u4E0D\u5B58\u5728");
  await ctx.db.prepare("UPDATE module_review_tasks SET notify_status = 'pending' WHERE id = ?").bind(id).run();
  const { notifyReviewTask: notifyReviewTask2 } = await Promise.resolve().then(() => (init_telegram(), telegram_exports));
  const res = await notifyReviewTask2(
    ctx.env,
    id,
    task.task_type === "delete" ? "delete" : task.task_type === "update" ? "update" : "new"
  );
  return jsonOk({ sent: res.sent, error: res.error });
}
async function handleRepoWebhook(request, env, repositoryId, ctx) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const repo = await getRepository(env.DB, repositoryId);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  if (repo.enabled !== 1 || repo.webhook_enabled !== 1) {
    return jsonError("forbidden", "\u8BE5\u4ED3\u5E93\u7684 Webhook \u68C0\u6D4B\u5DF2\u5173\u95ED");
  }
  let rawText;
  try {
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (declared > 2 * 1024 * 1024) return jsonError("payload_too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
    rawText = await request.text();
  } catch {
    return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u8BFB\u53D6\u5931\u8D25");
  }
  if (rawText.length > 2 * 1024 * 1024) return jsonError("payload_too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(rawText);
  } catch {
    const form = new URLSearchParams(rawText).get("payload");
    try {
      parsedPayload = form ? JSON.parse(form) : null;
    } catch {
      parsedPayload = null;
    }
  }
  if (parsedPayload === null || typeof parsedPayload !== "object") {
    return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  const raw = { data: parsedPayload };
  const eventId = (request.headers.get("x-github-delivery") ?? "").slice(0, 100);
  const eventType = (request.headers.get("x-github-event") ?? "").slice(0, 40);
  const signature = request.headers.get("x-hub-signature-256");
  if (!eventId) return jsonError("bad_request", "\u7F3A\u5C11 X-GitHub-Delivery");
  if (!eventType || !["push", "ping"].includes(eventType)) {
    return jsonOk({ ok: true, ignored: `\u672A\u76D1\u542C\u7684\u4E8B\u4EF6\uFF1A${eventType || "unknown"}` }, { status: 202 });
  }
  const existing = await env.DB.prepare(
    "SELECT processing_status FROM github_webhook_events WHERE event_id = ?"
  ).bind(eventId).first();
  if (existing) {
    return jsonOk({ ok: true, duplicate: true, status: existing.processing_status }, { status: 202 });
  }
  const insertEvent = async (sha, summary2, status, error = "") => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO github_webhook_events
        (id, repository_id, event_id, event_type, commit_sha, payload_summary,
         processing_status, error_message, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      repo.id,
      eventId,
      eventType,
      sha.slice(0, 40),
      summary2.slice(0, 500),
      status,
      error.slice(0, 500),
      status === "received" ? null : iso4()
    ).run();
  };
  if (repo.webhook_secret_enc) {
    const key = env.WEBHOOK_SECRET_KEY;
    if (!key) {
      await insertEvent("", "missing WEBHOOK_SECRET_KEY", "failed", "\u670D\u52A1\u7AEF\u672A\u914D\u7F6E\u52A0\u5BC6\u5BC6\u94A5");
      return jsonError("internal_error", "\u670D\u52A1\u7AEF\u672A\u914D\u7F6E Webhook \u52A0\u5BC6\u5BC6\u94A5");
    }
    const secret = await decryptSecret(repo.webhook_secret_enc, key);
    if (!secret) {
      await insertEvent("", "secret decrypt failed", "failed", "\u65E0\u6CD5\u89E3\u5BC6\u4ED3\u5E93 Secret");
      return jsonError("internal_error", "\u65E0\u6CD5\u89E3\u5BC6\u4ED3\u5E93 Secret");
    }
    const valid = await verifyGithubSignature(rawText, signature, secret);
    if (!valid) {
      await insertEvent("", "signature mismatch", "failed", "\u7B7E\u540D\u9A8C\u8BC1\u5931\u8D25");
      return jsonError("unauthorized", "Webhook \u7B7E\u540D\u9A8C\u8BC1\u5931\u8D25");
    }
  } else if (env.ENVIRONMENT === "production") {
    await insertEvent("", "no secret configured", "failed", "\u4ED3\u5E93\u672A\u914D\u7F6E Webhook Secret");
    return jsonError("unauthorized", "\u8BE5\u4ED3\u5E93\u672A\u914D\u7F6E Webhook Secret\uFF0C\u51FA\u4E8E\u5B89\u5168\u8003\u8651\u62D2\u7EDD\u5904\u7406");
  }
  const payload = raw.data;
  if (eventType === "ping") {
    await insertEvent("", "ping", "ignored");
    return jsonOk({ ok: true, pong: true }, { status: 202 });
  }
  const branch = (payload.ref ?? "").replace("refs/heads/", "") || repo.default_branch;
  const commitSha = payload.head_commit?.id ?? payload.after ?? "";
  if (!bucketSegments(branch)) {
    await insertEvent(commitSha, `invalid branch ${branch}`, "failed", "\u5206\u652F\u540D\u4E0D\u5408\u6CD5");
    return jsonError("bad_request", "\u5206\u652F\u540D\u4E0D\u5408\u6CD5");
  }
  if (branch !== repo.default_branch) {
    await insertEvent(commitSha, `branch ${branch} ignored`, "ignored");
    return jsonOk({ ok: true, ignored: `\u53EA\u8DDF\u8E2A\u5206\u652F ${repo.default_branch}` }, { status: 202 });
  }
  const { changesFromPush: changesFromPush2 } = await Promise.resolve().then(() => (init_third_party(), third_party_exports));
  const changes = changesFromPush2(payload);
  if (changes.length === 0) {
    await insertEvent(commitSha, "no sgmodule changes", "ignored");
    return jsonOk({ ok: true, changes: 0 }, { status: 202 });
  }
  const summary = changes.slice(0, 20).map((c) => `${c.status}:${c.path}`).join(", ");
  await insertEvent(commitSha, summary, "received");
  const work = (async () => {
    try {
      const result = await runCheck(env, repo, {
        method: "webhook",
        branch,
        commitSha,
        changes,
        silent: false
      });
      const ok = result.status !== "failed";
      await env.DB.prepare(
        `UPDATE github_webhook_events
            SET processing_status = ?, processed_at = ?, error_message = ?
          WHERE event_id = ?`
      ).bind(
        ok ? "processed" : "failed",
        iso4(),
        ok ? "" : (result.error || result.outcomes.find((o) => o.reason)?.reason || "\u5904\u7406\u5931\u8D25").slice(0, 500),
        eventId
      ).run();
      if (result.status === "failed" && result.error) {
        await notifyOps(env, "Webhook \u5904\u7406\u5931\u8D25", `${repo.name}
${result.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[webhook] processing failed", message);
      await env.DB.prepare(
        `UPDATE github_webhook_events SET processing_status = 'failed',
                processed_at = ?, error_message = ? WHERE event_id = ?`
      ).bind(iso4(), message.slice(0, 500), eventId).run();
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return jsonOk(
    { ok: true, queued: true, changes: changes.length, branch, commit: commitSha.slice(0, 10) },
    { status: 202 }
  );
}
function bucketSegments(value) {
  return /^[\w.\-/]{1,200}$/.test(value) && !value.includes("..");
}
async function previewPush(ctx, id) {
  const repo = await getRepository(ctx.db, id);
  if (!repo) return jsonError("not_found", "\u4ED3\u5E93\u4E0D\u5B58\u5728");
  const listing = await listSgmoduleFiles(
    repo.owner,
    repo.repository,
    repo.default_branch,
    ctx.env.GITHUB_READ_TOKEN
  );
  if ("error" in listing) return jsonError("bad_request", listing.error);
  const head = await ghRequest(
    `/repos/${repo.owner}/${repo.repository}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
    { token: ctx.env.GITHUB_READ_TOKEN }
  );
  const headSha = head.ok && head.json ? head.json.object?.sha ?? "" : "";
  return jsonOk({
    files: listing.files.slice(0, 200),
    truncated: listing.truncated,
    branch: repo.default_branch,
    headSha
  });
}

// workers/site/auth.ts
var PBKDF2_ITERATIONS = 1e5;
var SALT_BYTES = 16;
var KEY_BITS = 256;
var SESSION_COOKIE = "sm_admin";
var SESSION_TTL_SECONDS = 12 * 60 * 60;
function b642(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += String.fromCharCode(b);
  return btoa(out);
}
function unb642(value) {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b642(salt)}$${b642(hash)}`;
}
async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1e4) return false;
  const salt = unb642(parts[2]);
  const expected = unb642(parts[3]);
  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(expected, actual);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b642(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return b642(digest);
}
function cookieFor(token, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}
async function resolveSession(db, token) {
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db.prepare(
    `SELECT a.id, a.username, a.display_name, a.role, a.is_active,
              s.expires_at, s.revoked_at
         FROM admin_sessions s
         JOIN admins a ON a.id = s.admin_id
        WHERE s.token_hash = ?
        LIMIT 1`
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.is_active !== 1) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return {
    admin: {
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username,
      role: row.role === "super" ? "super" : "editor"
    },
    sessionExpiresAt: row.expires_at
  };
}
function can(role, action) {
  return PERMISSIONS[action].includes(role);
}
var PERMISSIONS = {
  "module:write": ["super", "editor"],
  "module:delete": ["super"],
  "category:write": ["super", "editor"],
  "source:write": ["super"],
  "proxy:write": ["super"],
  "review:decide": ["super", "editor"],
  "announcement:write": ["super", "editor"],
  "settings:write": ["super"],
  "admin:manage": ["super"],
  "sync:run": ["super"],
  "content:delete": ["super"],
  // An editor may approve/reject what the detectors found (review:decide) but
  // may not add, reconfigure or delete a repository — that is a super action.
  "thirdparty:write": ["super"],
  "thirdparty:check": ["super", "editor"]
};

// workers/site/admin.ts
var MAX_BODY2 = 64 * 1024;
async function readJson2(request) {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_BODY2) return null;
  const text = await request.text();
  if (text.length > MAX_BODY2) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
async function audit(db, admin, action, target, detail) {
  await db.prepare(
    `INSERT INTO audit_logs (actor, action, target, detail)
       VALUES (?, ?, ?, ?)`
  ).bind(
    admin.username,
    action,
    target,
    typeof detail === "string" ? detail : JSON.stringify(detail ?? {}).slice(0, 2e3)
  ).run();
}
async function requireAdmin(request, env) {
  const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const session = await resolveSession(env.DB, token);
  if (!session) {
    return { ok: false, response: jsonError("unauthorized", "\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F") };
  }
  return { ok: true, admin: session.admin };
}
function forbid(admin, action) {
  if (can(admin.role, action)) return null;
  return jsonError("forbidden", `\u5F53\u524D\u89D2\u8272\u65E0\u6743\u6267\u884C\u6B64\u64CD\u4F5C\uFF08${action}\uFF09`);
}
async function bootstrapState(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM admins").first();
  if ((row?.n ?? 0) > 0) {
    return { allowed: false, reason: "\u7BA1\u7406\u5458\u5DF2\u5B58\u5728\uFF0C\u65E0\u6CD5\u518D\u521D\u59CB\u5316" };
  }
  return { allowed: true, reason: "" };
}
async function login(request, env) {
  const body = await readJson2(request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const username = String(body.username ?? "").trim().slice(0, 64);
  const password = String(body.password ?? "");
  if (!username || !password) return jsonError("bad_request", "\u8BF7\u8F93\u5165\u7528\u6237\u540D\u548C\u5BC6\u7801");
  const row = await env.DB.prepare(
    `SELECT id, username, display_name, role, password_hash, is_active,
            failed_attempts, locked_until
       FROM admins WHERE username = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(username).first();
  const invalid = () => jsonError("unauthorized", "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF");
  if (!row) return invalid();
  if (row.is_active !== 1) return invalid();
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return jsonError("too_many_requests", "\u8D26\u53F7\u5DF2\u4E34\u65F6\u9501\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
  }
  const okPassword = await verifyPassword(password, row.password_hash);
  if (!okPassword) {
    const attempts = row.failed_attempts + 1;
    const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1e3).toISOString().replace(/\.\d+Z$/, "Z") : null;
    await env.DB.prepare(
      `UPDATE admins SET failed_attempts = ?, locked_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
    ).bind(attempts, lockUntil, row.id).run();
    return invalid();
  }
  await env.DB.prepare(
    `UPDATE admins SET failed_attempts = 0, locked_until = NULL,
            last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`
  ).bind(row.id).run();
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1e3).toISOString().replace(/\.\d+Z$/, "Z");
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, user_agent, client_hint)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    tokenHash,
    row.id,
    expiresAt,
    (request.headers.get("user-agent") ?? "").slice(0, 200),
    // country/region hint only; the full address is never stored
    request.headers.get("cf-ipcountry") ?? null
  ).run();
  const secure = new URL(request.url).protocol === "https:";
  return jsonOk(
    {
      admin: {
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        role: row.role
      },
      expiresAt
    },
    { headers: { "set-cookie": cookieFor(token, secure) } }
  );
}
async function logout(ctx) {
  const token = parseCookie(ctx.request.headers.get("cookie"), SESSION_COOKIE);
  if (token) {
    const tokenHash = await hashToken(token);
    await ctx.db.prepare(
      `UPDATE admin_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE token_hash = ?`
    ).bind(tokenHash).run();
  }
  return jsonOk({ ok: true }, { headers: { "set-cookie": clearedCookie() } });
}
async function bootstrap(request, env) {
  const state = await bootstrapState(env.DB);
  if (!state.allowed) {
    return jsonError("forbidden", state.reason);
  }
  const body = await readJson2(request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return jsonError("bad_request", "\u7528\u6237\u540D\u9700\u4E3A 3\u201332 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u6216\u70B9");
  }
  if (password.length < 12) {
    return jsonError("bad_request", "\u5BC6\u7801\u81F3\u5C11 12 \u4F4D");
  }
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO admins (id, username, display_name, role, password_hash)
     VALUES (?, ?, ?, 'super', ?)`
  ).bind(id, username, username, hash).run();
  await env.DB.prepare(
    `INSERT INTO audit_logs (actor, action, target, detail) VALUES (?, 'admin.bootstrap', ?, '{}')`
  ).bind(username, id).run();
  return jsonOk({ id, username, role: "super" });
}
async function dashboard(ctx) {
  const { db } = ctx;
  const counts = await db.prepare(
    `SELECT
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL) AS total,
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 1) AS published,
         (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 0) AS hidden,
         (SELECT COUNT(*) FROM review_items WHERE status = 'pending') AS pending,
         (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL) AS sources,
         (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL AND is_enabled = 1) AS sources_on,
         (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL) AS mappings,
         (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL AND is_enabled = 1) AS mappings_on`
  ).first();
  const lastSync = await db.prepare(
    `SELECT id, status, trigger, started_at, finished_at,
              scanned, added, updated, skipped, failed, error
         FROM sync_jobs ORDER BY created_at DESC LIMIT 5`
  ).all();
  const failures = await db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs WHERE status = 'failed'`).first();
  const analytics = await db.prepare(
    `SELECT event, COUNT(*) AS n FROM analytics_events
        WHERE day >= date('now', '-7 day') GROUP BY event ORDER BY n DESC`
  ).all();
  const proxy = await db.prepare(
    `SELECT SUM(hits) AS hits, SUM(misses) AS misses, SUM(errors) AS errors
         FROM proxy_stats WHERE day >= date('now', '-7 day')`
  ).first();
  return jsonOk({
    counts: counts ?? {},
    syncFailures: failures?.n ?? 0,
    recentSyncs: lastSync.results ?? [],
    analytics: analytics.results ?? [],
    proxy: {
      hits: proxy?.hits ?? 0,
      misses: proxy?.misses ?? 0,
      errors: proxy?.errors ?? 0
    }
  });
}
async function listModules2(ctx, url) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const status = url.searchParams.get("status") ?? "";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get("perPage") ?? "25", 10) || 25)
  );
  const where = ["m.deleted_at IS NULL"];
  const binds = [];
  if (q) {
    where.push("(m.name LIKE ? OR m.slug LIKE ? OR m.author LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (status === "published") where.push("m.is_published = 1");
  else if (status === "hidden") where.push("m.is_published = 0");
  else if (status === "featured") where.push("m.is_featured = 1");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM modules m ${whereSql}`).bind(...binds).first();
  const rows = await ctx.db.prepare(
    `SELECT m.id, m.slug, m.name, m.author, m.version, m.is_published,
              m.is_featured, m.review_status, m.updated_at, m.source_id,
              c.name AS category_name,
              (SELECT COUNT(*) FROM module_overrides o WHERE o.module_id = m.id) AS overrides,
              (SELECT COUNT(*) FROM module_proxy_mappings p
                WHERE p.module_id = m.id AND p.deleted_at IS NULL) AS mappings
         FROM modules m
         LEFT JOIN categories c ON c.id = m.category_id
        ${whereSql}
        ORDER BY m.updated_at DESC
        LIMIT ? OFFSET ?`
  ).bind(...binds, perPage, (page - 1) * perPage).all();
  return jsonOk(
    { items: rows.results ?? [] },
    { meta: { page, perPage, total: total?.n ?? 0, totalPages: Math.ceil((total?.n ?? 0) / perPage) } }
  );
}
async function getModule(ctx, id) {
  const row = await ctx.db.prepare(
    `SELECT m.*, c.name AS category_name, c.slug AS category_slug
         FROM modules m LEFT JOIN categories c ON c.id = m.category_id
        WHERE m.id = ? AND m.deleted_at IS NULL`
  ).bind(id).first();
  if (!row) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
  const tags = await ctx.db.prepare("SELECT tag FROM module_tags WHERE module_id = ?").bind(id).all();
  const overrides = await ctx.db.prepare("SELECT field, value, updated_at FROM module_overrides WHERE module_id = ?").bind(id).all();
  const versions = await ctx.db.prepare(
    `SELECT version, changelog, content_hash, released_at
         FROM module_versions WHERE module_id = ? ORDER BY released_at DESC LIMIT 20`
  ).bind(id).all();
  const mapping = await ctx.db.prepare(
    `SELECT id, public_slug, file_path, is_enabled, content_hash, ttl_seconds,
              last_fetched_at, last_status, last_error, source_id
         FROM module_proxy_mappings
        WHERE module_id = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(id).first();
  return jsonOk({
    module: row,
    tags: (tags.results ?? []).map((t) => t.tag),
    overrides: overrides.results ?? [],
    versions: versions.results ?? [],
    mapping: mapping ?? null
  });
}
async function updateModule(ctx, id) {
  const body = await readJson2(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const existing = await ctx.db.prepare("SELECT id FROM modules WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!existing) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
  const overridable = [
    "name",
    "description",
    "author",
    "category_id",
    "version",
    "is_featured",
    "is_published",
    "sort_weight"
  ];
  const applied = [];
  for (const field of overridable) {
    if (!(field in body)) continue;
    const raw = body[field];
    const value = field === "is_featured" || field === "is_published" || field === "sort_weight" ? String(typeof raw === "boolean" ? raw ? 1 : 0 : Number(raw) || 0) : String(raw ?? "");
    await ctx.db.prepare(
      `INSERT INTO module_overrides (module_id, field, value, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(module_id, field) DO UPDATE SET
           value = excluded.value, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
    ).bind(id, field, value, ctx.admin.username).run();
    if (field === "sort_weight") {
      await ctx.db.prepare("UPDATE modules SET sort_weight = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").bind(Number(value) || 0, id).run();
    } else if (field === "is_featured" || field === "is_published") {
      await ctx.db.prepare(`UPDATE modules SET ${field} = ? WHERE id = ?`).bind(Number(value) ? 1 : 0, id).run();
    } else {
      await ctx.db.prepare(`UPDATE modules SET ${field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(value, id).run();
    }
    applied.push(field);
  }
  if (Array.isArray(body.tags)) {
    const tags = body.tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 12);
    await ctx.db.prepare("DELETE FROM module_tags WHERE module_id = ?").bind(id).run();
    for (const tag of tags) {
      await ctx.db.prepare("INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)").bind(id, tag).run();
    }
    applied.push("tags");
  }
  await audit(ctx.db, ctx.admin, "module.update", id, { fields: applied });
  return jsonOk({ id, applied });
}
async function setModuleVisibility(ctx, id, action) {
  const map = {
    publish: { sql: "is_published = 1", audit: "module.publish" },
    hide: { sql: "is_published = 0", audit: "module.hide" },
    feature: { sql: "is_featured = 1", audit: "module.feature" },
    unfeature: { sql: "is_featured = 0", audit: "module.unfeature" }
  };
  const op = map[action];
  if (!op) return jsonError("bad_request", "\u672A\u77E5\u64CD\u4F5C");
  await ctx.db.prepare(`UPDATE modules SET ${op.sql}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run();
  if (action === "hide") {
    await ctx.db.prepare("UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?").bind(id).run();
  }
  await audit(ctx.db, ctx.admin, op.audit, id, {});
  return jsonOk({ id, action });
}
async function softDeleteModule(ctx, id) {
  const row = await ctx.db.prepare("SELECT slug, source_id, source_path FROM modules WHERE id = ?").bind(id).first();
  if (!row) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728");
  await ctx.db.prepare(
    `UPDATE modules SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_published = 0
        WHERE id = ?`
  ).bind(id).run();
  await ctx.db.prepare("UPDATE module_proxy_mappings SET is_enabled = 0, deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE module_id = ?").bind(id).run();
  if (row.source_id && row.source_path) {
    await ctx.db.prepare(
      `INSERT INTO module_tombstones (id, source_id, source_path, reason)
         VALUES (?, ?, ?, 'removed')
         ON CONFLICT(source_id, source_path) DO NOTHING`
    ).bind(crypto.randomUUID(), row.source_id, row.source_path).run();
  }
  await audit(ctx.db, ctx.admin, "module.delete", id, { slug: row.slug });
  return jsonOk({ id, deleted: true });
}
async function listMappings(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT p.id, p.public_slug, p.file_path, p.is_enabled, p.content_hash,
              p.ttl_seconds, p.last_fetched_at, p.last_status, p.last_error,
              p.source_id, s.owner, s.repo, s.branch, s.is_enabled AS source_enabled,
              m.name AS module_name, m.is_published,
              (SELECT SUM(hits) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS hits,
              (SELECT SUM(misses) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS misses,
              (SELECT SUM(errors) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS errors
         FROM module_proxy_mappings p
         JOIN sources s ON s.id = p.source_id
         LEFT JOIN modules m ON m.id = p.module_id
        WHERE p.deleted_at IS NULL
        ORDER BY p.public_slug`
  ).all();
  const base = await ctx.db.prepare("SELECT value FROM site_settings WHERE key = 'proxy.public_base'").first();
  return jsonOk({
    items: rows.results ?? [],
    publicBase: base?.value ?? ""
  });
}
async function updateMapping(ctx, id) {
  const body = await readJson2(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const row = await ctx.db.prepare("SELECT id, public_slug FROM module_proxy_mappings WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!row) return jsonError("not_found", "\u6620\u5C04\u4E0D\u5B58\u5728");
  const sets = [];
  const binds = [];
  if ("is_enabled" in body) {
    sets.push("is_enabled = ?");
    binds.push(body.is_enabled ? 1 : 0);
  }
  if ("ttl_seconds" in body) {
    const ttl = Math.min(86400, Math.max(30, Number(body.ttl_seconds) || 300));
    sets.push("ttl_seconds = ?");
    binds.push(ttl);
  }
  if (typeof body.file_path === "string") {
    const path = body.file_path.trim();
    if (!/^[\w./@+-]+$/.test(path) || path.includes("..") || path.startsWith("/")) {
      return jsonError("bad_request", "\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5408\u6CD5");
    }
    sets.push("file_path = ?");
    binds.push(path);
  }
  if (sets.length === 0) return jsonError("bad_request", "\u6CA1\u6709\u53EF\u66F4\u65B0\u7684\u5B57\u6BB5");
  await ctx.db.prepare(
    `UPDATE module_proxy_mappings SET ${sets.join(", ")},
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
  ).bind(...binds, id).run();
  if ("is_enabled" in body && !body.is_enabled) {
    await ctx.db.prepare(
      `UPDATE modules SET is_published = 0
          WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)`
    ).bind(id).run();
  }
  await audit(ctx.db, ctx.admin, "proxy.update", row.public_slug, body);
  return jsonOk({ id: row.public_slug });
}
async function deleteMapping(ctx, id) {
  const row = await ctx.db.prepare("SELECT public_slug FROM module_proxy_mappings WHERE id = ?").bind(id).first();
  if (!row) return jsonError("not_found", "\u6620\u5C04\u4E0D\u5B58\u5728");
  await ctx.db.prepare(
    `UPDATE module_proxy_mappings
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), is_enabled = 0
        WHERE id = ?`
  ).bind(id).run();
  await ctx.db.prepare("UPDATE modules SET is_published = 0 WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)").bind(id).run();
  await audit(ctx.db, ctx.admin, "proxy.delete", row.public_slug, {});
  return jsonOk({ deleted: row.public_slug });
}
async function refreshMapping(ctx, id) {
  const row = await ctx.db.prepare("SELECT public_slug FROM module_proxy_mappings WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!row) return jsonError("not_found", "\u6620\u5C04\u4E0D\u5B58\u5728");
  const revision = crypto.randomUUID().slice(0, 12);
  await ctx.db.prepare(
    `UPDATE module_proxy_mappings
          SET content_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
  ).bind(revision, id).run();
  await audit(ctx.db, ctx.admin, "proxy.refresh", row.public_slug, { revision });
  return jsonOk({ slug: row.public_slug, revision });
}
async function listSources(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT s.id, s.owner, s.repo, s.branch, s.allow_paths, s.sync_mode,
              s.is_enabled, s.notes, s.last_synced_at, s.last_status,
              s.sync_lock IS NOT NULL AS locked,
              (SELECT COUNT(*) FROM modules m WHERE m.source_id = s.id AND m.deleted_at IS NULL) AS modules,
              (SELECT COUNT(*) FROM sync_jobs j WHERE j.source_id = s.id AND j.status = 'failed') AS failures
         FROM sources s WHERE s.deleted_at IS NULL ORDER BY s.owner, s.repo`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function upsertSource(ctx, id) {
  const body = await readJson2(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const owner = String(body.owner ?? "").trim();
  const repo = String(body.repo ?? "").trim();
  const branch = String(body.branch ?? "main").trim() || "main";
  const allowPaths = String(body.allow_paths ?? "").trim();
  for (const [label, value] of [
    ["owner", owner],
    ["repo", repo],
    ["branch", branch]
  ]) {
    if (!/^[\w.-]{1,100}$/.test(value) || value === "." || value === "..") {
      return jsonError("bad_request", `${label} \u4E0D\u5408\u6CD5`);
    }
  }
  if (allowPaths) {
    for (const p of allowPaths.split(",")) {
      const clean = p.trim();
      if (!clean) continue;
      if (clean.startsWith("/") || clean.includes("..")) {
        return jsonError("bad_request", "allow_paths \u4E0D\u80FD\u662F\u7EDD\u5BF9\u8DEF\u5F84\u6216\u5305\u542B ..");
      }
    }
  }
  const enabled = body.is_enabled ? 1 : 0;
  const syncMode = ["manual", "cron", "webhook"].includes(String(body.sync_mode)) ? String(body.sync_mode) : "manual";
  if (id) {
    await ctx.db.prepare(
      `UPDATE sources SET owner = ?, repo = ?, branch = ?, allow_paths = ?,
                sync_mode = ?, is_enabled = ?, notes = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`
    ).bind(owner, repo, branch, allowPaths, syncMode, enabled, String(body.notes ?? "").slice(0, 300), id).run();
    await audit(ctx.db, ctx.admin, "source.update", id, { owner, repo, branch, enabled });
    return jsonOk({ id });
  }
  const newId = `src-${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await ctx.db.prepare(
    `INSERT INTO sources (id, owner, repo, branch, allow_paths, sync_mode, is_enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner, repo = excluded.repo, branch = excluded.branch,
         allow_paths = excluded.allow_paths, sync_mode = excluded.sync_mode,
         is_enabled = excluded.is_enabled, notes = excluded.notes,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).bind(newId, owner, repo, branch, allowPaths, syncMode, enabled, String(body.notes ?? "").slice(0, 300)).run();
  await audit(ctx.db, ctx.admin, "source.create", newId, { owner, repo });
  return jsonOk({ id: newId });
}
async function verifySource(ctx, id) {
  const source = await ctx.db.prepare("SELECT owner, repo, branch FROM sources WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!source) return jsonError("not_found", "\u6570\u636E\u6E90\u4E0D\u5B58\u5728");
  const token = ctx.env.GITHUB_READ_TOKEN;
  if (!token) return jsonOk({ ok: false, reason: "\u672A\u914D\u7F6E GITHUB_READ_TOKEN" });
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/branches/${encodeURIComponent(source.branch)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "surge-modules-verify"
      }
    }
  );
  const result = res.status === 200 ? { ok: true, reason: "\u4ED3\u5E93\u4E0E\u5206\u652F\u53EF\u8BBF\u95EE" } : res.status === 404 ? { ok: false, reason: "\u4ED3\u5E93/\u5206\u652F\u4E0D\u5B58\u5728\uFF0C\u6216\u51ED\u636E\u65E0\u6743\u8BBF\u95EE" } : res.status === 401 ? { ok: false, reason: "\u51ED\u636E\u65E0\u6548" } : res.status === 403 || res.status === 429 ? { ok: false, reason: "GitHub \u9650\u6D41\u6216\u6743\u9650\u4E0D\u8DB3" } : { ok: false, reason: `GitHub \u8FD4\u56DE ${res.status}` };
  await ctx.db.prepare(`UPDATE sources SET last_status = ? WHERE id = ?`).bind(result.ok ? "verified" : "error", id).run();
  await audit(ctx.db, ctx.admin, "source.verify", id, { ok: result.ok });
  return jsonOk(result);
}
async function runSync(ctx, sourceId) {
  const env = { DB: ctx.db, GITHUB_READ_TOKEN: ctx.env.GITHUB_READ_TOKEN };
  const denied = forbid(ctx.admin, "sync:run");
  if (denied) return denied;
  const ids = sourceId === "all" ? (await ctx.db.prepare("SELECT id FROM sources WHERE deleted_at IS NULL AND is_enabled = 1").all()).results?.map((r) => r.id) ?? [] : [sourceId];
  if (ids.length === 0) return jsonOk({ results: [], message: "\u6CA1\u6709\u542F\u7528\u7684\u6570\u636E\u6E90" });
  const results = [];
  for (const id of ids) {
    results.push({ sourceId: id, ...await syncSource(env, id, "manual") });
  }
  await audit(ctx.db, ctx.admin, "sync.run", sourceId, { sources: ids.length });
  return jsonOk({ results });
}
async function listSyncJobs(ctx, url) {
  const sourceId = url.searchParams.get("source");
  const rows = sourceId ? await ctx.db.prepare(
    `SELECT id, source_id, trigger, status, started_at, finished_at,
                  scanned, added, updated, skipped, failed, error
             FROM sync_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(sourceId).all() : await ctx.db.prepare(
    `SELECT id, source_id, trigger, status, started_at, finished_at,
                  scanned, added, updated, failed, error
             FROM sync_jobs ORDER BY created_at DESC LIMIT 50`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function syncJobLogs(ctx, jobId) {
  const rows = await ctx.db.prepare(
    `SELECT level, path, message, created_at FROM sync_logs
        WHERE job_id = ? ORDER BY id LIMIT 500`
  ).bind(jobId).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function listReview(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT r.id, r.kind, r.status, r.source_path, r.proposed, r.baseline,
              r.note, r.created_at, m.name AS module_name, m.slug,
              s.owner || '/' || s.repo AS source_repo
         FROM review_items r
         LEFT JOIN modules m ON m.id = r.module_id
         LEFT JOIN sources s ON s.id = r.source_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC LIMIT 100`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function decideReview2(ctx, id, decision) {
  if (decision !== "approve" && decision !== "reject") {
    return jsonError("bad_request", "\u672A\u77E5\u51B3\u5B9A");
  }
  const item = await ctx.db.prepare(
    `SELECT id, module_id, kind, proposed FROM review_items
        WHERE id = ? AND status = 'pending'`
  ).bind(id).first();
  if (!item) return jsonError("not_found", "\u5BA1\u6838\u9879\u4E0D\u5B58\u5728\u6216\u5DF2\u5904\u7406");
  const status = decision === "approve" ? "approved" : "rejected";
  await ctx.db.prepare(
    `UPDATE review_items SET status = ?, reviewed_by = ?,
              reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`
  ).bind(status, ctx.admin.id, id).run();
  if (item.module_id) {
    if (decision === "approve") {
      await ctx.db.prepare(
        `UPDATE modules SET review_status = 'approved', is_published = 1,
                  published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE id = ?`
      ).bind(item.module_id).run();
      await ctx.db.prepare("UPDATE module_proxy_mappings SET is_enabled = 1 WHERE module_id = ? AND deleted_at IS NULL").bind(item.module_id).run();
    } else {
      await ctx.db.prepare(
        `UPDATE modules SET review_status = 'rejected', is_published = 0
            WHERE id = ?`
      ).bind(item.module_id).run();
      await ctx.db.prepare("UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?").bind(item.module_id).run();
    }
  }
  await audit(ctx.db, ctx.admin, `review.${decision}`, id, { moduleId: item.module_id });
  return jsonOk({ id, status });
}
async function listCategoriesAdmin(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order,
              c.is_visible, c.deleted_at,
              (SELECT COUNT(*) FROM modules m WHERE m.category_id = c.id
                 AND m.deleted_at IS NULL) AS module_count
         FROM categories c WHERE c.deleted_at IS NULL
        ORDER BY c.sort_order, c.name`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function upsertCategory(ctx, id) {
  const body = await readJson2(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const name = String(body.name ?? "").trim().slice(0, 40);
  const slug = String(body.slug ?? "").trim().toLowerCase();
  if (!name) return jsonError("bad_request", "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return jsonError("bad_request", "slug \u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u5355\u4E2A\u8FDE\u5B57\u7B26");
  }
  const sortOrder = Number(body.sort_order) || 0;
  const visible = body.is_visible === false ? 0 : 1;
  if (id) {
    await ctx.db.prepare(
      `UPDATE categories SET name = ?, slug = ?, description = ?, icon = ?,
                sort_order = ?, is_visible = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`
    ).bind(
      name,
      slug,
      String(body.description ?? "").slice(0, 200),
      String(body.icon ?? "").slice(0, 40),
      sortOrder,
      visible,
      id
    ).run();
    await audit(ctx.db, ctx.admin, "category.update", id, { name, slug });
    return jsonOk({ id });
  }
  const newId = `cat-${slug}`;
  await ctx.db.prepare(
    `INSERT INTO categories (id, name, slug, description, icon, sort_order, is_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    newId,
    name,
    slug,
    String(body.description ?? "").slice(0, 200),
    String(body.icon ?? "").slice(0, 40),
    sortOrder,
    visible
  ).run();
  await audit(ctx.db, ctx.admin, "category.create", newId, { name, slug });
  return jsonOk({ id: newId });
}
async function listAnnouncementsAdmin(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT id, title, body, level, is_pinned, is_published, published_at
         FROM announcements WHERE deleted_at IS NULL
        ORDER BY is_pinned DESC, published_at DESC LIMIT 100`
  ).all();
  return jsonOk({ items: rows.results ?? [] });
}
async function upsertAnnouncement(ctx, id) {
  const body = await readJson2(ctx.request);
  if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  const title = String(body.title ?? "").trim().slice(0, 80);
  if (!title) return jsonError("bad_request", "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  const level = ["info", "warning", "critical"].includes(String(body.level)) ? String(body.level) : "info";
  if (id) {
    await ctx.db.prepare(
      `UPDATE announcements SET title = ?, body = ?, level = ?, is_pinned = ?,
                is_published = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ? AND deleted_at IS NULL`
    ).bind(
      title,
      String(body.body ?? "").slice(0, 1e3),
      level,
      body.is_pinned ? 1 : 0,
      body.is_published === false ? 0 : 1,
      id
    ).run();
    await audit(ctx.db, ctx.admin, "announcement.update", id, { title });
    return jsonOk({ id });
  }
  const newId = crypto.randomUUID();
  await ctx.db.prepare(
    `INSERT INTO announcements (id, title, body, level, is_pinned, is_published, published_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).bind(
    newId,
    title,
    String(body.body ?? "").slice(0, 1e3),
    level,
    body.is_pinned ? 1 : 0,
    body.is_published === false ? 0 : 1
  ).run();
  await audit(ctx.db, ctx.admin, "announcement.create", newId, { title });
  return jsonOk({ id: newId });
}
async function getSettingsAdmin(ctx) {
  const rows = await ctx.db.prepare("SELECT key, value, value_type, scope FROM site_settings ORDER BY scope, key").all();
  return jsonOk({ items: rows.results ?? [] });
}
async function updateSettings2(ctx) {
  const body = await readJson2(ctx.request);
  const items = body?.items;
  if (!Array.isArray(items)) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
  for (const entry of items.slice(0, 50)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, value } = entry;
    if (typeof key !== "string" || typeof value !== "string") continue;
    await ctx.db.prepare(
      `UPDATE site_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE key = ?`
    ).bind(value.slice(0, 500), key).run();
  }
  await audit(ctx.db, ctx.admin, "settings.update", null, { count: items.length });
  return jsonOk({ updated: items.length });
}
async function analyticsSummary(ctx) {
  const byEvent = await ctx.db.prepare(
    `SELECT event, day, COUNT(*) AS n FROM analytics_events
        WHERE day >= date('now','-30 day') GROUP BY event, day ORDER BY day DESC`
  ).all();
  const proxy = await ctx.db.prepare(
    `SELECT day, SUM(hits) AS hits, SUM(misses) AS misses, SUM(errors) AS errors
         FROM proxy_stats WHERE day >= date('now','-30 day') GROUP BY day ORDER BY day DESC`
  ).all();
  return jsonOk({ events: byEvent.results ?? [], proxy: proxy.results ?? [] });
}
async function handleAdmin(request, env, path) {
  const url = new URL(request.url);
  const method = request.method;
  if (path === "/login") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    if (!originAllowed(request)) return jsonError("forbidden", "\u975E\u6CD5\u6765\u6E90");
    return login(request, env);
  }
  if (path === "/bootstrap") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    if (!originAllowed(request)) return jsonError("forbidden", "\u975E\u6CD5\u6765\u6E90");
    return bootstrap(request, env);
  }
  if (path === "/session") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const auth2 = await requireAdmin(request, env);
    if (!auth2.ok) return auth2.response;
    return jsonOk({ admin: auth2.admin });
  }
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const ctx = { db: env.DB, admin: auth.admin, env, request };
  if (path === "/logout") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return logout(ctx);
  }
  if (method !== "GET" && !originAllowed(request)) {
    return jsonError("forbidden", "\u975E\u6CD5\u6765\u6E90");
  }
  if (path === "/third-party" || path.startsWith("/third-party/")) {
    return handleThirdParty(ctx, path.slice("/third-party".length) || "/", method);
  }
  if (path === "/dashboard") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return dashboard(ctx);
  }
  const PHASE6_GUARD = [
    [/^\/modules$/, "module:write"],
    // deletion is its own permission: editors may edit, not destroy
    [/^\/categories\/[\w-]+\/delete$/, "content:delete"],
    [/^\/sources\/[\w-]+\/delete$/, "content:delete"],
    [/^\/announcements\/[\w-]+\/delete$/, "content:delete"],
    [/^\/update-logs/, "announcement:write"],
    [/^\/backups/, "settings:write"],
    [/^\/config\/import$/, "settings:write"],
    [/^\/operation-logs$/, "module:write"]
  ];
  const isPhase6Path = path === "/modules" || path.startsWith("/categories/") || path.startsWith("/sources/") || path.startsWith("/announcements/") || path.startsWith("/update-logs") || path.startsWith("/backups") || path.startsWith("/operation-logs") || path.startsWith("/config/");
  if (isPhase6Path && method !== "GET") {
    for (const [re, action] of PHASE6_GUARD) {
      if (!re.test(path)) continue;
      const denied = forbid(ctx.admin, action);
      if (denied) return denied;
      break;
    }
  }
  const phase6 = await handlePhase6(
    {
      db: ctx.db,
      admin: ctx.admin,
      request,
      publicOrigin: new URL(request.url).origin,
      githubToken: ctx.env.GITHUB_READ_TOKEN
    },
    path,
    method,
    url
  );
  if (phase6) return phase6;
  if (path === "/modules") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listModules2(ctx, url);
  }
  const moduleMatch = path.match(/^\/modules\/([\w-]+)$/);
  if (moduleMatch) {
    const id = moduleMatch[1];
    if (method === "GET") return getModule(ctx, id);
    if (method === "PATCH") {
      const denied = forbid(ctx.admin, "module:write");
      if (denied) return denied;
      return updateModule(ctx, id);
    }
    if (method === "DELETE") {
      const denied = forbid(ctx.admin, "module:delete");
      if (denied) return denied;
      return softDeleteModule(ctx, id);
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }
  const actionMatch = path.match(/^\/modules\/([\w-]+)\/(publish|hide|feature|unfeature)$/);
  if (actionMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = forbid(ctx.admin, "module:write");
    if (denied) return denied;
    return setModuleVisibility(ctx, actionMatch[1], actionMatch[2]);
  }
  if (path === "/mappings") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listMappings(ctx);
  }
  const mappingMatch = path.match(/^\/mappings\/([\w-]+)$/);
  if (mappingMatch) {
    const id = mappingMatch[1];
    const denied = forbid(ctx.admin, "proxy:write");
    if (method === "PATCH") {
      if (denied) return denied;
      return updateMapping(ctx, id);
    }
    if (method === "DELETE") {
      if (denied) return denied;
      return deleteMapping(ctx, id);
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  const refreshMatch = path.match(/^\/mappings\/([\w-]+)\/refresh$/);
  if (refreshMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = forbid(ctx.admin, "proxy:write");
    if (denied) return denied;
    return refreshMapping(ctx, refreshMatch[1]);
  }
  if (path === "/sources") {
    if (method === "GET") return listSources(ctx);
    if (method === "POST") {
      const denied = forbid(ctx.admin, "source:write");
      if (denied) return denied;
      return upsertSource(ctx, null);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const sourceMatch = path.match(/^\/sources\/([\w-]+)$/);
  if (sourceMatch) {
    if (method === "PATCH") {
      const denied = forbid(ctx.admin, "source:write");
      if (denied) return denied;
      return upsertSource(ctx, sourceMatch[1]);
    }
    return methodNotAllowed(["PATCH"]);
  }
  const verifyMatch = path.match(/^\/sources\/([\w-]+)\/verify$/);
  if (verifyMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = forbid(ctx.admin, "source:write");
    if (denied) return denied;
    return verifySource(ctx, verifyMatch[1]);
  }
  const syncMatch = path.match(/^\/sync\/([\w-]+)$/);
  if (syncMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return runSync(ctx, syncMatch[1]);
  }
  if (path === "/sync-jobs") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listSyncJobs(ctx, url);
  }
  const logsMatch = path.match(/^\/sync-jobs\/([\w-]+)\/logs$/);
  if (logsMatch) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return syncJobLogs(ctx, logsMatch[1]);
  }
  if (path === "/review") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listReview(ctx);
  }
  const reviewMatch = path.match(/^\/review\/([\w-]+)\/(approve|reject)$/);
  if (reviewMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = forbid(ctx.admin, "review:decide");
    if (denied) return denied;
    return decideReview2(ctx, reviewMatch[1], reviewMatch[2]);
  }
  if (path === "/categories") {
    if (method === "GET") return listCategoriesAdmin(ctx);
    if (method === "POST") {
      const denied = forbid(ctx.admin, "category:write");
      if (denied) return denied;
      return upsertCategory(ctx, null);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const catMatch = path.match(/^\/categories\/([\w-]+)$/);
  if (catMatch) {
    if (method !== "PATCH") return methodNotAllowed(["PATCH"]);
    const denied = forbid(ctx.admin, "category:write");
    if (denied) return denied;
    return upsertCategory(ctx, catMatch[1]);
  }
  if (path === "/announcements") {
    if (method === "GET") return listAnnouncementsAdmin(ctx);
    if (method === "POST") {
      const denied = forbid(ctx.admin, "announcement:write");
      if (denied) return denied;
      return upsertAnnouncement(ctx, null);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const annMatch = path.match(/^\/announcements\/([\w-]+)$/);
  if (annMatch) {
    if (method !== "PATCH") return methodNotAllowed(["PATCH"]);
    const denied = forbid(ctx.admin, "announcement:write");
    if (denied) return denied;
    return upsertAnnouncement(ctx, annMatch[1]);
  }
  if (path === "/settings") {
    if (method === "GET") return getSettingsAdmin(ctx);
    if (method === "PATCH") {
      const denied = forbid(ctx.admin, "settings:write");
      if (denied) return denied;
      return updateSettings2(ctx);
    }
    return methodNotAllowed(["GET", "PATCH"]);
  }
  if (path === "/analytics") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return analyticsSummary(ctx);
  }
  if (path === "/audit") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const rows = await ctx.db.prepare(
      `SELECT actor, action, target, detail, created_at FROM audit_logs
          ORDER BY id DESC LIMIT 100`
    ).all();
    return jsonOk({ items: rows.results ?? [] });
  }
  return jsonError("not_found", "\u7BA1\u7406\u63A5\u53E3\u4E0D\u5B58\u5728");
}
async function handleThirdParty(ctx, path, method) {
  const tp = {
    db: ctx.db,
    env: {
      DB: ctx.db,
      GITHUB_READ_TOKEN: ctx.env.GITHUB_READ_TOKEN,
      TELEGRAM_BOT_TOKEN: ctx.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_ADMIN_ID: ctx.env.TELEGRAM_ADMIN_ID,
      WEBHOOK_SECRET_KEY: ctx.env.WEBHOOK_SECRET_KEY,
      ENVIRONMENT: ctx.env.ENVIRONMENT
    },
    admin: ctx.admin,
    request: ctx.request,
    url: new URL(ctx.request.url)
  };
  const write = () => forbid(ctx.admin, "thirdparty:write");
  const check = () => forbid(ctx.admin, "thirdparty:check");
  const review = () => forbid(ctx.admin, "review:decide");
  if (path === "/repositories" || path === "/repositories/") {
    if (method === "GET") return listRepos(tp);
    if (method === "POST") {
      const denied = write();
      if (denied) return denied;
      return createRepo(tp);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const repoMatch = path.match(/^\/repositories\/([\w-]+)$/);
  if (repoMatch) {
    if (method === "PATCH" || method === "PUT") {
      const denied = write();
      if (denied) return denied;
      return updateRepo(tp, repoMatch[1]);
    }
    if (method === "DELETE") {
      const denied = write();
      if (denied) return denied;
      return deleteRepo(tp, repoMatch[1]);
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  const repoSub = path.match(/^\/repositories\/([\w-]+)\/([\w-]+)$/);
  if (repoSub) {
    const id = repoSub[1];
    const action = repoSub[2];
    if (action === "verify") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const denied = write();
      if (denied) return denied;
      return verifyRepo(tp, id);
    }
    if (action === "check") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const denied = check();
      if (denied) return denied;
      return triggerCheck(tp, id);
    }
    if (action === "logs") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      return repoLogs(tp, id);
    }
    if (action === "modules") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      return repoModules(tp, id);
    }
    if (action === "preview") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const denied = check();
      if (denied) return denied;
      return previewPush(tp, id);
    }
    if (action === "secret") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      const denied = write();
      if (denied) return denied;
      return setWebhookSecret(tp, id);
    }
    return jsonError("not_found", "\u63A5\u53E3\u4E0D\u5B58\u5728");
  }
  if (path === "/credentials") {
    if (method === "GET") return getCredentials(tp);
    if (method === "PUT" || method === "PATCH") {
      const denied = write();
      if (denied) return denied;
      return saveCredentials(tp);
    }
    return methodNotAllowed(["GET", "PUT"]);
  }
  if (path === "/credentials/test-telegram") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = write();
    if (denied) return denied;
    return testTelegram(tp);
  }
  if (path === "/settings") {
    if (method === "GET") return getSettings(tp);
    if (method === "PUT" || method === "PATCH") {
      const denied = forbid(ctx.admin, "settings:write");
      if (denied) return denied;
      return updateSettings(tp);
    }
    return methodNotAllowed(["GET", "PUT"]);
  }
  if (path === "/scheduler/run") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const denied = forbid(ctx.admin, "sync:run");
    if (denied) return denied;
    return runSchedulerNow(tp);
  }
  if (path === "/reviews" || path === "/reviews/") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listReviews(tp);
  }
  const reviewId = path.match(/^\/reviews\/([\w-]+)$/);
  if (reviewId) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return getReview(tp, reviewId[1]);
  }
  const reviewAct = path.match(/^\/reviews\/([\w-]+)\/([\w-]+)$/);
  if (reviewAct) {
    const denied = review();
    if (denied) return denied;
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const id = reviewAct[1];
    const action = reviewAct[2];
    if (action === "decide" || action === "approve" || action === "reject") {
      if (action !== "decide") {
        const original = ctx.request;
        const body = action === "approve" ? { decision: "approve" } : { decision: "reject" };
        const patched = new Request(original.url, {
          method: "POST",
          headers: original.headers,
          body: JSON.stringify(body)
        });
        return decideReview({ ...tp, request: patched }, id);
      }
      return decideReview(tp, id);
    }
    if (action === "resend") {
      return resendNotification(tp, id);
    }
    return jsonError("not_found", "\u63A5\u53E3\u4E0D\u5B58\u5728");
  }
  return jsonError("not_found", "\u7B2C\u4E09\u65B9\u63A5\u53E3\u4E0D\u5B58\u5728");
}

// workers/site/webhook.ts
var MAX_BODY3 = 5 * 1024 * 1024;
function timingSafeEqualHex2(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function handleWebhook(request, env, deps) {
  const json = (status, payload2) => new Response(JSON.stringify(payload2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return json(503, { ok: false, error: "webhook_not_configured" });
  }
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_BODY3) {
    return json(413, { ok: false, error: "payload_too_large" });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY3) {
    return json(413, { ok: false, error: "payload_too_large" });
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!signature) {
    return json(401, { ok: false, error: "missing_signature" });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const bodyText = new TextDecoder().decode(raw);
  let parsedBody;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  const repoFullName = parsedBody.repository?.full_name ?? "";
  const [repoOwner, repoName] = repoFullName.split("/");
  let verifyWith = null;
  if (repoOwner && repoName) {
    const row = await env.DB.prepare(
      `SELECT webhook_secret FROM sources
        WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND deleted_at IS NULL
        LIMIT 1`
    ).bind(repoOwner, repoName).first();
    if (row?.webhook_secret) verifyWith = row.webhook_secret;
  }
  if (!verifyWith) verifyWith = env.GITHUB_WEBHOOK_SECRET ?? null;
  if (!verifyWith) {
    return json(503, { ok: false, error: "webhook_not_configured" });
  }
  let verified = timingSafeEqualHex2(
    signature,
    `sha256=${await hmacSha256Hex(verifyWith, raw)}`
  );
  if (!verified && event === "ping") {
    const { results } = await env.DB.prepare(
      "SELECT webhook_secret FROM sources WHERE deleted_at IS NULL AND webhook_secret IS NOT NULL"
    ).all();
    for (const row of results ?? []) {
      const candidate = `sha256=${await hmacSha256Hex(row.webhook_secret, raw)}`;
      if (timingSafeEqualHex2(signature, candidate)) {
        verified = true;
        break;
      }
    }
  }
  if (!verified) {
    return json(401, { ok: false, error: "invalid_signature" });
  }
  if (event === "ping") {
    return json(200, { ok: true, action: "pong" });
  }
  if (event !== "push") {
    return json(202, { ok: true, action: "ignored", reason: `event:${event || "unknown"}` });
  }
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (delivery) {
    const seen = await env.DB.prepare(
      "SELECT 1 AS hit FROM rate_limits WHERE bucket = ? AND window = ? LIMIT 1"
    ).bind(`webhook:${delivery}`, "seen").first();
    if (seen) {
      return json(200, { ok: true, action: "duplicate" });
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rate_limits (bucket, window, count) VALUES (?, 'seen', 1)`
    ).bind(`webhook:${delivery}`).run();
  }
  const payload = parsedBody;
  if (payload.deleted) {
    return json(200, { ok: true, action: "ignored", reason: "branch_deleted" });
  }
  const fullName = payload.repository?.full_name ?? "";
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    return json(400, { ok: false, error: "missing_repository" });
  }
  const ref = payload.ref ?? "";
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
  const source = await env.DB.prepare(
    `SELECT id, branch, is_enabled FROM sources
      WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND deleted_at IS NULL
      LIMIT 1`
  ).bind(owner, repo).first();
  if (!source) {
    return json(404, { ok: false, error: "source_not_registered" });
  }
  if (source.is_enabled !== 1) {
    return json(200, { ok: true, action: "ignored", reason: "source_disabled" });
  }
  if (branch && branch !== source.branch) {
    return json(200, { ok: true, action: "ignored", reason: `branch:${branch}` });
  }
  const work = deps.sync(env.DB, source.id, "webhook");
  if (deps.waitUntil) {
    deps.waitUntil(
      work.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[webhook] background sync failed:", message);
      })
    );
    return json(202, { ok: true, action: "accepted", source: source.id });
  }
  try {
    await work;
    return json(200, { ok: true, action: "synced", source: source.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[webhook] sync failed:", message);
    return json(500, { ok: false, error: "sync_failed" });
  }
}

// workers/site/cron.ts
async function runCronSync(env, sync, now = Date.now()) {
  const intervalHours = Math.max(1, Number.parseInt(env.SYNC_INTERVAL_HOURS ?? "6", 10) || 6);
  const cutoff = new Date(now - intervalHours * 3600 * 1e3).toISOString().replace(/\.\d+Z$/, "Z");
  const { results } = await env.DB.prepare(
    `SELECT id, owner, repo, last_synced_at, sync_lock
       FROM sources
      WHERE deleted_at IS NULL AND is_enabled = 1
      ORDER BY COALESCE(last_synced_at, '1970-01-01T00:00:00Z') ASC
      LIMIT 20`
  ).all();
  const rows = results ?? [];
  const result = {
    scanned: rows.length,
    synced: 0,
    skipped: 0,
    failed: 0,
    details: []
  };
  for (const row of rows) {
    if (row.sync_lock) {
      result.skipped += 1;
      result.details.push({ sourceId: row.id, status: "skipped", reason: "locked" });
      continue;
    }
    if (row.last_synced_at && row.last_synced_at > cutoff) {
      result.skipped += 1;
      result.details.push({ sourceId: row.id, status: "skipped", reason: "fresh" });
      continue;
    }
    try {
      const outcome = await sync(env.DB, row.id, "cron");
      if (outcome.status === "ok") {
        result.synced += 1;
        result.details.push({ sourceId: row.id, status: "ok" });
      } else if (outcome.status === "skipped") {
        result.skipped += 1;
        result.details.push({
          sourceId: row.id,
          status: "skipped",
          reason: outcome.message ?? "skipped"
        });
      } else {
        result.failed += 1;
        result.details.push({
          sourceId: row.id,
          status: "failed",
          reason: outcome.message ?? "unknown"
        });
      }
    } catch (err) {
      result.failed += 1;
      result.details.push({
        sourceId: row.id,
        status: "failed",
        reason: err instanceof Error ? err.message.slice(0, 200) : "threw"
      });
    }
  }
  return result;
}

// workers/site/index.ts
init_sync();
init_telegram();
var API_PREFIX = "/api/v1";
async function readJsonSafe(request, maxBytes) {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > maxBytes) return null;
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const id = requestId();
    if (!url.pathname.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request);
    }
    return guard(id, async () => {
      const path = url.pathname.slice(API_PREFIX.length) || "/";
      if (path === "/health") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonOk({
          status: "ok",
          env: env.ENVIRONMENT === "production" ? "production" : "non-production",
          db: Boolean(env.DB)
        });
      }
      if (!env.DB) {
        return jsonError("internal_error", "\u6570\u636E\u5E93\u672A\u914D\u7F6E");
      }
      const db = env.DB;
      let credentialCache = null;
      const creds = async () => credentialCache ??= await resolveAll({
        DB: db,
        GITHUB_READ_TOKEN: env.GITHUB_READ_TOKEN,
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_ADMIN_ID: env.TELEGRAM_ADMIN_ID,
        WEBHOOK_SECRET_KEY: env.WEBHOOK_SECRET_KEY
      });
      if (path === "/webhook/github") {
        return handleWebhook(
          request,
          {
            DB: db,
            GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
            GITHUB_READ_TOKEN: (await creds()).githubReadToken
          },
          {
            sync: async (database, sourceId, trigger) => {
              await syncSource(
                { DB: database, GITHUB_READ_TOKEN: (await creds()).githubReadToken },
                sourceId,
                trigger
              );
            },
            // keeps the isolate alive after the 202 is returned; GitHub aborts at
            // 10s and a full scan takes longer than that
            waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : void 0
          }
        );
      }
      const repoHook = path.match(/^\/webhook\/github\/([\w-]+)$/);
      if (repoHook) {
        return handleRepoWebhook(
          request,
          {
            DB: db,
            GITHUB_READ_TOKEN: (await creds()).githubReadToken,
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
            WEBHOOK_SECRET_KEY: (await creds()).encryptionKey,
            ENVIRONMENT: env.ENVIRONMENT
          },
          repoHook[1],
          {
            // keep the isolate alive while the check runs; GitHub gives up at 10s
            waitUntil: ctx ? (p) => ctx.waitUntil(p) : void 0
          }
        );
      }
      if (path === "/webhook/telegram") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const expected = env.TELEGRAM_WEBHOOK_SECRET;
        if (expected) {
          const got = request.headers.get("x-telegram-bot-api-secret-token");
          if (got !== expected) {
            return jsonError("unauthorized", "Telegram \u6821\u9A8C\u5931\u8D25");
          }
        }
        const body = await readJsonSafe(request, 256 * 1024);
        if (!body) return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u5408\u6CD5");
        const result = await handleTelegramWebhook(
          {
            DB: db,
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId
          },
          body,
          {
            decide: async (input) => {
              const res = await decideTask(
                {
                  DB: db,
                  TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
                  TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
                  GITHUB_READ_TOKEN: (await creds()).githubReadToken
                },
                input
              );
              return res.ok ? { ok: true, status: res.status } : { ok: false, message: res.message };
            }
          }
        );
        return jsonOk(result.body, { status: result.status });
      }
      if (path === "/admin" || path.startsWith("/admin/")) {
        return handleAdmin(
          request,
          {
            DB: db,
            ENVIRONMENT: env.ENVIRONMENT,
            // the hook manager needs the token to create registrations; without
            // this the panel reports "未配置 GitHub Token" even when the secret
            // exists, because the value never reached the handler
            GITHUB_READ_TOKEN: (await creds()).githubReadToken,
            // 第七阶段：third-party panels need these to talk to Telegram and to
            // encrypt per-repo secrets. None of them is ever echoed back.
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
            WEBHOOK_SECRET_KEY: (await creds()).encryptionKey
          },
          path.slice("/admin".length) || "/"
        );
      }
      if (path === "/modules") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const settings = await loadSettings(db);
        const query = parseModuleListQuery(url.searchParams);
        query.perPage = clamp(query.perPage, 1, settings.perPageMax);
        const { items, meta } = await listModules(db, settings, query);
        return jsonOk(items, { meta });
      }
      const detailMatch = path.match(/^\/modules\/([^/]+)$/);
      if (detailMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const slug = validSlug(detailMatch[1]);
        if (!slug) return jsonError("bad_request", "slug \u683C\u5F0F\u4E0D\u5408\u6CD5");
        const settings = await loadSettings(db);
        const module = await getModuleBySlug(db, settings, slug);
        if (!module) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728\u6216\u672A\u53D1\u5E03");
        return jsonOk(module);
      }
      const versionsMatch = path.match(/^\/modules\/([^/]+)\/versions$/);
      if (versionsMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const slug = validSlug(versionsMatch[1]);
        if (!slug) return jsonError("bad_request", "slug \u683C\u5F0F\u4E0D\u5408\u6CD5");
        const limit = clamp(
          Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
          1,
          50
        );
        const versions = await listVersions(db, slug, limit);
        if (versions === null) return jsonError("not_found", "\u6A21\u5757\u4E0D\u5B58\u5728\u6216\u672A\u53D1\u5E03");
        return jsonOk(versions);
      }
      if (path === "/categories") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonOk(await listCategories(db));
      }
      if (path === "/announcements") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonOk(await listAnnouncements(db));
      }
      if (path === "/settings") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonOk(toPublicSettings(await loadSettings(db)));
      }
      if (path === "/analytics") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
        if (declared > ANALYTICS_LIMITS.maxBodyBytes) {
          return jsonError("payload_too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
        }
        const text = await request.text();
        if (text.length > ANALYTICS_LIMITS.maxBodyBytes) {
          return jsonError("payload_too_large", "\u8BF7\u6C42\u4F53\u8FC7\u5927");
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return jsonError("bad_request", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
        }
        const events = parseEvents(parsed);
        if (events === null) {
          return jsonError("bad_request", "\u4E8B\u4EF6\u683C\u5F0F\u4E0D\u5408\u6CD5\u6216\u5305\u542B\u672A\u5141\u8BB8\u7684\u4E8B\u4EF6\u7C7B\u578B");
        }
        const salt = env.RATE_LIMIT_SALT ?? "dev-salt";
        const clientKey = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
        const allowed = await checkRateLimit(
          db,
          salt,
          clientKey,
          ANALYTICS_LIMITS.maxEventsPerWindow,
          ANALYTICS_LIMITS.windowSeconds
        );
        if (!allowed) {
          return jsonError("too_many_requests", "\u4E0A\u62A5\u8FC7\u4E8E\u9891\u7E41");
        }
        const accepted = await insertEvents(db, events);
        return jsonOk({ accepted }, { status: 202 });
      }
      return jsonError("not_found", "\u63A5\u53E3\u4E0D\u5B58\u5728");
    });
  },
  /**
   * Cron entrypoint. Runs on the schedule in wrangler.toml.
   *
   * No request context is available here, so the work is driven entirely by
   * `sources`: every enabled source whose last sync is older than the interval
   * is re-scanned. Failures are recorded by `syncSource` in sync_jobs, which the
   * admin UI surfaces.
   */
  async scheduled(_controller, env) {
    if (!env.DB) {
      console.error("[cron] no DB binding");
      return;
    }
    const credentialSet = await resolveAll({
      DB: env.DB,
      GITHUB_READ_TOKEN: env.GITHUB_READ_TOKEN,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_ADMIN_ID: env.TELEGRAM_ADMIN_ID,
      WEBHOOK_SECRET_KEY: env.WEBHOOK_SECRET_KEY
    });
    const result = await runCronSync(
      {
        DB: env.DB,
        GITHUB_READ_TOKEN: credentialSet.githubReadToken,
        SYNC_INTERVAL_HOURS: env.SYNC_INTERVAL_HOURS
      },
      async (db, sourceId, trigger) => syncSource({ DB: db, GITHUB_READ_TOKEN: credentialSet.githubReadToken }, sourceId, trigger)
    );
    console.log("[cron]", JSON.stringify(result));
    try {
      const third = await runScheduler(
        {
          DB: env.DB,
          GITHUB_READ_TOKEN: credentialSet.githubReadToken,
          TELEGRAM_BOT_TOKEN: credentialSet.telegramBotToken,
          TELEGRAM_ADMIN_ID: credentialSet.telegramAdminId,
          WEBHOOK_SECRET_KEY: credentialSet.encryptionKey,
          ENVIRONMENT: env.ENVIRONMENT
        },
        { trigger: "cron" }
      );
      console.log("[cron:third-party]", JSON.stringify(third));
    } catch (err) {
      console.error(
        "[cron:third-party] failed",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
};
export {
  index_default as default
};
