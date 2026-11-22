#!/usr/bin/env bash
# 一键自检：Python 参考实现 / JS 移植 / 两者随机交叉 三项全量校验。
# 不需要浏览器；端到端另见 tests/run_e2e.sh。
set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${1:-samples}"
fail=0

echo "================ JS 解释器 × expected.json ================"
node tests/node_check.mjs "$SAMPLES" || fail=1

echo
echo "================ Python 参考 × expected.json ================"
node tests/python_check.mjs "$SAMPLES" || fail=1

echo
echo "================ JS × Python 随机交叉核对 ================"
node tests/crosscheck.mjs 150 1 || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "存在失败项。" >&2
  exit 1
fi
