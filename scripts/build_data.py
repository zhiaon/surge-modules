#!/usr/bin/env python3
"""
Build dist/data/* from state/catalogue.json — no database involved.

This replaces build_static.py's D1 dump path so the whole pipeline can run in
CI from the repo alone:

  state/catalogue.json   →  dist/data/modules.json
                            dist/data/details/<slug>.json
                            dist/data/categories.json
                            dist/data/settings.json

Run: python3 scripts/build_data.py
"""
import json
import os
import sys

# Repo root: works both in the sandbox and on a GitHub runner.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, 'state', 'catalogue.json')
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(DIST, 'data')
RAW_DIR = os.path.join(ROOT, 'raw')
DIST_RAW = os.path.join(DIST, 'm')
PROXY_BASE = 'https://son.zhiaon.top/m'

# The site's fixed taxonomy. Upstream files rarely carry a usable category, so
# everything defaults here; the slug must match an entry to be counted.
CATEGORIES = [
    {'id': 'cat-adblock', 'name': '广告拦截', 'slug': 'adblock',
     'description': '在请求层拦截网页与 App 内的广告、统计与追踪域名。', 'icon': 'shield', 'sortOrder': 1},
    {'id': 'cat-rules', 'name': '规则与分流', 'slug': 'rules',
     'description': '补充域名规则、策略组与更细粒度的分流判断。', 'icon': 'waypoints', 'sortOrder': 2},
    {'id': 'cat-scripts', 'name': '脚本增强', 'slug': 'scripts',
     'description': '定时任务、自动签到与基于 HTTP 的轻量自动化。', 'icon': 'terminal', 'sortOrder': 3},
    {'id': 'cat-clean', 'name': '应用净化', 'slug': 'clean',
     'description': '移除开屏广告、信息流推荐与多余的运营弹窗。', 'icon': 'sparkles', 'sortOrder': 4},
    {'id': 'cat-privacy', 'name': '隐私防护', 'slug': 'privacy',
     'description': '阻断设备指纹、追踪像素与遥测上报。', 'icon': 'eyeoff', 'sortOrder': 5},
    {'id': 'cat-tools', 'name': '网络工具', 'slug': 'tools',
     'description': 'IP 信息、流媒体解锁与网络诊断类模块。', 'icon': 'globe', 'sortOrder': 6},
]

# Modules that are clearly more than ad blocking, keyed by slug. Kept small on
# purpose: guessing from the file name produced more noise than signal.
TOOL_SLUGS = {'dns', 'dns-lite', 'ipinfo', 'jichang', 'streaming', 'netcheck',
              'cloudflare-speedtest', 'speedtest'}

SETTINGS = {
    'contactTelegram': '',
    'siteName': 'Surge Modules',
    'tagline': '让 Surge 模块发现更简单',
    'description': '一个独立的 Surge 模块索引平台：浏览、搜索、收藏与分发模块，查看原始配置与版本记录。',
    'locale': 'zh-CN',
    'version': '2.0.0',
    'perPageDefault': 24,
    'perPageMax': 60,
    'proxyBase': PROXY_BASE,
}


def category_for(rec):
    # The stored category wins — it came from the curated catalogue. The slug
    # list is only a fallback for records that predate having one.
    cat = (rec.get('category') or '').lower()
    if not cat and rec['slug'] in TOOL_SLUGS:
        return 'tools'
    if not cat:
        return 'adblock'
    valid = {c['slug'] for c in CATEGORIES}
    return cat if cat in valid else 'adblock'


def main():
    if not os.path.exists(STATE):
        print(f'! 缺少 {STATE}', file=sys.stderr)
        return 1
    catalogue = json.load(open(STATE))

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'details'), exist_ok=True)
    os.makedirs(DIST_RAW, exist_ok=True)

    # Copy the committed raw modules into the bundle (vite build wipes dist/).
    for f in os.listdir(RAW_DIR):
        if not f.endswith('.sgmodule'):
            continue
        src = os.path.join(RAW_DIR, f)
        dst = os.path.join(DIST_RAW, f)
        if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
            with open(src, 'rb') as fi, open(dst, 'wb') as fo:
                fo.write(fi.read())

    cat_by_slug = {c['slug']: c for c in CATEGORIES}
    counts = {}

    modules = []
    for rec in catalogue.values():
        cslug = category_for(rec)
        cat = cat_by_slug[cslug]
        counts[cslug] = counts.get(cslug, 0) + 1
        modules.append({
            'id': f"mod-{rec['slug']}",
            'slug': rec['slug'],
            'name': rec['name'],
            'description': rec['description'],
            'author': rec['author'],
            'category': {'id': cat['id'], 'name': cat['name'], 'slug': cat['slug']},
            'tags': [],
            'version': rec['version'],
            'updatedAt': rec['updatedAt'],
            'rawUrl': f"{PROXY_BASE}/{rec['slug']}.sgmodule",
            'repositoryUrl': f"https://github.com/{rec['repo']}",
            'isFeatured': False,
        })

    modules.sort(key=lambda m: m['updatedAt'], reverse=True)

    categories = [{
        'id': c['id'], 'name': c['name'], 'slug': c['slug'],
        'description': c['description'], 'icon': c['icon'],
        'sortOrder': c['sortOrder'], 'moduleCount': counts.get(c['slug'], 0),
    } for c in CATEGORIES]

    settings = dict(SETTINGS)
    settings['totalVersions'] = len(modules)
    settings['sourceCount'] = len({r['repo'] for r in catalogue.values()})

    json.dump(modules, open(f'{OUT}/modules.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(categories, open(f'{OUT}/categories.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(settings, open(f'{OUT}/settings.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump([], open(f'{OUT}/announcements.json', 'w'))

    # detail files: one per module, versions come from the state if present
    for rec, mod in zip(catalogue.values(), [m for m in modules]):
        pass
    for mod in modules:
        rec = catalogue[mod['slug']]
        detail = dict(mod)
        detail['versions'] = [{
            'version': rec['version'],
            'changelog': '同步自上游仓库',
            'releasedAt': rec['updatedAt'],
            'commitSha': None,
            'commitUrl': None,
        }]
        detail['createdAt'] = rec['updatedAt']
        json.dump(detail, open(f'{OUT}/details/{mod["slug"]}.json', 'w'),
                  ensure_ascii=False, separators=(',', ':'))

    # prune orphan detail files (removed modules)
    keep = {m['slug'] for m in modules}
    for f in os.listdir(os.path.join(OUT, 'details')):
        if f.endswith('.json') and f[:-5] not in keep:
            os.remove(os.path.join(OUT, 'details', f))

    # placeholder modules for upstream stubs whose body was removed
    for slug in ('alibabagroup', 'cibn', 'flightradar24', 'hdo', 'hello',
                 'startup', 'unicom-remove-ads', 'zhaoqianjinbao', 'wifiwannengyuechi'):
        fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
        if not os.path.exists(fp):
            os.makedirs(RAW_DIR, exist_ok=True)
            with open(fp, 'w', encoding='utf-8') as f:
                f.write('#!name=模块已下架\n'
                        '#!desc=该模块的上游文件已被作者删除，请前往 son.zhiaon.top 选择其他模块\n'
                        '#!author=Surge Modules\n\n[General]\n')

    print(f'模块 {len(modules)} · 分类 {len(categories)} · 来源 {settings["sourceCount"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
