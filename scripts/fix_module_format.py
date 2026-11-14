#!/usr/bin/env python3
"""
Repair three mechanical Surge-format defects in raw/*.sgmodule.

  1. [MITM] hostname without %APPEND%  — a bare list REPLACES the user's own
     hostname set instead of adding to it, which silently breaks every other
     MITM module they have installed.
  2. [Mitm] / [mitm] — section names are case-sensitive.
  3. [Body Rewrite] — not a Surge section. Surge rejects the whole module, so
     convert the common `regex 'a' 'b'` search/replace pairs to [URL Rewrite]
     reject rules where the intent is clearly "block this response", and
     comment out the rest with an explicit note.

Everything else is left byte-identical. Run with --apply to write.

Usage: python3 scripts/fix_module_format.py [--apply] [--only append|case|body]
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')


def section_span(lines, name):
    """Return (start, end) line indexes of a [name] section, end exclusive."""
    rx = re.compile(r'^\s*\[' + re.escape(name) + r'\]\s*$', re.I)
    for i, line in enumerate(lines):
        if rx.match(line):
            j = i + 1
            while j < len(lines) and not re.match(r'^\s*\[[^\]]+\]\s*$', lines[j]):
                j += 1
            return i, j
    return None


def fix_append(text):
    """Add %APPEND% to a bare [MITM] hostname line."""
    lines = text.split('\n')
    span = section_span(lines, 'MITM')
    if not span:
        return text, False
    start, end = span
    changed = False
    for i in range(start + 1, end):
        m = re.match(r'^(\s*hostname\s*=\s*)(.*)$', lines[i], re.I)
        if not m:
            continue
        prefix, value = m.group(1), m.group(2).strip()
        if not value:
            continue
        if value.startswith('%APPEND%'):
            fixed = '%APPEND% ' + re.sub(r'^[,\s]+', '', value[len('%APPEND%'):])
            if fixed != value:
                lines[i] = f'{prefix}{fixed}'
                changed = True
            continue
        # Keep a trailing comment untouched: "a.com  ; note"
        tail = ''
        if ';' in value:
            value, tail = value.split(';', 1)
            value, tail = value.rstrip(), ' ;' + tail
        # Upstream sometimes writes "%APPEND%, a.com" — the stray comma parses
        # as an empty hostname, so drop leading separators after the token.
        value = re.sub(r'^[,\s]+', '', value)
        lines[i] = f'{prefix}%APPEND% {value}{tail}'
        changed = True
        break
    return '\n'.join(lines), changed


def fix_case(text):
    """Normalise section names that Surge spells in caps."""
    changed = False
    out = []
    for line in text.split('\n'):
        m = re.match(r'^(\s*)\[([A-Za-z ]+)\](\s*)$', line)
        if m:
            name = m.group(2).strip()
            if name.lower() == 'mitm' and name != 'MITM':
                line = f'{m.group(1)}[MITM]{m.group(3)}'
                changed = True
        out.append(line)
    return '\n'.join(out), changed


BODY_RX = re.compile(r"^\s*(?:http-response|http-request)\s+(\S+)\s+'([^']*)'\s+'([^']*)'")


def fix_body(text):
    """Turn [Body Rewrite] into something Surge understands.

    Two shapes appear in the wild:
      a) `url 'old' 'new'` — a search/replace pair (cannot be expressed)
      b) a bare regex with no quotes — usually a block, which maps onto a
         [URL Rewrite] reject
    Anything we cannot translate is preserved as a comment so no information is
    lost, and the module stays loadable.
    """
    lines = text.split('\n')
    span = section_span(lines, 'Body Rewrite')
    if not span:
        return text, False
    start, end = span
    body = lines[start + 1:end]

    rejects, comments = [], []
    for raw in body:
        line = raw.rstrip()
        if not line.strip() or line.strip().startswith('#'):
            if line.strip():
                comments.append('# ' + line.strip())
            continue
        if line.lstrip().startswith('#!'):
            comments.append(line)
            continue
        if re.search(r"'[^']*'\s+'[^']*'", line):
            # search/replace — not representable in a module
            comments.append('# [Body Rewrite 无法转换，原样保留] ' + line.strip())
            continue
        m = re.match(r'^\s*(?:http-response|http-request)\s+(\S+)\s*$', line)
        if m:
            rejects.append(f'{m.group(1)} - reject')
            continue
        comments.append('# [Body Rewrite 原样保留] ' + line.strip())

    new_section = []
    if rejects:
        new_section += ['', '[URL Rewrite]', '# 由 [Body Rewrite] 转换：整段响应拦截']
        new_section += rejects
    if comments:
        new_section += ['', '# ---- 以下来自 [Body Rewrite]，Surge 无等价语法 ----']
        new_section += comments

    lines[start:end] = new_section if new_section else []
    return '\n'.join(lines), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--only', default='')
    ap.add_argument('--report', default='')
    ap.add_argument('paths', nargs='*',
                    help='只处理这些文件；省略则扫描整个 raw/')
    args = ap.parse_args()
    stages = [args.only] if args.only else ['append', 'case', 'body']

    stats = {s: 0 for s in stages}
    rows = []
    if args.paths:
        # Only the files the sync run actually touched — an untouched module is
        # never rewritten, so a working one can never be broken by a repair.
        paths = [p for p in args.paths if os.path.isfile(p)]
    else:
        paths = [os.path.join(RAW, x) for x in sorted(os.listdir(RAW))
                 if x.endswith('.sgmodule')]

    for path in paths:
        f = os.path.basename(path)
        text = open(path, encoding='utf-8', errors='replace').read()
        orig = text
        touched = []
        if 'append' in stages:
            text, ch = fix_append(text)
            if ch:
                stats['append'] += 1
                touched.append('append')
        if 'case' in stages:
            text, ch = fix_case(text)
            if ch:
                stats['case'] += 1
                touched.append('case')
        if 'body' in stages:
            text, ch = fix_body(text)
            if ch:
                stats['body'] += 1
                touched.append('body')
        if text != orig:
            rows.append(f'{f}: {",".join(touched)}')
            if args.apply:
                with open(path, 'w', encoding='utf-8') as fh:
                    fh.write(text)

    print(('已修改' if args.apply else '将修改') + f' {len(rows)} 个文件')
    for k, v in stats.items():
        print(f'  {k:7s} {v}')
    if args.report:
        open(args.report, 'w').write('\n'.join(rows))
    return 0


if __name__ == '__main__':
    sys.exit(main())
