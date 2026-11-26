#!/usr/bin/env node
/* Comprehensive correctness tests for the PDQ engine. Zero dependencies.
 * Run: node test/run.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/engine.js');
const W = require('../js/wav.js');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, msg + (ja === jb ? '' : `\n      expected=${jb}\n      actual  =${ja}`));
}
function test(name, fn) {
  try { fn(); console.log('• ' + name); }
  catch (e) { failed++; failures.push(name + ' threw: ' + e.stack); console.error('  ✗ ' + name + ' threw', e); }
}

function readPdq(rel) {
  const b = fs.readFileSync(path.join(ROOT, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function compareDecodeToExpected(label, buffer, exp) {
  const r = E.decode(buffer);
  eq(r.parsed.headerOk, !!exp.header.headerOk, label + ' header ok');
  eq(r.parsed.records.length, exp.recordCount, label + ' record count');
  eq(r.parsed.records.filter(x => !x.crcOk).map(x => x.index), exp.badCrc, label + ' bad crc indices');
  eq(r.parsed.records.map(x => x.adopted), exp.adopted, label + ' adopted flags');

  // truncation subset
  const et = exp.truncated, at = r.parsed.truncated;
  if (et == null) ok(at == null, label + ' expected no truncation but got ' + JSON.stringify(at));
  else {
    ok(at != null, label + ' expected truncation info');
    if (at) {
      eq(at.recordIndex, et.recordIndex, label + ' trunc recordIndex');
      eq(at.offset, et.offset, label + ' trunc offset');
    }
  }

  if (exp.pcm) {
    ok(r.ok, label + ' decode ok for pcm compare');
    eq(r.frames, exp.frames, label + ' frame count');
    const C = exp.pcm.length;
    for (let c = 0; c < C; c++) {
      eq(Array.from(r.channelData[c].pcm), exp.pcm[c], label + ` ch${c} PCM exact`);
      eq(Array.from(r.channelData[c].affected), exp.affected[c], label + ` ch${c} affected exact`);
      eq(r.channelData[c].intervals, exp.intervals[c], label + ` ch${c} intervals exact`);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
test('CRC32 IEEE standard vector 123456789 -> cbf43926', () => {
  const s = new TextEncoder().encode('123456789');
  eq(E.crc32Range(s, 0, s.length) >>> 0, 0xcbf43926, 'crc32 ascii');
});

test('popcount8', () => {
  eq(E.popcount8(0b10110101), 5, 'popcount b5');
  eq(E.popcount8(0), 0, 'popcount 0');
  eq(E.popcount8(255), 8, 'popcount 255');
});

test('roundHalfEvenDiv: ties to even, signs, exact', () => {
  const R = E.roundHalfEvenDiv;
  eq(R(1, 2), 0, '0.5 -> 0');
  eq(R(3, 2), 2, '1.5 -> 2');
  eq(R(5, 2), 2, '2.5 -> 2');
  eq(R(7, 2), 4, '3.5 -> 4');
  eq(R(-1, 2), 0, '-0.5 -> 0');
  eq(R(-3, 2), -2, '-1.5 -> -2 (even)');
  eq(R(-5, 2), -2, '-2.5 -> -2');
  // D=64 scaling is exactSum/8 ; half steps when |s| mod 8 == 4
  eq(R(4 * 32768, 262144), 0, 'sum4/8=0.5 -> 0');
  eq(R(12 * 32768, 262144), 2, 'sum12/8=1.5 -> 2');
  eq(R(20 * 32768, 262144), 2, 'sum20/8=2.5 -> 2');
  eq(R(-12 * 32768, 262144), -2, 'sum-12/8=-1.5 -> -2');
  // D=32 scaling cancels exactly -> integer exactSum
  for (const s of [-32768, -12345, 0, 777, 32767]) eq(R(s * 32768, 32768), s, 'D32 identity ' + s);
});

test('demo.pdq known answer matches independent reference', () => {
  const buf = readPdq('samples/demo.pdq');
  const exp = readJson('test/fixtures/demo.expected.json');
  const r = compareDecodeToExpected('demo', buf, exp);
  eq(Array.from(r.channelData[0].pcm).slice(0, 4), [3142, 16314, 19662, 19658], 'demo ch0 head literal');
  eq(r.parsed.anchor, 0xfffffff0 >>> 0, 'wrap anchor');
  eq(r.parsed.records[1].relStart, 185, 'wrapped rel tick record2');
});

test('named fixtures all match reference exactly', () => {
  for (const name of ['holes-4ch-d64', 'bad-crc-overwrite', 'overlap-outoforder',
    'tie-rounding-d64', 'trunc-midbody', 'trunc-header', 'trunc-atrecord', 'trunc-onebyte']) {
    const buf = readPdq(`test/fixtures/${name}.pdq`);
    const exp = readJson(`test/fixtures/${name}.expected.json`);
    compareDecodeToExpected(name, buf, exp);
  }
});

test('truncation locates exact record offset/index and keeps result', () => {
  const buf = readPdq('test/fixtures/trunc-midbody.pdq');
  const r = E.decode(buf);
  ok(r.parsed.truncated, 'midbody truncated present');
  eq(r.parsed.truncated.offset, 296, 'last record byte offset 296');
  eq(r.parsed.truncated.recordIndex, 5, 'last record index 5');
  eq(r.parsed.records.length, 5, 'five complete records retained');
  eq(r.frames, 8, 'computable frame count retained from header');
  ok(r.channelData[0].pcm.length === 8, 'pcm still produced');

  const h = E.decode(readPdq('test/fixtures/trunc-header.pdq'));
  eq(h.parsed.truncated.offset, 296, 'header-trunc offset same record start');
  eq(h.parsed.truncated.stage, 'record-header', 'stage header');

  const b = E.decode(readPdq('test/fixtures/trunc-atrecord.pdq'));
  ok(b.parsed.truncated == null, 'exact record boundary is clean EOF, no truncation');
  eq(b.parsed.records.length, 5, 'five records at boundary');
});

test('bad CRC never overwrites; last good record wins', () => {
  const r = E.decode(readPdq('test/fixtures/bad-crc-overwrite.pdq'));
  const g = E.buildChannelGrid(r.parsed, 0);
  eq(g[15], 1, 'good retransmit 12..29 wins -> +1');
  eq(g[12], 1, 'left edge of good overwrite');
  eq(g[29], 1, 'right edge of good overwrite');
  eq(g[10], -1, 'bad-CRC record at 10..11 discarded -> base zero bit => -1');
  eq(g[30], -1, 'bad-CRC record 30..49 discarded -> base stays -1');
  eq(g[65], -1, 'stale-CRC (flipped payload) record discarded -> base -1');
  // provenance of tick 15 in frame 0 detail
  const d = E.describeFrame(r, 0, 0);
  const t15 = d.ticks.find(x => x.tick === 15);
  ok(t15 && t15.kind === 'real', 'tick15 real');
  eq(t15.sourceIndex, 3, 'tick15 winner record 3');
  const badProv = t15.providers.find(p => p.recordIndex === 1);
  ok(badProv && badProv.crcOk === false && badProv.adopted === false, 'bad record listed but not adopted');
  const winners = t15.providers.filter(p => p.winner);
  eq(winners.length, 1, 'exactly one winner provider for tick15');
  eq(winners[0].recordIndex, 3, 'winner flagged as record 3');
  const rec0prov = t15.providers.find(p => p.recordIndex === 0);
  ok(rec0prov && rec0prov.adopted === true && rec0prov.winner === false, 'earlier good record adopted but overwritten');
  // tick 10 winner must be record 0, not bad record 1
  const t10 = d.ticks.find(x => x.tick === 10);
  eq(t10.sourceIndex, 0, 'tick10 winner base record 0');
});

test('describeFrame recomputes exact PCM + affected for many frames', () => {
  for (const name of ['demo', 'holes-4ch-d64', 'bad-crc-overwrite', 'tie-rounding-d64', 'trunc-midbody']) {
    const r = E.decode(readPdq(`test/fixtures/${name}.pdq`));
    if (!r.ok) continue;
    for (let c = 0; c < r.channels; c++) {
      const F = r.frames;
      const picks = new Set([0, 1, F - 1, Math.floor(F / 2)]);
      for (const f of picks) {
        if (f < 0 || f >= F) continue;
        const d = E.describeFrame(r, c, f);
        ok(d.pcmConsistent, `${name} c${c} f${f} pcm consistent (${d.pcm} vs ${d.expectedPcm})`);
        ok(d.affectedConsistent, `${name} c${c} f${f} affected consistent`);
        eq(d.ticks.length, 3 * (r.D - 1) + 1, `${name} f${f} dependency width`);
      }
    }
  }
});

test('affected geometry: a missing tick hits exactly frames whose window contains it', () => {
  for (const D of [32, 64]) {
    const F = 12, T = D * F, K = 3 * (D - 1);
    for (const hole of [0, 1, D - 1, D, D + 7, 2 * D, T - 1, T - 50]) {
      const grid = new Int8Array(T).fill(1); // all real +1
      grid[hole] = 0;                        // one missing tick
      const { affected } = E.decimateGrid(grid, 0, D);
      for (let f = 0; f < F; f++) {
        const Tout = (f + 1) * D - 1;
        const L = Tout - K;
        const should = hole >= Math.max(0, L) && hole <= Tout;
        ok(!!affected[f] === should, `D${D} hole${hole} frame${f} affected=${affected[f]} expected ${should}`);
      }
    }
  }
});

test('affected geometry matches naive window scan on random missing sets', () => {
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const D of [32, 64]) {
    const F = 8, T = D * F, K = 3 * (D - 1);
    const grid = new Int8Array(T);
    for (let i = 0; i < T; i++) grid[i] = rnd() < 0.7 ? (rnd() < 0.5 ? 1 : -1) : 0;
    const { affected } = E.decimateGrid(grid, 7, D);
    for (let f = 0; f < F; f++) {
      const Tout = (f + 1) * D - 1, L = Math.max(0, Tout - K);
      let any = false;
      for (let t = L; t <= Tout; t++) if (grid[t] === 0) any = true;
      eq(!!affected[f], any, `random D${D} f${f}`);
    }
  }
});

test('WAV selection data is byte-exact slice of full-track WAV data', () => {
  const C = 4, F = 100;
  const planes = [];
  for (let c = 0; c < C; c++) {
    const a = new Int16Array(F);
    for (let f = 0; f < F; f++) a[f] = ((f * (c + 3) * 7) % 60000) - 30000;
    planes.push(a);
  }
  const full = W.interleaveSlice(planes, C, 0, F);
  const wavFull = W.encodeInterleaved(full, 48000, C);
  const f0 = 13, f1 = 77;
  const selView = W.interleavedViewSlice(full, C, f0, f1);
  const wavSel = W.encodeInterleaved(selView, 48000, C);

  // header sanity
  const dv = new DataView(wavSel);
  eq(dv.getUint16(20, true), 1, 'pcm format');
  eq(dv.getUint16(22, true), C, 'channels');
  eq(dv.getUint32(24, true), 48000, 'rate');
  eq(dv.getUint16(34, true), 16, 'bits');
  eq(dv.getUint32(40, true), (f1 - f0) * C * 2, 'sel data len');

  const fullBytes = new Uint8Array(wavFull);
  const selData = new Uint8Array(wavSel, 44);
  const expectSlice = fullBytes.subarray(44 + f0 * C * 2, 44 + f1 * C * 2);
  eq(Array.from(selData), Array.from(expectSlice), 'selection WAV data == full WAV byte slice');

  // and an independently interleaved copy is identical too
  const selCopy = W.interleaveSlice(planes, C, f0, f1);
  eq(Array.from(selCopy), Array.from(selView), 'interleaveSlice equals view slice');
});

test('randomized 400-case manifest matches independent Python reference', () => {
  const manifest = readJson('test/vectors/manifest.json');
  let n = 0;
  for (const c of manifest.cases) {
    const bin = Buffer.from(c.pdqBase64, 'base64');
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    compareDecodeToExpected(c.name, ab, c.expected);
    n++;
  }
  eq(n, 400, 'manifest case count');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} assertions passed, ${failed} failed`);
if (failed) { console.error('\nFAILURES:\n' + failures.slice(0, 20).join('\n')); process.exit(1); }
console.log('ALL ENGINE TESTS PASSED');
