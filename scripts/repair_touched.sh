#!/bin/sh
# Repair the modules this sync run actually added or changed.
#
# A module nobody touched is never rewritten: an untouched file already works,
# and re-running the converter over it is pure risk. Repair only what is new or
# was just re-downloaded from upstream.
set -e
cd "$(dirname "$0")/.."

LIST=$(python3 - <<'PY'
import json, os
try:
    r = json.load(open('/tmp/sync-report.json'))
except Exception:
    print('')
    raise SystemExit
slugs = r.get('touched') or []
paths = [f'raw/{s}.sgmodule' for s in slugs if os.path.exists(f'raw/{s}.sgmodule')]
print(' '.join(paths))
PY
)

if [ -z "$LIST" ]; then
    echo "本次没有新增或更新的模块，跳过格式修复"
else
    COUNT=$(echo "$LIST" | wc -w)
    echo "需要检查的模块：$COUNT 个"
    python3 scripts/fix_module_format.py --apply $LIST
    python3 scripts/fix_shadowrocket_scripts.py --apply $LIST
fi

echo "--- 格式检查（仅本次涉及的模块）"
if [ -n "$LIST" ]; then
    python3 scripts/check_module_format.py $LIST
else
    echo "跳过"
fi
