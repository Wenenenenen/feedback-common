#!/usr/bin/env bash
# 静态启动导频校速台（从仓库根目录提供页面）
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-${PORT:-8000}}"
echo "Serving pilot-cycle-restorer at http://127.0.0.1:${PORT}"
exec python3 -I -m http.server "$PORT" --bind 127.0.0.1
