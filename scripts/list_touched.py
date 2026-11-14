#!/usr/bin/env python3
"""Print the raw paths of modules this sync run touched (space separated)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')

try:
    rep = json.load(open('/tmp/sync-report.json'))
except Exception:
    print('')
    sys.exit(0)

slugs = rep.get('touched') or []
paths = [f'raw/{s}.sgmodule' for s in slugs
         if os.path.exists(os.path.join(RAW, f'{s}.sgmodule'))]
print(' '.join(paths))
