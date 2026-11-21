#!/usr/bin/env bash
# Regenerate fixtures (extract the provided archive + build the synthetic
# matrix), then run all three suites.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf .untrusted-samples .cache/synthetic
mkdir -p .untrusted-samples
unzip -qo samples/sparse-tiff-roi-cases.zip -d .untrusted-samples
python3 -I tools/gen_cases.py .cache/synthetic

node tests/core.test.js
node tests/synthetic.test.js
node tests/ui.test.js
