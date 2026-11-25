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
    {'id': 'cat-clean', 'name': '应用净化', 'slug': 'clean',
     'description': '移除开屏广告、信息流推荐与多余的运营弹窗。', 'icon': 'sparkles', 'sortOrder': 2},
    {'id': 'cat-unlock', 'name': '应用解锁', 'slug': 'unlock',
     'description': '解锁会员功能、去除功能限制。', 'icon': 'key', 'sortOrder': 3},
    {'id': 'cat-media', 'name': '流媒体', 'slug': 'media',
     'description': '流媒体平台的解锁、增强与广告清理。', 'icon': 'play', 'sortOrder': 4},
    {'id': 'cat-scripts', 'name': '脚本增强', 'slug': 'scripts',
     'description': '定时任务、自动签到与基于 HTTP 的轻量自动化。', 'icon': 'terminal', 'sortOrder': 5},
    {'id': 'cat-apple', 'name': 'Apple 服务', 'slug': 'apple',
     'description': '改写 Apple 网络请求：Siri、地图、天气、News、TestFlight 等区域与功能开放。', 'icon': 'apple', 'sortOrder': 6},
    {'id': 'cat-subs', 'name': '字幕翻译', 'slug': 'subs',
     'description': '为流媒体自动挂载双语字幕，或翻译页面内容。', 'icon': 'subtitles', 'sortOrder': 7},
    {'id': 'cat-rules', 'name': '规则分流', 'slug': 'rules',
     'description': '补充域名规则、策略组与更细粒度的分流判断。', 'icon': 'waypoints', 'sortOrder': 6},
    {'id': 'cat-privacy', 'name': '隐私防护', 'slug': 'privacy',
     'description': '阻断设备指纹、追踪像素与遥测上报。', 'icon': 'eyeoff', 'sortOrder': 7},
    {'id': 'cat-tools', 'name': '网络工具', 'slug': 'tools',
     'description': 'IP 信息、流媒体解锁与网络诊断类模块。', 'icon': 'globe', 'sortOrder': 8},
]

# Modules that are clearly more than ad blocking, keyed by slug. Kept small on
# purpose: guessing from the file name produced more noise than signal.
TOOL_SLUGS = {'dns', 'dns-lite', 'ipinfo', 'jichang', 'streaming', 'netcheck',
              'cloudflare-speedtest', 'speedtest'}

SETTINGS = {
    'contactTelegram': 'https://t.me/Xzhou_Xz',
    'siteName': 'Surge Modules',
    'tagline': '让 Surge 模块发现更简单',
    'description': '一个独立的 Surge 模块索引平台：浏览、搜索、收藏与分发模块，查看原始配置与版本记录。',
    'locale': 'zh-CN',
    'version': '2.0.0',
    'perPageDefault': 24,
    'perPageMax': 60,
    'proxyBase': PROXY_BASE,
}


def name_key(name):
    """Same normalisation as src/lib/sameName.ts — keep the two in sync."""
    import re as _re
    n = (name or '').lower()
    n = _re.sub(r'[（(][^）)]*[）)]', '', n)
    n = _re.sub(r'[\s·・,，.。:：\-—_/\\|]+', '', n)
    return n.strip()


def category_for(rec, auto=None):
    # Auto-classification (content-derived) wins over the stored value, which
    # was a single coarse bucket for almost everything.
    if auto and rec['slug'] in auto:
        return auto[rec['slug']]
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
    # Auto-classification output (scripts/classify.py); falls back to the
    # stored category when a module has not been classified yet.
    enrich = {}
    enrich_path = os.path.join(os.path.dirname(STATE), 'enrich.json')
    if os.path.exists(enrich_path):
        enrich = json.load(open(enrich_path))

    history = {}
    history_path = os.path.join(os.path.dirname(STATE), 'history.json')
    if os.path.exists(history_path):
        history = json.load(open(history_path))

    health = {}
    health_path = os.path.join(os.path.dirname(STATE), 'health.json')
    if os.path.exists(health_path):
        health = json.load(open(health_path))

    auto_cat = {}
    auto_path = os.path.join(os.path.dirname(STATE), 'categories.json')
    if os.path.exists(auto_path):
        auto_cat = json.load(open(auto_path))

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'details'), exist_ok=True)
    os.makedirs(DIST_RAW, exist_ok=True)

    # Copy only modules that are still in the catalogue: an upstream removal
    # must actually disappear from the site, not linger as an orphan file.
    # Hidden (broken) modules must not keep a working /m/ URL either: an old
    # bookmark would still install a module that silently does nothing.
    keep_slugs = set(catalogue.keys()) - {
        slug for slug, rec in health.items() if rec.get('status') == 'broken'}
    # Stale copies from earlier builds have to go too, otherwise a hidden
    # module keeps answering 200 on /m/<slug>.sgmodule forever.
    for f in os.listdir(DIST_RAW):
        if f.endswith('.sgmodule') and f[:-9] not in keep_slugs:
            os.remove(os.path.join(DIST_RAW, f))
    for f in os.listdir(RAW_DIR):
        if not f.endswith('.sgmodule'):
            continue
        if f[:-9] not in keep_slugs:
            continue
        src = os.path.join(RAW_DIR, f)
        dst = os.path.join(DIST_RAW, f)
        if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
            with open(src, 'rb') as fi, open(dst, 'wb') as fo:
                fo.write(fi.read())

    cat_by_slug = {c['slug']: c for c in CATEGORIES}
    counts = {}

    missing_raw = [rec['slug'] for rec in catalogue.values()
                   if not os.path.exists(os.path.join(RAW_DIR, f"{rec['slug']}.sgmodule"))]
    if missing_raw:
        # A module without its file produces a 404 install link and (worse) an
        # HTML fallback page — drop it from the catalogue feed instead.
        print(f'! 缺少 raw 文件 {len(missing_raw)} 个，已跳过：{missing_raw[:5]}')

    # Prune raw files whose module is gone (they would never be served).
    for f in os.listdir(RAW_DIR):
        if f.endswith('.sgmodule') and f[:-9] not in set(catalogue.keys()):
            os.remove(os.path.join(RAW_DIR, f))

    modules = []
    # Broken modules stay in the catalogue (so the daily probe keeps watching
    # them) but are not published: a module that installs and silently does
    # nothing is worse than one that is simply absent. When upstream fixes the
    # script, the next health run flips it back to ok and it reappears.
    # `streak` is how many consecutive nightly runs found the script gone. It is
    # a second fence on top of check_health.py: an old health.json, a hand edit
    # or a single bad probe must never hide a module on its own.
    HIDE_AFTER_RUNS = 2
    hidden = {slug for slug, rec in health.items()
              if rec.get('status') == 'broken'
              and (rec.get('streak') if rec.get('streak') is not None else HIDE_AFTER_RUNS) >= HIDE_AFTER_RUNS}
    for rec in catalogue.values():
        if rec['slug'] in set(missing_raw) or rec['slug'] in hidden:
            continue
        cslug = category_for(rec, auto_cat)
        cat = cat_by_slug[cslug]
        counts[cslug] = counts.get(cslug, 0) + 1
        modules.append({
            'id': f"mod-{rec['slug']}",
            'slug': rec['slug'],
            'name': rec['name'],
            # Upstream descriptions are one boilerplate sentence for ~1000
            # modules; enrich.py writes a factual replacement for those.
            'description': ((enrich.get(rec['slug']) or {}).get('summary')
                            if (enrich.get(rec['slug']) or {}).get('generated')
                            else rec['description']),
            'author': rec['author'],
            'category': {'id': cat['id'], 'name': cat['name'], 'slug': cat['slug']},
            'tags': (enrich.get(rec['slug']) or {}).get('tags', []),
            'version': rec['version'],
            'updatedAt': rec['updatedAt'],
            'rawUrl': f"{PROXY_BASE}/{rec['slug']}.sgmodule",
            'repositoryUrl': f"https://github.com/{rec['repo']}",
            'isFeatured': False,
            # 'ok' | 'broken' | 'unknown' — 'broken' means at least one
            # script-path in the module no longer resolves.
            'health': (health.get(rec['slug']) or {}).get('status', 'unknown'),
            # why a broken script is gone: upstream deleted the file, the whole
            # repo disappeared, or it is hosted outside GitHub.
            'healthReason': (health.get(rec['slug']) or {}).get('reason'),
            # pinyin index for the search box (jingdong → 京东)
            'py': (enrich.get(rec['slug']) or {}).get('pinyin') or None,
            # true when the module declares a [Panel] section (Surge renders it
            # as a dashboard card). Parsed from the file, not from the name.
            'hasPanel': bool((enrich.get(rec['slug']) or {}).get('panel')),
        })

    modules.sort(key=lambda m: m['updatedAt'], reverse=True)

    # Same-title modules across repos (jd / jd-2 / jd-3 …). Computed here so the
    # client never has to group 1200 records on every render.
    groups = {}
    for mod in modules:
        groups.setdefault(name_key(mod['name']), []).append(mod['slug'])
    for mod in modules:
        siblings = groups.get(name_key(mod['name']), [])
        mod['dupe'] = max(0, len(siblings) - 1)

    # Empty categories would render as dead chips — hide them.
    categories = [{
        'id': c['id'], 'name': c['name'], 'slug': c['slug'],
        'description': c['description'], 'icon': c['icon'],
        'sortOrder': c['sortOrder'], 'moduleCount': counts.get(c['slug'], 0),
    } for c in CATEGORIES if counts.get(c['slug'], 0) > 0]

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
            'changelog': '',
            'releasedAt': rec['updatedAt'],
            'commitSha': None,
            'commitUrl': None,
        }]
        detail['createdAt'] = rec['updatedAt']
        info = enrich.get(mod['slug']) or {}
        detail['tech'] = info.get('tech') or None
        detail['sameAs'] = [x for x in groups.get(name_key(mod['name']), []) if x != mod['slug']]
        detail['history'] = (history.get(mod['slug']) or [])[-8:][::-1]
        json.dump(detail, open(f'{OUT}/details/{mod["slug"]}.json', 'w'),
                  ensure_ascii=False, separators=(',', ':'))

    # prune orphan detail files (removed modules)
    keep = {m['slug'] for m in modules}
    for f in os.listdir(os.path.join(OUT, 'details')):
        if f.endswith('.json') and f[:-5] not in keep:
            os.remove(os.path.join(OUT, 'details', f))

    print(f'模块 {len(modules)} · 分类 {len(categories)} · 来源 {settings["sourceCount"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
