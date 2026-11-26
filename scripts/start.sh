#!/usr/bin/env bash
# Serve the static tone-curve workbench from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8000}"
echo "Serving anchored-tone-curve at http://127.0.0.1:${PORT}"
exec python3 -I -m http.server "$PORT" --bind 127.0.0.1
