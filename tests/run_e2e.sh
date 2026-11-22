#!/usr/bin/env bash
# 端到端测试编排：启动本地服务，再用无头 Chromium 跑 tests/e2e.mjs。
# 用法：./tests/run_e2e.sh [端口，默认 8000]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8000}"
BASE="http://127.0.0.1:$PORT/"

python3 -I src/py/server.py --port "$PORT" >/tmp/lfv-e2e-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

# 等服务就绪
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "$BASE"; then break; fi
  sleep 0.2
done

node tests/e2e.mjs "$BASE"
