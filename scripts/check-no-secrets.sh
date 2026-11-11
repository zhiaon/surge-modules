#!/bin/sh
# 部署前检查：确认没有密钥被写进会被部署的文件。
#
# 检查范围是 `git ls-files` 会包含的内容（源码、配置、文档），
# 跳过 node_modules、dist、.wrangler 和测试夹具。
#
# 退出码 0 = 干净；1 = 发现问题。

set -u
cd "$(dirname "$0")/.." || exit 1

fail=0

echo "检查密钥泄漏…"

# 真正的 token 形状。测试文件里的假 token（ghp_TEST...）会被下面的白名单放过。
PATTERNS='ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}'

hits=$(grep -rEn "$PATTERNS" \
  src workers packages scripts docs database index.html wrangler.toml 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v 'tests/' \
  | grep -v '\.example' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ 发现疑似 GitHub Token："
  echo "$hits"
  fail=1
else
  echo "✓ 源码中无 GitHub Token"
fi

# .env / .dev.vars 不应该被提交
for f in .env .dev.vars .env.local; do
  if [ -f "$f" ]; then
    echo "✗ 存在 $f —— 确认它已在 .gitignore 中，且不要提交"
    fail=1
  fi
done

# 构建产物里也不允许出现
if [ -d dist ]; then
  if grep -rEq "$PATTERNS" dist/ 2>/dev/null; then
    echo "✗ dist/ 中包含疑似 Token"
    fail=1
  else
    echo "✓ dist/ 干净"
  fi
fi

# wrangler.toml 里不应有 secret
for f in workers/site/wrangler.toml workers/module-proxy/wrangler.toml; do
  if grep -Eq 'GITHUB_READ_TOKEN *= *"[^"]+"|RATE_LIMIT_SALT *= *"[^"]+"' "$f" 2>/dev/null; then
    echo "✗ $f 中出现明文 secret（只应使用 wrangler secret put）"
    fail=1
  fi
done
echo "✓ wrangler 配置无明文 secret"

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "检查未通过，请修复后再部署。"
  exit 1
fi

echo ""
echo "全部通过。"
