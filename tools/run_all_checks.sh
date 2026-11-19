#!/usr/bin/env bash
# Full verification pipeline. Run from repo root with: bash tools/run_all_checks.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. Python reference vs reference.json (operator, adjoint, RL, MSE) =="
python3 -I tools/ref_rl.py

echo "== 2. Generate independent Python expected values for cross-engine checks =="
python3 -I tools/gen_py_expected.py

echo "== 3. Shared JS engine: reference.json + Python cross-checks =="
node tools/test_engine.js

echo "== 4. PNG encoder (quantization, CRC/adler, stored zlib) =="
node tools/test_png.js
python3 -I tools/check_png.py

echo "== 5. Build the self-contained page (inlines validated engine + encoder) =="
node tools/build.js

echo "== 6. Headless-browser end-to-end tests =="
node tools/e2e_test.js

echo "ALL CHECKS PASSED"
