'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../synth-core.js');

const samplePath = path.join(__dirname, '..', 'samples', 'anchored-partials.json');
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

test('sample solves the documented turn counts and stays in frequency range', () => {
  const compiled = Core.compileProject(sample);
  assert.equal(compiled.duration, 9600);
  assert.deepEqual(compiled.tracks.map((t) => t.id), ['A', 'B']);
  assert.deepEqual(compiled.tracks[0].segments.map((s) => s.k), [53, 76]);
  assert.deepEqual(compiled.tracks[1].segments.map((s) => s.k), [90, 36]);
  for (const track of compiled.tracks) {
    for (const seg of track.segments) {
      assert.equal(seg.feasible, true);
      assert.ok(seg.minMhz >= 20000 - 1e-9);
      assert.ok(seg.maxMhz <= 20000000 + 1e-9);
      assert.ok(seg.kMin <= seg.k && seg.k <= seg.kMax);
    }
  }
});

test('exact half-way objective ties choose the smaller integer k', () => {
  // h=4800, f0=f1=100 Hz, phase remainder moves by +1/2 turn:
  // ideal phase increment is 10 turns, so k = 9.5 exactly.
  const low = Core.solveSegment('tie-low', 0,
    { x: 0, p: 0, f: 100000 },
    { x: 4800, p: 32768, f: 100000 });
  assert.equal(low.targetK, 9.5);
  assert.equal(low.k, 9);

  // Opposite remainder move makes kIdeal=10.5; tie must still choose 10.
  const high = Core.solveSegment('tie-high', 0,
    { x: 0, p: 32768, f: 100000 },
    { x: 4800, p: 0, f: 100000 });
  assert.equal(high.targetK, 10.5);
  assert.equal(high.k, 10);

  // This exact rational case defeated float-Hz implementations:
  // h=625 and endpoints 143092/87308 mHz make target k exactly 3/2.
  const exact = Core.solveSegment('exact', 7,
    { x: 10, p: 0, f: 143092 },
    { x: 635, p: 0, f: 87308 });
  assert.equal(exact.targetK, 1.5);
  assert.equal(exact.k, 1);
  assert.equal(exact.segmentIndex, 7);
  assert.ok(Math.abs(exact.minMhz / 1000 - 54.22342159722222) < 1e-12);
  assert.ok(Math.abs(exact.maxMhz / 1000 - 143.092) < 1e-12);
});

test('short impossible segment reports track and segment index', () => {
  const project = {
    tracks: [{
      id: 'short',
      anchors: [
        [0, 0, 440000, 1000, 1000],
        [1, 0, 440000, 1000, 1000],
        [24, 12345, 1000000, 1000, 1000],
      ],
    }],
  };
  assert.throws(() => Core.compileProject(project), (error) => {
    assert.equal(error.name, 'SegmentInfeasibleError');
    assert.equal(error.trackId, 'short');
    assert.equal(error.segmentIndex, 0);
    assert.match(error.message, /轨 short 段 #0/);
    return true;
  });
});

test('structural limits reject too many tracks, anchors and frames', () => {
  assert.throws(() => Core.normalizeProject({ tracks: Array.from({ length: 129 }, (_, i) => ({
    id: `t${i}`, anchors: [[0, 0, 440000, 1, 1], [10, 0, 440000, 1, 1]],
  })) }), /128/);

  const manyAnchors = [];
  for (let i = 0; i < 60001; i += 1) manyAnchors.push([i * 10, 0, 440000, 1, 1]);
  assert.throws(() => Core.normalizeProject({ tracks: [{ id: 'many', anchors: manyAnchors }] }), /60000/);

  assert.throws(() => Core.normalizeProject({
    tracks: [{ id: 'long', anchors: [[0, 0, 440000, 1, 1], [1440001, 0, 440000, 1, 1]] }],
  }), /30 秒|1440000/);
});

test('rounding is nearest with ties to even, followed by PCM16 clamp', () => {
  assert.equal(Core.roundHalfEven(0.5), 0);
  assert.equal(Core.roundHalfEven(1.5), 2);
  assert.equal(Core.roundHalfEven(2.5), 2);
  assert.equal(Core.roundHalfEven(3.5), 4);
  assert.equal(Core.roundHalfEven(-1.5), -2);
  assert.equal(Core.roundHalfEven(-2.5), -2);
  assert.equal(Core.roundHalfEven(-3.5), -4);
  assert.equal(Core.clampPcm16(Core.roundHalfEven(40000.5)), 32767);
  assert.equal(Core.clampPcm16(Core.roundHalfEven(-40000.5)), -32768);
});

test('random segments: chosen k is feasible and objectively nearest, ties smaller', () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const targetDen = 3072000000n;
  for (let iter = 0; iter < 1000; iter += 1) {
    const h = 1 + Math.floor(random() * 260);
    const a0 = { x: 0, p: Math.floor(random() * 65536), f: 20000 + Math.floor(random() * 19980001) };
    const a1 = { x: h, p: Math.floor(random() * 65536), f: 20000 + Math.floor(random() * 19980001) };
    const solved = Core.solveSegment('r', iter, a0, a1);
    if (!solved.feasible) {
      assert.ok(solved.issue);
      continue;
    }
    assert.equal(Core.lowerFrequencyOK(solved, solved.k), true);
    assert.equal(Core.upperFrequencyOK(solved, solved.k), true);
    assert.ok(solved.minMhz >= 20000 - 1e-9);
    assert.ok(solved.maxMhz <= 20000000 + 1e-6);

    const targetNum = 32n * BigInt(h) * BigInt(a0.f + a1.f) - 46875n * BigInt(a1.p - a0.p);
    const distance = (k) => {
      let z = BigInt(k) * targetDen - targetNum;
      return z < 0n ? -z : z;
    };
    for (let k = solved.kMin; k <= solved.kMax; k += 1) {
      assert.equal(Core.lowerFrequencyOK(solved, k), true);
      assert.equal(Core.upperFrequencyOK(solved, k), true);
      assert.ok(distance(solved.k) <= distance(k));
      if (distance(solved.k) === distance(k)) assert.ok(solved.k <= k);
    }
  }
});

test('mathematically exact sine half samples use ties-to-even', () => {
  // 4 kHz / 48 kHz = 1/12 turn per frame. Frame 1 is sin(2*pi/12)=1/2.
  // Math.sin itself is one ULP low; the synth must preserve the mathematical
  // cardinal angle so 1003/2 and 1007/2 are exact half-even cases.
  const project = {
    tracks: [{ id: 'quant', anchors: [[0, 0, 4000000, 1003, 1007], [12, 0, 4000000, 1003, 1007]] }],
  };
  const pcm = Core.renderPcm16(Core.compileProject(project));
  assert.equal(pcm[2], 502);
  assert.equal(pcm[3], 504);
});

test('ranged PCM is sample-code identical to full mix slice', () => {
  const compiled = Core.compileProject(sample);
  const full = Core.renderPcm16(compiled);
  for (const [start, end] of [[0, 1], [0, 4800], [123, 4567], [4800, 9600], [9000, 9600]]) {
    const ranged = Core.renderPcm16(compiled, { startFrame: start, endFrame: end });
    const slice = full.subarray(start * 2, end * 2);
    assert.equal(ranged.length, slice.length);
    assert.deepEqual(Array.from(ranged), Array.from(slice));
  }
});

test('tracks are summed as Float64 before one quantization', () => {
  const compiled = Core.compileProject(sample);
  const all = Core.renderMix(compiled);
  const onlyA = Core.renderMix(compiled, { audibleIds: ['A'] });
  const onlyB = Core.renderMix(compiled, { audibleIds: ['B'] });
  for (let i = 0; i < all.left.length; i += 1) {
    assert.equal(all.left[i], onlyA.left[i] + onlyB.left[i]);
    assert.equal(all.right[i], onlyA.right[i] + onlyB.right[i]);
  }
  const pcm = Core.finalizePcm16(all);
  assert.equal(pcm.length, compiled.duration * 2);
});

test('WAV is 48 kHz stereo PCM16 with canonical header and data', () => {
  const compiled = Core.compileProject(sample);
  const pcm = Core.renderPcm16(compiled);
  const wav = Core.encodeWav(pcm);
  assert.equal(wav.length, 44 + compiled.duration * 4);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(wav.slice(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(wav[20], 1); // PCM format
  assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint16(22, true), 2);
  assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true), 48000);
  assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint16(34, true), 16);
  const decoded = Core.decodeWavPcm16(wav);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels, 2);
  assert.deepEqual(Array.from(decoded.samples), Array.from(pcm));
});
