#!/usr/bin/env python3
"""
Build link-preview pages for sharing.

A pure SPA has one global <meta> set, so pasting a module link into Telegram or
WeChat shows a bare URL. This generates, per module:

  dist/p/<slug>.html   real HTML with per-module OG/Twitter meta, an inline
                       redirect to the app, and readable content for crawlers
  dist/og/<slug>.png   1200x630 cover (dark card: name, category, author)

Both are static files, so no runtime cost. Generation degrades gracefully: if
Pillow or a CJK font is missing the pages still ship, just with a shared cover.

Run: python3 scripts/build_og.py
"""
import html
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
DATA = os.path.join(DIST, 'data', 'modules.json')
OUT_P = os.path.join(DIST, 'p')
OUT_OG = os.path.join(DIST, 'og')
SITE = 'https://son.zhiaon.top'

FONT_CANDIDATES = [
    '/usr/share/fonts/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
]

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except Exception:
    HAS_PIL = False


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


def wrap(draw, text, font, max_width):
    """Greedy wrap that works for CJK (no spaces) as well as latin text."""
    lines, cur = [], ''
    for ch in text:
        trial = cur + ch
        if draw.textlength(trial, font=font) <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


_BASE = None


def base_canvas(W=1200, H=630):
    """The glow is expensive (60 ellipses) and identical for every card, so it
    is rendered once and copied."""
    global _BASE
    if _BASE is None:
        img = Image.new('RGB', (W, H), '#0b0d12')
        d = ImageDraw.Draw(img)
        for i in range(48, 0, -1):
            r = int(i * 5.2)
            shade = int(1.5 * i)
            d.ellipse([-r - 120, -r - 160, r - 120, r - 160],
                      fill=(17 + shade, 25 + shade, 48 + shade))
        _BASE = img
    return _BASE.copy()


def make_cover(path, title, subtitle, lines=(), accent='#39445a'):
    W, H = 1200, 630
    img = base_canvas(W, H)
    d = ImageDraw.Draw(img)

    title_font = load_font(64)
    meta_font = load_font(30)
    small_font = load_font(26)
    if not title_font:
        img.convert('P', palette=Image.ADAPTIVE, colors=64).save(path, optimize=True)
        return False

    tw = d.textlength(title, font=title_font)
    d.text((80, 200), title, font=title_font, fill='#f2f5fa')
    d.rounded_rectangle([80, 300, 80 + tw + 24, 350], radius=25, outline=accent, width=2)
    d.text((96, 311), subtitle, font=small_font, fill='#9fb0c9')


    d.text((W - 300, H - 86), 'Surge Modules', font=small_font, fill='#5b6779')
    img.convert('P', palette=Image.ADAPTIVE, colors=64).save(path, optimize=True)
    return True


def build_page(mod, cover_rel):
    name = html.escape(mod['name'])
    desc = html.escape(mod.get('description') or 'Surge 模块')
    cat = html.escape((mod.get('category') or {}).get('name') or '模块')
    author = html.escape(mod.get('author') or '')
    url = f'{SITE}/p/{mod["slug"]}'
    img = f'{SITE}{cover_rel}'

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{name} · Surge Modules</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Surge Modules">
<meta property="og:title" content="{name} · Surge Modules">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{name} · Surge Modules">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{img}">

<meta http-equiv="refresh" content="0; url=/modules/{mod['slug']}">
<style>
  body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;
       color:#e7ebf3;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
  .card{{max-width:460px;padding:36px 30px;text-align:center}}
  .eyebrow{{color:#6f7d94;font-size:12px;letter-spacing:.12em;text-transform:uppercase}}
  h1{{margin:10px 0 12px;font-size:26px;font-weight:600;letter-spacing:-.02em}}
  p{{margin:0 0 18px;color:#8d9ab0;font-size:13.5px}}
  a{{display:inline-block;padding:11px 22px;border-radius:999px;background:#fff;
     color:#0b0d12;font-weight:600;text-decoration:none;font-size:13.5px}}
  .muted{{margin-top:18px;color:#5b6779;font-size:11.5px}}
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">{cat}</div>
    <h1>{name}</h1>
    <p>{desc}</p>
    <a href="/modules/{mod['slug']}">在 Surge Modules 中打开</a>
    <p class="muted">@{author} · 正在跳转…</p>
  </div>
  <script>location.replace('/modules/{mod['slug']}');</script>
</body>
</html>
"""


def main():
    if not os.path.exists(DATA):
        print('! 缺少 modules.json，先跑 build_data.py', file=sys.stderr)
        return 1
    modules = json.load(open(DATA))

    os.makedirs(OUT_P, exist_ok=True)
    os.makedirs(OUT_OG, exist_ok=True)

    # One cover per category (plus a default). Per-module covers would be ~1200
    # PNGs and a minute of CPU each run for very little extra value.
    by_cat = {}
    for mod in modules:
        cat = mod.get('category') or {}
        by_cat.setdefault(cat.get('slug') or 'all', {'name': cat.get('name') or '模块',
                                                     'mods': []})['mods'].append(mod)

    covers = 0
    if HAS_PIL:
        for catslug, info in list(by_cat.items()) + [('all', {'name': 'Surge 模块',
                                                             'mods': modules})]:
            sample = [m['name'][:14] for m in info['mods'][:3]]
            try:
                make_cover(os.path.join(OUT_OG, f'cat-{catslug}.png'), info['name'],
                           f'{len(info["mods"])} 个模块', sample)
                covers += 1
            except Exception:
                pass

    made = 0
    for mod in modules:
        catslug = (mod.get('category') or {}).get('slug') or 'all'
        cover_rel = f'/og/cat-{catslug}.png'
        if catslug not in by_cat:
            cover_rel = '/og-cover.png'
        with open(os.path.join(OUT_P, f'{mod["slug"]}.html'), 'w', encoding='utf-8') as f:
            f.write(build_page(mod, cover_rel))
        made += 1

    # prune pages/covers for modules that are gone
    keep = {f"{m['slug']}.html" for m in modules}
    for f in os.listdir(OUT_P):
        if f.endswith('.html') and f not in keep:
            os.remove(os.path.join(OUT_P, f))
    # keep the category covers (cat-*.png); everything else is orphaned
    for f in os.listdir(OUT_OG):
        if f.endswith('.png') and not f.startswith('cat-'):
            os.remove(os.path.join(OUT_OG, f))

    print(f'预览页 {made} 个 · 封面 {covers} 张')
    return 0


if __name__ == '__main__':
    sys.exit(main())
