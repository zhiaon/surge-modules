#!/bin/sh
# 本地人工发布：同步 → 构建 → 部署 → 推送通知
#
# 为什么需要这个脚本：GitHub Actions 那套会在有变化时自动发 Telegram，
# 但在本地手动跑（改代码 / 手动同步）不会经过 Actions，通知就漏了。
# 以后手动发布一律走这个脚本，行为与 Actions 保持一致。
#
#   ./scripts/deploy_local.sh              # 同步 + 构建 + 部署 + 通知
#   ./scripts/deploy_local.sh --no-sync    # 只构建部署（不同步上游）
#   ./scripts/deploy_local.sh --no-notify  # 不发 Telegram
set -e
cd "$(dirname "$0")/.."

SYNC=1
NOTIFY=1
for arg in "$@"; do
  [ "$arg" = "--no-sync" ] && SYNC=0
  [ "$arg" = "--no-notify" ] && NOTIFY=0
done

if [ "$SYNC" = "1" ]; then
  echo "== 1/5 同步上游 =="
  python3 scripts/sync_upstream.py
else
  echo "== 1/5 跳过同步 =="
fi

echo "== 2/5 构建 =="
npm run build:static

echo "== 3/5 部署 =="
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-7a89ed189beac8f21cb18dfed4e1668c}"
npx wrangler pages deploy dist --project-name surge-modules --branch main

if [ "$NOTIFY" = "1" ]; then
  echo "== 4/5 通知 =="
  python3 scripts/notify_telegram.py
else
  echo "== 4/5 跳过通知 =="
fi

echo "== 5/5 提交状态 =="
git add -A
git -c user.name=zhiaon -c user.email=ycccchi@gmail.com commit -qm "sync: $(date -u +%Y-%m-%dT%H:%MZ)" || echo "（无变化）"
git push -q origin main || echo "（推送失败，稍后重试）"
echo "✓ 完成"
