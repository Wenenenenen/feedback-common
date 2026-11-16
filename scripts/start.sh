#!/usr/bin/env bash
# 启动本地服务（纯 Python 标准库，离线可用）。
# 用法：./scripts/start.sh [端口，默认 8000]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8000}"

if [ ! -f samples/extracted/linear.pfm ]; then
  if [ -f samples/irradiance-sh-baker-cases.zip ]; then
    mkdir -p samples/extracted
    python3 -I -m zipfile -e samples/irradiance-sh-baker-cases.zip samples/extracted >/dev/null
    echo "已解压样例到 samples/extracted/"
  else
    echo "警告：未找到 samples/irradiance-sh-baker-cases.zip，样例下拉将为空（仍可手动导入 PFM）" >&2
  fi
fi

exec python3 -I src/py/server.py --port "$PORT"
