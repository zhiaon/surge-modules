#!/usr/bin/env python3
"""
Build the static Pages payload + deploy. Single entry point.

Steps:
  1. vite build          → dist/ (frontend, wipes dist/data — regenerated next)
  2. build_static.py     → dist/data/*.json from /tmp/static_dump (needs dump_for_static.py once)
  3. fetch_raw_modules.py→ dist/m/<slug>.sgmodule (1270 files, uses GITHUB_TOKEN for private repo)
  4. wrangler pages deploy
"""
import subprocess
import sys

STEPS = [
    ['node', 'node_modules/vite/bin/vite.js', 'build'],
    ['python3', 'scripts/build_static.py'],
    ['python3', 'scripts/fetch_raw_modules.py'],
    ['npx', 'wrangler', 'pages', 'deploy', 'dist',
     '--project-name', 'surge-modules', '--branch', 'main'],
]

for i, cmd in enumerate(STEPS, 1):
    print(f'== {i}/{len(STEPS)} {" ".join(cmd[:3])} ==', flush=True)
    r = subprocess.run(cmd, cwd='/var/minis/workspace/surge-modules')
    if r.returncode != 0:
        print(f'✗ 步骤 {i} 失败', file=sys.stderr)
        sys.exit(r.returncode)
print('✓ 完成')
