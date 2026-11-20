#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8000}"
exec python3 -I scripts/serve.py --port "$PORT" --root src
