#!/usr/bin/env python3
"""
Re-probe every module currently marked broken, from this machine.

The nightly health run executes on GitHub's US runners. A host that is slow,
blocked or rate-limited there but fine for real readers (a CN-facing CDN, for
instance) produces a verdict that hides a working module from the site. This
prints, per module, what those URLs actually answer from here — the input for
deciding whether "broken" is real or a false positive.

Run: python3 scripts/audit_broken.py [--json]
"""
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_health import probe  # noqa: E402

STATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'state')


def main():
    health = json.load(open(os.path.join(STATE, 'health.json')))
    broken = {k: v for k, v in health.items() if v.get('status') == 'broken'}

    urls = sorted({u for v in broken.values() for u in v.get('broken', [])
                   if not u.startswith('(relative)')})
    print(f'broken 模块 {len(broken)} 个，唯一 URL {len(urls)} 个', flush=True)

    with ThreadPoolExecutor(max_workers=6) as pool:
        verdict = dict(zip(urls, pool.map(probe, urls)))

    rows = []
    for slug, rec in sorted(broken.items()):
        rec_urls = [u for u in rec.get('broken', []) if not u.startswith('(relative)')]
        alive = [u for u in rec_urls if verdict.get(u) == 'ok']
        dead = [u for u in rec_urls if verdict.get(u) == 'gone']
        unknown = [u for u in rec_urls if verdict.get(u) == 'unknown']
        state = ('alive' if alive and not dead and not unknown else
                 'dead' if dead and not alive and not unknown else
                 'partial' if alive or dead else
                 'unknown')
        rows.append({'slug': slug, 'state': state,
                     'reason': rec.get('reason'), 'alive': alive,
                     'dead': dead, 'unknown': unknown})

    if '--json' in sys.argv:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return 0

    for r in rows:
        mark = {'alive': '可用', 'dead': '真失效', 'partial': '部分',
                'unknown': '不可达'}[r['state']]
        print(f"{mark:6} {r['slug']:24} {str(r['reason'] or ''):14} "
              f"alive={len(r['alive'])} dead={len(r['dead'])} unknown={len(r['unknown'])}")

    from collections import Counter
    print('\n结论:', Counter(r['state'] for r in rows).most_common())
    return 0


if __name__ == '__main__':
    sys.exit(main())
