#!/usr/bin/env node
/* Every corrupt file must be rejected, and the report must name the right spot. */
'use strict';
const fs = require('fs');
const M = require('../src/mvr1.js');
const { execFileSync } = require('child_process');
const path = require('path');

const seq = (() => {
  const w = 19, h = 13, frames = [];
  for (let f = 0; f < 6; f++) {
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = (x * 13 + y * 7 + f * 3) & 255;
    frames.push({ index: f, data: d });
  }
  return { width: w, height: h, frames };
})();
const enc = M.encodeAll(seq, { keyInterval: 3, quantStep: 9 });
const good = enc.bytes;
const bw = enc.header.paddedWidth / 8, bh = enc.header.paddedHeight / 8;

function expectBad(label, bytes, checks) {
  const d = M.decode(bytes);
  const errors = d.issues.filter(i => i.severity === 'error');
  const problems = [];
  if (d.ok) problems.push('decode reported ok=true');
  if (!errors.length) problems.push('no error issues');
  for (const [key, want] of Object.entries(checks || {})) {
    const ok = errors.some(e => (typeof want === 'function' ? want(e) : e[key] === want));
    if (!ok) problems.push(`no issue with ${key}=${want}; got ` + JSON.stringify(errors.map(e => ({ k: e.kind, f: e.frame, b: e.block, bx: e.bx, by: e.by }))));
  }
  if (problems.length) { console.log('FAIL ' + label + '\n   ' + problems.join('\n   ')); return 1; }
  const e = errors[0];
  console.log(`ok   ${label.padEnd(42)} -> ${e.kind} @${e.offset} f=${e.frame == null ? '-' : e.frame} blk=${e.block == null ? '-' : e.block} :: ${e.message}`);
  return 0;
}

let fails = 0;
const frame1 = enc.frames[1];
const frame0 = enc.frames[0];
function withByte(buf, at, v) { const c = Uint8Array.from(buf); c[at] = v; return c; }
function truncate(buf, n) { return buf.subarray(0, n); }

fails += expectBad('empty file', new Uint8Array(0), { kind: 'truncated-header' });
fails += expectBad('magic corrupted', withByte(good, 0, 0x58), { kind: 'bad-magic' });
fails += expectBad('header cut after magic', truncate(good, 9), { kind: 'truncated-header' });
fails += expectBad('width 0', withByte(good, 4, 0), { kind: 'bad-header' });
fails += expectBad('frameCount 0', (() => { const c = Uint8Array.from(good); c[8] = 0; c[9] = 0; return c; })(), { kind: 'bad-header' });
fails += expectBad('quantStep 0', (() => { const c = Uint8Array.from(good); c[12] = 0; c[13] = 0; return c; })(), { kind: 'bad-header' });
fails += expectBad('illegal frame type 7', withByte(good, frame0.frameStart, 7), { kind: 'illegal-frame-type', frame: 0 });
fails += expectBad('frame 2 payload cut in half', truncate(good, Math.floor((enc.frames[2].payloadStart + enc.frames[2].payloadEnd) / 2)), { kind: 'truncated-payload', frame: 2 });
fails += expectBad('truncated inside frame 4 block', truncate(good, enc.frames[4].payloadStart + 3), { kind: 'truncated-payload', frame: 4 });
fails += expectBad('I frame marked as P (frame 0)', withByte(good, frame0.frameStart, 1), { kind: 'missing-reference', frame: 0 });
fails += expectBad('P frame marked as I (frame 1)', withByte(good, frame1.frameStart, 0), { kind: 'type-mismatch', frame: 1 });
fails += expectBad('illegal motion vector dx=60', withByte(good, frame1.payloadStart, 60), { kind: 'illegal-vector', frame: 1, block: 0 });
fails += expectBad('illegal motion vector dy=-79', withByte(good, frame1.payloadStart + 1, 0xb1), { kind: 'illegal-vector', frame: 1, block: 0 });
// Frame 1's first block payload begins with 2 MV bytes; zero-run byte follows.
const blk0 = frame1.payloadStart + 2;
fails += expectBad('zero-run past block end', withByte(good, blk0, 70), { kind: 'illegal-run', frame: 1, block: 0 });
// Point every coefficient at block 0 to non-zero runs -> guaranteed overrun at some block.
fails += expectBad('trailing bytes after last frame', (() => { const c = new Uint8Array(good.length + 4); c.set(good); return c; })(), { kind: 'trailing-bytes' });
// payloadLen overstated (extends past file) on last frame
fails += expectBad('last frame length points past EOF', (() => {
  const c = Uint8Array.from(good); const at = enc.frames[5].frameStart + 1;
  const v = M.readU32(c, at) + 64;
  c[at] = v & 255; c[at + 1] = (v >> 8) & 255; c[at + 2] = (v >> 16) & 255; c[at + 3] = (v >>> 24) & 255;
  return c;
})(), { kind: 'truncated-payload', frame: 5 });
// payloadLen understated -> block decode hits payload end mid-block
fails += expectBad('last frame length too small', (() => {
  const c = Uint8Array.from(good); const at = enc.frames[5].frameStart + 1;
  const v = 5;
  c[at] = v; c[at + 1] = 0; c[at + 2] = 0; c[at + 3] = 0;
  return c;
})(), { kind: (e) => e.kind === 'truncated-block' || e.kind === 'truncated-payload' });

// Valid files must still decode.
for (const [ki, qs] of [[1, 1], [3, 9], [6, 64], [48, 255]]) {
  const e2 = M.encodeAll(seq, { keyInterval: ki, quantStep: qs });
  const d = M.decode(e2.bytes);
  if (!d.ok || d.issues.length) { console.log(`FAIL valid ki=${ki} qs=${qs}: ` + JSON.stringify(d.issues)); fails++; }
  else console.log(`ok   valid ki=${ki} qs=${qs} bytes=${e2.bytes.length}`);
}

console.log(fails ? `\n${fails} corruption test(s) FAILED` : '\nall corruption cases report the expected location');
process.exit(fails ? 1 : 0);
