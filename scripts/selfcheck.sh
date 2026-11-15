#!/usr/bin/env bash
# 一键自检：Python 交叉核对 + Node 单元测试（可选浏览器端到端）。
# 用法：./scripts/selfcheck.sh [--e2e]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f samples/extracted/cases.json ]; then
  mkdir -p samples/extracted
  python3 -I -m zipfile -e samples/matrix-room.zip samples/extracted >/dev/null
fi

echo "== Python 交叉核对 =="
python3 -I tests/crosscheck.py samples/extracted

echo
echo "== Node 单元测试 =="
node tests/node_check.mjs samples/extracted

if [ "${1:-}" = "--e2e" ]; then
  PORT="${PORT:-8899}"
  echo
  echo "== 浏览器端到端（端口 $PORT）=="
  python3 -I src/py/server.py --port "$PORT" >/tmp/mrc-server.log 2>&1 &
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
