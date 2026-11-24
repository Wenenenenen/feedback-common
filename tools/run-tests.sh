#!/usr/bin/env bash
# 一键跑全部检查（需要 node；python3 + numpy 可选；playwright 可选）。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 核心测试 ==="
node tools/test-core.js

echo
echo "=== 性能基准 ==="
node tools/bench.js

if python3 -c 'import numpy' 2>/dev/null; then
  echo
  echo "=== 独立参考与 KKT 核验 ==="
  python3 tools/reference.py
  python3 tools/verify-kkt.py
else
  echo
  echo "（跳过 numpy 参考核验：未安装 numpy）"
fi

if node -e "require(require('path').join(require('path').dirname(process.execPath),'..','lib','node_modules','playwright'))" 2>/dev/null; then
  echo
  echo "=== 浏览器回归 ==="
  node tools/serve.mjs 8137 >/tmp/sap-serve-test.log 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null || true' EXIT
  sleep 1
  node --test tools/browser-test.mjs
  if [ -f test-output/large-1800.zip ]; then
    node --test tools/perf-page.mjs
  fi
else
  echo
  echo "（跳过浏览器测试：未安装 playwright）"
fi

echo
echo "全部完成"
