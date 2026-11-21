#!/usr/bin/env node
/* Encode the real sample cases and assert known-good properties. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('../src/mvr1.js');

function readZip(file) {
  const buf = fs.readFileSync(file);
  const out = new Map();
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const elen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
    const start = p + 30 + nlen + elen;
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    p = start + csize;
  }
  return out;
}

const zip = readZip(path.join(__dirname, '..', 'samples', 'closed-loop-motion-cases.zip'));
const groups = new Map();
for (const [name, bytes] of zip) {
  const m = /^(.+)\/(\d+)\.pgm$/.exec(name);
  if (!m) continue;
  if (!groups.has(m[1])) groups.set(m[1], []);
  groups.get(m[1]).push({ n: Number(m[2]), name: m[0], buffer: new Uint8Array(bytes) });
}

let fails = 0;
function check(cond, msg) { if (!cond) { console.log('FAIL ' + msg); fails++; } }

for (const [group, list] of groups) {
  list.sort((a, b) => a.n - b.n);
  const seq = M.buildSequence(list.map(f => ({ name: f.name.split('/').pop(), buffer: f.buffer })), group);
  const pw = M.ceil8(seq.width), ph = M.ceil8(seq.height);
  check(pw !== seq.width || ph !== seq.height, group + ': expected a non-block-aligned size');

  // Quant step 1 must be lossless for this synthetic content.
  const lossless = M.encodeAll(seq, { keyInterval: seq.frames.length, quantStep: 1 });
  lossless.frames.forEach((f, i) => {
    check(f.metrics.psnr === Infinity, `${group}: q=1 frame ${i} not lossless (PSNR ${f.metrics.psnr})`);
    check(M.comparePlanes(f.recCrop, seq.frames[i].data).mismatches === 0, `${group}: q=1 frame ${i} differs from source`);
  });

  for (const ki of [1, 2, 3, seq.frames.length]) {
    for (const q of [1, 8, 32, 255]) {
      const enc = M.encodeAll(seq, { keyInterval: ki, quantStep: q });
      const dec = M.decode(enc.bytes);
      check(dec.ok, `${group}: ki=${ki} q=${q} decode not ok`);
      check(dec.issues.length === 0, `${group}: ki=${ki} q=${q} decoder issues`);
      check(dec.frames.length === seq.frames.length, `${group}: ki=${ki} q=${q} frame count`);
      enc.frames.forEach((ef, i) => {
        const df = dec.frames[i];
        const c = M.comparePlanes(df.recCrop, ef.recCrop);
        check(c.mismatches === 0, `${group}: ki=${ki} q=${q} frame ${i} encoder/decoder drift at px ${c.first}`);
        check(df.type === (i % ki === 0 ? 0 : 1), `${group}: ki=${ki} frame ${i} wrong type`);
      });
      // P-frame prediction must be motion compensation of the previous DECODED
      // plane. Recompute it from that plane and compare pixel-for-pixel.
      for (let i = 1; i < enc.frames.length; i++) {
        const ef = enc.frames[i];
        if (ef.type !== 1) continue;
        const prev = enc.frames[i - 1].recPadded;
        const phases = M.buildPhasePlanes(prev, pw, ph);
        for (const b of ef.blocks) {
          const plane = phases.planes[M.phaseIndex(b.dx, b.dy)];
          const ox = Math.floor(b.dx / 2), oy = Math.floor(b.dy / 2);
          for (let yy = 0; yy < 8; yy++) {
            const py = b.by * 8 + yy;
            const row = py * pw + b.bx * 8;
            const src = (py + oy + 5) * phases.ew + (b.bx * 8 + ox) + 5;
            for (let xx = 0; xx < 8; xx++) {
              if (plane[src + xx] !== ef.predPadded[row + xx]) {
                check(false, `${group}: ki=${ki} q=${q} frame ${i} block ${b.index} prediction is not MC of the decoded reference`);
                yy = 8; break;
              }
            }
          }
        }
        // And the prediction must NOT equal the previous ORIGINAL frame's MC
        // whenever the reference actually differs from the original.
        const diffRef = M.comparePlanes(prev, enc.frames[i - 1].origPadded);
        if (diffRef.mismatches > 0 && ef.blocks.length) {
          const origPhases = M.buildPhasePlanes(enc.frames[i - 1].origPadded, pw, ph);
          let matchesOrig = 0, totalPx = 0;
          for (const b of ef.blocks) {
            const pl = origPhases.planes[M.phaseIndex(b.dx, b.dy)];
            const ox = Math.floor(b.dx / 2), oy = Math.floor(b.dy / 2);
            for (let yy = 0; yy < 8; yy++) {
              const py = b.by * 8 + yy, row = py * pw + b.bx * 8;
              const src = (py + oy + 5) * origPhases.ew + (b.bx * 8 + ox) + 5;
              for (let xx = 0; xx < 8; xx++) { totalPx++; if (pl[src + xx] === ef.predPadded[row + xx]) matchesOrig++; }
            }
          }
          check(matchesOrig < totalPx, `${group}: ki=${ki} q=${q} frame ${i} prediction matches the ORIGINAL reference everywhere (open loop)`);
        }
      }
    }
  }
  console.log(`ok   ${group}: ${seq.width}x${seq.height}, ${seq.frames.length} frames, q=1 lossless, all ki/q decode identically`);
}
console.log(fails ? `\n${fails} sample assertion(s) FAILED` : '\nall sample assertions pass');
process.exit(fails ? 1 : 0);
