#!/usr/bin/env bash
# 启动本地服务（纯 Python 标准库，离线可用）。
# 用法：./scripts/start.sh [端口，默认 8000]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8000}"

if [ ! -f samples/extracted/cases.json ]; then
  if [ -f samples/matrix-room.zip ]; then
    mkdir -p samples/extracted
    python3 -I -m zipfile -e samples/matrix-room.zip samples/extracted >/dev/null
    echo "已解压样例到 samples/extracted/"
  else
    echo "警告：未找到 samples/matrix-room.zip，样例下拉将为空（仍可手动导入 WAV）" >&2
  fi
fi

exec python3 -I src/py/server.py --port "$PORT"
