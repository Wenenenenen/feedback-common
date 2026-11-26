'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../solver.js');
const A = require('../audio.js');
const IO = require('../zipio.js');

const ROOT = path.join(__dirname, '..');

test('样例渲染与独立 Python 预言机黄金 WAV 逐字节一致', () => {
  const zip = new Uint8Array(fs.readFileSync(path.join(ROOT, 'samples', 'pilot-cycle-cases.zip')));
  return IO.loadCaseFromZipBuffer(zip).then((c) => {
    const res = S.solveProject(c.project);
    const prep = S.prepare(c.project);
    const r = A.renderCorrected(prep, res.z, c.wav);
    const mine = Buffer.from(A.encodeWav16(r.samples, 48000, 2));
    const golden = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-golden.wav'));
    assert.equal(mine.length, golden.length);
    assert.ok(mine.equals(golden), '编码 WAV 与 Python Fraction 参考不一致');
  });
});

test('roundHalfEven：正中取偶与常规四舍五入边界', () => {
  assert.equal(A.roundHalfEven(5, 2), 2);   // 2.5 -> 2
  assert.equal(A.roundHalfEven(7, 2), 4);   // 3.5 -> 4
  assert.equal(A.roundHalfEven(-5, 2), -2); // -2.5 -> -2（偶）
  assert.equal(A.roundHalfEven(-7, 2), -4); // -3.5 -> -4（偶）
  assert.equal(A.roundHalfEven(49, 10), 5);
  assert.equal(A.roundHalfEven(41, 10), 4);
  assert.equal(A.roundHalfEven(0, 3), 0);
});

// 独立的“逐帧直接有理计算”参考（BigInt），不使用增量状态
function directRender(prep, z, wav) {
  const n = prep.n, ch = wav.channels;
  const yNum = z.map((zi) => 3 * (zi - z[0]));
  const frames = Math.floor((yNum[n - 1] + 15) / 16);
  const out = new Int16Array(frames * ch);
  function rheBI(num, den) {
    // num/den BigInt, den>0
    let q = num / den;
    let rem = num - q * den;
    if (rem < 0n) { q -= 1n; rem += den; }
    const t = 2n * rem;
    if (t < den) return Number(q);
    if (t > den) return Number(q + 1n);
    // tie
    if (q % 2n === 0n) return Number(q);
    return Number(q + 1n);
  }
  for (let f = 0; f < frames; f++) {
    let seg = 0;
    while (seg < n - 2 && 16 * f >= yNum[seg + 1]) seg++;
    const Q = BigInt(3 * (z[seg + 1] - z[seg]));
    const P = BigInt(prep.xs[seg]) * Q + BigInt(prep.dx[seg]) * BigInt(16 * f - yNum[seg]);
    let j = P / Q;
    let rem = P - j * Q;
    const jn = Number(j);
    for (let c = 0; c < ch; c++) {
      const a = BigInt(wav.samples[Math.min(jn, wav.frames - 1) * ch + c]);
      const bjn = jn + 1 < wav.frames ? jn + 1 : wav.frames - 1;
      const b = BigInt(wav.samples[bjn * ch + c]);
      const numer = a * Q + (b - a) * rem;
      let v = rheBI(numer, Q);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      out[f * ch + c] = v;
    }
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('随机曲线：增量渲染与逐帧 BigInt 直接参考逐码一致（含非整数 y 边界）', () => {
  const rand = rng(20261127);
  for (let iter = 0; iter < 60; iter++) {
    const n = 2 + Math.floor(rand() * 8);
    const xs = [0];
    for (let i = 1; i < n; i++) xs.push(xs[i - 1] + 20 + Math.floor(rand() * 200));
    const dx = xs.slice(1).map((x, i) => x - xs[i]);
    // 随机正 dz，保证 Q>0
    const z = [Math.floor(rand() * 100)];
    for (let i = 1; i < n; i++) z.push(z[i - 1] + 6 + Math.floor(rand() * 1200));
    const prep = { n, xs, dx };
    const srcFrames = xs[n - 1] + 2; // 故意留 2 帧，测试右邻接末
    const samples = new Int16Array(srcFrames * 2);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.floor((rand() * 2 - 1) * 32768);
    const wav = { channels: 2, frames: srcFrames, sampleRate: 48000, samples };

    const got = A.renderCorrected(prep, z, wav).samples;
    const exp = directRender(prep, z, wav);
    assert.equal(got.length, exp.length, 'length iter=' + iter);
    let firstDiff = -1;
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== exp[i]) { firstDiff = i; break; }
    }
    assert.equal(firstDiff, -1, 'sample mismatch iter=' + iter + ' at ' + firstDiff +
      ' got=' + (firstDiff >= 0 && got[firstDiff]) + ' exp=' + (firstDiff >= 0 && exp[firstDiff]));
  }
});

test('右邻点超出最后实际帧时沿用末帧（不越界、不置零）', () => {
  // 2 个读数，输出最后一帧源位置极接近 N，使 j=N-1 且需要右邻
  const prep = { n: 2, xs: [0, 10], dx: [10] };
  const z = [0, 21]; // ylast=63/16=3.9375 -> 4 输出帧
  const samples = new Int16Array([100, 200, 300, 400]); // 仅 2 帧立体声
  const wav = { channels: 2, frames: 2, sampleRate: 48000, samples };
  const r = A.renderCorrected(prep, z, wav);
  assert.equal(r.frames, 4);
  // 最后一帧应可正常量化且声道独立
  assert.ok(r.samples[6] !== 0 || r.samples[7] !== 0);
  // 与直接参考一致即说明 clamp 正确
  assert.deepEqual(Array.from(r.samples), Array.from(directRender(prep, z, wav)));
});

test('选区导出 PCM 码与整段 WAV 对应区间逐码一致', () => {
  const zip = new Uint8Array(fs.readFileSync(path.join(ROOT, 'samples', 'pilot-cycle-cases.zip')));
  return IO.loadCaseFromZipBuffer(zip).then((c) => {
    const res = S.solveProject(c.project);
    const r = A.renderCorrected(S.prepare(c.project), res.z, c.wav);
    const f0 = 137, f1 = 891;
    const sel = A.selectionSamples(r, f0, f1);
    // 1) 与整段 Int16 缓冲逐码相同
    for (let i = 0; i < sel.samples.length; i++) {
      assert.equal(sel.samples[i], r.samples[f0 * 2 + i]);
    }
    // 2) 编码后的选区 WAV data chunk 与整段 WAV data chunk 的对应字节相同
    const fullWav = A.encodeWav16(r.samples, 48000, 2);
    const selWav = A.encodeWav16(sel.samples, 48000, 2);
    const fullData = fullWav.subarray(44);
    const selData = selWav.subarray(44);
    const sliceBytes = fullData.subarray(f0 * 4, f1 * 4); // stereo16 = 4 bytes/frame
    assert.equal(selData.length, sliceBytes.length);
    assert.ok(Buffer.from(selData).equals(Buffer.from(sliceBytes)));
  });
});

test('180 秒上限：超出抛 TOO_LONG', () => {
  const N = 100;
  const wav = { channels: 2, frames: N, sampleRate: 48000, samples: new Int16Array(N * 2) };
  const prep = { n: 2, xs: [0, N], dx: [N] };
  const z = [0, 50000000]; // ylast ≈ 9.375M 帧 > 8.64M
  assert.throws(() => A.renderCorrected(prep, z, wav), /180/);
});
