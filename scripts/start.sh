#!/usr/bin/env bash
# 启动深度区间合成台本地服务（纯标准库，离线可用）。
# 用法：./scripts/start.sh [端口，默认 8000]
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8000}"
exec python3 -I src/server.py --port "$PORT"
