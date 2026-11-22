// Node verification harness: decode the three sample WAVs with the JS module
// and compare labels/sample spans against the probe ground truth.
// Run: node scratch/verify-js.mjs
import { readFileSync } from 'node:fs';
import { parseWav, decodeChannel } from '../docs/ltc-decoder.js';

const root = new URL('../samples/extracted/', import.meta.url);
const cases = [
  ['df.wav', 'df-probes.json', 'df30'],
  ['tenth-rev.wav', 'tenth-rev-probes.json', 'df30'],
  ['midnight.wav', 'midnight-probes.json', 'ndf25'],
];
let allOk = true;
for (const [wav, probesFile, mode] of cases) {
  const buf = readFileSync(new URL(wav, root));
  const probes = JSON.parse(readFileSync(new URL(probesFile, root)));
  const parsed = parseWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const res = decodeChannel(parsed.channels[0], parsed.sampleRate, mode);
  let ok = res.frames.length === probes.length;
  const rows = res.frames.map((f) => [f.label, f.startSample, f.endSample]);
  if (ok) {
    for (let k = 0; k < probes.length; k++) {
      if (rows[k][0] !== probes[k][0] || rows[k][1] !== probes[k][1] ||
          rows[k][2] !== probes[k][2]) ok = false;
    }
  }
  console.log(`===== ${wav} (dir=${res.direction}) ${ok ? 'MATCH' : 'FAIL'}`);
  if (!ok) {
    allOk = false;
    rows.forEach((r, k) => console.log('  got ', JSON.stringify(r),
      'want', JSON.stringify(probes[k])));
  } else {
    rows.forEach((r) => console.log('  ', JSON.stringify(r)));
  }
}
console.log(allOk ? '\nALL JS DECODE RESULTS MATCH GROUND TRUTH' : '\nMISMATCH');
process.exit(allOk ? 0 : 1);
