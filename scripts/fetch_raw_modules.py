#!/usr/bin/env python3
"""
Copy every published module's raw .sgmodule text into dist/m/<slug>.sgmodule.

This is the "B" proxy design: the files live in the static bundle, and the
proxy Worker simply serves them from the same origin — no mapping table, no
database lookup, no GitHub API call at request time. Adding a module later
means dropping a file in here and redeploying.

Source resolution, in order:
  1. /tmp/static_dump/sources.json gives file_path + owner/repo/branch
  2. raw.githubusercontent.com fetch
  3. skip + report on failure

Run: python3 scripts/fetch_raw_modules.py
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

DIST = '/var/minis/workspace/surge-modules/dist'
OUT = os.path.join(DIST, 'm')
DUMP = '/tmp/static_dump/sources.json'


def fetch(owner, repo, branch, path):
    # quote each segment, keeping the separators
    enc = '/'.join(urllib.parse.quote(seg) for seg in path.split('/'))
    token = os.environ.get('GITHUB_TOKEN', '').strip()

    # Private repositories (zhiaon/Modules) need the API with a bearer token;
    # raw.githubusercontent.com always 404s for them.
    if token:
        url = f'https://api.github.com/repos/{owner}/{repo}/contents/{enc}?ref={branch}'
        req = urllib.request.Request(url, headers={
            'User-Agent': 'sm-static-export',
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github.raw',
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception:
            pass  # fall through to the public path

    url = f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{enc}'
    req = urllib.request.Request(url, headers={'User-Agent': 'sm-static-export'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main():
    if not os.path.exists(DUMP):
        print(f'! 缺少 {DUMP}', file=sys.stderr)
        return 1

    rows = json.load(open(DUMP))
    os.makedirs(OUT, exist_ok=True)

    # Upstream-broken modules: fmz200's split archive contains a handful of
    # metadata-only stubs (the author moved the real rules out; the stub keeps
    # only the #! header). Surge rejects them with SGSettingsModelErrorDomain:2,
    # so they stay out of the bundle and out of the catalogue.
    SKIP = {'alibabagroup', 'cibn', 'flightradar24', 'hdo', 'hello', 'startup',
            'unicom-remove-ads', 'zhaoqianjinbao'}

    ok = skipped = failed = 0
    index = {}

    for i, r in enumerate(rows, 1):
        slug = r.get('public_slug')
        path = r.get('file_path')
        if not slug or not path:
            skipped += 1
            continue
        if slug in SKIP:
            skipped += 1
            continue

        if r.get('s_owner'):
            owner, repo, branch = r['s_owner'], r['s_repo'], r['s_branch']
        elif r.get('t_owner'):
            owner, repo, branch = r['t_owner'], r['t_repo'], r['t_branch'] or 'main'
        else:
            skipped += 1
            continue

        target = os.path.join(OUT, f'{slug}.sgmodule')
        if os.path.exists(target):
            ok += 1
            index[slug] = path
            continue

        try:
            data = fetch(owner, repo, branch, path)
        except Exception:
            failed += 1
            continue

        with open(target, 'wb') as f:
            f.write(data)
        index[slug] = path
        ok += 1

        if i % 100 == 0:
            print(f'  {i}/{len(rows)} … ok={ok} fail={failed}', flush=True)

    # The proxy needs to know which slugs exist; a manifest beats a 404 probe.
    json.dump(sorted(k for k in index.keys() if k not in SKIP),
              open(os.path.join(DIST, 'm-index.json'), 'w'))

    print(f'完成：{ok} 个文件，跳过 {skipped}，失败 {failed}')
    print(f'→ {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
