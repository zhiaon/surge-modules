#!/usr/bin/env python3
"""
Record what the repair step changed, into /tmp/sync-report.json as `fixed`.

The two fixers write one line per modified file (`name: append,case`), and the
Shadowrocket converter prints a count. Both are folded into a small tally the
Telegram message renders as `格式修复 3 个（%APPEND% 3）`.
"""
import json
import os
import sys

REPORT = '/tmp/sync-report.json'


def read_keys(path):
    """`file.sgmodule: append,case` → list of keys, one entry per file."""
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line or ':' not in line:
            continue
        _, keys = line.rsplit(':', 1)
        out.append([k.strip() for k in keys.split(',') if k.strip()])
    return out


def main():
    if '--empty' in sys.argv and not os.path.exists(REPORT):
        return

    try:
        rep = json.load(open(REPORT, encoding='utf-8'))
    except Exception:
        return

    if '--empty' in sys.argv:
        rep['fixed'] = {}
        json.dump(rep, open(REPORT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        return

    keys_by_file = read_keys('/tmp/fix_report.txt') + read_keys('/tmp/sr_report.txt')
    tally = {}
    for keys in keys_by_file:
        for k in keys:
            tally[k] = tally.get(k, 0) + 1

    rep['fixed'] = tally
    json.dump(rep, open(REPORT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
