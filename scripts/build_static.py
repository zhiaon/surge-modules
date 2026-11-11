#!/usr/bin/env python3
"""
Build the Pages-ready static payload from /tmp/static_dump/*.json.

    dist/data/settings.json         PublicSettings
    dist/data/categories.json       PublicCategory[]
    dist/data/announcements.json    []
    dist/data/modules.json          PublicModule[]           (whole catalogue)
    dist/data/details/<slug>.json   PublicModuleDetail        (per module)

No D1 access at all — safe to run repeatedly while the database is throttled.
"""
import json
import os
import sys

DUMP = '/tmp/static_dump'
DIST = '/var/minis/workspace/surge-modules/dist'
OUT = os.path.join(DIST, 'data')
# Modules are served straight from the static bundle: /m/<slug>.sgmodule.
# Absolute URL because Surge's install-module link needs a host to fetch from,
# and this string is also used for "copy link" in the UI.
PROXY_BASE = 'https://son.zhiaon.top/m'


def load(name):
    fp = f'{DUMP}/{name}.json'
    if not os.path.exists(fp):
        print(f'! 缺少 {fp} — 先跑 scripts/dump_for_static.py', file=sys.stderr)
        sys.exit(1)
    return json.load(open(fp))


def main():
    modules_raw = load('modules')
    cats_raw = load('categories')
    settings_raw = load('settings')
    tags_raw = load('tags')
    vers_raw = load('versions')
    sources_raw = load('sources')

    s = {r['key']: r['value'] for r in settings_raw}

    # category counts, computed here instead of with a correlated subquery
    counts = {}
    for m in modules_raw:
        cid = m.get('category_id')
        if cid:
            counts[cid] = counts.get(cid, 0) + 1

    cat_by_id = {c['id']: c for c in cats_raw}
    categories = []
    for c in cats_raw:
        categories.append({
            'id': c['id'], 'name': c['name'], 'slug': c['slug'],
            'description': c['description'] or '', 'icon': c['icon'],
            'sortOrder': c['sort_order'], 'moduleCount': counts.get(c['id'], 0),
        })

    tags = {}
    for t in tags_raw:
        tags.setdefault(t['module_id'], []).append(t['tag'])

    vers = {}
    for v in vers_raw:
        vers.setdefault(v['module_id'], []).append({
            'version': v['version'],
            'changelog': v['changelog'] or '',
            'releasedAt': v['released_at'],
            'commitSha': None,
            'commitUrl': None,
        })

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
        'totalVersions': len(vers_raw),
        'sourceCount': len({r.get('s_owner') + '/' + r.get('s_repo')
                             if r.get('s_owner') else r.get('t_owner') + '/' + r.get('t_repo')
                             for r in sources_raw}),
    }

    # zhiaon/Modules (the private first-party repo) has no repository_url in
    # D1 — those modules' repositoryUrl is NULL. Fill it in so the sources
    # sheet groups them under the same entry that sourceCount counts.
    OWNERS_REPO = 'https://github.com/zhiaon/Modules'
    OWNERS_SLUGS = {'dns-lite', 'dns', 'fanqie', 'hongguo', 'ipinfo',
                    'jichang', 'qimao', 'streaming'}
    modules = []
    for m in modules_raw:
        cat = cat_by_id.get(m.get('category_id'))
        slug = m.get('public_slug') or m['slug']
        repo_url = m['repository_url'] or (
            OWNERS_REPO if slug in OWNERS_SLUGS else None)
        modules.append({
            'id': m['id'],
            'slug': m['slug'],
            'name': m['name'],
            'description': m['description'] or '',
            'author': m['author'] or '',
            'category': ({'id': cat['id'], 'name': cat['name'], 'slug': cat['slug']}
                         if cat else None),
            'tags': tags.get(m['id'], [])[:8],
            'version': m['version'] or '1.0.0',
            'updatedAt': m['updated_at'],
            'rawUrl': f'{PROXY_BASE}/{slug}.sgmodule',
            'repositoryUrl': repo_url,
            'isFeatured': bool(m['is_featured']),
        })

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'details'), exist_ok=True)

    json.dump(modules, open(f'{OUT}/modules.json', 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(categories, open(f'{OUT}/categories.json', 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(settings, open(f'{OUT}/settings.json', 'w'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump([], open(f'{OUT}/announcements.json', 'w'))


    # _redirects: the 8 upstream-broken stubs must hard-404 instead of hitting
    # the SPA fallback (a module installer receiving index.html shows
    # "并非有效的 Surge 配置文件"). The 404 target page ships as dist/404.html.
    SKIP = {'alibabagroup', 'cibn', 'flightradar24', 'hdo', 'hello', 'startup',
            'unicom-remove-ads', 'zhaoqianjinbao'}
    redirects = os.path.join(DIST, '_redirects')
    with open(redirects, 'w') as f:
        f.write('# Broken upstream stubs — hard 404, must precede the SPA fallback\n')
        for slug in sorted(SKIP):
            f.write(f'/m/{slug}.sgmodule      /404.html 404\n')

    for mod, raw in zip(modules, modules_raw):
        detail = dict(mod)
        detail['versions'] = vers.get(raw['id'], [])[:20]
        detail['createdAt'] = raw['created_at']
        json.dump(detail, open(f'{OUT}/details/{mod["slug"]}.json', 'w'),
                  ensure_ascii=False, separators=(',', ':'))

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(OUT) for f in fs)
    print(f'模块 {len(modules)} · 分类 {len(categories)} · 详情 {len(modules)}')
    print(f'体积 {total/1024/1024:.2f} MB → {OUT}')


if __name__ == '__main__':
    sys.exit(main())
