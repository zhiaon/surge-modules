"""
Admin API for the local preview server.

This mirrors the Cloudflare worker's admin handlers closely enough to exercise the
UI, and keeps the same security rules:

  * PBKDF2-SHA256 password hashes (210k iterations), never plaintext
  * opaque session tokens; only their SHA-256 is stored
  * HttpOnly + SameSite=Lax cookie, 12h expiry, server-side revocation
  * role checks on every mutating endpoint
  * audit rows for anything that changes state

The one deliberate difference: this server has no GitHub access, so sync and
verify return a clear "not available in preview" message instead of pretending.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie

PBKDF2_ITERATIONS = 210_000
SESSION_TTL_HOURS = 12
COOKIE_NAME = "sm_admin"

PERMISSIONS = {
    "module:write": {"super", "editor"},
    "module:delete": {"super"},
    "category:write": {"super", "editor"},
    "source:write": {"super"},
    "proxy:write": {"super"},
    "review:decide": {"super", "editor"},
    "announcement:write": {"super", "editor"},
    "settings:write": {"super"},
    "admin:manage": {"super"},
    "sync:run": {"super"},
}


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ password
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return "pbkdf2${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode(),
        base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt_b64, hash_b64 = stored.split("$")
        if scheme != "pbkdf2":
            return False
        iterations_n = int(iterations)
        if iterations_n < 10_000:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except Exception:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations_n)
    return hmac.compare_digest(expected, actual)


def token_hash(token: str) -> str:
    return base64.b64encode(hashlib.sha256(token.encode()).digest()).decode()


# ------------------------------------------------------------------ sessions
def parse_cookie(header: str | None) -> str | None:
    if not header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    morsel = jar.get(COOKIE_NAME)
    return morsel.value if morsel else None


def resolve_session(conn: sqlite3.Connection, token: str | None) -> dict | None:
    if not token:
        return None
    row = conn.execute(
        """SELECT a.id, a.username, a.display_name, a.role, a.is_active,
                  s.expires_at, s.revoked_at
             FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
            WHERE s.token_hash = ? LIMIT 1""",
        [token_hash(token)],
    ).fetchone()
    if not row:
        return None
    if row["revoked_at"] or not row["is_active"]:
        return None
    if row["expires_at"] <= now():
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "displayName": row["display_name"] or row["username"],
        "role": "super" if row["role"] == "super" else "editor",
    }


def can(role: str, action: str) -> bool:
    return role in PERMISSIONS.get(action, set())


def op_log(conn: sqlite3.Connection, actor: str, action: str, target, result: str, detail=None) -> None:
    """Business-level operation log (the admin log page reads this)."""
    conn.execute(
        "INSERT INTO operation_logs (actor, action, target, result, detail) VALUES (?, ?, ?, ?, ?)",
        [actor, action, target, result,
         json.dumps(detail, ensure_ascii=False)[:2000] if detail is not None else None],
    )
    conn.commit()


def audit(conn: sqlite3.Connection, actor: str, action: str, target, detail) -> None:
    conn.execute(
        "INSERT INTO audit_logs (actor, action, target, detail) VALUES (?, ?, ?, ?)",
        [actor, action, target, json.dumps(detail, ensure_ascii=False)[:2000] if detail is not None else None],
    )
    conn.commit()


# -------------------------------------------------------------------- helpers
def ok(data, meta=None, status=200):
    payload = {"ok": True, "data": data}
    if meta is not None:
        payload["meta"] = meta
    return status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }, json.dumps(payload, ensure_ascii=False).encode()


def fail(code: str, message: str, status: int | None = None):
    mapping = {
        "unauthorized": 401,
        "forbidden": 403,
        "bad_request": 400,
        "not_found": 404,
        "too_many_requests": 429,
        "method_not_allowed": 405,
        "internal_error": 500,
    }
    return (
        status or mapping.get(code, 500),
        {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
        json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False).encode(),
    )


def row_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# ------------------------------------------------------------------- handlers
def handle(method: str, path: str, query: dict, body: bytes, cookie_header, conn: sqlite3.Connection):
    """Returns (status, headers, body) or None when the path is not an admin route."""

    def json_body() -> dict | None:
        if not body:
            return {}
        try:
            parsed = json.loads(body)
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    # ---- bootstrap: only while no admin exists
    if path == "/bootstrap":
        if method != "POST":
            return fail("method_not_allowed", "只支持 POST")
        count = conn.execute("SELECT COUNT(*) AS n FROM admins").fetchone()["n"]
        if count > 0:
            return fail("forbidden", "管理员已存在，无法再初始化")
        data = json_body() or {}
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if not username or len(password) < 12:
            return fail("bad_request", "用户名必填，密码至少 12 位")
        conn.execute(
            "INSERT INTO admins (id, username, display_name, role, password_hash) VALUES (?, ?, ?, 'super', ?)",
            [secrets.token_hex(8), username, username, hash_password(password)],
        )
        conn.commit()
        audit(conn, username, "admin.bootstrap", None, {})
        return ok({"id": username})

    # ---- login
    if path == "/login":
        if method != "POST":
            return fail("method_not_allowed", "只支持 POST")
        data = json_body() or {}
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        row = conn.execute(
            "SELECT * FROM admins WHERE username = ? AND deleted_at IS NULL LIMIT 1",
            [username],
        ).fetchone()
        if not row or not row["is_active"]:
            return fail("unauthorized", "用户名或密码错误")
        if row["locked_until"] and row["locked_until"] > now():
            return fail("too_many_requests", "账号已临时锁定，请稍后再试")
        if not verify_password(password, row["password_hash"]):
            attempts = int(row["failed_attempts"]) + 1
            lock = (
                (datetime.now(timezone.utc) + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
                if attempts >= 5
                else None
            )
            conn.execute(
                "UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?",
                [attempts, lock, row["id"]],
            )
            conn.commit()
            return fail("unauthorized", "用户名或密码错误")

        conn.execute(
            "UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
            [now(), row["id"]],
        )
        token = secrets.token_urlsafe(32)
        expires = (datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        conn.execute(
            "INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)",
            [token_hash(token), row["id"], expires],
        )
        conn.commit()
        status, headers, payload = ok(
            {
                "admin": {
                    "id": row["id"],
                    "username": row["username"],
                    "displayName": row["display_name"] or row["username"],
                    "role": row["role"],
                },
                "expiresAt": expires,
            }
        )
        headers["Set-Cookie"] = (
            f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_HOURS * 3600}"
        )
        return status, headers, payload

    # ---- everything below needs a session
    admin = resolve_session(conn, parse_cookie(cookie_header))
    if admin is None:
        return fail("unauthorized", "未登录或会话已过期")

    if path == "/session":
        return ok({"admin": admin})

    if path == "/logout":
        token = parse_cookie(cookie_header)
        if token:
            conn.execute(
                "UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?",
                [now(), token_hash(token)],
            )
            conn.commit()
        status, headers, payload = ok({"ok": True})
        headers["Set-Cookie"] = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        return status, headers, payload

    def require(action: str):
        if can(admin["role"], action):
            return None
        return fail("forbidden", f"当前角色无权执行此操作（{action}）")

    if path == "/dashboard":
        c = conn.execute(
            """SELECT
                 (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL) AS total,
                 (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 1) AS published,
                 (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL AND is_published = 0) AS hidden,
                 (SELECT COUNT(*) FROM review_items WHERE status = 'pending') AS pending,
                 (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL) AS sources,
                 (SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL AND is_enabled = 1) AS sources_on,
                 (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL) AS mappings,
                 (SELECT COUNT(*) FROM module_proxy_mappings WHERE deleted_at IS NULL AND is_enabled = 1) AS mappings_on"""
        ).fetchone()
        recent = [
            row_dict(r)
            for r in conn.execute(
                """SELECT id, status, trigger, started_at, finished_at, scanned, added, updated, skipped, failed, error
                     FROM sync_jobs ORDER BY created_at DESC LIMIT 5"""
            ).fetchall()
        ]
        failures = conn.execute("SELECT COUNT(*) AS n FROM sync_jobs WHERE status = 'failed'").fetchone()["n"]
        analytics = [
            row_dict(r)
            for r in conn.execute(
                """SELECT event, COUNT(*) AS n FROM analytics_events
                    WHERE day >= date('now','-7 day') GROUP BY event ORDER BY n DESC"""
            ).fetchall()
        ]
        proxy = conn.execute(
            """SELECT COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(misses),0) AS misses,
                      COALESCE(SUM(errors),0) AS errors
                 FROM proxy_stats WHERE day >= date('now','-7 day')"""
        ).fetchone()
        return ok(
            {
                "counts": row_dict(c),
                "syncFailures": failures,
                "recentSyncs": recent,
                "analytics": analytics,
                "proxy": {"hits": proxy["hits"], "misses": proxy["misses"], "errors": proxy["errors"]},
            }
        )

    if path == "/modules":
        q = (query.get("q", [""])[0] or "").strip()
        status_filter = query.get("status", [""])[0]
        where = ["m.deleted_at IS NULL"]
        binds = []
        if q:
            where.append("(m.name LIKE ? OR m.slug LIKE ? OR m.author LIKE ?)")
            binds += [f"%{q}%"] * 3
        if status_filter == "published":
            where.append("m.is_published = 1")
        elif status_filter == "hidden":
            where.append("m.is_published = 0")
        elif status_filter == "featured":
            where.append("m.is_featured = 1")

        rows = conn.execute(
            f"""SELECT m.id, m.slug, m.name, m.author, m.version, m.is_published,
                       m.is_featured, m.review_status, m.updated_at,
                       c.name AS category_name,
                       (SELECT COUNT(*) FROM module_overrides o WHERE o.module_id = m.id) AS overrides,
                       (SELECT COUNT(*) FROM module_proxy_mappings p
                         WHERE p.module_id = m.id AND p.deleted_at IS NULL) AS mappings
                  FROM modules m LEFT JOIN categories c ON c.id = m.category_id
                 WHERE {' AND '.join(where)}
                 ORDER BY m.updated_at DESC LIMIT 200""",
            binds,
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]}, {"total": len(rows)})

    parts = path.strip("/").split("/")

    if parts[0] == "modules" and len(parts) >= 2:
        module_id = parts[1]

        if len(parts) == 2 and method == "GET":
            row = conn.execute("SELECT * FROM modules WHERE id = ?", [module_id]).fetchone()
            if not row:
                return fail("not_found", "模块不存在")
            tags = [r["tag"] for r in conn.execute("SELECT tag FROM module_tags WHERE module_id = ?", [module_id])]
            overrides = [
                row_dict(r)
                for r in conn.execute(
                    "SELECT field, value, updated_at FROM module_overrides WHERE module_id = ?", [module_id]
                ).fetchall()
            ]
            versions = [
                row_dict(r)
                for r in conn.execute(
                    """SELECT version, changelog, content_hash, released_at FROM module_versions
                        WHERE module_id = ? ORDER BY released_at DESC LIMIT 20""",
                    [module_id],
                ).fetchall()
            ]
            mapping = conn.execute(
                "SELECT * FROM module_proxy_mappings WHERE module_id = ? AND deleted_at IS NULL LIMIT 1",
                [module_id],
            ).fetchone()
            return ok(
                {
                    "module": row_dict(row),
                    "tags": tags,
                    "overrides": overrides,
                    "versions": versions,
                    "mapping": row_dict(mapping) if mapping else None,
                }
            )

        if len(parts) == 2 and method == "PATCH":
            denied = require("module:write")
            if denied:
                return denied
            data = json_body()
            if data is None:
                return fail("bad_request", "请求体不合法")
            applied = []
            for field in ("name", "description", "author", "category_id", "version"):
                if field not in data:
                    continue
                value = str(data[field] or "")
                conn.execute(
                    """INSERT INTO module_overrides (module_id, field, value, updated_by)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(module_id, field) DO UPDATE SET
                         value = excluded.value, updated_by = excluded.updated_by,
                         updated_at = ?""",
                    [module_id, field, value, admin["username"], now()],
                )
                conn.execute(f"UPDATE modules SET {field} = ?, updated_at = ? WHERE id = ?", [value, now(), module_id])
                applied.append(field)
            for field in ("is_featured", "is_published"):
                if field in data:
                    value = 1 if data[field] else 0
                    conn.execute(
                        """INSERT INTO module_overrides (module_id, field, value, updated_by)
                           VALUES (?, ?, ?, ?)
                           ON CONFLICT(module_id, field) DO UPDATE SET value = excluded.value""",
                        [module_id, field, str(value), admin["username"]],
                    )
                    conn.execute(f"UPDATE modules SET {field} = ? WHERE id = ?", [value, module_id])
                    applied.append(field)
            if isinstance(data.get("tags"), list):
                conn.execute("DELETE FROM module_tags WHERE module_id = ?", [module_id])
                for tag in [str(t).strip()[:32] for t in data["tags"] if str(t).strip()][:12]:
                    conn.execute(
                        "INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)", [module_id, tag]
                    )
                applied.append("tags")
            conn.commit()
            audit(conn, admin["username"], "module.update", module_id, {"fields": applied})
            return ok({"id": module_id, "applied": applied})

        if len(parts) == 2 and method == "DELETE":
            denied = require("module:delete")
            if denied:
                return denied
            row = conn.execute("SELECT slug, source_id, source_path FROM modules WHERE id = ?", [module_id]).fetchone()
            if not row:
                return fail("not_found", "模块不存在")
            conn.execute("UPDATE modules SET deleted_at = ?, is_published = 0 WHERE id = ?", [now(), module_id])
            conn.execute(
                "UPDATE module_proxy_mappings SET deleted_at = ?, is_enabled = 0 WHERE module_id = ?",
                [now(), module_id],
            )
            if row["source_id"] and row["source_path"]:
                conn.execute(
                    """INSERT OR IGNORE INTO module_tombstones (id, source_id, source_path, reason)
                       VALUES (?, ?, ?, 'removed')""",
                    [secrets.token_hex(8), row["source_id"], row["source_path"]],
                )
            conn.commit()
            audit(conn, admin["username"], "module.delete", module_id, {"slug": row["slug"]})
            return ok({"id": module_id, "deleted": True})

        if len(parts) == 3 and method == "POST" and parts[2] in ("publish", "hide", "feature", "unfeature"):
            denied = require("module:write")
            if denied:
                return denied
            action = parts[2]
            if action == "publish":
                conn.execute("UPDATE modules SET is_published = 1, updated_at = ? WHERE id = ?", [now(), module_id])
            elif action == "hide":
                conn.execute("UPDATE modules SET is_published = 0, updated_at = ? WHERE id = ?", [now(), module_id])
                conn.execute("UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?", [module_id])
            elif action == "feature":
                conn.execute("UPDATE modules SET is_featured = 1 WHERE id = ?", [module_id])
            else:
                conn.execute("UPDATE modules SET is_featured = 0 WHERE id = ?", [module_id])
            conn.commit()
            audit(conn, admin["username"], f"module.{action}", module_id, {})
            return ok({"id": module_id, "action": action})

    if path == "/mappings":
        rows = conn.execute(
            """SELECT p.id, p.public_slug, p.file_path, p.is_enabled, p.content_hash,
                      p.ttl_seconds, p.last_fetched_at, p.last_status, p.last_error,
                      p.source_id, s.owner, s.repo, s.branch, s.is_enabled AS source_enabled,
                      m.name AS module_name, m.is_published,
                      (SELECT COALESCE(SUM(hits),0) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS hits,
                      (SELECT COALESCE(SUM(misses),0) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS misses,
                      (SELECT COALESCE(SUM(errors),0) FROM proxy_stats ps WHERE ps.slug = p.public_slug) AS errors
                 FROM module_proxy_mappings p
                 JOIN sources s ON s.id = p.source_id
                 LEFT JOIN modules m ON m.id = p.module_id
                WHERE p.deleted_at IS NULL ORDER BY p.public_slug"""
        ).fetchall()
        base = conn.execute("SELECT value FROM site_settings WHERE key = 'proxy.public_base'").fetchone()
        return ok({"items": [row_dict(r) for r in rows], "publicBase": base["value"] if base else ""})

    if parts[0] == "mappings" and len(parts) >= 2:
        mapping_id = parts[1]
        denied = require("proxy:write")
        if len(parts) == 2 and method == "PATCH":
            if denied:
                return denied
            data = json_body() or {}
            sets, binds = [], []
            if "is_enabled" in data:
                sets.append("is_enabled = ?")
                binds.append(1 if data["is_enabled"] else 0)
            if "ttl_seconds" in data:
                ttl = max(30, min(86400, int(data["ttl_seconds"] or 300)))
                sets.append("ttl_seconds = ?")
                binds.append(ttl)
            if isinstance(data.get("file_path"), str):
                path_value = data["file_path"].strip()
                if ".." in path_value or path_value.startswith("/") or "\\" in path_value:
                    return fail("bad_request", "文件路径不合法")
                sets.append("file_path = ?")
                binds.append(path_value)
            if not sets:
                return fail("bad_request", "没有可更新的字段")
            conn.execute(f"UPDATE module_proxy_mappings SET {', '.join(sets)}, updated_at = ? WHERE id = ?", [*binds, now(), mapping_id])
            if "is_enabled" in data and not data["is_enabled"]:
                conn.execute(
                    "UPDATE modules SET is_published = 0 WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)",
                    [mapping_id],
                )
            conn.commit()
            audit(conn, admin["username"], "proxy.update", mapping_id, data)
            return ok({"id": mapping_id})

        if len(parts) == 2 and method == "DELETE":
            if denied:
                return denied
            conn.execute(
                "UPDATE module_proxy_mappings SET deleted_at = ?, is_enabled = 0 WHERE id = ?", [now(), mapping_id]
            )
            conn.execute(
                "UPDATE modules SET is_published = 0 WHERE id = (SELECT module_id FROM module_proxy_mappings WHERE id = ?)",
                [mapping_id],
            )
            conn.commit()
            audit(conn, admin["username"], "proxy.delete", mapping_id, {})
            return ok({"deleted": mapping_id})

        if len(parts) == 3 and parts[2] == "refresh" and method == "POST":
            if denied:
                return denied
            revision = secrets.token_hex(6)
            conn.execute(
                "UPDATE module_proxy_mappings SET content_hash = ?, updated_at = ? WHERE id = ?",
                [revision, now(), mapping_id],
            )
            conn.commit()
            audit(conn, admin["username"], "proxy.refresh", mapping_id, {"revision": revision})
            return ok({"slug": mapping_id, "revision": revision})

    if path == "/sources":
        if method == "POST":
            denied = require("source:write")
            if denied:
                return denied
            data = json_body() or {}
            owner = str(data.get("owner", "")).strip()
            repo = str(data.get("repo", "")).strip()
            if not owner or not repo:
                return fail("bad_request", "owner 和 repo 必填")
            new_id = f"src-{owner}-{repo}".lower()
            conn.execute(
                """INSERT INTO sources (id, owner, repo, branch, allow_paths, sync_mode, is_enabled, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     owner = excluded.owner, repo = excluded.repo, branch = excluded.branch,
                     allow_paths = excluded.allow_paths, is_enabled = excluded.is_enabled""",
                [
                    new_id,
                    owner,
                    repo,
                    str(data.get("branch", "main")),
                    str(data.get("allow_paths", "")),
                    str(data.get("sync_mode", "manual")),
                    1 if data.get("is_enabled") else 0,
                    str(data.get("notes", "")),
                ],
            )
            conn.commit()
            audit(conn, admin["username"], "source.create", new_id, {"owner": owner, "repo": repo})
            return ok({"id": new_id})
        rows = conn.execute(
            """SELECT s.id, s.owner, s.repo, s.branch, s.allow_paths, s.sync_mode,
                      s.is_enabled, s.notes, s.last_synced_at, s.last_status,
                      (s.sync_lock IS NOT NULL) AS locked,
                      (SELECT COUNT(*) FROM modules m WHERE m.source_id = s.id AND m.deleted_at IS NULL) AS modules,
                      (SELECT COUNT(*) FROM sync_jobs j WHERE j.source_id = s.id AND j.status = 'failed') AS failures
                 FROM sources s WHERE s.deleted_at IS NULL ORDER BY s.owner, s.repo"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if parts[0] == "sources" and len(parts) >= 2:
        source_id = parts[1]
        if len(parts) == 2 and method == "PATCH":
            denied = require("source:write")
            if denied:
                return denied
            data = json_body() or {}
            conn.execute(
                """UPDATE sources SET owner = ?, repo = ?, branch = ?, allow_paths = ?,
                          sync_mode = ?, is_enabled = ?, notes = ?, updated_at = ?
                    WHERE id = ?""",
                [
                    str(data.get("owner", "")),
                    str(data.get("repo", "")),
                    str(data.get("branch", "main")),
                    str(data.get("allow_paths", "")),
                    str(data.get("sync_mode", "manual")),
                    1 if data.get("is_enabled") else 0,
                    str(data.get("notes", "")),
                    now(),
                    source_id,
                ],
            )
            conn.commit()
            audit(conn, admin["username"], "source.update", source_id, {})
            return ok({"id": source_id})
        if len(parts) == 3 and parts[2] == "verify":
            return ok({"ok": False, "reason": "本地预览服务不访问 GitHub，请在部署后或 Node 服务下验证"})

    if parts[0] == "sync" and len(parts) >= 2 and method == "POST":
        denied = require("sync:run")
        if denied:
            return denied
        return ok(
            {
                "results": [
                    {
                        "status": "failed",
                        "message": "本地预览服务不执行同步，请用 wrangler dev 或部署后运行",
                        "scanned": 0,
                        "added": 0,
                        "updated": 0,
                        "unchanged": 0,
                        "failed": 0,
                    }
                ]
            }
        )

    if path == "/sync-jobs":
        rows = conn.execute(
            """SELECT id, source_id, trigger, status, started_at, finished_at,
                      scanned, added, updated, skipped, failed, error
                 FROM sync_jobs ORDER BY created_at DESC LIMIT 50"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if parts[0] == "sync-jobs" and len(parts) == 3 and parts[2] == "logs":
        rows = conn.execute(
            "SELECT level, path, message, created_at FROM sync_logs WHERE job_id = ? ORDER BY id LIMIT 500",
            [parts[1]],
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if path == "/review":
        rows = conn.execute(
            """SELECT r.id, r.kind, r.status, r.source_path, r.proposed, r.baseline,
                      r.note, r.created_at, m.name AS module_name, m.slug,
                      s.owner || '/' || s.repo AS source_repo
                 FROM review_items r
                 LEFT JOIN modules m ON m.id = r.module_id
                 LEFT JOIN sources s ON s.id = r.source_id
                WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 100"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if parts[0] == "review" and len(parts) == 3 and method == "POST":
        denied = require("review:decide")
        if denied:
            return denied
        decision = parts[2]
        if decision not in ("approve", "reject"):
            return fail("bad_request", "未知决定")
        item = conn.execute(
            "SELECT id, module_id FROM review_items WHERE id = ? AND status = 'pending'", [parts[1]]
        ).fetchone()
        if not item:
            return fail("not_found", "审核项不存在或已处理")
        conn.execute(
            "UPDATE review_items SET status = ?, reviewed_at = ? WHERE id = ?",
            ["approved" if decision == "approve" else "rejected", now(), parts[1]],
        )
        if item["module_id"]:
            if decision == "approve":
                conn.execute(
                    "UPDATE modules SET review_status = 'approved', is_published = 1, published_at = COALESCE(published_at, ?) WHERE id = ?",
                    [now(), item["module_id"]],
                )
                conn.execute(
                    "UPDATE module_proxy_mappings SET is_enabled = 1 WHERE module_id = ? AND deleted_at IS NULL",
                    [item["module_id"]],
                )
            else:
                conn.execute(
                    "UPDATE modules SET review_status = 'rejected', is_published = 0 WHERE id = ?",
                    [item["module_id"]],
                )
                conn.execute(
                    "UPDATE module_proxy_mappings SET is_enabled = 0 WHERE module_id = ?", [item["module_id"]]
                )
        conn.commit()
        audit(conn, admin["username"], f"review.{decision}", parts[1], {})
        return ok({"id": parts[1]})

    if path == "/categories":
        if method == "POST":
            denied = require("category:write")
            if denied:
                return denied
            data = json_body() or {}
            name = str(data.get("name", "")).strip()
            slug = str(data.get("slug", "")).strip().lower()
            if not name or not slug:
                return fail("bad_request", "名称和 slug 必填")
            new_id = f"cat-{slug}"
            conn.execute(
                """INSERT INTO categories (id, name, slug, description, icon, sort_order, is_visible)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [
                    new_id,
                    name,
                    slug,
                    str(data.get("description", "")),
                    str(data.get("icon", "")),
                    int(data.get("sort_order") or 0),
                    1 if data.get("is_visible", True) else 0,
                ],
            )
            conn.commit()
            audit(conn, admin["username"], "category.create", new_id, {"name": name})
            return ok({"id": new_id})
        rows = conn.execute(
            """SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order, c.is_visible,
                      (SELECT COUNT(*) FROM modules m WHERE m.category_id = c.id AND m.deleted_at IS NULL) AS module_count
                 FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if parts[0] == "categories" and len(parts) == 2 and method == "PATCH":
        denied = require("category:write")
        if denied:
            return denied
        data = json_body() or {}
        conn.execute(
            "UPDATE categories SET name = ?, description = ?, sort_order = ?, is_visible = ?, updated_at = ? WHERE id = ?",
            [
                str(data.get("name", "")),
                str(data.get("description", "")),
                int(data.get("sort_order") or 0),
                1 if data.get("is_visible", True) else 0,
                now(),
                parts[1],
            ],
        )
        conn.commit()
        audit(conn, admin["username"], "category.update", parts[1], {})
        return ok({"id": parts[1]})

    if path == "/announcements":
        if method == "POST":
            denied = require("announcement:write")
            if denied:
                return denied
            data = json_body() or {}
            title = str(data.get("title", "")).strip()
            if not title:
                return fail("bad_request", "标题必填")
            new_id = secrets.token_hex(8)
            conn.execute(
                """INSERT INTO announcements (id, title, body, level, is_pinned, is_published, published_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [
                    new_id,
                    title,
                    str(data.get("body", "")),
                    str(data.get("level", "info")),
                    1 if data.get("is_pinned") else 0,
                    1 if data.get("is_published", True) else 0,
                    now(),
                ],
            )
            conn.commit()
            audit(conn, admin["username"], "announcement.create", new_id, {"title": title})
            return ok({"id": new_id})
        rows = conn.execute(
            """SELECT id, title, body, level, is_pinned, is_published, published_at
                 FROM announcements WHERE deleted_at IS NULL ORDER BY is_pinned DESC, published_at DESC LIMIT 100"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if parts[0] == "announcements" and len(parts) == 2 and method == "PATCH":
        denied = require("announcement:write")
        if denied:
            return denied
        data = json_body() or {}
        conn.execute(
            """UPDATE announcements SET title = ?, body = ?, level = ?, is_pinned = ?, is_published = ?, updated_at = ?
                WHERE id = ?""",
            [
                str(data.get("title", "")),
                str(data.get("body", "")),
                str(data.get("level", "info")),
                1 if data.get("is_pinned") else 0,
                1 if data.get("is_published", True) else 0,
                now(),
                parts[1],
            ],
        )
        conn.commit()
        audit(conn, admin["username"], "announcement.update", parts[1], {})
        return ok({"id": parts[1]})

    if path == "/settings":
        if method == "PATCH":
            denied = require("settings:write")
            if denied:
                return denied
            data = json_body() or {}
            items = data.get("items") or []
            for entry in items[:50]:
                if not isinstance(entry, dict):
                    continue
                key = entry.get("key")
                value = entry.get("value")
                if isinstance(key, str) and isinstance(value, str):
                    conn.execute(
                        "UPDATE site_settings SET value = ?, updated_at = ? WHERE key = ?", [value[:500], now(), key]
                    )
            conn.commit()
            audit(conn, admin["username"], "settings.update", None, {"count": len(items)})
            return ok({"updated": len(items)})
        rows = conn.execute(
            "SELECT key, value, value_type, scope FROM site_settings ORDER BY scope, key"
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    if path == "/analytics":
        events = conn.execute(
            """SELECT event, day, COUNT(*) AS n FROM analytics_events
                WHERE day >= date('now','-30 day') GROUP BY event, day ORDER BY day DESC"""
        ).fetchall()
        proxy = conn.execute(
            """SELECT day, SUM(hits) AS hits, SUM(misses) AS misses, SUM(errors) AS errors
                 FROM proxy_stats WHERE day >= date('now','-30 day') GROUP BY day ORDER BY day DESC"""
        ).fetchall()
        return ok({"events": [row_dict(r) for r in events], "proxy": [row_dict(r) for r in proxy]})

    if path == "/audit":
        rows = conn.execute(
            "SELECT actor, action, target, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT 100"
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    
    # ---------------------------------------------------------- phase 6
    if path == "/modules" and method == "POST":
        denied = require("module:write")
        if denied:
            return denied
        data = json_body() or {}
        name = str(data.get("name", "")).strip()[:80]
        if not name:
            return fail("bad_request", "名称不能为空")
        raw_slug = str(data.get("slug", "")).strip() if data.get("slug") is not None else ""
        slug = raw_slug or "".join(c if (c.isalnum() and c.isascii()) else "-" for c in name.lower()).strip("-")
        import re as _re
        if not _re.match(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", slug):
            return fail("bad_request", "slug 只能是小写字母、数字和单个连字符")
        dup = conn.execute("SELECT id FROM modules WHERE slug = ? AND deleted_at IS NULL", [slug]).fetchone()
        if dup:
            return fail("bad_request", f"slug「{slug}」已被占用")
        mid = f"mod-{slug}"
        published = 1 if data.get("is_published") else 0
        conn.execute(
            """INSERT INTO modules (id, slug, name, description, author, category_id, version,
                 source_id, source_path, is_featured, is_published, review_status, published_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)""",
            [
                mid, slug, name,
                str(data.get("description", ""))[:400],
                str(data.get("author", ""))[:60],
                str(data.get("category_id", "")) or None,
                str(data.get("version", "1.0.0"))[:20],
                str(data.get("source_id", "")) or None,
                str(data.get("source_path", ""))[:300] or None,
                1 if data.get("is_featured") else 0,
                published,
                now() if published else None,
            ],
        )
        for tag in (data.get("tags") or [])[:12]:
            tag = str(tag).strip()[:32]
            if tag:
                conn.execute("INSERT OR IGNORE INTO module_tags (module_id, tag) VALUES (?, ?)", [mid, tag])
        conn.execute(
            "INSERT OR IGNORE INTO module_versions (id, module_id, version, changelog, released_at) VALUES (?, ?, ?, '手工创建', ?)",
            [f"{mid}-manual", mid, str(data.get("version", "1.0.0"))[:20], now()],
        )
        conn.commit()
        op_log(conn, admin["username"], "module.create", mid, "ok", {"slug": slug})
        return ok({"id": mid, "slug": slug})

    import re as _re2
    m = _re2.match(r"^/categories/([\w-]+)/delete$", path)
    if m and method == "POST":
        denied = require("content:delete")
        if denied:
            return denied
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM modules WHERE category_id = ? AND deleted_at IS NULL", [m.group(1)]
        ).fetchone()["n"]
        if used:
            return fail("bad_request", f"该分类下还有 {used} 个模块，请先移动或删除它们")
        conn.execute("UPDATE categories SET deleted_at = ? WHERE id = ?", [now(), m.group(1)])
        conn.commit()
        op_log(conn, admin["username"], "category.delete", m.group(1), "ok")
        return ok({"id": m.group(1), "deleted": True})

    m = _re2.match(r"^/sources/([\w-]+)/delete$", path)
    if m and method == "POST":
        denied = require("content:delete")
        if denied:
            return denied
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM modules WHERE source_id = ? AND deleted_at IS NULL", [m.group(1)]
        ).fetchone()["n"]
        if used:
            return fail("bad_request", f"该仓库下还有 {used} 个模块，请先删除模块")
        conn.execute(
            "UPDATE module_proxy_mappings SET deleted_at = ?, is_enabled = 0 WHERE source_id = ? AND deleted_at IS NULL",
            [now(), m.group(1)],
        )
        conn.execute("UPDATE sources SET deleted_at = ?, is_enabled = 0 WHERE id = ?", [now(), m.group(1)])
        conn.commit()
        op_log(conn, admin["username"], "source.delete", m.group(1), "ok")
        return ok({"id": m.group(1), "deleted": True})

    m = _re2.match(r"^/announcements/([\w-]+)/delete$", path)
    if m and method == "POST":
        denied = require("content:delete")
        if denied:
            return denied
        conn.execute("UPDATE announcements SET deleted_at = ? WHERE id = ?", [now(), m.group(1)])
        conn.commit()
        op_log(conn, admin["username"], "announcement.delete", m.group(1), "ok")
        return ok({"id": m.group(1), "deleted": True})

    if path == "/update-logs":
        if method == "POST":
            denied = require("announcement:write")
            if denied:
                return denied
            data = json_body() or {}
            title = str(data.get("title", "")).strip()[:120]
            if not title:
                return fail("bad_request", "标题不能为空")
            uid = secrets.token_hex(8)
            conn.execute(
                """INSERT INTO update_logs (id, version, title, body, kind, is_published, published_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [uid, str(data.get("version", ""))[:20], title, str(data.get("body", ""))[:4000],
                 str(data.get("kind", "feature")), 1 if data.get("is_published", True) else 0, now()],
            )
            conn.commit()
            op_log(conn, admin["username"], "update_log.create", uid, "ok", {"title": title})
            return ok({"id": uid})
        rows = conn.execute(
            """SELECT id, version, title, body, kind, is_published, published_at
                 FROM update_logs WHERE deleted_at IS NULL ORDER BY published_at DESC LIMIT 100"""
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    m = _re2.match(r"^/update-logs/([\w-]+)$", path)
    if m and method == "DELETE":
        denied = require("content:delete")
        if denied:
            return denied
        conn.execute("UPDATE update_logs SET deleted_at = ? WHERE id = ?", [now(), m.group(1)])
        conn.commit()
        op_log(conn, admin["username"], "update_log.delete", m.group(1), "ok")
        return ok({"id": m.group(1), "deleted": True})

    if path == "/backups":
        if method == "POST":
            denied = require("settings:write")
            if denied:
                return denied
            data = json_body() or {}
            tables = ["modules", "module_tags", "module_versions", "categories", "sources",
                      "module_proxy_mappings", "announcements", "update_logs", "site_settings", "module_overrides"]
            redacted = {"password_hash", "token_hash", "github_token", "secret", "webhook_secret", "api_key"}
            snapshot, counts = {}, {}
            for t in tables:
                try:
                    rows = []
                    for r in conn.execute(f"SELECT * FROM {t}").fetchall():
                        rows.append({k: r[k] for k in r.keys() if k not in redacted})
                    snapshot[t] = rows
                    counts[t] = len(rows)
                except sqlite3.Error:
                    snapshot[t] = []
                    counts[t] = 0
            payload = json.dumps({"version": 1, "createdAt": now(), "tables": snapshot}, ensure_ascii=False)
            bid = secrets.token_hex(8)
            conn.execute(
                "INSERT INTO backups (id, label, scope, payload, bytes, row_counts, created_by) VALUES (?, ?, 'content', ?, ?, ?, ?)",
                [bid, str(data.get("label", ""))[:80] or "未命名备份", payload, len(payload),
                 json.dumps(counts), admin["username"]],
            )
            conn.commit()
            op_log(conn, admin["username"], "backup.create", bid, "ok", counts)
            return ok({"id": bid, "bytes": len(payload), "rowCounts": counts})
        rows = conn.execute(
            "SELECT id, label, scope, bytes, row_counts, created_by, created_at FROM backups ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
        return ok({"items": [row_dict(r) for r in rows]})

    m = _re2.match(r"^/backups/([\w-]+)/download$", path)
    if m:
        row = conn.execute("SELECT payload, created_at FROM backups WHERE id = ?", [m.group(1)]).fetchone()
        if not row:
            return fail("not_found", "备份不存在")
        filename = f"surge-modules-{row['created_at'].replace(':', '-')}.json"
        op_log(conn, admin["username"], "backup.download", m.group(1), "ok")
        return 200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        }, row["payload"].encode()

    m = _re2.match(r"^/backups/([\w-]+)/restore$", path)
    if m and method == "POST":
        denied = require("settings:write")
        if denied:
            return denied
        row = conn.execute("SELECT payload FROM backups WHERE id = ?", [m.group(1)]).fetchone()
        if not row:
            return fail("not_found", "备份不存在")
        try:
            parsed = json.loads(row["payload"])
        except Exception:
            return fail("bad_request", "备份文件已损坏")
        tables = parsed.get("tables", {})
        data = json_body() or {}
        counts = {t: len(tables.get(t, [])) for t in tables}
        if data.get("dryRun") is True:
            return ok({"dryRun": True, "wouldWrite": counts})
        if str(data.get("confirm", "")) != m.group(1):
            return fail("bad_request", "恢复需要显式确认：先以 dryRun 查看影响，再传 confirm=<备份 ID>")
        written = 0
        for t, rows in tables.items():
            for r in rows:
                cols = [k for k in r.keys() if k not in {"password_hash", "token_hash"}]
                if not cols:
                    continue
                try:
                    conn.execute(
                        f"INSERT OR REPLACE INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                        [r[c] for c in cols],
                    )
                    written += 1
                except sqlite3.Error:
                    pass
        conn.commit()
        op_log(conn, admin["username"], "backup.restore", m.group(1), "ok", {"written": written})
        return ok({"restored": True, "written": written})

    m = _re2.match(r"^/backups/([\w-]+)$", path)
    if m and method == "DELETE":
        denied = require("settings:write")
        if denied:
            return denied
        conn.execute("DELETE FROM backups WHERE id = ?", [m.group(1)])
        conn.commit()
        op_log(conn, admin["username"], "backup.delete", m.group(1), "ok")
        return ok({"id": m.group(1), "deleted": True})

    if path == "/operation-logs":
        rows = conn.execute(
            "SELECT actor, action, target, result, detail, created_at FROM operation_logs ORDER BY id DESC LIMIT 200"
        ).fetchall()
        import re as _re3
        items = []
        for r in rows:
            d = row_dict(r)
            if isinstance(d.get("detail"), str):
                d["detail"] = _re3.sub(r"ghp_[A-Za-z0-9]{20,}", "[redacted]", d["detail"])
            items.append(d)
        return ok({"items": items})

    if path == "/config/export":
        rows = conn.execute("SELECT key, value FROM site_settings WHERE scope = 'public'").fetchall()
        op_log(conn, admin["username"], "config.export", None, "ok")
        return ok({"version": 1, "settings": [row_dict(r) for r in rows], "categories": []})

    if path == "/config/import" and method == "POST":
        denied = require("settings:write")
        if denied:
            return denied
        data = json_body() or {}
        written = 0
        for entry in (data.get("settings") or [])[:200]:
            if isinstance(entry, dict) and isinstance(entry.get("key"), str) and isinstance(entry.get("value"), str):
                conn.execute("UPDATE site_settings SET value = ?, updated_at = ? WHERE key = ?",
                             [entry["value"][:500], now(), entry["key"]])
                written += 1
        conn.commit()
        op_log(conn, admin["username"], "config.import", None, "ok", {"settingsWritten": written})
        return ok({"settingsWritten": written})

    return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    morsel = jar.get(COOKIE_NAME)

    return None
