// 数值核心单元测试：FFT / 卷积 / 逆扫频 / 定标 / 定位 / 冲突 / 越界补零。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyticSweep, analyzeRef, convolveRef, calibratorRef, inverseSweepRef } from './reference.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFT = require(path.join(ROOT, 'src/js/fft.js'));
const Core = require(path.join(ROOT, 'src/js/core.js'));
const Wav = require(path.join(ROOT, 'src/js/wav.js'));

const SR = 48000;

/* ------------------------------ FFT ------------------------------- */

test('FFT 往返与朴素 DFT 对拍', () => {
  for (const n of [2, 4, 8, 16, 64, 256, 1024]) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = Math.sin(i * 0.31) + 0.2 * Math.cos(i * 0.07);
      re[i] = x[i];
    }
    const plan = FFT.makeComplexFFT(n);
    plan.fwd(re, im);
    // 朴素 DFT
    let maxErr = 0;
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = -2 * Math.PI * k * t / n;
        sr += x[t] * Math.cos(a);
        si += x[t] * Math.sin(a);
      }
      maxErr = Math.max(maxErr, Math.abs(re[k] - sr), Math.abs(im[k] - si));
    }
    assert.ok(maxErr < 1e-9, `n=${n} 正变换误差 ${maxErr}`);
    plan.ifft(re, im);
    let rErr = 0;
    for (let i = 0; i < n; i++) rErr = Math.max(rErr, Math.abs(re[i] - x[i]), Math.abs(im[i]));
    assert.ok(rErr < 1e-12, `n=${n} 逆变换误差 ${rErr}`);
  }
});

test('FFT 长度校验', () => {
  assert.throws(() => FFT.makeComplexFFT(100), /2 的幂/);
  assert.throws(() => FFT.makeComplexFFT(0), /2 的幂/);
  assert.equal(FFT.nextPow2(1), 1);
  assert.equal(FFT.nextPow2(1025), 2048);
});

/* --------------------------- 参数校验 ---------------------------- */

test('setup 参数按包内规则校验', () => {
  const ok = Core.validateSetupObject({ f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 });
  assert.deepEqual(ok, { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 });

  assert.throws(() => Core.validateSetupObject({ f1: 6000, lo: 0, hi: 1, pre: 0, post: 1 }), /缺少参数 f0/);
  assert.throws(() => Core.validateSetupObject({ f0: 6000, f1: 80, lo: 0, hi: 1, pre: 0, post: 1 }), /f0 < f1/);
  assert.throws(() => Core.validateSetupObject({ f0: 10, f1: 6000, lo: 0, hi: 1, pre: 0, post: 1 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 20001, lo: 0, hi: 1, pre: 0, post: 1 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: 5, hi: 1, pre: 0, post: 1 }), /lo <= hi/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: -1, hi: 1, pre: 0, post: 1 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: 0, hi: 1, pre: -1, post: 1 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: 0, hi: 1, pre: 0, post: 0 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: 0, hi: 1, pre: 0, post: 5000000 }), /超出范围/);
  assert.throws(() => Core.validateSetupObject({ f0: 80, f1: 6000, lo: 0, hi: 1, pre: 3000000, post: 2000000 }), /pre\+post/);
  assert.throws(() => Core.validateSetupObject({ f0: 80.5, f1: 6000, lo: 0, hi: 1, pre: 0, post: 1 }), /整数/);
  assert.throws(() => Core.validateSetupObject({ f0: '80', f1: 6000, lo: 0, hi: 1, pre: 0, post: 1 }), /整数/);
  assert.throws(() => Core.validateSetupObject(null), /JSON 对象/);
});

test('搜索端点必须小于采集帧数', () => {
  const base = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 };
  Core.validateParams(base, { captureFrames: 5000 });
  assert.throws(() => Core.validateParams({ ...base, hi: 5000 }, { captureFrames: 5000 }), /小于采集帧数/);
  assert.throws(() => Core.validateParams(base, { captureFrames: 1000 }), /小于采集帧数/);
  assert.throws(() => Core.validateParams(base, { captureRate: 44100 }), /48000/);
  assert.throws(() => Core.validateParams(base, { sweepChannels: 2 }), /单声道/);
  assert.throws(() => Core.validateParams(base, { captureChannels: 5 }), /1–4/);
  assert.throws(() => Core.validateParams(base, { sweepFrames: 21 * SR }), /1–20 s/);
  assert.throws(() => Core.validateParams(base, { captureFrames: 26 * SR, hi: 1300 }), /25 s/);
});

/* --------------------------- 逆扫频 / 定标 ------------------------- */

test('逆扫频与定标与暴力参考一致', () => {
  const frames = 4096;
  const x = analyticSweep({ f0: 100, f1: 4000, frames });
  const g = Core.inverseSweep(x, 100, 4000);
  const gr = inverseSweepRef(x, 100, 4000);
  let e = 0;
  for (let i = 0; i < frames; i++) e = Math.max(e, Math.abs(g[i] - gr[i]));
  assert.ok(e < 1e-15, `g 误差 ${e}`);

  const D = Core.selfCalibration(x, 100, 4000);
  const Dr = calibratorRef(x, 100, 4000);
  assert.ok(Math.abs(D - Dr) < Math.abs(Dr) * 1e-12, `D ${D} vs ${Dr}`);
});

test('零分母报错', () => {
  const x = new Float64Array(64); // 全零扫频
  const D = Core.selfCalibration(x, 80, 6000);
  assert.equal(D, 0);
  assert.throws(() => Core.deconvolve(new Float64Array(32), x, D), /分母为 0/);
  // NaN 也算无效分母
  assert.throws(() => Core.deconvolve(new Float64Array(32), x, NaN), /分母为 0/);
});

test('阶次偏移取整规则', () => {
  const N = 48000;
  const L = Math.log(6000 / 80);
  for (const q of [1, 2, 3, 4]) {
    assert.equal(Core.orderShift(q, N, 80, 6000), Math.floor(N * Math.log(q) / L + 0.5));
  }
  assert.deepEqual([1, 2, 3, 4].map((q) => Core.orderShift(q, N, 80, 6000)), [0, 7706, 12214, 15412]);
});

/* ---------------------------- 反卷积 ----------------------------- */

test('反卷积与直接卷积逐样点一致', () => {
  const frames = 2000;
  const x = analyticSweep({ f0: 100, f1: 3000, frames });
  const y = new Float64Array(2600);
  for (let i = 0; i < y.length; i++) {
    y[i] = 0.2 * Math.sin(i * 0.05) + 0.05 * Math.sin(i * 0.31) + 0.001 * ((i * 7919) % 13 - 6);
  }
  const g = Core.inverseSweep(x, 100, 3000);
  const D = Core.selfCalibration(x, 100, 3000);
  const c = Core.deconvolve(y, g, D);
  const ref = convolveRef(y, g);
  assert.equal(c.length, y.length + g.length - 1);
  let e = 0;
  let scale = 0;
  for (let i = 0; i < c.length; i++) {
    e = Math.max(e, Math.abs(c[i] - ref[i] / D));
    scale = Math.max(scale, Math.abs(ref[i] / D));
  }
  assert.ok(e < scale * 1e-10, `反卷积误差 ${e}（尺度 ${scale}）`);
});

test('分段反卷积与整段逐样点一致', () => {
  const frames = 1500;
  const x = analyticSweep({ f0: 120, f1: 2500, frames });
  const y = new Float64Array(1900);
  for (let i = 0; i < y.length; i++) y[i] = 0.3 * Math.sin(i * 0.02 + 1);
  const g = Core.inverseSweep(x, 120, 2500);
  const D = Core.selfCalibration(x, 120, 2500);
  const full = Core.deconvolve(y, g, D);
  for (const [a, b] of [[frames - 1 - 50, frames - 1 + 900], [0, frames * 2], [frames - 1, frames - 1], [10, 20]]) {
    const band = Core.deconvolveBand(y, g, D, a, b);
    assert.equal(band.lo, Math.max(0, Math.min(a, full.length - 1)));
    let e = 0;
    for (let i = 0; i < band.values.length; i++) {
      e = Math.max(e, Math.abs(full[band.lo + i] - band.values[i]));
    }
    assert.ok(e < 1e-12, `区间 [${a},${b}] 误差 ${e}`);
  }
});

test('planBand 覆盖搜索区间与全部窗口', () => {
  const N = 48000;
  const dataLen = 51000 + N - 1;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 };
  const plan = Core.planBand(N, dataLen, params);
  assert.ok(plan.lo <= N - 1 + params.lo);
  assert.ok(plan.hi >= N - 1 + params.hi);
  // q4 窗最早可能落点（零点取 hi 时）
  const shift4 = Core.orderShift(4, N, params.f0, params.f1);
  assert.ok(plan.lo <= N - 1 + params.hi - shift4 - params.pre);
  assert.equal(plan.coreLo, N - 1 + params.lo - shift4 - params.pre);
  // 上界：零点取 lo 时 q1 窗的右端
  assert.ok(plan.hi >= N - 1 + params.lo + params.post - 1);
});

/* ---------------------------- 窗口定位 --------------------------- */

test('零点取绝对幅度最大帧，同高取较早帧', () => {
  const N = 48000;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 };
  const dataLen = N + 2000;
  const c = new Float64Array(dataLen);
  // 在区间内造三个峰：一个 +0.4、一个 -0.9、一个 +0.9（同高）
  c[N - 1 + 400] = 0.4;
  c[N - 1 + 500] = -0.9;
  c[N - 1 + 900] = 0.9;
  const a = Core.locateWindows(c, dataLen, N, params);
  assert.equal(a.zero, N - 1 + 500, '同高应取较早帧');
  assert.equal(a.zeroValue, -0.9);
  assert.equal(a.zeroRel, 500);
});

test('零点严格在搜索区间内（区间外更大的峰不算）', () => {
  const N = 1000;
  const params = { f0: 100, f1: 4000, lo: 100, hi: 200, pre: 10, post: 20 };
  const dataLen = 3000;
  const c = new Float64Array(dataLen);
  c[N - 1 + 150] = 0.5;
  c[N - 1 + 50] = 5.0;     // 区间外，必须忽略
  c[N - 1 + 250] = 4.0;    // 区间外，必须忽略
  const a = Core.locateWindows(c, dataLen, N, params);
  assert.equal(a.zero, N - 1 + 150);
});

test('四个窗口中心与索引、能量、冲突', () => {
  const N = 48000;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 };
  const dataLen = N + 100000;
  const c = new Float64Array(dataLen);
  c[N - 1 + 480] = 1;
  for (let i = 0; i < dataLen; i++) c[i] += 0.25;
  const a = Core.locateWindows(c, dataLen, N, params);
  assert.equal(a.zero, N - 1 + 480);
  const shifts = [0, 7706, 12214, 15412];
  for (let i = 0; i < 4; i++) {
    const w = a.windows[i];
    assert.equal(w.q, i + 1);
    assert.equal(w.shift, shifts[i]);
    assert.equal(w.center, N - 1 + 480 - shifts[i]);
    assert.equal(w.start, w.center - params.pre);
    assert.equal(w.end, w.center + params.post);
    assert.equal(w.length, params.pre + params.post);
    assert.equal(w.zeroFilled, 0);
  }
  // 能量：每个样本 0.25，外加直通窗中心的 1
  const expect1 = Math.pow(1.25, 2) + 0.0625 * (560 - 1);
  assert.ok(Math.abs(a.windows[0].energy - expect1) < 1e-9);
  assert.deepEqual(a.conflicts, []);
});

test('重叠窗提示冲突阶次（含两两全部重叠）', () => {
  const N = 48000;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 4000, post: 4800 };
  const dataLen = N + 100000;
  const c = new Float64Array(dataLen);
  c[N - 1 + 480] = 1;
  const a = Core.locateWindows(c, dataLen, N, params);
  // q1 中心 48479，q2 中心 40773；q1 窗 [44479, 53279)，q2 窗 [36773, 45573) → 重叠
  assert.deepEqual(a.conflicts, [[1, 2], [2, 3], [2, 4], [3, 4]]);
});

test('相邻窗刚好不重叠不算冲突（半开区间）', () => {
  const N = 48000;
  // 让 q1 与 q2 窗首尾相接：q1 窗 [c1-pre, c1+post)，q2 窗起点 = q1 终点
  const pre = 100;
  const post = 100;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre, post };
  const dataLen = N + 100000;
  const c = new Float64Array(dataLen);
  c[N - 1 + 480] = 1;
  const a = Core.locateWindows(c, dataLen, N, params);
  const w1 = a.windows[0], w2 = a.windows[1];
  assert.ok(w1.end <= w2.start || w2.end <= w1.start);
  // 用恰好相接的窗宽复核
  const gap = w1.center - w2.center;
  const tight = { ...params, pre: Math.floor(gap / 2), post: gap - Math.floor(gap / 2) };
  const b = Core.locateWindows(c, dataLen, N, tight);
  assert.equal(b.windows[0].center - b.windows[0].start + b.windows[0].end - b.windows[0].center, b.windows[0].length);
  // q1.start = q2.end 或 q2.start = q1.end 的情形
  if (b.windows[1].end === b.windows[0].start || b.windows[0].end === b.windows[1].start) {
    assert.equal(b.conflicts.some(([x, y]) => x === 1 && y === 2), false, '相接不算冲突');
  }
});

test('窗外索引取零并计数', () => {
  const N = 48000;
  const c = new Float64Array(N + 500);
  for (let i = 0; i < c.length; i++) c[i] = 1;
  c[N - 1 + 10] = 3;
  const params = { f0: 80, f1: 6000, lo: 0, hi: 100, pre: 40000, post: 480 };
  const a = Core.locateWindows(c, c.length, N, params);
  const q4 = a.windows[3];
  assert.ok(q4.start < 0, 'q4 窗左端应越界');
  assert.equal(q4.zeroFilledLeft, -q4.start);
  assert.equal(q4.samples[0], 0, '越界样本取零');
  assert.equal(q4.samples[-q4.start - 1], 0);
  assert.equal(q4.samples[-q4.start], 1, '第一个有效样本来自 c');
  // 能量只统计窗内（含补零）
  let e = 0;
  for (let i = 0; i < q4.length; i++) e += q4.samples[i] * q4.samples[i];
  assert.ok(Math.abs(q4.energy - e) < 1e-9);
});

test('右端越界时补零并计数', () => {
  const N = 1000;
  const c = new Float64Array(N + 200);
  for (let i = 0; i < c.length; i++) c[i] = 0.5;
  c[N - 1 + 150] = 3;
  const params = { f0: 100, f1: 4000, lo: 100, hi: 190, pre: 5, post: 1000 };
  const a = Core.locateWindows(c, c.length, N, params);
  const w1 = a.windows[0];
  assert.ok(w1.end > c.length, 'q1 窗右端应越界');
  assert.equal(w1.zeroFilledRight, w1.end - c.length);
  assert.equal(w1.samples[w1.length - 1], 0);
  assert.equal(w1.samples[c.length - w1.start - 1], 0.5, '最后一个有效样本仍来自 c');
});

test('搜索区间越出反卷积数据时报错', () => {
  const N = 1000;
  const c = new Float64Array(N + 200);
  const params = { f0: 100, f1: 4000, lo: 900, hi: 950, pre: 5, post: 10 };
  assert.throws(() => Core.locateWindows(c, c.length, N, params), /越界/);
});

/* --------------------------- 端到端数值 ---------------------------- */

test('解析扫频自测：主响应定标后峰值为 1', () => {
  const frames = 8192;
  const x = analyticSweep({ f0: 200, f1: 5000, frames });
  const g = Core.inverseSweep(x, 200, 5000);
  const D = Core.selfCalibration(x, 200, 5000);
  // x 与 g 卷积，主峰应在 N-1 且等于 D
  const self = Core.deconvolve(x, g, D);
  let peak = 0, at = -1;
  for (let i = 0; i < self.length; i++) if (Math.abs(self[i]) > peak) { peak = Math.abs(self[i]); at = i; }
  assert.equal(at, frames - 1, '自测主峰在 N-1');
  assert.ok(Math.abs(peak - 1) < 1e-6, `自测峰值 ${peak}`);
});

test('已知谐波位置的合成采集：零点与四窗全对', () => {
  // 1 s 扫频，构造 y = Σ g_q sin(q·φ(n-d))
  const frames = 16384;
  const f0 = 150, f1 = 5000;
  const x = analyticSweep({ f0, f1, frames });
  const T = frames / SR;
  const L = Math.log(f1 / f0);
  const d = 300;
  const M = frames + 700;
  const y = new Float64Array(M);
  const gains = [0.6, 0.06, 0.012, 0.004];
  for (let q = 1; q <= 4; q++) {
    for (let n = d; n < M; n++) {
      const k = n - d;
      if (k >= frames) break;
      const ph = 2 * Math.PI * f0 * T / L * (Math.exp(L * (k / SR) / T) - 1);
      y[n] += gains[q - 1] * Math.sin(q * ph);
    }
  }
  const params = { f0, f1, lo: 200, hi: 400, pre: 40, post: 200 };
  const got = Core.processChannel(y, x, params);
  const ref = analyzeRef(y, x, params);
  assert.equal(got.analysis.zero, ref.zero, '零点');
  assert.equal(got.analysis.zero, frames - 1 + d, '零点应在 d 处');
  assert.ok(Math.abs(got.calib - ref.D) < Math.abs(ref.D) * 1e-12);
  for (let i = 0; i < 4; i++) {
    const g = got.analysis.windows[i], r = ref.windows[i];
    assert.equal(g.start, r.start, `q${g.q} 窗起点`);
    assert.equal(g.end, r.end, `q${g.q} 窗终点`);
    assert.equal(g.center, r.center, `q${g.q} 中心`);
    assert.ok(Math.abs(g.energy - r.energy) <= Math.max(1e-12, Math.abs(r.energy) * 1e-9), `q${g.q} 能量 ${g.energy} vs ${r.energy}`);
    assert.ok(Math.abs(g.peak - r.peak) < 1e-10, `q${g.q} 峰值`);
  }
  // 峰值（带符号）的绝对幅度应反映注入增益：q1 ≈ 0.6，q2 ≈ 0.06
  assert.ok(Math.abs(got.analysis.windows[0].peak) > 0.3);
  assert.ok(Math.abs(Math.abs(got.analysis.windows[1].peak) - 0.06) < 0.02,
    `q2 峰值 ${got.analysis.windows[1].peak}`);
});

test('每个通道独立零点：两路不同延迟不互相影响', () => {
  const frames = 16384;
  const f0 = 200, f1 = 4000;
  const x = analyticSweep({ f0, f1, frames });
  const T = frames / SR;
  const L = Math.log(f1 / f0);
  const mk = (d, gain) => {
    const y = new Float64Array(frames + 900);
    for (let n = d; n < y.length; n++) {
      const k = n - d;
      if (k >= frames) break;
      const ph = 2 * Math.PI * f0 * T / L * (Math.exp(L * (k / SR) / T) - 1);
      y[n] = gain * Math.sin(ph);
    }
    return y;
  };
  const params = { f0, f1, lo: 100, hi: 700, pre: 30, post: 120 };
  const a = Core.processChannel(mk(200, 0.8), x, params).analysis;
  const b = Core.processChannel(mk(600, 0.05), x, params).analysis;
  assert.equal(a.zero, frames - 1 + 200);
  assert.equal(b.zero, frames - 1 + 600);
  // 增益差异不跨通道混算
  assert.ok(a.zeroValue > 0.5 && b.zeroValue < 0.1);
});

/* ------------------------------ WAV ------------------------------ */

test('WAV 解码：16 位多声道与 float32 编码往返', () => {
  const frames = 100;
  const ch = 3;
  const bytes = new Uint8Array(44 + frames * ch * 2);
  const dv = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + frames * ch * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, frames * ch * 2, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      dv.setInt16(44 + (i * ch + c) * 2, (i * 100 + c * 1000) - 8000, true);
    }
  }
  const w = Wav.decode(bytes);
  assert.equal(w.channels, 3);
  assert.equal(w.frames, frames);
  assert.equal(w.sampleRate, SR);
  assert.ok(Math.abs(w.data[1][5] - (500 + 1000 - 8000) / 32768) < 1e-12);

  const enc = Wav.encodeFloat32Mono(Float64Array.from([0.5, -0.25, 1.5]), SR);
  const back = Wav.decode(enc);
  assert.equal(back.channels, 1);
  assert.equal(back.bitsPerSample, 32);
  assert.equal(back.encoding, 3);
  assert.equal(back.frames, 3);
  assert.ok(Math.abs(back.data[0][0] - 0.5) < 1e-7);
  assert.ok(Math.abs(back.data[0][2] - 1.5) < 1e-7, 'float32 导出不限幅');
});

test('WAV 解码拒绝坏输入', () => {
  assert.throws(() => Wav.decode(new Uint8Array([1, 2, 3])), /过短/);
  assert.throws(() => Wav.decode(new TextEncoder().encode('NOTARIFF0000WAVE')), /RIFF\/WAVE/);
  // 截断的 data 块
  const good = Wav.encodeFloat32Mono(new Float64Array(10), SR);
  const bad = good.slice(0, good.length - 8);
  assert.throws(() => Wav.decode(bad), /截断|不是整帧/);
});

test('真实样例包：解析并复核已知值', () => {
  const zipPath = path.join(ROOT, 'samples/sweep-harmonic-cases.zip');
  if (!fs.existsSync(zipPath)) return;
  // 直接解包（Node 有 DecompressionStream），比对 sweep/capture 与 setup
  return import('./ziputil.mjs').then(async ({ unzipNode }) => {
    const entries = await unzipNode(fs.readFileSync(zipPath));
    const sweep = Wav.decode(entries.get('sweep.wav'));
    const cap = Wav.decode(entries.get('capture.wav'));
    const setup = JSON.parse(new TextDecoder().decode(entries.get('setup.json')));
    assert.equal(sweep.channels, 1);
    assert.equal(sweep.frames, 48000);
    assert.equal(cap.channels, 2);
    assert.equal(cap.frames, 51000);
    assert.deepEqual(setup, { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 });
    const params = Core.validateSetupObject(setup);
    const g = Core.inverseSweep(sweep.data[0], params.f0, params.f1);
    const D = Core.selfCalibration(sweep.data[0], params.f0, params.f1);
    assert.ok(Math.abs(D - 1001.149401094645) < 1e-6, `D=${D}`);
    const c0 = Core.deconvolve(cap.data[0], g, D);
    const a0 = Core.analyzeChannel(c0, sweep.frames, params);
    assert.equal(a0.zero, 48479);
    assert.equal(a0.zeroRel, 480);
    assert.ok(Math.abs(a0.zeroValue - 0.6500018) < 1e-5);
    assert.deepEqual(a0.conflicts, []);
    const c1 = Core.deconvolve(cap.data[1], g, D);
    const a1 = Core.analyzeChannel(c1, sweep.frames, params);
    assert.equal(a1.zero, 48812);
    assert.equal(a1.zeroRel, 813);
    assert.ok(Math.abs(a1.zeroValue + 0.4499979) < 1e-5);
    // 参考实现逐窗核对
    const ref0 = analyzeRef(cap.data[0], sweep.data[0], params);
    let maxE = 0;
    for (let i = 0; i < 4; i++) {
      maxE = Math.max(maxE, Math.abs(a0.windows[i].energy - ref0.windows[i].energy));
      assert.equal(a0.windows[i].start, ref0.windows[i].start);
      assert.equal(a0.windows[i].end, ref0.windows[i].end);
    }
    assert.ok(maxE < 1e-9, `能量与暴力参考最大差 ${maxE}`);
  });
});
