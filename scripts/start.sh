#!/usr/bin/env bash
# Serve the static anchored-partial synth from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-${PORT:-8000}}"
echo "Serving anchored-partial-synth at http://127.0.0.1:${PORT}"
exec python3 -I -m http.server "$PORT" --bind 127.0.0.1
