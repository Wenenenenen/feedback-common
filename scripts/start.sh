#!/usr/bin/env bash
# 启动本地静态服务器：默认 http://127.0.0.1:8000/
# 响应带 COOP/COEP，页面可用 SharedArrayBuffer → 多 Worker 并行投票。
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8000}"
exec node tools/serve.mjs --port "$PORT" --host 127.0.0.1 --root src
