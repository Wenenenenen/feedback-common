#!/usr/bin/env bash
# Offline self-checks: JS syntax plus exhaustive/DP and sample ZIP tests.
set -euo pipefail
cd "$(dirname "$0")/.."

node --check solver.js
node --check io.js
node --check sample-data.js
node --check app.js
node --test tests/solver.test.cjs

echo
echo 'Self-check passed.'
