// JS-internal cross-check: scanline engine vs independent per-cell clipper.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePgm } from '../src/pgm.js';
import { computeRasterMoments, cellContributions } from '../src/moments.js';
import { referenceMoments } from '../src/reference.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(HERE, '..', 'tests', 'cases');
const names = JSON.parse(readFileSync(path.join(CASES, 'manifest.json'), 'utf8'));

let fail = 0;
for (const name of names) {
  if (name === 'perf_256') continue;
  const dir = path.join(CASES, name);
  const region = JSON.parse(readFileSync(path.join(dir, 'region.json'), 'utf8'));
  const image = parsePgm(new Uint8Array(readFileSync(path.join(dir, 'gray.pgm'))));
  const eng = computeRasterMoments(region, image);
  const ref = referenceMoments(region, image);
  for (const k of Object.keys(eng.totals)) {
    if (eng.totals[k].toString() !== ref.totals[k].toString()) {
      console.log(`[${name}] total ${k}: engine ${eng.totals[k]} != clip ${ref.totals[k]}`);
      fail++;
    }
  }
  for (const [key, rm] of ref.cells) {
    const r = Math.floor(key / image.width), c = key % image.width;
    const got = cellContributions(eng, image, r, c);
    if (!got) { console.log(`[${name}] missing cell ${r},${c}`); fail++; continue; }
    for (const k of Object.keys(rm)) {
      if (got.geometric[k].toString() !== rm[k].toString()) {
        console.log(`[${name}] cell ${r},${c} ${k}: engine ${got.geometric[k]} != clip ${rm[k]}`);
        fail++;
      }
    }
  }
}
console.log(fail ? `\n${fail} mismatches` : 'ALL MATCH (scanline vs per-cell clipper)');
process.exit(fail ? 1 : 0);
