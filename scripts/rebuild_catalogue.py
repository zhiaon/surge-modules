#!/usr/bin/env python3
"""
Rebuild state/catalogue.json from scratch by rescanning every upstream repo.

Needed once after the slug-dedupe bug: that bug let a same-named module
overwrite another repo's record, leaving entries that point at the wrong file.
Repairing them by hand is guesswork, so this does a clean sweep:

  - one tree listing per repo (24 API calls)
  - download + parse only files that are not already in raw/
  - de-duplicate slugs correctly (base, base-2, base-3, …)
  - keep each module's category from the previous catalogue, matched by
    repo + path (the only stable identity)

Usage: python3 scripts/rebuild_catalogue.py
"""
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import sync_upstream as su  # noqa: E402  (reuse its GitHub helpers)

STATE = os.path.join(ROOT, 'state')
CATALOGUE = os.path.join(STATE, 'catalogue.json')
SOURCES = os.path.join(STATE, 'sources.json')
RAW_DIR = os.path.join(ROOT, 'raw')


def main():
    sources = json.load(open(SOURCES))
    old = json.load(open(CATALOGUE)) if os.path.exists(CATALOGUE) else {}

    # category by (repo, path) — survives slug churn
    cat_by_file = {f"{r['repo']}@{r['branch']}:{r['path']}": r.get('category')
                   for r in old.values()}

    os.makedirs(RAW_DIR, exist_ok=True)

    # 1) collect every upstream file
    files = []
    for key, meta in sorted(sources.items()):
        try:
            tree = su.tree_of(meta['owner'], meta['repo'], meta['branch'])
        except Exception as e:
            print(f'! {key}: {str(e)[:60]}')
            continue
        for node in tree:
            files.append((meta['owner'], meta['repo'], meta['branch'], node['path'], node['sha']))
    print(f'上游文件 {len(files)} 个', flush=True)

    # 2) fetch + parse (network bound; 8 workers)
    def one(item):
        owner, repo, branch, path, sha = item
        try:
            raw = su.raw_file(owner, repo, branch, path)
        except Exception as e:
            return (item, None, str(e)[:50])
        text = raw.decode('utf-8', 'replace').lstrip('\ufeff')
        fallback = path.split('/')[-1].rsplit('.', 1)[0]
        meta = su.parse_meta(text, fallback)
        return (item, (meta, raw), None)

    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, out in enumerate(pool.map(one, files), 1):
            results.append(out)
            if i % 200 == 0:
                print(f'  {i}/{len(files)}', flush=True)

    # 3) build the catalogue with correct de-duplication
    catalogue = {}
    ok = skipped = errors = 0
    for item, payload, err in results:
        if err or not payload:
            errors += 1
            continue
        owner, repo, branch, path, sha = item
        meta, raw = payload
        if not meta:
            skipped += 1
            continue
        if su.KELI_PATTERN.search(f"{meta['author']} {meta['name']}"):
            skipped += 1
            continue

        fallback = path.split('/')[-1].rsplit('.', 1)[0]
        slug = su.slugify(fallback, path)
        base, i = slug, 2
        while slug in catalogue:
            slug = f'{base}-{i}'
            i += 1

        catalogue[slug] = {
            'slug': slug,
            'repo': f'{owner}/{repo}',
            'branch': branch,
            'path': path,
            'sha': sha,
            'name': meta['name'],
            'description': meta['description'],
            'author': meta['author'] or owner,
            'version': meta['version'],
            'category': cat_by_file.get(f'{owner}/{repo}@{branch}:{path}') or 'adblock',
            'updatedAt': old.get(slug, {}).get('updatedAt')
                         or __import__('time').strftime('%Y-%m-%dT%H:%M:%SZ', __import__('time').gmtime()),
        }
        with open(os.path.join(RAW_DIR, f'{slug}.sgmodule'), 'wb') as f:
            f.write(raw)
        ok += 1

    # 4) drop raw files that no longer belong to any module
    keep = {f'{slug}.sgmodule' for slug in catalogue}
    for f in os.listdir(RAW_DIR):
        if f.endswith('.sgmodule') and f not in keep:
            os.remove(os.path.join(RAW_DIR, f))

    json.dump(catalogue, open(CATALOGUE, 'w'), ensure_ascii=False, indent=1)
    print(f'写入 {ok} 个模块（跳过 {skipped}，失败 {errors}）')
    print(f'旧目录 {len(old)} → 新目录 {len(catalogue)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
