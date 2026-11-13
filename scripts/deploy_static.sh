#!/bin/sh
# Build + deploy the pure-static Pages site.
#
# `vite build` wipes dist/, so the static data payload and the raw .sgmodule
# copies must be regenerated *after* every build, in this order. Running them
# by hand is how the files went missing once already.
#
#   ./scripts/deploy_static.sh            # build + deploy
#   ./scripts/deploy_static.sh --no-deploy # build only (local check)
set -e
cd "$(dirname "$0")/.."

echo "== 1/4 构建前端 =="
NODE_OPTIONS="--max-old-space-size=700" node node_modules/vite/bin/vite.js build

echo "== 2/4 生成静态数据 =="
python3 scripts/build_static.py

echo "== 3/4 复制 sgmodule 原文 =="
python3 scripts/fetch_raw_modules.py

echo "== 4/4 部署到 Pages =="
if [ "$1" = "--no-deploy" ]; then
  echo "   （跳过部署）"
else
  export CLOUDFLARE_ACCOUNT_ID=7a89ed189beac8f21cb18dfed4e1668c
  npx wrangler pages deploy dist --project-name surge-modules --branch main
fi
