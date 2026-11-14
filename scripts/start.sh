#!/usr/bin/env bash
# 启动 Alpha 层检查台本地服务（纯标准库，离线可用，无需 Docker）。
# 用法：./scripts/start.sh [端口，默认 8000]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8000}"

# 样例包尚未解压时自动解压到独立目录（不可信数据隔离）
if [ ! -f samples/extracted/说明.txt ]; then
  if [ -f samples/transparency-cases.zip ]; then
    mkdir -p samples/extracted
    unzip -o samples/transparency-cases.zip -d samples/extracted >/dev/null
    echo "已解压样例到 samples/extracted/"
  else
    echo "警告：未找到 samples/transparency-cases.zip，样例下拉将为空（仍可手动导入 JSON）" >&2
  fi
fi

# -I：隔离模式，忽略 PYTHONPATH/用户站点，避免样例目录内被植入同名模块
exec python3 -I src/py/server.py --port "$PORT"
