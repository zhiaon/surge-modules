#!/bin/sh
# Repair the modules this sync run actually added or changed.
#
# A module nobody touched is never rewritten: an untouched file already works,
# and re-running the converter over it is pure risk. Repair only what is new or
# was just re-downloaded from upstream.
#
# Writes the tally into /tmp/sync-report.json as `fixed`, so the Telegram
# message can say what was repaired instead of only that something changed.
set -e
cd "$(dirname "$0")/.."

LIST=$(python3 scripts/list_touched.py)

if [ -z "$LIST" ]; then
    echo "本次没有新增或更新的模块，跳过格式修复"
    python3 scripts/record_fixes.py --empty
    exit 0
fi

COUNT=$(echo "$LIST" | wc -w | tr -d ' ')
echo "需要检查的模块：$COUNT 个"

python3 scripts/fix_module_format.py --apply $LIST --report /tmp/fix_report.txt
python3 scripts/fix_shadowrocket_scripts.py --apply $LIST --report /tmp/sr_report.txt

echo "--- 格式检查（仅本次涉及的模块）"
python3 scripts/check_module_format.py $LIST

python3 scripts/record_fixes.py
