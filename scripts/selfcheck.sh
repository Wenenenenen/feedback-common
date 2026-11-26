#!/usr/bin/env bash
# 一键自检：Python 参考交叉核对 + 精度 + 性能 + 浏览器端到端。
# 用法：./scripts/selfcheck.sh [--e2e]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f samples/extracted/scene.json ]; then
  if [ -f samples/moving-audio.zip ]; then
    mkdir -p samples/extracted
    python3 -I -m zipfile -e samples/moving-audio.zip samples/extracted >/dev/null
    echo "已解压样例到 samples/extracted/"
  else
    echo "错误：未找到 samples/moving-audio.zip" >&2
    exit 1
  fi
fi

echo "== 引擎 vs Python 参考（逐样点） =="
node tests/engine_vs_reference.mjs

echo
echo "== 精度（u / gain / 声程残差） =="
node tests/accuracy.mjs

echo
echo "== 最坏情况性能（6000 段 / 60 秒 / 8 轨） =="
node tests/perf_worst.mjs

if [ "${1:-}" = "--e2e" ]; then
  PORT="${PORT:-8899}"
  echo
  echo "== 浏览器端到端（端口 $PORT） =="
  python3 -I src/py/server.py --port "$PORT" >/tmp/msb-server.log 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:$PORT/api/samples" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  node tests/e2e_check.mjs "http://127.0.0.1:$PORT"
fi

echo
echo "全部通过"
