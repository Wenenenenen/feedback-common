// Node verification for app/engine.js against the sample cases.
// Run: node --check style usage;  node tools/node_verify.js
const fs = require('fs');
const path = require('path');
require('../app/engine.js');
const U = globalThis.UVAudit;

const dir = path.join(__dirname, '..', 'samples', 'extracted');
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

let failures = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  got  ${g}\n  want ${w}`}`);
}
function approx(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} got=${got} want=${want}`);
}

(async () => {
  const audit = read('audit.json');
  const expected = read('expected.json');
  const token = { cancelled: false };
  const t0 = Date.now();
  const res = await U.analyze(U.validate(audit), token, null, () => new Promise(r => setTimeout(r, 0)));
  console.log(`analyze audit.json in ${Date.now() - t0} ms`);

  eq('degenerate faces', res.metrics.map((m, i) => m.degenerate ? i : -1).filter(i => i >= 0),
    expected.degenerate);
  eq('mirrored faces', res.metrics.map((m, i) => m.mirrored ? i : -1).filter(i => i >= 0),
    expected.mirrored);
  eq('outside faces', res.metrics.map((m, i) => m.outside ? i : -1).filter(i => i >= 0),
    expected.outside);

  for (const key of ['face0', 'face2']) {
    const idx = Number(key.slice(4));
    const m = res.metrics[idx], e = expected[key];
    approx(`${key} area_ratio`, m.areaRatio, e.area_ratio, 1e-12);
    approx(`${key} svHi`, m.svHi, e.singular_values[0], 1e-12);
    approx(`${key} svLo`, m.svLo, e.singular_values[1], 1e-12);
    approx(`${key} stretch`, m.stretch, e.stretch_ratio, 1e-12);
  }

  eq('overlap pair count', res.overlaps.length, expected.overlaps.length);
  eq('overlap faces', [res.overlaps[0].a, res.overlaps[0].b], expected.overlaps[0].faces);
  approx('overlap area', res.overlaps[0].area, expected.overlaps[0].area, 1e-12);

  const covered = res.mask.reduce((s, x) => s + x, 0);
  approx('mask covered pixels == python proto (8256)', covered, 8256, 0);

  // Degenerate faces excluded: pairs for 4 and 5 must be empty.
  eq('degenerate has no overlap entries', res.facePairs[4].length + res.facePairs[5].length, 0);

  // Cancel semantics.
  const tk = { cancelled: true };
  const cancelled = await U.analyze(U.validate(audit), tk, null, async () => {});
  eq('cancelled analysis returns null', cancelled, null);

  // Invalid inputs.
  for (const [file, fragment] of [['invalid-index.json', '越界'], ['invalid-uv.json', '有限数字']]) {
    let msg = null;
    try { U.validate(read(file)); } catch (e) { msg = e.message; }
    const ok = msg && msg.includes(fragment);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${file} rejected (${fragment}) got=${JSON.stringify(msg)}`);
  }

  // grid.json: 5000 faces performance + no false overlap between edge-sharing tris.
  const grid = read('grid.json');
  const t1 = Date.now();
  const gres = await U.analyze(U.validate(grid), { cancelled: false }, null,
    () => new Promise(r => setTimeout(r, 0)));
  const ms = Date.now() - t1;
  console.log(`analyze grid.json (5000 faces) in ${ms} ms, overlaps=${gres.overlaps.length}, ` +
    `maskCovered=${gres.mask.reduce((s, x) => s + x, 0)}`);
  if (ms > 15000) { failures++; console.log('FAIL grid too slow'); }
  if (gres.overlaps.length !== 0) { failures++; console.log('FAIL grid should have no interior overlaps'); }
  // grid triangles tile the unit square exactly: mask rule must yield 0 covered
  // (boundary-only contacts collapse to one id).
  eq('grid mask has no double-covered pixels', gres.mask.reduce((s, x) => s + x, 0), 0);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
