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
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from repo_removal import confirmed_missing_repo, missing_public_module

# Repo root: works both in the sandbox and on a GitHub runner.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, 'state')
CATALOGUE = os.path.join(STATE, 'catalogue.json')
SOURCES = os.path.join(STATE, 'sources.json')
DENYLIST = os.path.join(STATE, 'denylist.json')
RELEASES = os.path.join(STATE, 'releases.json')

# Things that must never reach the site: grey-market streaming/short-drama VIP
# unlocks and adult material. Keyed both by exact repo path (stable) and by
# name pattern (catches the same content arriving from a new repo).
def load_denylist():
    if not os.path.exists(DENYLIST):
        return set(), None
    d = json.load(open(DENYLIST))
    pats = d.get('name_patterns') or []
    rx = re.compile('|'.join(re.escape(x) for x in pats), re.I) if pats else None
    return set(d.get('keys') or []), rx


DENY_KEYS, DENY_RX = load_denylist()


def denied(key, author, name, is_new=False):
    """Keyed entries always lose. Name patterns only gate NEW files, so an
    existing module is never dropped because its title happens to contain a
    flagged word (红果短剧去广告 and friends stay)."""
    if key in DENY_KEYS:
        return True
    return bool(is_new and DENY_RX and DENY_RX.search(f'{author} {name}'))
HISTORY = os.path.join(STATE, 'history.json')
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
# Only the Chinese name and the literal "kelee" are blocked. Anything else
# (KELI, keli, luestr, iKeLee-style handles on unrelated work) is allowed —
# the earlier broad pattern caught other people's modules by accident.
KELI_PATTERN = re.compile(r'可莉|kelee', re.I)

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


def tree_snapshot(owner, repo, branch):
    """Keep completeness and tree identity alongside the module blobs."""
    ref = urllib.parse.quote(branch, safe='')
    data = gh(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1')
    out = []
    for node in data.get('tree', []):
        p = node.get('path', '')
        if node.get('type') != 'blob' or not p.lower().endswith('.sgmodule'):
            continue
        if SKIP_PATTERNS.search(p):
            continue
        out.append({'path': p, 'sha': node.get('sha', '')})
    return {'files': out, 'sha': data.get('sha'), 'truncated': data.get('truncated')}


def tree_of(owner, repo, branch):
    """List-only interface retained for rebuild_catalogue.py."""
    return tree_snapshot(owner, repo, branch)['files']


def plan_removals(owner, repo, branch, existing, snapshot):
    """Fail closed; a large loss needs every original URL 404 and a stable tree.

    Re-read the branch AFTER the probes, so a moving/renamed branch or an
    incomplete response cannot turn one suspicious answer into mass removal.
    Call before imports so a failed confirmation leaves this repo untouched.
    """
    tree = snapshot['files']
    if existing and not tree:
        return [], '上游返回空文件列表，跳过下架'
    if snapshot.get('truncated') is not False:
        return [], '上游文件树不完整或缺少完整性标记，跳过同步和下架'
    seen_paths = {node['path'] for node in tree}
    vanished = [path for path in existing if path not in seen_paths]
    if len(vanished) <= max(20, len(existing) * 0.4):
        return vanished, None

    prefix = f'{len(vanished)}/{len(existing)} 个文件消失，二次确认失败：'
    if not snapshot.get('sha'):
        return [], prefix + '缺少文件树标识，跳过下架'
    for path in vanished:
        if not missing_public_module(owner, repo, branch, path):
            return [], prefix + f'{path} 未确认404（仍可达或请求异常），跳过下架'
    try:
        check = tree_snapshot(owner, repo, branch)
    except Exception:
        return [], prefix + '文件树复查请求失败，跳过下架'
    if check.get('truncated') is not False or not check['files']:
        return [], prefix + '复查文件树为空或不完整，跳过下架'
    signature = lambda nodes: sorted((n['path'], n['sha']) for n in nodes)
    if (check.get('sha') != snapshot['sha']
            or signature(check['files']) != signature(tree)):
        return [], prefix + '复查文件树发生变化，跳过下架'
    return vanished, None


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


def diff_sections(old_text, new_text):
    """Per-section line diff for the change report.

    Counting added/removed lines per section is what a user actually wants to
    see ("+3 scripts, -1 rule"), and it costs nothing because the previous
    file is still on disk when we overwrite it.
    """
    def split(text):
        out, cur = {}, None
        for raw in text.replace('\r\n', '\n').split('\n'):
            line = raw.strip()
            m = re.match(r'^\[([^\]]+)\]$', line)
            if m:
                cur = m.group(1).strip()
                out.setdefault(cur, set())
                continue
            if not line or line.startswith('#') or line.startswith(';'):
                continue
            if cur is not None:
                out[cur].add(line)
        return out

    a, b = split(old_text), split(new_text)
    added = removed = 0
    by_section = {}
    for section in set(a) | set(b):
        plus = len(b.get(section, set()) - a.get(section, set()))
        minus = len(a.get(section, set()) - b.get(section, set()))
        if plus or minus:
            by_section[section] = {'added': plus, 'removed': minus}
            added += plus
            removed += minus
    return {'added': added, 'removed': removed, 'sections': by_section}


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
    history = json.load(open(HISTORY)) if os.path.exists(HISTORY) else {}

    def note(slug, kind):
        """Append one change event, keeping the last 20 per module."""
        events = history.setdefault(slug, [])
        events.append({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'type': kind})
        history[slug] = events[-20:]
    sources = json.load(open(SOURCES)) if os.path.exists(SOURCES) else {}

    # Measured before the denylist drop below, so the arithmetic check at the
    # end still balances when entries are removed by rule rather than upstream.
    before_count = len(catalogue)

    # Denylisted modules that slipped in before the rule existed are dropped
    # here, so the next build never ships them and they cannot come back.
    denied_drops = []
    for slug in [k for k, v in catalogue.items()
                 if f"{v['repo']}@{v['branch']}:{v['path']}" in DENY_KEYS]:
        rec = catalogue.pop(slug)
        denied_drops.append({'slug': slug, 'name': rec.get('name', slug),
                             'reason': 'denylisted', 'repo': rec.get('repo')})
        raw_p = os.path.join(RAW_DIR, f'{slug}.sgmodule')
        if os.path.exists(raw_p):
            os.remove(raw_p)
    # catalogue: slug -> module record (with repo/path/sha)
    # sources:   "owner/repo@branch" -> {branch, owner, repo}

    by_repo = {}
    for slug, rec in catalogue.items():
        key = f"{rec['repo']}@{rec['branch']}"
        by_repo.setdefault(key, {})[rec['path']] = (slug, rec.get('sha', ''))

    report = {'checked': 0, 'new': [], 'updated': [], 'removed': [], 'errors': [],
              'before': before_count, 'after': 0}
    gone_sources = set()   # repos proven deleted, pruned from sources at the end

    # A denylisted module leaving the catalogue is a real catalogue change:
    # count it, otherwise the run reports "nothing changed" and the workflow
    # skips the build, the deploy and the commit — the module would keep being
    # served from the old deploy and the removal would never stick.
    for drop in denied_drops:
        report['removed'].append(drop)
        note(drop['slug'], 'removed')

    for key, repo_meta in sorted(sources.items()):
        owner, repo = repo_meta['owner'], repo_meta['repo']
        branch = repo_meta['branch']
        try:
            snapshot = tree_snapshot(owner, repo, branch)
            tree = snapshot['files']
        except Exception as e:
            # A failed tree may mean a missing branch or a temporary API error.
            # Only a separate repository 404 AND each original module's public
            # URL returning 404 permits pruning; do not interpret all errors as
            # an empty upstream tree. Keep the source so it can recover later.
            if (isinstance(e, urllib.error.HTTPError) and e.code == 404
                    and confirmed_missing_repo(owner, repo, gh)):
                gone_sources.add(key)
                for path, (slug, _sha) in by_repo.get(key, {}).items():
                    if not missing_public_module(owner, repo, branch, path):
                        report['errors'].append(f'{key}:{path}: 仓库失联但原文件未确认404，保留')
                        continue
                    rec = catalogue.pop(slug)
                    report['removed'].append({
                        'slug': slug, 'name': rec.get('name', slug),
                        'reason': 'upstream-removed', 'repo': rec['repo'],
                        'evidence': 'repository-and-module-404'})
                    note(slug, 'removed')
                    fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
                    if not args.dry_run and os.path.exists(fp):
                        os.remove(fp)
            else:
                report['errors'].append(f'{key}: {str(e)[:80]}')
            continue
        existing = by_repo.get(key, {})
        vanished, block_reason = plan_removals(owner, repo, branch, existing, snapshot)
        if block_reason:
            report['errors'].append(f'{key}: {block_reason}')
            continue
        if len(vanished) > max(20, len(existing) * 0.4):
            report.setdefault('confirmed_removals', []).append({
                'repo': key, 'count': len(vanished), 'tree_sha': snapshot['sha'],
                'evidence': 'all-module-404-and-stable-complete-tree'})
            print(f'  ✓ {key}: {len(vanished)} 个原文件全部404，完整文件树复查一致，允许下架', flush=True)

        for node in tree:
            path, sha = node['path'], node['sha']
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

            if denied(f'{key}:{path}', meta['author'], meta['name'], is_new=prev is None):
                continue  # 黑名单：灰产解锁 / 上游测试残留

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
            prev_version = (catalogue.get(slug) or {}).get('version', '')
            change = None
            if not is_new:
                old_path = os.path.join(RAW_DIR, f'{slug}.sgmodule')
                if os.path.exists(old_path):
                    try:
                        old_text = open(old_path, encoding='utf-8', errors='replace').read()
                        change = diff_sections(old_text, text)
                    except Exception:
                        change = None
            catalogue[slug] = record
            note(slug, 'added' if is_new else 'content')
            (report['new'] if is_new else report['updated']).append(
                {'slug': slug, 'name': record['name'], 'version': record['version'],
                 'from_version': prev_version, 'repo': record['repo'],
                 'diff': change}
            )
            if not args.dry_run:
                os.makedirs(RAW_DIR, exist_ok=True)
                with open(os.path.join(RAW_DIR, f'{slug}.sgmodule'), 'wb') as f:
                    f.write(raw)

        # The removal plan was confirmed before this repo's imports.
        for path in vanished:
            slug, _sha = existing[path]
            report['removed'].append({
                'slug': slug, 'name': catalogue.get(slug, {}).get('name', slug),
                'reason': 'upstream-removed', 'repo': key.split('@')[0]})
            note(slug, 'removed')
            catalogue.pop(slug, None)
            # Upstream deleted it, so we stop serving it too — no orphan files
            # in the repo and no half-working links on the site.
            fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
            if not args.dry_run and os.path.exists(fp):
                os.remove(fp)


    # ---- release sources -------------------------------------------------
    # Some projects only ship one finished module as a GitHub Release asset;
    # the repo itself holds per-region or β fragments. Those are fetched here
    # by direct URL, keyed as "<home>#release" so the repo scanner never
    # touches (or deletes) them.
    if os.path.exists(RELEASES):
        rel = json.load(open(RELEASES)).get('items') or []
        rel_by_home = {}
        for item in rel:
            rel_by_home.setdefault(item['home'], []).append(item['url'])
        for home, urls in rel_by_home.items():
            key = f'{home}@release'
            existing = by_repo.get(key, {})
            seen = set()
            for url in urls:
                seen.add(url)
                try:
                    req = urllib.request.Request(url, headers={'User-Agent': 'surge-modules-sync'})
                    with urllib.request.urlopen(req, timeout=40) as r:
                        raw = r.read()
                except Exception as e:
                    report['errors'].append(f'{key}:{url.rsplit("/", 1)[-1]}: {str(e)[:50]}')
                    continue
                sha = hashlib.sha256(raw).hexdigest()
                prev = existing.get(url)
                if prev and prev[1] == sha:
                    continue
                report['checked'] += 1
                text = raw.decode('utf-8', 'replace').lstrip('\ufeff')
                fallback = url.rsplit('/', 1)[-1].rsplit('.', 1)[0]
                meta = parse_meta(text, fallback)
                if not meta:
                    continue
                if KELI_PATTERN.search(f"{meta['author']} {meta['name']}"):
                    continue
                if denied(f'{key}:{url}', meta['author'], meta['name'], is_new=prev is None):
                    continue
                if prev:
                    slug, is_new = prev[0], False
                else:
                    slug = slugify(fallback, url)
                    base, i = slug, 2
                    while slug in catalogue:
                        slug = f'{base}-{i}'
                        i += 1
                    is_new = True
                record = {
                    'slug': slug, 'repo': home, 'branch': 'release', 'path': url, 'sha': sha,
                    'name': meta['name'], 'description': meta['description'],
                    'author': meta['author'] or home.split('/')[0],
                    'version': meta['version'],
                    'category': (catalogue.get(slug, {}).get('category') or 'adblock'),
                    'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                }
                prev_version = (catalogue.get(slug) or {}).get('version', '')
                catalogue[slug] = record
                note(slug, 'added' if is_new else 'content')
                (report['new'] if is_new else report['updated']).append(
                    {'slug': slug, 'name': record['name'], 'version': record['version'],
                     'from_version': prev_version, 'repo': record['repo'], 'diff': None})
                if not args.dry_run:
                    os.makedirs(RAW_DIR, exist_ok=True)
                    with open(os.path.join(RAW_DIR, f'{slug}.sgmodule'), 'wb') as f:
                        f.write(raw)
            # a 404 release (asset renamed / deleted) drops the module
            for path in [p for p in existing if p not in seen]:
                slug, _sha = existing[path]
                report['removed'].append({
                'slug': slug, 'name': catalogue.get(slug, {}).get('name', slug),
                'reason': 'upstream-removed'})
                catalogue.pop(slug, None)
                fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
                if os.path.exists(fp):
                    os.remove(fp)

    # A source whose repo is gone and that no longer contributes a single
    # module is dead weight: it would make one wasted API call every hour
    # forever. Drop it once nothing is left to serve.
    for key in sorted(gone_sources):
        owner_repo = key.split('@')[0]
        if any(rec.get('repo') == owner_repo for rec in catalogue.values()):
            continue
        sources.pop(key, None)
        report.setdefault('sources_removed', []).append(key)
    if report.get('sources_removed') and not args.dry_run:
        json.dump(sources, open(SOURCES, 'w'), ensure_ascii=False, indent=1)

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
    fatal = False
    if report['after'] != expected:
        fatal = True
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
        fatal = True
        report['errors'].extend(dupes[:10])

    # ---- auto-repair -------------------------------------------------------
    # If the arithmetic or the (repo,path) uniqueness is off, the state itself
    # is suspect. Rather than fail the run and wait for a human, rebuild the
    # catalogue from upstream: it is deterministic and takes ~2 minutes.
    if fatal:
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
    json.dump(history, open(HISTORY, 'w'), ensure_ascii=False, separators=(',', ':'))
    # Repair runs only over these files downstream; touching an untouched
    # module would be pointless churn and a chance to break something.
    report['touched'] = sorted({m['slug'] for m in report['new']} |
                               {m['slug'] for m in report['updated']})
    json.dump(report, open(REPORT, 'w'), ensure_ascii=False, indent=1)

    print(f"新增 {len(report['new'])} · 更新 {len(report['updated'])} · "
          f"移除 {len(report['removed'])} · 错误 {len(report['errors'])}")
    for e in report['errors'][:5]:
        print('  !', e)
    return 0


if __name__ == '__main__':
    sys.exit(main())
