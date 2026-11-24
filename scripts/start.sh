#!/usr/bin/env bash
# 启动本地静态服务（纯 Python 标准库，离线可用）。
# 用法：./scripts/start.sh [端口，默认 8123]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8123}"

echo "扫频谐波分离台：http://localhost:${PORT}/"
exec python3 -I -m http.server "${PORT}" --bind 127.0.0.1
