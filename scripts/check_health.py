#!/usr/bin/env python3
"""
Module health check.

A Surge module is only as good as the scripts it points at. Upstream authors
move or delete those files all the time, and the module then installs fine but
silently does nothing — the worst failure mode for a user.

This walks every raw/*.sgmodule, extracts `script-path=` URLs and checks them:

  ok        every referenced script answers 2xx
  broken    at least one script is gone (404/410/DNS failure)
  unknown   nothing to check (no scripts) or the host rate-limited us

Result → state/health.json

  { "slug": {"status": "broken", "broken": ["url…"], "checked": "2026-11-13T…"} }

Run: python3 scripts/check_health.py [--limit 50] [--only slug]
"""
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'raw')
STATE = os.path.join(ROOT, 'state')
OUT = os.path.join(STATE, 'health.json')

SCRIPT_RE = re.compile(r'script-path\s*=\s*([^,\s]+)', re.I)
URL_OK = re.compile(r'^https?://', re.I)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Surge/5.0'

import urllib.error
import urllib.request


def probe(url, timeout=12):
    """True when the URL resolves and answers with something usable."""
    for method in ('HEAD', 'GET'):
        req = urllib.request.Request(url, method=method, headers={'User-Agent': UA})
        if method == 'GET':
            req.add_header('Range', 'bytes=0-0')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return 200 <= r.status < 400
        except urllib.error.HTTPError as e:
            # 403/405 = alive but refuses the probe method; treat as ok.
            if e.code in (401, 403, 405, 429):
                return True
            if e.code in (404, 410):
                return False
            if method == 'GET':
                return False
        except Exception:
            if method == 'GET':
                return False
    return False


def classify(url, repo_cache):
    """Why a script is gone: tells the site whether to say "upstream deleted the
    file" or "the whole repo is gone" — they mean very different things to a
    reader deciding whether to wait for a fix."""
    if url.startswith('(relative)'):
        return 'relative-path'
    parts = url.split('/')
    if 'raw.githubusercontent.com' not in url:
        return 'external-host'
    if len(parts) < 5:
        return 'file-removed'
    owner, repo = parts[3], parts[4]
    key = f'{owner}/{repo}'
    if key not in repo_cache:
        req = urllib.request.Request(f'https://api.github.com/repos/{key}',
                                     headers={'User-Agent': UA})
        try:
            with urllib.request.urlopen(req, timeout=12) as r:
                repo_cache[key] = 200 <= r.status < 400
        except urllib.error.HTTPError as e:
            repo_cache[key] = e.code != 404
        except Exception:
            repo_cache[key] = True   # unknown: do not claim the repo is gone
    return 'file-removed' if repo_cache[key] else 'repo-removed'


def scripts_of(text):
    urls = []
    for m in SCRIPT_RE.finditer(text):
        u = m.group(1).strip().strip('"\'')
        if URL_OK.match(u):
            urls.append(u)
        elif u.startswith('/') or '.' in u.split('/')[0]:
            # Relative path: Surge resolves it against the module URL, which is
            # our static host — those files never exist there.
            urls.append(f'(relative) {u}')
    return urls


def main():
    only = None
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1]
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    catalogue = json.load(open(os.path.join(STATE, 'catalogue.json')))
    slugs = [only] if only else sorted(catalogue)
    if limit:
        slugs = slugs[:limit]

    previous = json.load(open(OUT)) if os.path.exists(OUT) else {}

    # 1) collect work
    jobs = []      # (slug, [urls])
    no_scripts = []
    for slug in slugs:
        fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
        if not os.path.exists(fp):
            continue
        text = open(fp, encoding='utf-8', errors='replace').read()
        urls = scripts_of(text)
        if urls:
            jobs.append((slug, urls))
        else:
            no_scripts.append(slug)

    all_urls = sorted({u for _, us in jobs for u in us if not u.startswith('(relative)')})
    print(f'待检模块 {len(jobs)} 个，脚本 URL {len(all_urls)} 个', flush=True)

    # 2) probe each unique URL once
    verdict = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        for i, (url, ok) in enumerate(zip(all_urls, pool.map(probe, all_urls)), 1):
            verdict[url] = ok
            if i % 200 == 0:
                print(f'  {i}/{len(all_urls)}', flush=True)

    # 3) roll up per module
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    out = {}
    broken_count = 0
    repo_cache = {}
    for slug, urls in jobs:
        bad = [u for u in urls if u.startswith('(relative)') or not verdict.get(u, True)]
        status = 'broken' if bad else 'ok'
        reason = None
        if bad:
            broken_count += 1
            reasons = {classify(u, repo_cache) for u in bad}
            reason = reasons.pop() if len(reasons) == 1 else 'mixed'
        out[slug] = {'status': status, 'broken': bad[:5], 'checked': now,
                     'reason': reason}

    # keep previous verdicts for modules we did not scan this round
    for slug, rec in previous.items():
        if slug not in out and slug not in no_scripts:
            out[slug] = rec
    for slug in no_scripts:
        out[slug] = {'status': 'unknown', 'broken': [], 'checked': now}

    json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))

    total = len(out)
    print(f'完成：{total} 个模块 · 脚本失效 {broken_count} 个 · 无脚本 {len(no_scripts)} 个')
    return 0


if __name__ == '__main__':
    sys.exit(main())
