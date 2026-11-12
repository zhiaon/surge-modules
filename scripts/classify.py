#!/usr/bin/env python3
"""
Classify every module from its own content.

Upstream files carry almost no usable category (they all land in a single
"adblock" bucket), so this reads each raw .sgmodule and decides from what the
file actually does:

  [Script] type=cron        → 脚本增强（定时/签到）
  [Panel]                   → 网络工具（面板类）
  hostname 含流媒体域名      → 流媒体解锁
  正文含 VIP/会员/解锁       → 应用解锁
  [URL Rewrite] 里大量 reject → 广告拦截
  追踪/遥测域名             → 隐私防护
  仅 [Rule] / [Host]        → 规则分流

Output: state/categories.json  { slug: categorySlug }

Usage: python3 scripts/classify.py [--report]
"""
import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'raw')
STATE = os.path.join(ROOT, 'state')
OUT = os.path.join(STATE, 'categories.json')

CATEGORIES = [
    ('adblock', '广告拦截'),
    ('clean', '应用净化'),
    ('unlock', '应用解锁'),
    ('media', '流媒体'),
    ('scripts', '脚本增强'),
    ('rules', '规则分流'),
    ('privacy', '隐私防护'),
    ('tools', '网络工具'),
]

MEDIA_HOSTS = re.compile(
    r'netflix|youtube|ytimg|googlevideo|disney|spotify|hulu|hbomax|primevideo|'
    r'bilibili|iqiyi|youku|qq\.com/video|mgtv|baha|viu\.tv|twitch|tiktok|'
    r'soundcloud|tidal|deezer|abema|nicovideo|crunchyroll',
    re.I,
)
TRACKER_HOSTS = re.compile(
    r'app-measurement|google-analytics|doubleclick|umeng|cnzz|baidu\.com/hm|'
    r'mtq\.baidu|sensorsdata|growingio|mixpanel|amplitude|bugly|firebase-'
    r'|adjust\.com|appsflyer|branch\.io',
    re.I,
)
UNLOCK_WORDS = re.compile(r'解锁|会员|vip|pro 版|高级版|去限制|premium', re.I)
AD_WORDS = re.compile(r'去广告|广告|开屏|弹窗|推广|拦截|净化', re.I)
PANEL_WORDS = re.compile(r'面板|panel|状态|流量|节点', re.I)
PRIVACY_WORDS = re.compile(r'隐私|追踪|遥测|指纹|统计上报', re.I)
TOOL_WORDS = re.compile(r'dns|ip 信息|ip信息|测速|诊断|speedtest', re.I)


def parse(text):
    """Pull the structural facts we classify on."""
    mitm = []
    m = re.search(r'^\[MITM\][\s\S]*?(?=^\[|\Z)', text, re.M)
    if m:
        for line in m.group(0).splitlines():
            if 'hostname' in line.lower():
                part = line.split('=', 1)[-1]
                mitm += [h.strip() for h in re.split(r'[,\s]+', part) if h.strip()]

    sections = {s.lower() for s in re.findall(r'^\[([^\]]+)\]', text, re.M)}
    script_types = re.findall(r'=\s*type=([a-z-]+)', text, re.I)
    script_paths = re.findall(r'script-path=([^,\s]+)', text, re.I)
    reject_count = len(re.findall(r'\breject\b', text, re.I))
    rewrite_count = len(re.findall(r'=\s*(?:reject|header|response-header)', text, re.I))

    return {
        'sections': sections,
        'mitm': mitm,
        'script_types': [t.lower() for t in script_types],
        'script_paths': script_paths,
        'reject': reject_count,
        'rewrites': rewrite_count,
    }


def classify(name, desc, facts):
    """Precedence first, scoring second.

    Titles are the most reliable signal (上游的模块名基本都是「应用名」或
    「功能名」), so an explicit keyword short-circuits before content heuristics
    can pull the module into the wrong bucket.
    """
    text = f'{name} {desc}'
    hosts = ' '.join(facts['mitm'])
    sections = facts['sections']

    # 1. panels / network utilities — name is decisive
    if re.search(r'面板|panel|测速|speedtest|dns|ip ?信息|网络信息|流量|状态栏|'
                 r'倒数日|时间|天气|^mitm$|^cookie$', name, re.I):
        return 'tools'
    if re.search(r'url ?rewrite', name, re.I):
        return 'rules'

    # 2. scheduled scripts — anything that runs on a timer or fills a cookie
    if re.search(r'签到|签退|signin|checkin|cookie|自动任务|定时|监控-自动', name, re.I):
        return 'scripts'
    if 'cron' in facts['script_types']:
        return 'scripts'

    # 3. subscription unlocking
    if UNLOCK_WORDS.search(text) or 'unlockvip' in ' '.join(facts['script_paths']).lower():
        return 'unlock'

    score = Counter()

    media_hits = len(set(MEDIA_HOSTS.findall(hosts)))
    if media_hits >= 2 or (media_hits and MEDIA_HOSTS.search(text)):
        score['media'] += 3
    if re.search(r'流媒体|netflix|youtube|disney|spotify|bilibili', text, re.I):
        score['media'] += 2

    if facts['reject'] >= 5:
        score['adblock'] += 3
    elif facts['reject'] >= 1:
        score['adblock'] += 1
    if AD_WORDS.search(text):
        score['adblock'] += 2

    if TRACKER_HOSTS.search(hosts):
        score['privacy'] += 2
    if PRIVACY_WORDS.search(text):
        score['privacy'] += 2

    if 'panel' in sections:
        score['tools'] += 2
    if facts['script_paths'] and not facts['mitm']:
        score['scripts'] += 1

    # pure rule sets: no MITM, no scripts, has rules
    if 'rule' in sections and not facts['mitm'] and not facts['script_paths']:
        score['rules'] += 2

    if not score:
        return 'clean' if facts['rewrites'] else 'adblock'

    best, best_score = None, 0
    for cat, val in score.items():
        if val > best_score:
            best, best_score = cat, val
    return best or 'adblock'


def main():
    catalogue = json.load(open(os.path.join(STATE, 'catalogue.json')))
    out = {}
    dist = Counter()
    missing = 0

    for slug, rec in catalogue.items():
        fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
        if not os.path.exists(fp):
            out[slug] = rec.get('category') or 'adblock'
            dist[out[slug]] += 1
            missing += 1
            continue
        text = open(fp, encoding='utf-8', errors='replace').read()
        facts = parse(text)
        cat = classify(rec['name'], rec.get('description', ''), facts)
        out[slug] = cat
        dist[cat] += 1

    json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=0)

    if '--report' in sys.argv:
        names = dict(CATEGORIES)
        for cat, n in dist.most_common():
            print(f'  {names.get(cat, cat):8} {n:5}')
        print(f'  共 {len(out)} 个（缺文件 {missing}）')
    else:
        print(f'分类完成：{len(out)} 个')
    return 0


if __name__ == '__main__':
    sys.exit(main())
