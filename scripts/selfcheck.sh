#!/usr/bin/env bash
# 一键自检：页面构建 + Node 单元/手工真值/JS↔Python fuzz 交叉核对 + Python 参考实现。
# 不需要启动服务、不需要浏览器；浏览器 E2E 另见 tests/e2e.mjs。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "================ 构建 index.html（内联引擎） ================"
scripts/build-page.sh

echo
echo "================ Node 单元 + JS/Python fuzz 交叉核对 ================"
node tests/node_check.mjs

echo
echo "================ Python 参考实现独立运行 ================"
python3 -I tools/reference.py validate samples/deep-intervals.json

echo
echo "全部自检通过。"
