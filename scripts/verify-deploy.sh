#!/bin/sh
# 部署后验证。可在 iPhone 的 a-Shell / iSH 里跑，也可让 GitHub Actions 跑。
#
# 用法：  sh scripts/verify-deploy.sh
# 全部通过退出 0，否则退出 1。

set -u

SITE="${SITE:-https://son.zhiaon.top}"
PROXY="${PROXY:-https://sgmd.zhiaon.top}"
ACCOUNT="${CF_ACCOUNT:-}"

fail=0
pass=0

check() {
  label="$1"
  expected="$2"
  actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $label → $actual"
    pass=$((pass + 1))
  else
    echo "  ✗ $label → 期望 $expected，实际 $actual"
    fail=$((fail + 1))
  fi
}

echo "主站 $SITE"
check "健康检查" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/health" 2>/dev/null || echo 000)"
check "首页" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/" 2>/dev/null || echo 000)"
check "SPA 深层路由" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/modules/dns-lite" 2>/dev/null || echo 000)"
check "后台入口" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/admin" 2>/dev/null || echo 000)"

# 未登录必须 401，不是 200
echo ""
check "管理 API 未授权拦截" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/admin/dashboard" 2>/dev/null || echo 000)"

# 公开 API 必须返回 JSON
echo ""
body=$(curl -s "$SITE/api/v1/categories" 2>/dev/null || echo '')
# JSON 可能带或不带空格（wrangler 用紧凑格式，Python 预览用 spaced 格式）
case "$body" in
  *'"ok":true'*|*'"ok": true'*) echo "  ✓ 分类 API 返回 JSON"; pass=$((pass + 1));;
  *) echo "  ✗ 分类 API 返回异常"; fail=$((fail + 1));;
esac

echo ""
echo "反代 $PROXY"
check "健康检查" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/health" 2>/dev/null || echo 000)"

# 未登记的 slug 必须 404，不能是 200
check "未知 slug 拒绝" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/not-registered-xyz" 2>/dev/null || echo 000)"
# 查询串必须 400（防开放代理）
check "查询串拒绝" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/dns-lite?url=http://evil.com" 2>/dev/null || echo 000)"
# 多段路径必须 400
check "多段路径拒绝" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/dns-lite/extra" 2>/dev/null || echo 000)"

echo ""
echo "内容类型"
ct=$(curl -s -o /dev/null -w '%{content_type}' "$PROXY/dns-lite" 2>/dev/null || echo '')
case "$ct" in
  text/plain*) echo "  ✓ 模块原文为 text/plain"; pass=$((pass + 1));;
  *) echo "  ✗ 模块原文 content-type = $ct（应为 text/plain）"; fail=$((fail + 1));;
esac

# workers.dev 必须关闭
if [ -n "$ACCOUNT" ]; then
  echo ""
  echo "workers.dev 入口"
  for host in "surge-modules-site.$ACCOUNT.workers.dev" "surge-modules-proxy.$ACCOUNT.workers.dev"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      echo "  ✗ $host 仍可访问（返回 200）"
      fail=$((fail + 1))
    else
      echo "  ✓ $host 已关闭（$code）"
      pass=$((pass + 1))
    fi
  done
else
  echo ""
  echo "  · 未设置 CF_ACCOUNT，跳过 workers.dev 检查"
  echo "    用法：CF_ACCOUNT=<account-id> sh scripts/verify-deploy.sh"
fi

echo ""
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ] || exit 1
