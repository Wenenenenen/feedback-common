#!/usr/bin/env node
/* Cross-check src/mvr1.js against tools/reference_decode.py on many cases. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../src/mvr1.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function synth(w, h, n, mode, seed) {
  const r = rng(seed);
  const frames = [];
  let base = new Uint8Array(w * h);
  for (let i = 0; i < base.length; i++) base[i] = Math.floor(r() * 256);
  for (let f = 0; f < n; f++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v;
      if (mode === 'noise') v = Math.floor(r() * 256);
      else if (mode === 'smooth') v = Math.floor(128 + 100 * Math.sin((x + f * 0.7) / 5) * Math.cos(y / 7));
      else if (mode === 'ramp') v = (x * 3 + y * 5 + f * 17) & 255;
      else if (mode === 'flat') v = 128;
      else v = base[y * w + x];
      out[y * w + x] = Math.max(0, Math.min(255, v));
    }
    frames.push({ index: f, name: f + '.pgm', data: out });
  }
  return { name: 'synth-' + mode, width: w, height: h, frames };
}

const cases = [];
for (const [w, h] of [[1, 1], [7, 5], [8, 8], [9, 9], [19, 13], [16, 9], [192, 128], [17, 128]]) {
  for (const mode of ['noise', 'smooth', 'ramp', 'base']) {
    cases.push({ w, h, n: 5, mode, ki: 3, qs: 7, seed: w * 1000 + h + mode.length });
  }
}
cases.push({ w: 19, h: 13, n: 12, mode: 'base', ki: 1, qs: 1, seed: 1 });
cases.push({ w: 19, h: 13, n: 12, mode: 'base', ki: 48, qs: 32, seed: 2 });
cases.push({ w: 3, h: 2, n: 48, mode: 'noise', ki: 5, qs: 255, seed: 3 });

let failures = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvr1-xcheck-'));
for (const c of cases) {
  const seq = synth(c.w, c.h, c.n, c.mode, c.seed);
  const enc = M.encodeAll(seq, { keyInterval: c.ki, quantStep: c.qs });
  const file = path.join(tmp, 'case.mvr1');
  fs.writeFileSync(file, enc.bytes);
  const dec = M.decode(enc.bytes);
  const py = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, '..', 'tools', 'reference_decode.py'), file], { maxBuffer: 1 << 28 }).toString());
  const problems = [];
  if (!dec.ok) problems.push('JS decode ok=false: ' + JSON.stringify(dec.issues));
  if (dec.frames.length !== c.n) problems.push('JS frame count ' + dec.frames.length);
  for (let i = 0; i < c.n; i++) {
    const jf = dec.frames[i], pf = py.frames[i];
    for (let k = 0; k < jf.recCrop.length; k++) {
      if (jf.recCrop[k] !== pf.crop[k]) { problems.push(`frame ${i} rec px ${k}: js ${jf.recCrop[k]} py ${pf.crop[k]}`); break; }
    }
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const j = y * py.pw + x, p = pf.pred[j];
      if (jf.predCrop[y * c.w + x] !== p) { problems.push(`frame ${i} pred px (${x},${y}): js ${jf.predCrop[y * c.w + x]} py ${p}`); break; }
    }
    for (let b = 0; b < jf.blocks.length; b++) {
      const a = jf.blocks[b], q = pf.vectors[b];
      const ex = q ? q[0] : 0, ey = q ? q[1] : 0;
      if ((a.dx || 0) !== ex || (a.dy || 0) !== ey) { problems.push(`frame ${i} block ${b} mv js ${a.dx},${a.dy} py ${ex},${ey}`); break; }
    }
    // encoder's own reconstruction must match what the bitstream decodes to
    const ef = enc.frames[i];
    for (let k = 0; k < ef.recCrop.length; k++) {
      if (ef.recCrop[k] !== jf.recCrop[k]) { problems.push(`frame ${i} encoder/decoder drift px ${k}`); break; }
    }
  }
  if (problems.length) {
    failures++;
    console.log(`FAIL w=${c.w} h=${c.h} mode=${c.mode} ki=${c.ki} qs=${c.qs}`);
    problems.slice(0, 6).forEach(p => console.log('   ' + p));
  } else {
    console.log(`ok   w=${String(c.w).padStart(3)} h=${String(c.h).padStart(3)} ${c.mode.padEnd(6)} ki=${String(c.ki).padStart(2)} qs=${String(c.qs).padStart(3)} bytes=${enc.bytes.length}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} case(s) FAILED` : '\nall cases match the independent decoder');
process.exit(failures ? 1 : 0);
