#!/usr/bin/env bash
# Numerical smoke tests + Python-reference parity for the inlined ESM modules.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -I tools/reference_dump.py samples/extracted 0 > /tmp/ref_extracted_0.json
python3 -I tools/reference_dump.py samples/extracted 8 > /tmp/ref_extracted_8.json
python3 -I tools/reference_dump.py /tmp/ab-synth64 0 > /tmp/ref_synth64_0.json
python3 -I tools/reference_dump.py /tmp/ab-synth64 8 > /tmp/ref_synth64_8.json

node tools/test/node-smoke.mjs samples/extracted 0 /tmp/ref_extracted_0.json
node tools/test/node-smoke.mjs samples/extracted 8 /tmp/ref_extracted_8.json
node tools/test/node-smoke.mjs /tmp/ab-synth64 0 /tmp/ref_synth64_0.json
node tools/test/node-smoke.mjs /tmp/ab-synth64 8 /tmp/ref_synth64_8.json

# parser safety: malformed files must be rejected, never crash with a raw exception type leak
node --input-type=module -e "
import { parsePnm } from './tools/src/pnm.js';
import { PnmError } from './tools/src/pnm.js';
const cases = {
  truncated: new TextEncoder().encode('P6\n4 4\n255\n').buffer,
  badMagic: new TextEncoder().encode('P3\n1 1\n255\n0 0 0').buffer,
  tooBig: new TextEncoder().encode('P6\n385 1\n255\n').buffer,
  badMax: new TextEncoder().encode('P6\n1 1\n128\n0').buffer,
};
let ok = true;
for (const [name, buf] of Object.entries(cases)) {
  try { parsePnm(buf); console.error('FAIL: accepted', name); ok = false; }
  catch (e) { if (!(e instanceof PnmError)) { console.error('FAIL: wrong error type', name, e); ok = false; } }
}
if (!ok) process.exit(1);
console.log('parser rejection cases: all rejected with PnmError');
"
