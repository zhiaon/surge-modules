#!/usr/bin/env python3
"""
Minimal local preview server.

Replaces the Node dev server on this device: Node reserved ~84 MB resident and
the box only has a few hundred MB free, so the OS kept killing it. CPython with
the standard library stays under ~20 MB for the same workload.

Scope is deliberately narrow — it is a *preview* server:
  * serves ./dist with SPA fallback
  * implements the read-only /api/v1 endpoints the frontend calls
  * proxies /<slug> from the module_proxy_mappings table to GitHub

It is not a reimplementation of the worker: the SQL is copied verbatim from
workers/site/db.ts so query semantics stay identical, and any endpoint that is
not needed for browsing is simply absent (the frontend shows its error state).

Usage: python3 scripts/serve.py [--port 8787] [--proxy-port 8788]
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_api import handle as handle_admin  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DB = ROOT / ".wrangler" / "local" / "dev.db"

GITHUB_API = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_READ_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""

MAX_MODULE_BYTES = 256 * 1024
PER_PAGE_MAX = 60
PER_PAGE_DEFAULT = 20

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/javascript", ".js")


# --------------------------------------------------------------------- helpers
def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def settings(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM site_settings WHERE scope='public'"
    ).fetchall()
    raw = {r["key"]: r["value"] for r in rows}
    return {
        "siteName": raw.get("site.name", "Surge Modules"),
        "tagline": raw.get("site.tagline", ""),
        "description": raw.get("site.description", ""),
        "locale": raw.get("site.locale", "zh-CN"),
        "version": raw.get("site.version", "0.0.0"),
        "perPageDefault": int(raw.get("modules.per_page_default", PER_PAGE_DEFAULT)),
        "perPageMax": int(raw.get("modules.per_page_max", PER_PAGE_MAX)),
        "proxyBase": raw.get("proxy.public_base", ""),
    }


def proxy_url(conf: dict, slug: str) -> str:
    base = (conf.get("proxyBase") or "").strip()
    return f"{base.rstrip('/')}/{slug}" if base else ""


def like_escape(value: str) -> str:
    """Mirror of packages/shared/src/query.ts likeEscape."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def tokenize(value: str) -> list[str]:
    out, cur = [], ""
    for ch in value.lower():
        if ch in " \t,，、":
            if cur:
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out[:6]


MODULE_COLUMNS = """
    m.id, m.slug, m.name, m.description, m.author, m.version,
    m.updated_at, m.created_at, m.repository_url, m.is_featured,
    m.category_id, c.name AS category_name, c.slug AS category_slug
"""

MODULE_FROM = """
    FROM modules m
    LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL
   WHERE m.deleted_at IS NULL AND m.is_published = 1
"""


def row_to_module(row: sqlite3.Row, tags: list[str], conf: dict) -> dict:
    return {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "description": row["description"],
        "author": row["author"],
        "category": (
            {
                "id": row["category_id"],
                "name": row["category_name"],
                "slug": row["category_slug"],
            }
            if row["category_id"]
            else None
        ),
        "tags": tags,
        "version": row["version"],
        "updatedAt": row["updated_at"],
        "rawUrl": proxy_url(conf, row["slug"]),
        "repositoryUrl": row["repository_url"],
        "isFeatured": bool(row["is_featured"]),
    }


def tags_for(conn: sqlite3.Connection, ids: list[str]) -> dict[str, list[str]]:
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT module_id, tag FROM module_tags WHERE module_id IN ({marks})", ids
    ).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["module_id"], []).append(r["tag"])
    return out


def list_modules(conn: sqlite3.Connection, qs: dict, conf: dict) -> tuple[list, dict]:
    where, binds = [], []

    try:
        page = max(1, min(int(qs.get("page", ["1"])[0]), 10000))
    except ValueError:
        page = 1
    try:
        per_page = int(qs.get("perPage", [str(PER_PAGE_DEFAULT)])[0])
    except ValueError:
        per_page = PER_PAGE_DEFAULT
    per_page = max(1, min(per_page, conf["perPageMax"] or PER_PAGE_MAX))

    category = (qs.get("category", [""])[0] or "").strip()
    if category and category.replace("-", "").isalnum():
        where.append("c.slug = ?")
        binds.append(category)

    if qs.get("featured", ["0"])[0] in ("1", "true"):
        where.append("m.is_featured = 1")

    tag = (qs.get("tag", [""])[0] or "").strip()[:40]
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM module_tags t WHERE t.module_id = m.id AND LOWER(t.tag) = LOWER(?))"
        )
        binds.append(tag)

    search = (qs.get("q", [""])[0] or "").strip()[:80]
    for token in tokenize(search):
        pattern = f"%{like_escape(token)}%"
        where.append(
            """(m.name LIKE ? ESCAPE '\\' OR m.author LIKE ? ESCAPE '\\'
                OR m.description LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM module_tags t2 WHERE t2.module_id = m.id
                           AND t2.tag LIKE ? ESCAPE '\\'))"""
        )
        binds.extend([pattern, pattern, pattern, pattern])

    where_sql = (" AND " + " AND ".join(where)) if where else ""

    total = conn.execute(
        "SELECT COUNT(*) AS n FROM modules m "
        "LEFT JOIN categories c ON c.id = m.category_id AND c.deleted_at IS NULL "
        f"WHERE m.deleted_at IS NULL AND m.is_published = 1{where_sql}",
        binds,
    ).fetchone()["n"]

    total_pages = max(1, (total + per_page - 1) // per_page)
    page = min(page, total_pages)

    sort = qs.get("sort", ["updated"])[0]
    order = {
        "name": "m.name COLLATE NOCASE ASC",
        "created": "m.created_at DESC",
        "featured": "m.is_featured DESC, m.updated_at DESC",
    }.get(sort, "m.updated_at DESC")

    rows = conn.execute(
        f"SELECT {MODULE_COLUMNS} {MODULE_FROM}{where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        [*binds, per_page, (page - 1) * per_page],
    ).fetchall()

    tag_map = tags_for(conn, [r["id"] for r in rows])
    items = [row_to_module(r, tag_map.get(r["id"], []), conf) for r in rows]
    return items, {
        "page": page,
        "perPage": per_page,
        "total": total,
        "totalPages": total_pages,
    }


def module_detail(conn: sqlite3.Connection, slug: str, conf: dict) -> dict | None:
    row = conn.execute(
        f"SELECT {MODULE_COLUMNS} {MODULE_FROM} AND m.slug = ? LIMIT 1", [slug]
    ).fetchone()
    if not row:
        return None
    tag_map = tags_for(conn, [row["id"]])
    out = row_to_module(row, tag_map.get(row["id"], []), conf)
    versions = conn.execute(
        """SELECT version, changelog, released_at, commit_sha, commit_url
             FROM module_versions WHERE module_id = ?
            ORDER BY released_at DESC LIMIT 50""",
        [row["id"]],
    ).fetchall()
    out["versions"] = [
        {
            "version": v["version"],
            "changelog": v["changelog"],
            "releasedAt": v["released_at"],
            "commitSha": v["commit_sha"],
            "commitUrl": v["commit_url"],
        }
        for v in versions
    ]
    out["createdAt"] = row["created_at"]
    return out


def categories(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order,
                  (SELECT COUNT(*) FROM modules m
                    WHERE m.category_id = c.id AND m.deleted_at IS NULL
                      AND m.is_published = 1) AS module_count
             FROM categories c
            WHERE c.deleted_at IS NULL AND c.is_visible = 1
            ORDER BY c.sort_order ASC, c.name ASC"""
    ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "slug": r["slug"],
            "description": r["description"],
            "icon": r["icon"],
            "sortOrder": r["sort_order"],
            "moduleCount": r["module_count"],
        }
        for r in rows
    ]


def announcements(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT id, title, body, level, is_pinned, published_at
             FROM announcements
            WHERE deleted_at IS NULL AND is_published = 1
            ORDER BY is_pinned DESC, published_at DESC LIMIT 20"""
    ).fetchall()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "body": r["body"],
            "level": r["level"] if r["level"] in ("info", "warning", "critical") else "info",
            "isPinned": bool(r["is_pinned"]),
            "publishedAt": r["published_at"],
        }
        for r in rows
    ]


# ---------------------------------------------------------------- HTTP handler
def json_response(payload: dict, status: int = 200) -> tuple[int, dict, bytes]:
    body = json.dumps(payload, ensure_ascii=False).encode()
    return status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }, body


def err(code: str, message: str) -> tuple[int, dict, bytes]:
    status = {
        "bad_request": 400,
        "not_found": 404,
        "method_not_allowed": 405,
        "payload_too_large": 413,
        "too_many_requests": 429,
        "internal_error": 500,
        "forbidden": 403,
        "upstream_timeout": 504,
        "upstream_error": 502,
    }.get(code, 500)
    return json_response({"ok": False, "error": {"code": code, "message": message}}, status)


def ok(data, meta=None, status=200):
    payload = {"ok": True, "data": data}
    if meta is not None:
        payload["meta"] = meta
    return json_response(payload, status)


class SiteHandler(BaseHTTPRequestHandler):
    server_version = "surge-modules-preview"

    def log_message(self, fmt, *a):  # keep the console readable
        if self.path.startswith("/api/"):
            sys.stderr.write("[api] %s %s\n" % (self.command, self.path))

    def _send(self, status: int, headers: dict, body: bytes):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _route_api(self, path: str, qs: dict) -> tuple[int, dict, bytes]:
        if not DB.exists():
            return err("internal_error", "数据库不存在，先运行 npm run dev:local")

        # admin routes live under /api/v1/admin and have their own auth
        if path == "/admin" or path.startswith("/admin/"):
            conn = db()
            try:
                body = b""
                if self.command in ("POST", "PATCH", "PUT", "DELETE"):
                    length = int(self.headers.get("content-length") or 0)
                    if length > 65536:
                        return err("payload_too_large", "请求体过大")
                    body = self.rfile.read(length) if length else b""
                sys.stderr.write(f"[admin] {self.command} {path} -> {path[len('/admin'):] or '/'}\n")
                result = handle_admin(
                    self.command,
                    path[len("/admin"):] or "/",
                    qs,
                    body,
                    self.headers.get("cookie"),
                    conn,
                )
                if result is None:
                    return err("not_found", "管理接口不存在")
                return result
            finally:
                conn.close()

        conn = db()
        try:
            conf = settings(conn)

            if path == "/health":
                return ok({"status": "ok", "env": "non-production", "db": True})

            if path == "/modules":
                items, meta = list_modules(conn, qs, conf)
                return ok(items, meta)

            if path.startswith("/modules/"):
                rest = path[len("/modules/"):]
                slug = rest.split("/")[0]
                if not slug or not all(c.isalnum() or c == "-" for c in slug):
                    return err("bad_request", "slug 格式不合法")
                if rest.endswith("/versions"):
                    detail = module_detail(conn, slug, conf)
                    if detail is None:
                        return err("not_found", "模块不存在或未发布")
                    return ok(detail["versions"])
                if "/" in rest:
                    return err("bad_request", "路径不合法")
                detail = module_detail(conn, slug, conf)
                if detail is None:
                    return err("not_found", "模块不存在或未发布")
                return ok(detail)

            if path == "/categories":
                return ok(categories(conn))

            if path == "/announcements":
                return ok(announcements(conn))

            if path == "/settings":
                return ok(conf)

            if path == "/analytics":
                # accepted locally, not persisted: the point of a preview is
                # that nothing leaves the machine
                return ok({"accepted": 0}, status=202)

            return err("not_found", "接口不存在")
        finally:
            conn.close()

    def _serve_static(self, path: str):
        if not DIST.exists():
            self._send(503, {"Content-Type": "text/plain; charset=utf-8"},
                       b"frontend not built. run: npm run build")
            return

        rel = unquote(path).lstrip("/")
        target = (DIST / rel).resolve()

        # never escape dist/
        if not str(target).startswith(str(DIST.resolve())):
            self._send(403, {"Content-Type": "text/plain"}, b"forbidden")
            return

        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            target = DIST / "index.html"  # SPA fallback

        if not target.exists():
            self._send(404, {"Content-Type": "text/plain"}, b"not found")
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        body = target.read_bytes()
        # assets are hashed; index.html must never be cached in preview
        cache = "public, max-age=31536000, immutable" if "/assets/" in str(target) else "no-store"
        self._send(200, {"Content-Type": ctype, "Cache-Control": cache}, body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/v1"):
            rest = path[len("/api/v1"):] or "/"
            status, headers, body = self._route_api(rest, _qs(parsed.query))
            self._send(status, headers, body)
            return

        self._serve_static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self._dispatch_write()

    def do_PATCH(self):
        self._dispatch_write()

    def do_DELETE(self):
        self._dispatch_write()

    def _dispatch_write(self):
        """Non-GET requests: analytics plus the admin API (which has its own auth)."""
        parsed = urlparse(self.path)

        if parsed.path.startswith("/api/v1/analytics"):
            # body must be drained even when rejected, or the socket stalls
            length = int(self.headers.get("content-length") or 0)
            if length > 1024:
                self.rfile.read(length)
                status, headers, body = err("payload_too_large", "请求体过大")
            else:
                self.rfile.read(length)
                status, headers, body = ok({"accepted": 0}, status=202)
            self._send(status, headers, body)
            return

        if parsed.path.startswith("/api/v1/admin"):
            # hand over the full admin path: _route_api strips the /admin prefix
            # itself, so slicing it here would make it match nothing
            rest = parsed.path[len("/api/v1"):] or "/"
            status, headers, body = self._route_api(rest, _qs(parsed.query))
            self._send(status, headers, body)
            return

        status, headers, body = err("method_not_allowed", "只支持 GET")
        self._send(status, headers, body)


def _qs(query: str) -> dict:
    out: dict[str, list[str]] = {}
    for pair in query.split("&"):
        if not pair:
            continue
        k, _, v = pair.partition("=")
        out.setdefault(unquote(k), []).append(unquote(v))
    return out


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "surge-modules-proxy-preview"

    def log_message(self, fmt, *a):
        sys.stderr.write("[proxy] %s %s\n" % (self.command, self.path))

    def _send(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, {"Content-Type": "application/json; charset=utf-8",
                            "Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff"},
                   json.dumps(payload, ensure_ascii=False).encode())

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", ""):
            self._send(200, {"Content-Type": "text/plain; charset=utf-8"},
                       b"surge-modules proxy preview\nGET /<slug>\n")
            return
        if path == "/health":
            self._send(200, {"Content-Type": "text/plain; charset=utf-8"}, b"ok\n")
            return
        if parsed.query:
            self._json(400, {"ok": False, "error": {"code": "bad_request", "message": "不支持查询参数"}})
            return

        segments = [s for s in path.split("/") if s]
        if len(segments) != 1:
            self._json(400, {"ok": False, "error": {"code": "bad_request", "message": "路径格式应为 /<module-slug>"}})
            return

        slug = segments[0]
        if not all(c.isalnum() or c == "-" for c in slug) or not slug:
            self._json(400, {"ok": False, "error": {"code": "bad_request", "message": "slug 格式不合法"}})
            return

        if not DB.exists():
            self._json(500, {"ok": False, "error": {"code": "internal_error", "message": "数据库未配置"}})
            return

        conn = db()
        try:
            row = conn.execute(
                """SELECT p.public_slug, p.file_path, p.content_hash,
                          s.owner, s.repo, s.branch, s.allow_paths
                     FROM module_proxy_mappings p
                     JOIN sources s ON s.id = p.source_id
                    WHERE p.public_slug = ?
                      AND p.deleted_at IS NULL AND p.is_enabled = 1
                      AND s.deleted_at IS NULL AND s.is_enabled = 1
                    LIMIT 1""",
                [slug],
            ).fetchone()
        finally:
            conn.close()

        if not row:
            self._json(404, {"ok": False, "error": {"code": "not_found", "message": "模块不存在"}})
            return

        if not _safe_path(row["file_path"]):
            self._json(404, {"ok": False, "error": {"code": "not_found", "message": "模块不存在"}})
            return
        if not _allowed_path(row["file_path"], row["allow_paths"]):
            self._json(404, {"ok": False, "error": {"code": "not_found", "message": "模块不存在"}})
            return

        if not TOKEN:
            self._json(500, {"ok": False, "error": {"code": "internal_error", "message": "未配置读取凭据"}})
            return

        url = (
            f"{GITHUB_API}/repos/{row['owner']}/{row['repo']}/contents/"
            f"{row['file_path']}?ref={row['branch']}"
        )
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/vnd.github.raw",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "surge-modules-proxy-preview",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(MAX_MODULE_BYTES + 1)
                etag = resp.headers.get("ETag", "")
        except urllib.error.HTTPError as e:
            e.read()
            if e.code == 404:
                self._json(404, {"ok": False, "error": {"code": "not_found", "message": "源文件不存在"}})
            elif e.code in (401, 403):
                rem = e.headers.get("X-RateLimit-Remaining") if e.headers else None
                if rem == "0":
                    self._json(429, {"ok": False, "error": {"code": "too_many_requests", "message": "源站限流，请稍后重试"}})
                else:
                    self._json(403, {"ok": False, "error": {"code": "forbidden", "message": "无权读取源文件"}})
            else:
                self._json(502, {"ok": False, "error": {"code": "upstream_error", "message": "源站返回异常"}})
            return
        except TimeoutError:
            self._json(504, {"ok": False, "error": {"code": "upstream_timeout", "message": "源站响应超时"}})
            return
        except Exception:
            self._json(502, {"ok": False, "error": {"code": "upstream_error", "message": "源站返回异常"}})
            return

        if len(body) > MAX_MODULE_BYTES:
            self._json(413, {"ok": False, "error": {"code": "payload_too_large", "message": "模块文件超过大小上限"}})
            return

        revision = (row["content_hash"] or "v0")[:64]
        self._send(
            200,
            {
                "Content-Type": "text/plain; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "public, max-age=60",
                "ETag": f'"{revision}"',
                "X-Module-Revision": revision,
                "X-Proxy-Cache": "miss",
            },
            body,
        )

    def do_HEAD(self):
        self.do_GET()


def _safe_path(path: str) -> bool:
    if not path or len(path) > 512 or path.startswith("/") or "\\" in path or ".." in path:
        return False
    if "://" in path:
        return False
    return all(c.isalnum() or c in "./@+-_" for c in path)


def _allowed_path(file_path: str, allow_paths: str) -> bool:
    prefixes = [p.strip() for p in (allow_paths or "").split(",") if p.strip()]
    if not prefixes:
        return True
    for p in prefixes:
        clean = p.lstrip("/")
        if file_path == clean or file_path.startswith(clean + "/"):
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--proxy-port", type=int, default=8788)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    if not DB.exists():
        print(f"数据库不存在：{DB}", file=sys.stderr)
        print("先运行一次 Node 版建库，或手工执行 database/migrations/*.sql", file=sys.stderr)
        sys.exit(1)

    site = ThreadingHTTPServer((args.host, args.port), SiteHandler)
    proxy = ThreadingHTTPServer((args.host, args.proxy_port), ProxyHandler)

    print(f"\n  site   http://localhost:{args.port}")
    print(f"  proxy  http://localhost:{args.proxy_port}")
    print(f"  db     {DB}")
    if not TOKEN:
        print("  提示：未设置 GITHUB_READ_TOKEN，反代无法读取源文件")
    print()

    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        site.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
