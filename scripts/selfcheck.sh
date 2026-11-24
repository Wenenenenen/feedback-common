#!/usr/bin/env bash
# 一键自检：worker 源码新鲜度 + 单元测试 + 浏览器端到端 + 满额性能。
# 用法：./scripts/selfcheck.sh [--fast]   （--fast 跳过性能测试）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 检查 worker-source.js 是否最新"
node tools/build-worker.mjs --check

echo
echo "== 数值核心单元测试"
node --test tests/core.test.mjs

echo
echo "== 合成用例（冲突 / 补零 / 多通道）"
node --test tests/cases.test.mjs

echo
echo "== Python 标准库独立复算（真实样例包）"
python3 -I tests/crosscheck.py

echo
echo "== 浏览器端到端"
node --test tests/ui.test.mjs

if [ "${1:-}" != "--fast" ]; then
  echo
  echo "== 满额输入性能"
  node tests/perf.mjs
fi

echo
echo "全部通过。"
