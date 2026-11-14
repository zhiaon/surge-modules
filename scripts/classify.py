#!/usr/bin/env python3
"""
Classify every module from its own content.

Upstream files carry almost no usable category (they all land in a single
"adblock" bucket), so this reads each raw .sgmodule and decides from what the
file actually does.

Signals, strongest first:
  name keywords            → 字幕 / Apple / 面板 / 签到 / 解锁
  section presence         → [Panel] 面板, [Rule] 规则, [SNAT] 网络
  MITM hosts               → Apple 服务、流媒体、追踪域名
  script types             → type=cron 定时任务
  reject / rewrite counts  → 拦截型 vs 净化型

Output: state/categories.json  { slug: categorySlug }

Usage: python3 scripts/classify.py [--report] [--samples N]
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
    ('subs', '字幕翻译'),
    ('apple', 'Apple 服务'),
    ('scripts', '脚本增强'),
    ('tools', '网络工具'),
    ('rules', '规则分流'),
    ('privacy', '隐私防护'),
]

# ---- host fingerprints -----------------------------------------------------
APPLE_HOSTS = re.compile(
    r'ls\.apple\.com|gspe\d|gs-loc|configuration\.apple\.com|bag\.itunes\.apple\.com|'
    r'itunes\.apple\.com|appstore\.com|mzstatic|weather-data\.apple\.com|'
    r'smoot\.apple\.com|gsp-\d|apple-relay|mask-api\.icloud|gateway\.icloud',
    re.I,
)
MEDIA_HOSTS = re.compile(
    r'netflix|nflxvideo|nflximg|youtube|ytimg|googlevideo|disney|spotify|scdn\.co|'
    r'hulu|hbomax|primevideo|bilibili|bilivideo|iqiyi|youku|qq\.com/video|mgtv|'
    r'baha|viu\.tv|twitch|tiktok|soundcloud|tidal|deezer|abema|nicovideo|'
    r'crunchyroll|vimeo|kuaishou|douyin|ixigua|miguvideo|wasu',
    re.I,
)
TRACKER_HOSTS = re.compile(
    r'app-measurement|google-analytics|doubleclick|umeng|cnzz|baidu\.com/hm|'
    r'mtq\.baidu|sensorsdata|growingio|mixpanel|amplitude|bugly|firebase-|'
    r'adjust\.com|appsflyer|branch\.io|growing|beacon|log\.',
    re.I,
)
AD_HOSTS = re.compile(
    r'gdt\.qq\.com|pgdt|umeng|pangolin|bytedance|csj|ad\.|ads\.|advert|'
    r'admob|applovin|unityads|mintegral|tanx|alimama|bdmob|mobads',
    re.I,
)

# ---- name fingerprints -----------------------------------------------------
SUBS_WORDS = re.compile(r'字幕|subtitle|translate|翻译|dualsubs', re.I)
APPLE_WORDS = re.compile(
    r'iringo|testflight|weatherkit|\bsiri\b|apple ?news|apple ?tv|apple ?maps|'
    r'apple ?wl[oc]|icloud|apple ?服务|app ?store|apple ?music|find ?my',
    re.I,
)
PANEL_WORDS = re.compile(
    r'面板|panel|测速|speedtest|netspeed|网络信息|ip ?信息|ip 纯净|流量|状态栏|'
    r'dns|倒数日|黄历|油价|天气|加密货币|机场信息|代理信息|节点信息',
    re.I,
)
SCRIPT_WORDS = re.compile(r'签到|签退|signin|checkin|cookie|ws ?key|token|凭证|密钥|自动任务|定时|每日|领取|抽奖', re.I)
ADBLOCK_WORDS = re.compile(r'adblock|ad ?block|去广告|广告拦截|广告屏蔽|拦截广告|adguard', re.I)
UNLOCK_WORDS = re.compile(r'解锁|会员|vip|pro 版|高级版|去限制|premium|破解', re.I)
MEDIA_WORDS = re.compile(
    r'netflix|youtube|disney|spotify|bilibili|b站|爱奇艺|腾讯视频|优酷|芒果|'
    r'抖音|快手|tiktok|twitch|hbo|prime ?video|网易云|qq音乐|酷狗|酷我|喜马拉雅',
    re.I,
)
CLEAN_WORDS = re.compile(r'净化|精简|去推荐|信息流|开屏|首页|沉浸|美化|屏蔽推荐', re.I)
RULE_WORDS = re.compile(r'规则集|分流|策略组|snat|路由|解析|dns 查询|规则补充', re.I)
TOOL_WORDS = re.compile(r'private access|人机验证|reject|去广告 ?lite|adblock ?lite', re.I)
PRIVACY_WORDS = re.compile(r'隐私|追踪|遥测|指纹|统计上报|去统计', re.I)


def parse(text):
    """Pull the structural facts we classify on."""
    mitm = []
    m = re.search(r'^\[MITM\][\s\S]*?(?=^\[|\Z)', text, re.M)
    if m:
        for line in m.group(0).splitlines():
            if 'hostname' in line.lower():
                part = line.split('=', 1)[-1]
                mitm += [h.strip().lstrip('-').strip() for h in re.split(r'[,\s]+', part) if h.strip()]

    sections = {s.lower() for s in re.findall(r'^\[([^\]]+)\]', text, re.M)}
    script_types = re.findall(r'=\s*type=([a-z-]+)', text, re.I)
    script_paths = re.findall(r'script-path=([^,\s]+)', text, re.I)
    reject_count = len(re.findall(r'\breject\b', text, re.I))
    rewrite_count = len(re.findall(r'^\s*[^#\[][^=]*=\s*(?:reject|header|response-header)', text, re.I | re.M))

    return {
        'sections': sections,
        'mitm': mitm,
        'script_types': [t.lower() for t in script_types],
        'script_paths': script_paths,
        'reject': reject_count,
        'rewrites': rewrite_count,
    }


def classify(name, desc, facts):
    """Rule ladder over name → structure → content, first hit wins."""
    text = f'{name} {desc}'
    name_l = name or ''
    hosts = ' '.join(facts['mitm'])
    sections = facts['sections']

    # 1. 名字直接说明了用途
    if SUBS_WORDS.search(name_l):
        return 'subs'
    if APPLE_WORDS.search(name_l):
        return 'apple'
    if PANEL_WORDS.search(name_l):
        return 'tools'
    if re.search(r'^mitm$|mitm$|\bmitm\b', name_l, re.I) and not MEDIA_WORDS.search(name_l):
        return 'tools'

    # 2. 结构特征
    if 'panel' in sections:
        return 'tools'
    if 'snat' in sections:
        return 'rules'
    if SCRIPT_WORDS.search(name_l) or 'cron' in facts['script_types']:
        return 'scripts'
    if CLEAN_WORDS.search(name_l):
        return 'clean'
    if ADBLOCK_WORDS.search(name_l):
        return 'adblock'
    if UNLOCK_WORDS.search(text):
        return 'unlock'
    if MEDIA_WORDS.search(name_l):
        return 'media'
    if PRIVACY_WORDS.search(name_l):
        return 'privacy'
    if CLEAN_WORDS.search(name_l):
        return 'clean'
    if RULE_WORDS.search(name_l) and not facts['mitm']:
        return 'rules'
    if TOOL_WORDS.search(name_l):
        return 'tools'

    # 3. 内容打分：看它实际动了哪些域名
    score = Counter()
    apple_hits = len(set(APPLE_HOSTS.findall(hosts)))
    media_hits = len(set(MEDIA_HOSTS.findall(hosts)))
    tracker_hits = len(set(TRACKER_HOSTS.findall(hosts)))
    ad_hits = len(set(AD_HOSTS.findall(hosts)))

    if apple_hits >= 2:
        score['apple'] += 4
    elif apple_hits:
        score['apple'] += 2
    if media_hits >= 2:
        score['media'] += 3
    elif media_hits:
        score['media'] += 2
    if tracker_hits >= 2:
        score['privacy'] += 3
    if ad_hits >= 2 or facts['reject'] >= 5:
        score['adblock'] += 3
    elif facts['reject'] >= 1:
        score['adblock'] += 1
    if facts['rewrites'] >= 3 and facts['reject'] <= 1:
        score['clean'] += 2
    if facts['script_paths'] and not facts['mitm']:
        score['scripts'] += 2
    # 纯规则文件：没有 MITM / 脚本。带 reject 的是按域名拦截（算广告拦截），
    # 只有策略、解析、分流才算规则分流。
    if 'rule' in sections and not facts['mitm'] and not facts['script_paths']:
        if facts['reject'] == 0:
            score['rules'] += 4
        else:
            score['adblock'] += 3

    if not score:
        return 'adblock'
    best, best_val = 'adblock', 0
    for cat, val in score.items():
        if val > best_val:
            best, best_val = cat, val
    return best


def main():
    catalogue = json.load(open(os.path.join(STATE, 'catalogue.json')))
    out = {}
    dist = Counter()
    samples = {}
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
        samples.setdefault(cat, []).append(rec['name'])

    json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=0)

    if '--report' in sys.argv or '--samples' in sys.argv:
        names = dict(CATEGORIES)
        for cat, n in dist.most_common():
            print(f'  {names.get(cat, cat):8} {n:5}')
    if '--samples' in sys.argv:
        k = 6
        for cat, n in dist.most_common():
            print(f'\n[{cat}]')
            for nm in samples.get(cat, [])[:k]:
                print('   ', nm[:44])
    print(f'  共 {sum(dist.values())} 个（缺文件 {missing}）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
