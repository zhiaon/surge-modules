#!/usr/bin/env python3
"""
Gate: fail the sync when raw/ contains a module Surge cannot load.

Runs in CI right after the repair steps. Exits non-zero when a defect survives,
which stops the build from shipping it — a loud failure beats a module that
silently wipes the user's MITM config.

Usage: python3 scripts/check_module_format.py [--warn]
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')

SURGE_SECTIONS = {
    'General', 'Proxy', 'Proxy Group', 'Rule', 'Host', 'URL Rewrite',
    'Header Rewrite', 'Map Local', 'Map Remote', 'MITM', 'Script', 'Panel',
    'Rule Set', 'Ruleset', 'IP Rewrite', 'SSID Setting', 'Replica', 'MTProto',
    'Keystore',
}

# `http-response <regex>` inside [Script] is Shadowrocket syntax; inside
# [Header Rewrite] the same leading token is the correct Surge direction.
SR_LINE = re.compile(r'^(http-request|http-response|cron|generic)\s+\S', re.I)
QX_LINE = re.compile(r'\burl\s+script-(response|request)-body\b')
SECTION = re.compile(r'^\[([^\]]+)\]$')


def main():
    warn_only = '--warn' in sys.argv
    problems = []

    for name in sorted(f for f in os.listdir(RAW) if f.endswith('.sgmodule')):
        path = os.path.join(RAW, name)
        text = open(path, encoding='utf-8', errors='replace').read()
        lines = text.split('\n')

        section = None
        for line in lines:
            stripped = line.strip()
            m = SECTION.match(stripped)
            if m:
                section = m.group(1)
                if section not in SURGE_SECTIONS:
                    problems.append(f'{name}: 非法段名 [{section}]')
                continue
            if not stripped or stripped.startswith('#') or stripped.startswith(';'):
                continue
            if section == 'Script' and SR_LINE.match(stripped):
                problems.append(f'{name}: [Script] 使用了非 Surge 语法 -> {stripped[:60]}')
            if QX_LINE.search(stripped) and not stripped.startswith('#'):
                problems.append(f'{name}: Quantumult X 语法 -> {stripped[:60]}')

        # A bare hostname list replaces the user's own MITM set.
        m = re.search(r'^\[(?:MITM|Mitm)\]([\s\S]*?)(?=^\[|\Z)', text, re.M | re.I)
        if m:
            for line in m.group(1).split('\n'):
                if re.match(r'^\s*hostname\s*=', line):
                    value = line.split('=', 1)[1].strip()
                    if value and not re.match(r'^%?(APPEND|INSERT|DELETE)%', value, re.I):
                        problems.append(f'{name}: [MITM] hostname 缺少 %APPEND%')

    if not problems:
        print(f'格式检查通过（{len(os.listdir(RAW))} 个文件）')
        return 0

    print(f'发现 {len(problems)} 处格式问题：')
    for p in problems[:40]:
        print('  -', p)
    if len(problems) > 40:
        print(f'  …另有 {len(problems) - 40} 处')
    if warn_only:
        print('（--warn 模式，不阻断）')
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
