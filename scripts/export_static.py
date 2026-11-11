#!/usr/bin/env python3
"""
Export the live D1 data into static JSON for a Pages deployment.

The site is moving to pure static hosting: no Worker, no D1 at request time.
Everything the frontend needs is emitted here, once, at build time:

  dist/data/settings.json      PublicSettings
  dist/data/categories.json    PublicCategory[]
  dist/data/modules.json       PublicModule[]          (the whole catalogue)
  dist/data/details/<slug>.json  PublicModuleDetail     (per module)

The module list is a single file on purpose: 1270 modules ≈ 500 KB raw,
~110 KB gzipped — one request, then every search/filter/sort runs locally.

Run:  python3 scripts/export_static.py
"""
import json
import os
import re
import subprocess
import sys

WORKDIR = '/var/minis/workspace/surge-modules'
ACCOUNT = '7a89ed189beac8f21cb18dfed4e1668c'
DB = 'surge-modules'
OUT = os.path.join(WORKDIR, 'dist', 'data')
PROXY_BASE = 'https://sgmd.zhiaon.top'


def d1(sql):
    out = subprocess.run(
        ['node', 'node_modules/wrangler/wrangler-dist/cli.js', 'd1', 'execute',
         DB, '--remote', '--command', sql, '--json'],
        cwd=WORKDIR, capture_output=True, text=True,
        env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': ACCOUNT},
    )
    lines = out.stdout.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.strip() == '['), None)
    if start is None:
        raise RuntimeError((out.stdout or out.stderr)[:500])
    return json.loads('\n'.join(lines[start:]))[0]['results']


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'details'), exist_ok=True)

    print('1/4 读取设置与分类…', flush=True)
    settings_rows = d1("SELECT key, value FROM site_settings;")
    s = {r['key']: r['value'] for r in settings_rows}

    # No correlated subquery: on a 1270-row table D1 evaluates it per category
    # and each evaluation is a fresh scan, which alone blew past the daily row
    # budget. One flat query + in-memory counting costs a single scan.
    cats = d1("""
        SELECT c.id, c.name, c.slug, c.description, c.icon, c.sort_order
          FROM categories c
         WHERE c.deleted_at IS NULL
         ORDER BY c.sort_order ASC, c.name ASC;
    """)
    counts = {c['id']: 0 for c in cats}
    for row in d1("""
        SELECT category_id, COUNT(*) AS n FROM modules
         WHERE deleted_at IS NULL AND is_published = 1
         GROUP BY category_id;
    """):
        if row['category_id'] in counts:
            counts[row['category_id']] = row['n']

    categories = [{
        'id': c['id'], 'name': c['name'], 'slug': c['slug'],
        'description': c['description'] or '', 'icon': c['icon'],
        'sortOrder': c['sort_order'], 'moduleCount': counts.get(c['id'], 0),
    } for c in cats]

    settings = {
        'contactTelegram': s.get('contact.telegram', ''),
        'siteName': s.get('site.name', 'Surge Modules'),
        'tagline': s.get('site.tagline', ''),
        'description': s.get('site.description', ''),
        'locale': 'zh-CN',
        'version': s.get('site.version', '2.0.0'),
        'perPageDefault': 24,
        'perPageMax': 60,
        'proxyBase': PROXY_BASE,
    }

    print('2/4 读取模块目录…', flush=True)
    # Paged: a 1270-row result with two joins is fine, but paging keeps each
    # management-API call cheap and lets us report progress.
    rows = []
    PAGE = 300
    offset = 0
    while True:
        chunk = d1(f"""
            SELECT m.id, m.slug, m.name, m.description, m.author, m.version,
                   m.updated_at, m.created_at, m.is_featured, m.repository_url,
                   c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug,
                   p.public_slug
              FROM modules m
              LEFT JOIN categories c ON c.id = m.category_id
              LEFT JOIN module_proxy_mappings p
                     ON p.module_id = m.id AND p.deleted_at IS NULL
             WHERE m.deleted_at IS NULL AND m.is_published = 1
             ORDER BY m.updated_at DESC
             LIMIT {PAGE} OFFSET {offset};
        """)
        rows.extend(chunk)
        print(f'    ... {len(rows)} 行', flush=True)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    print(f'    共 {len(rows)} 个模块', flush=True)

    # tags per module, one query
    tag_rows = d1("""
        SELECT mt.module_id, mt.tag FROM module_tags mt
          JOIN modules m ON m.id = mt.module_id
         WHERE m.deleted_at IS NULL AND m.is_published = 1;
    """)
    tags = {}
    for t in tag_rows:
        tags.setdefault(t['module_id'], []).append(t['tag'])

    modules = []
    for r in rows:
        slug = r['public_slug'] or r['slug']
        modules.append({
            'id': r['id'],
            'slug': r['slug'],
            'name': r['name'],
            'description': r['description'] or '',
            'author': r['author'] or '',
            'category': ({'id': r['cat_id'], 'name': r['cat_name'], 'slug': r['cat_slug']}
                         if r['cat_id'] else None),
            'tags': tags.get(r['id'], [])[:8],
            'version': r['version'] or '1.0.0',
            'updatedAt': r['updated_at'],
            'rawUrl': f'{PROXY_BASE}/{slug}',
            'repositoryUrl': r['repository_url'],
            'isFeatured': bool(r['is_featured']),
        })

    print('3/4 写入列表与设置…', flush=True)
    json.dump(modules, open(os.path.join(OUT, 'modules.json'), 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(categories, open(os.path.join(OUT, 'categories.json'), 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(settings, open(os.path.join(OUT, 'settings.json'), 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump([], open(os.path.join(OUT, 'announcements.json'), 'w'))

    print('4/4 写入详情与版本记录…', flush=True)
    vers = []
    PG = 400
    off = 0
    while True:
        c = d1(f"""
            SELECT v.module_id, v.version, v.changelog, v.released_at
              FROM module_versions v
              JOIN modules m ON m.id = v.module_id
             WHERE m.deleted_at IS NULL AND m.is_published = 1
             ORDER BY v.released_at DESC
             LIMIT {PG} OFFSET {off};
        """)
        vers.extend(c)
        if len(c) < PG:
            break
        off += PG
    print(f'    {len(vers)} 条版本记录', flush=True)
    by_module = {}
    for v in vers:
        by_module.setdefault(v['module_id'], []).append({
            'version': v['version'],
            'changelog': v['changelog'] or '',
            'releasedAt': v['released_at'],
            'commitSha': None,
            'commitUrl': None,
        })

    # The raw sgmodule text is no longer served from D1; the detail page reads
    # it from the static copy under /m/<slug>.sgmodule when it exists.
    written = 0
    for m, r in zip(modules, rows):
        detail = dict(m)
        detail['versions'] = by_module.get(r['id'], [])[:20]
        detail['createdAt'] = r['created_at']
        fp = os.path.join(OUT, 'details', f'{m["slug"]}.json')
        json.dump(detail, open(fp, 'w'), ensure_ascii=False, separators=(',', ':'))
        written += 1
    print(f'    {written} 个详情文件', flush=True)

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(OUT) for f in fs)
    print(f'完成：{total/1024/1024:.1f} MB → {OUT}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
