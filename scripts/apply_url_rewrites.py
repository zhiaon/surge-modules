#!/usr/bin/env python3
"""
Repoint module script references at the address their author moved them to.

Upstream repos sometimes delete the build output a module points at (Maasea
removed Script/Youtube/dist/*.preview.js). The module still installs, but the
script never loads, so it silently does nothing and the health check marks it
broken. Waiting for the every mirror author to notice takes months.

Rules live in state/url_rewrites.json and are applied as exact full-URL
replacements. Deliberately no regex/wildcards: a wrong guess produces a module
that runs the wrong code, which is worse than an honest 404. Every rule carries
the date and the HTTP evidence it was verified with.

Idempotent: a module already on the new URL is left byte-identical, so this can
run on every sync without churning the repo.

Output: /tmp/url-rewrites.json  {changed: n, files: [{slug, from, to}], rules: n}
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'raw')
RULES = os.path.join(ROOT, 'state', 'url_rewrites.json')
REPORT = '/tmp/url-rewrites.json'


def load_rules():
    if not os.path.exists(RULES):
        return []
    data = json.load(open(RULES))
    rules = []
    for r in data.get('rules') or []:
        src, dst = (r.get('from') or '').strip(), (r.get('to') or '').strip()
        # A half-written rule must never rewrite anything: both sides are
        # required, must differ, and must be absolute https URLs.
        if not src.startswith('https://') or not dst.startswith('https://'):
            print(f'! 跳过无效规则（需要双侧 https）: {src[:60]}')
            continue
        if src == dst:
            continue
        rules.append({'from': src, 'to': dst})
    return rules


def main():
    rules = load_rules()
    changed = []
    if not rules:
        json.dump({'changed': 0, 'files': [], 'rules': 0}, open(REPORT, 'w'))
        print('没有登记地址迁移规则，跳过')
        return 0

    for name in sorted(os.listdir(RAW_DIR)):
        if not name.endswith('.sgmodule'):
            continue
        path = os.path.join(RAW_DIR, name)
        try:
            with open(path, encoding='utf-8', errors='surrogateescape') as f:
                text = f.read()
        except OSError as e:
            print(f'! 读取失败 {name}: {e}')
            continue

        new_text = text
        hits = []
        for rule in rules:
            if rule['from'] in new_text:
                new_text = new_text.replace(rule['from'], rule['to'])
                hits.append(rule)
        if not hits:
            continue

        if new_text != text:
            with open(path, 'w', encoding='utf-8', errors='surrogateescape') as f:
                f.write(new_text)
            slug = name[:-len('.sgmodule')]
            changed.append({'slug': slug, 'from': hits[0]['from'], 'to': hits[0]['to'],
                            'rules': len(hits)})

    json.dump({'changed': len(changed), 'files': changed, 'rules': len(rules)},
              open(REPORT, 'w'), ensure_ascii=False, indent=1)
    print(f'地址迁移：改写 {len(changed)} 个模块（规则 {len(rules)} 条）')
    for c in changed[:10]:
        print(f"  - {c['slug']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
