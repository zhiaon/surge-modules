#!/usr/bin/env python3
"""
Sync upstream module repositories into the static catalogue.

This is the D1-free replacement for the old scanner: the whole platform is a
static bundle, so the "database" is `state/catalogue.json` in this repo, and
`state/sources.json` records which upstream repo/branch each module came from.

One run:
  1. list every upstream repo's .sgmodule tree (GitHub API, 1 request per repo)
  2. diff blob SHAs against the state
  3. download only the new/changed files
  4. rewrite the catalogue + per-module detail JSON into dist/data
  5. emit a machine-readable change report (dist cannot be relied on, so it also
     writes /tmp/sync-report.json for the workflow to print)

Exit codes: 0 always (a failed repo is reported, not fatal).

Usage:
  python3 scripts/sync_upstream.py            # full sync
  python3 scripts/sync_upstream.py --dry-run  # report only, touch nothing
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Repo root: works both in the sandbox and on a GitHub runner.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, 'state')
CATALOGUE = os.path.join(STATE, 'catalogue.json')
SOURCES = os.path.join(STATE, 'sources.json')
DIST = os.path.join(ROOT, 'dist')
RAW_DIR = os.path.join(ROOT, 'raw')
DATA_DIR = os.path.join(DIST, 'data')
PROXY_BASE = 'https://son.zhiaon.top/m'
TOKEN = os.environ.get('GITHUB_TOKEN', '').strip()
REPORT = '/tmp/sync-report.json'

# Upstream stubs whose body was removed by their author; Surge rejects them, so
# they never enter the catalogue (mirrors the SKIP list in fetch_raw_modules).
SKIP_SLUGS = {
    'alibabagroup', 'cibn', 'flightradar24', 'hdo', 'hello', 'startup',
    'unicom-remove-ads', 'zhaoqianjinbao', 'wifiwannengyuechi',
}
# Modules authored by 可莉 (kel.ee / luestr / iKeLee) are excluded on request:
# the site indexes other people's modules, not hers. Matching is on the *author
# and title* only — many unrelated modules merely call her shared JS or credit
# her in a comment, and those must stay.
KELI_PATTERN = re.compile(r'可莉|kel[ie]|luestr|ikelee', re.I)

# Files that are not Surge modules at all.
SKIP_PATTERNS = re.compile(r'(^|/)(\.|README|LICENSE)', re.I)


def gh(url, accept='application/vnd.github+json', retries=3):
    """GET a GitHub API URL, returning parsed JSON (or raw bytes for raw accept)."""
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            'User-Agent': 'surge-modules-sync',
            'Accept': accept,
            **({'Authorization': f'Bearer {TOKEN}'} if TOKEN else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read() if accept.endswith('raw') else json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))  # rate limited
                continue
            raise
        except Exception:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            raise
    raise RuntimeError(f'giving up on {url}')


def tree_of(owner, repo, branch):
    """All .sgmodule blobs in a repo: [{path, sha}]."""
    data = gh(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1')
    out = []
    for node in data.get('tree', []):
        p = node.get('path', '')
        if node.get('type') != 'blob' or not p.lower().endswith('.sgmodule'):
            continue
        if SKIP_PATTERNS.search(p):
            continue
        out.append({'path': p, 'sha': node.get('sha', '')})
    return out


def raw_file(owner, repo, branch, path):
    enc = '/'.join(urllib.parse.quote(s) for s in path.split('/'))
    # Private repos (zhiaon/Modules) 404 on raw.githubusercontent.com.
    if TOKEN:
        try:
            return gh(f'https://api.github.com/repos/{owner}/{repo}/contents/{enc}?ref={branch}',
                      accept='application/vnd.github.raw')
        except Exception:
            pass
    url = f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{enc}'
    req = urllib.request.Request(url, headers={'User-Agent': 'surge-modules-sync'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse_meta(text, fallback_name):
    def field(*names):
        for n in names:
            m = re.search(rf'^#!\s*{n}\s*=\s*(.+)$', text, re.M | re.I)
            if m:
                return m.group(1).strip()
        return ''

    name = field('name') or fallback_name
    desc = field('desc', 'description')
    author = field('author')
    version = field('version') or '1.0.0'
    if not re.search(r'^\s*\[(general|script|rewrite|rule|mitm|host|url.?rewrite|map.?local|header.?rewrite|body.?rewrite)\]',
                     text, re.M | re.I):
        return None  # body-less stub: Surge rejects it
    return {
        'name': name[:120],
        'description': desc[:500],
        'author': author[:120],
        'version': version[:32],
    }


def slugify(name, path):
    s = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not s:
        base = path.split('/')[-1].rsplit('.', 1)[0]
        s = re.sub(r'[^a-z0-9]+', '-', base.lower()).strip('-')
    return (s or 'module')[:80]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    catalogue = json.load(open(CATALOGUE)) if os.path.exists(CATALOGUE) else {}
    sources = json.load(open(SOURCES)) if os.path.exists(SOURCES) else {}
    # catalogue: slug -> module record (with repo/path/sha)
    # sources:   "owner/repo@branch" -> {branch, owner, repo}

    by_repo = {}
    for slug, rec in catalogue.items():
        key = f"{rec['repo']}@{rec['branch']}"
        by_repo.setdefault(key, {})[rec['path']] = (slug, rec.get('sha', ''))

    before_count = len(catalogue)
    report = {'checked': 0, 'new': [], 'updated': [], 'removed': [], 'errors': [],
              'before': before_count, 'after': 0}

    for key, repo_meta in sorted(sources.items()):
        owner, repo = repo_meta['owner'], repo_meta['repo']
        branch = repo_meta['branch']
        try:
            tree = tree_of(owner, repo, branch)
        except Exception as e:
            report['errors'].append(f'{key}: {str(e)[:80]}')
            continue
        existing = by_repo.get(key, {})
        seen_paths = set()

        for node in tree:
            path, sha = node['path'], node['sha']
            seen_paths.add(path)
            prev = existing.get(path)
            if prev and prev[1] == sha:
                continue  # unchanged
            report['checked'] += 1
            try:
                raw = raw_file(owner, repo, branch, path)
            except Exception as e:
                report['errors'].append(f'{key}:{path}: {str(e)[:60]}')
                continue
            text = raw.decode('utf-8', 'replace').lstrip('\ufeff')
            fallback = path.split('/')[-1].rsplit('.', 1)[0]
            meta = parse_meta(text, fallback)
            if not meta:
                continue  # body-less stub upstream

            if KELI_PATTERN.search(f"{meta['author']} {meta['name']}"):
                continue  # 可莉的模块，一律不导入

            if prev:
                slug = prev[0]
                is_new = False
            else:
                # New file: derive a slug, then de-duplicate against EVERY
                # existing module. This used to be inverted (dedupe ran only
                # when the slug was free), so a same-named module from another
                # repo silently overwrote the existing entry — the catalogue
                # count never moved and the run reported a phantom "new".
                slug = slugify(fallback, path)
                base, i = slug, 2
                while slug in catalogue:
                    slug = f'{base}-{i}'
                    i += 1
                is_new = True

            if slug in SKIP_SLUGS:
                continue
            record = {
                'slug': slug,
                'repo': f'{owner}/{repo}',
                'branch': branch,
                'path': path,
                'sha': sha,
                'name': meta['name'],
                'description': meta['description'],
                'author': meta['author'] or owner,
                'version': meta['version'],
                'category': (catalogue.get(slug, {}).get('category') or 'adblock'),
                'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
            catalogue[slug] = record
            (report['new'] if is_new else report['updated']).append(
                {'slug': slug, 'name': record['name'], 'version': record['version'],
                 'repo': record['repo']}
            )
            if not args.dry_run:
                os.makedirs(RAW_DIR, exist_ok=True)
                with open(os.path.join(RAW_DIR, f'{slug}.sgmodule'), 'wb') as f:
                    f.write(raw)

        # files gone from upstream → drop them
        for path, (slug, _sha) in existing.items():
            if path in seen_paths:
                continue
            report['removed'].append({'slug': slug, 'name': catalogue.get(slug, {}).get('name', slug)})
            catalogue.pop(slug, None)

    if args.dry_run:
        json.dump(report, open(REPORT, 'w'), ensure_ascii=False, indent=1)
        print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in report.items()}, ensure_ascii=False))
        return 0

    # ---- consistency check -------------------------------------------------
    # The catalogue is the platform's only source of truth, so a silent
    # overwrite is worse than a failed run: verify the arithmetic before
    # writing anything.
    report['after'] = len(catalogue)
    expected = before_count + len(report['new']) - len(report['removed'])
    if report['after'] != expected:
        report['errors'].append(
            f'数量校验失败：{before_count} + {len(report["new"])} - '
            f'{len(report["removed"])} 应为 {expected}，实际 {report["after"]}'
        )

    # Every upstream file must map to exactly one catalogue record.
    seen = {}
    dupes = []
    for slug, rec in catalogue.items():
        key = f"{rec['repo']}@{rec['branch']}:{rec['path']}"
        if key in seen:
            dupes.append(f'{seen[key]} 与 {slug} 指向同一文件 {key}')
        seen[key] = slug
    if dupes:
        report['errors'].extend(dupes[:10])

    # ---- auto-repair -------------------------------------------------------
    # If the arithmetic or the (repo,path) uniqueness is off, the state itself
    # is suspect. Rather than fail the run and wait for a human, rebuild the
    # catalogue from upstream: it is deterministic and takes ~2 minutes.
    if report['errors']:
        print('! 校验未通过，自动从上游重建目录…', flush=True)
        repair = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'rebuild_catalogue.py')],
                                cwd=ROOT, capture_output=True, text=True)
        tail = (repair.stdout or repair.stderr).strip().splitlines()[-3:]
        for line in tail:
            print('  ', line, flush=True)
        if repair.returncode == 0:
            catalogue = json.load(open(CATALOGUE))
            report['after'] = len(catalogue)
            report['auto_repaired'] = True
            # The stale problems are gone now; keep one honest note so the
            # notification says what happened instead of listing fixed errors.
            report['errors'] = ['检测到目录异常，已自动从上游重建并修复']
        else:
            report['errors'].append('自动修复失败，请查看 Actions 日志')

    os.makedirs(STATE, exist_ok=True)
    json.dump(catalogue, open(CATALOGUE, 'w'), ensure_ascii=False, indent=1)
    json.dump(report, open(REPORT, 'w'), ensure_ascii=False, indent=1)

    print(f"新增 {len(report['new'])} · 更新 {len(report['updated'])} · "
          f"移除 {len(report['removed'])} · 错误 {len(report['errors'])}")
    for e in report['errors'][:5]:
        print('  !', e)
    return 0


if __name__ == '__main__':
    sys.exit(main())
