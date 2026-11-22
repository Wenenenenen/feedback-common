// Cross-check the JS engine against the Python reference dump.
// Run: node tools/crosscheck.js samples/film-stack-cases.json tools/ref_outputs.json
'use strict';

const fs = require('fs');
const path = require('path');
const TMM = require(path.join(__dirname, '..', 'js', 'tmm.js'));

const samplePath = process.argv[2];
const refPath = process.argv[3];
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

const wavelengths = ref.wavelengths;
const angles = ref.angles;
let worst = 0;
let worstAt = '';
let failures = 0;

for (const caseData of sample.cases) {
  const layers = caseData.layers.map(([d, n, k]) => ({ d, n, k }));
  const got = TMM.fullGrid(caseData.n0, caseData.ns, layers, wavelengths, angles);
  const want = ref.cases[caseData.id];
  for (const pol of ['s', 'p']) {
    for (const q of ['R', 'T', 'A']) {
      for (let ai = 0; ai < angles.length; ai++) {
        for (let wi = 0; wi < wavelengths.length; wi++) {
          const a = got[pol][q][ai][wi];
          const b = want[pol][q][ai][wi];
          const diff = Math.abs(a - b);
          if (diff > worst) {
            worst = diff;
            worstAt = `${caseData.id} ${pol}${q} ang=${angles[ai]} wl=${wavelengths[wi]}`;
          }
          if (!Number.isFinite(a)) {
            failures++;
            console.error(`NON-FINITE: ${caseData.id} ${pol}${q} ang=${angles[ai]} wl=${wavelengths[wi]}`);
          }
          if (diff > 1e-10) {
            failures++;
            if (failures <= 10) {
              console.error(`MISMATCH: ${caseData.id} ${pol}${q} ang=${angles[ai]} ` +
                `wl=${wavelengths[wi]} js=${a} py=${b} diff=${diff}`);
            }
          }
        }
      }
    }
  }
}

console.log(`checked ${sample.cases.length} cases x ${angles.length} angles x ` +
  `${wavelengths.length} wavelengths x 2 pol x 3 quantities`);
console.log(`worst abs diff: ${worst.toExponential(3)} at ${worstAt}`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('cross-check passed (tolerance 1e-10)');
