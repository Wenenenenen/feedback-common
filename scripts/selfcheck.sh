#!/usr/bin/env bash
# 一键自检：Python 参考实现与 JS 移植分别对照 expected.json 全量校验。
# 不需要启动服务、不需要浏览器；E2E 另见 tests/run_e2e.sh。
set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${1:-samples/extracted}"
EXPECTED="$SAMPLES/expected.json"

echo "================ Python 参考实现 ================"
fail=0
for name in crossing gradient clipping shared-edge equal-depth occlusion \
            stack32 crossing-reversed stack32-reversed; do
  python3 -I src/py/alpha_render.py check "$SAMPLES/$name.json" \
    --expected "$EXPECTED" --name "$name.json" || fail=1
done

echo
echo "================ JavaScript 移植（Node） ================"
node tests/node_check.mjs "$SAMPLES" || fail=1

echo
echo "================ JS / Python 全帧交叉核对 ================"
node tests/crosscheck.mjs "$SAMPLES" || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "存在失败项。" >&2
  exit 1
fi
