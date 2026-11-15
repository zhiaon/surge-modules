#!/usr/bin/env python3
"""
Enrich the catalogue from each module's own content.

Everything here is derived at build time from raw/*.sgmodule, so the site stays
static:

  tags      keyword rules over hosts/rules/scripts (the tag filter used to be
            dead because no module had any)
  summary   a real one-liner for the ~1000 modules whose upstream description is
            the same boilerplate sentence
  tech      MITM hosts, rewrite-rule count, referenced scripts, cron jobs
  pinyin    full + initials, so 「jingdong」 finds 「京东」

Output: state/enrich.json  { slug: {tags, summary, tech, pinyin} }
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'raw')
STATE = os.path.join(ROOT, 'state')
CATALOGUE = os.path.join(STATE, 'catalogue.json')
OUT = os.path.join(STATE, 'enrich.json')

try:
    from pypinyin import Style, lazy_pinyin
    HAS_PINYIN = True
except Exception:  # CI without the package degrades gracefully
    HAS_PINYIN = False

TEMPLATE_DESC = re.compile(
    r'某些\s*APP\s*要清除缓存|重新安装拦截广告才会生效|请清除缓存|重新安装即可', re.I)

# tag → (host or keyword patterns)
TAG_RULES = [
    ('电商', r'jd\.com|taobao|tmall|pinduoduo|yangkeduo|amazon|shopee|lazada|'
             r'xiaohongshu|xhs\.|dewu|vipshop|suning|kaola|mogu|1688|alibaba'),
    ('视频', r'iqiyi|youku|bilibili|bilivideo|mgtv|qq\.com.*video|v\.qq|'
             r'netflix|youtube|googlevideo|disney|hulu|hbomax|primevideo|'
             r'tencentvideo|migu|sohu|le\.com|acfun'),
    ('音乐', r'music\.163|qq\.com.*music|kugou|kuwo|spotify|apple.*music|'
             r'tidal|deezer|soundcloud|migu.*music|xiami'),
    ('社交', r'weibo|wechat|weixin|zhihu|tieba|douyin|tiktok|instagram|'
             r'twitter\.com|facebook|telegram|discord|reddit|threads'),
    ('出行', r'amap|baidumap|didi|12306|ctrip|qunar|meituan|ele\.me|'
             r'hellobike|mobike|gaode'),
    ('银行支付', r'icbc|ccb\.com|boc\.cn|abchina|bankofchina|unionpay|alipay|'
                r'alipayobjects|cmbchina|spdb|pingan|wechatpay'),
    ('运营商', r'10086|10010|189\.cn|chinamobile|chinaunicom|chinatelecom|'
              r'cmcc|chinaunicom'),
    ('游戏', r'steam|epicgames|battle\.net|miHoYo|hoyoverse|blizzard|'
             r'wegame|taptap|garena'),
    ('阅读', r'qidian|fanqie|hongguo|qimao|zhangyue|ireader|kindle|weread|'
             r'douban.*book'),
    ('地图导航', r'gaode|amap|baidumap|maps\.apple|openstreetmap|tencent.*map'),
]

TECH_TAGS = {
    '签到': r'签到|签退|signin|checkin|每日任务',
    '面板': r'\[panel\]|panel',
    '去广告': r'去广告|广告|屏蔽|净化',
    '解锁': r'解锁|会员|vip',
    '反追踪': r'app-measurement|google-analytics|doubleclick|umeng|sensorsdata|'
              r'firebase-analytics|bugly|mixpanel',
    'DNS': r'\bdns\b',
    '定时任务': r'type=cron',
    '重写': r'\[url rewrite\]',
}


def parse(text):
    mitm = []
    m = re.search(r'^\[MITM\][\s\S]*?(?=^\[|\Z)', text, re.M)
    if m:
        for line in m.group(0).splitlines():
            if line.strip().lower().startswith('hostname'):
                value = line.split('=', 1)[-1].replace('%APPEND%', '')
                mitm += [h.strip() for h in value.split(',') if h.strip()]

    sections = [s.strip() for s in re.findall(r'^\[([^\]]+)\]', text, re.M)]
    # A `[Panel]` section is a structural fact — Surge renders it as a dashboard
    # card. Kept separate from the loose 面板 tag, which also fires on any script
    # whose file name happens to contain "panel".
    panels = len([s for s in sections if s.strip().lower() == 'panel'])

    scripts = re.findall(r'((?:[A-Za-z0-9_\-]+)\s*=\s*[^\n]*?script-path\s*=\s*([^,\s]+))', text, re.I)
    crons = re.findall(r'cronexp\s*=\s*"([^"]+)"', text)
    # Count real rules inside the rewrite sections. URL Rewrite lines have no
    # `key =` form, so a key-based regex silently reported 0.
    rewrites = 0
    for sec in ('URL Rewrite', 'Header Rewrite', 'Body Rewrite', 'Map Local'):
        m = re.search(rf'^\[{sec}\]([\s\S]*?)(?=^\[|\Z)', text, re.M | re.I)
        if not m:
            continue
        for line in m.group(1).splitlines():
            st = line.strip()
            if st and not st.startswith('#') and not st.startswith(';'):
                rewrites += 1
    rejects = len(re.findall(r'=\s*reject', text, re.I))

    rules = 0
    m_rule = re.search(r'^\[Rule\]([\s\S]*?)(?=^\[|\Z)', text, re.M | re.I)
    if m_rule:
        those = [l.strip() for l in m_rule.group(1).splitlines()]
        rules = len([l for l in those if l and not l.startswith('#')])

    return {
        'rules': rules,
        'mitm': mitm,
        'sections': sections,
        'panels': panels,
        'scripts': [{'name': s[0].split('=')[0].strip(), 'url': s[1]} for s in scripts],
        'crons': crons,
        'rewrites': rewrites,
        'rejects': rejects,
    }


def make_tags(rec, facts, text):
    hay = ' '.join([rec['name'], rec.get('description', ''), ' '.join(facts['mitm'])])
    tags = []
    for tag, pattern in TAG_RULES:
        if re.search(pattern, hay, re.I):
            tags.append(tag)

    low = text.lower()
    for tag, pattern in TECH_TAGS.items():
        if re.search(pattern, low):
            tags.append(tag)

    # de-duplicate, keep the most specific ones first, cap at 5
    seen = set()
    out = []
    for t in tags:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:5]


def make_summary(rec, facts):
    desc = (rec.get('description') or '').strip()
    # keep a genuinely informative upstream description untouched
    if len(desc) >= 40 and not TEMPLATE_DESC.search(desc):
        return desc, False

    name = rec['name']
    parts = []
    if facts['rejects'] or facts['rewrites']:
        action = '拦截广告与追踪请求' if facts['rejects'] else '重写请求与响应'
        parts.append(f'{action}')
    if facts['mitm']:
        parts.append(f'覆盖 {len(facts["mitm"])} 个域名')
    if facts['scripts']:
        parts.append(f'引用 {len(facts["scripts"])} 个脚本')
    if facts['crons']:
        parts.append('含定时任务')
    if not parts:
        parts.append('模块内容见原始配置')

    return f'{name}：' + '，'.join(parts) + '。', True


def make_pinyin(name):
    if not HAS_PINYIN:
        return {}
    try:
        full = ''.join(lazy_pinyin(name))
        initials = ''.join(lazy_pinyin(name, style=Style.FIRST_LETTER))
        return {'full': full.lower(), 'initials': initials.lower()}
    except Exception:
        return {}


def main():
    catalogue = json.load(open(CATALOGUE))
    out = {}
    missing = 0
    tag_count = 0

    for slug, rec in catalogue.items():
        fp = os.path.join(RAW_DIR, f'{slug}.sgmodule')
        if not os.path.exists(fp):
            missing += 1
            continue
        text = open(fp, encoding='utf-8', errors='replace').read()
        facts = parse(text)
        tags = make_tags(rec, facts, text)
        if tags:
            tag_count += 1
        out[slug] = {
            'tags': tags,
            'summary': (lambda r: (r[0], r[1]))(make_summary(rec, facts))[0],
            'generated': make_summary(rec, facts)[1],
            'tech': {
                'rules': facts['rules'],
                'mitm': facts['mitm'][:40],
                'rewrites': facts['rewrites'],
                'scripts': facts['scripts'][:10],
                'crons': facts['crons'][:5],
                'panels': facts['panels'],
            },
            'pinyin': make_pinyin(rec['name']),
            'panel': bool(facts['panels']),
        }

    panel_count = sum(1 for v in out.values() if v.get('panel'))
    json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'增强完成：{len(out)} 个（缺文件 {missing}）· 有标签 {tag_count} · '
          f'含面板 {panel_count} · 拼音 {"开" if HAS_PINYIN else "关"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
