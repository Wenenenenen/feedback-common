#!/usr/bin/env bash
# 启动本地双面去透印服务（隔离模式，仅 127.0.0.1）
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8899}"
exec .venv/bin/python -I server/app.py
