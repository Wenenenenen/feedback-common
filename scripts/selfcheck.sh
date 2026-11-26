#!/usr/bin/env bash
# 一键自检：Node 单元测试 + 浏览器端到端测试 + 满额性能基准
set -euo pipefail
cd "$(dirname "$0")/.."
echo "===== 单元测试 ====="
node tests/unit.test.js
echo
echo "===== 满额性能基准（单线程）====="
node tests/bench.mjs
echo
echo "===== 浏览器端到端 ====="
node tests/e2e.mjs
