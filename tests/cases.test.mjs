// 合成用例的数值测试：用 tools/make-case.mjs 生成的已知答案包，
// 与独立暴力参考逐窗核对；覆盖冲突、补零、3 通道、满额输入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCases } from '../tools/make-case.mjs';
import { analyzeRef } from './reference.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Core = require(path.join(ROOT, 'src/js/core.js'));

const cases = buildCases(false);
const byName = (n) => cases.find((c) => c.name === n);

function runCase(c) {
  const N = c.sweep.length;
  const params = Core.validateSetupObject(c.setup);
  const g = Core.inverseSweep(c.sweep, params.f0, params.f1);
  const D = Core.selfCalibration(c.sweep, params.f0, params.f1);
  return c.capture.map((y) => {
    const dataLen = y.length + N - 1;
    const plan = Core.planBand(N, dataLen, params);
    const band = Core.deconvolveBand(y, g, D, plan.lo, plan.hi);
    const got = Core.analyzeBand(band, N, params);
    const ref = analyzeRef(y, c.sweep, params);
    return { got, ref, params, N };
  });
}

function compare(got, ref) {
  assert.equal(got.zero, ref.zero, '零点');
  assert.equal(got.zeroRel, ref.zeroRel, '零点偏移');
  for (let i = 0; i < 4; i++) {
    const a = got.windows[i], b = ref.windows[i];
    assert.equal(a.q, b.q);
    assert.equal(a.shift, b.shift, `q${a.q} 偏移`);
    assert.equal(a.center, b.center, `q${a.q} 中心`);
    assert.equal(a.start, b.start, `q${a.q} 窗起`);
    assert.equal(a.end, b.end, `q${a.q} 窗止`);
    assert.equal(a.zeroFilled, b.zeroFilled, `q${a.q} 补零数`);
    const tol = Math.max(1e-10, Math.abs(b.energy) * 1e-9);
    assert.ok(Math.abs(a.energy - b.energy) <= tol, `q${a.q} 能量 ${a.energy} vs ${b.energy}`);
    assert.ok(Math.abs(a.peak - b.peak) <= Math.max(1e-10, Math.abs(b.peak) * 1e-8), `q${a.q} 峰值`);
    assert.equal(a.peakIndex, b.peakIndex, `q${a.q} 峰位置`);
  }
  assert.deepEqual(got.conflicts, ref.conflicts, '冲突');
}

test('basic：两通道已知答案', () => {
  const c = byName('basic');
  const out = runCase(c);
  for (const r of out) compare(r.got, r.ref);
  // 注入的零点偏移
  assert.equal(out[0].got.zeroRel, 480);
  assert.equal(out[1].got.zeroRel, 813);
  // 直达峰应接近注入增益 × 定标后幅值
  assert.ok(Math.abs(out[0].got.windows[0].peak) > 0.5);
});

test('conflict：重叠窗全部报告', () => {
  const c = byName('conflict');
  const [r] = runCase(c);
  compare(r.got, r.ref);
  assert.deepEqual(r.got.conflicts, [[1, 2], [2, 3], [2, 4], [3, 4]]);
});

test('zeropad：左端负索引补零', () => {
  const c = byName('zeropad');
  const [r] = runCase(c);
  compare(r.got, r.ref);
  const q4 = r.got.windows[3];
  assert.ok(q4.start < 0);
  assert.equal(q4.zeroFilled, -q4.start);
  for (let i = 0; i < -q4.start; i++) assert.equal(q4.samples[i], 0);
});

test('zeropad-right：右端越界补零', () => {
  const c = byName('zeropad-right');
  const [r] = runCase(c);
  compare(r.got, r.ref);
  const w1 = r.got.windows[0];
  assert.ok(w1.end > r.got.dataLen);
  assert.equal(w1.zeroFilled, w1.end - r.got.dataLen);
});

test('threech：三通道各自零点，互不影响', () => {
  const c = byName('threech');
  const out = runCase(c);
  for (const r of out) compare(r.got, r.ref);
  const rels = out.map((r) => r.got.zeroRel);
  assert.deepEqual(rels, [200, 450, 700]);
  assert.equal(new Set(out.map((r) => r.got.zero)).size, 3);
});

test('窗口能量与 RMS 的恒等式', () => {
  const c = byName('basic');
  const [r] = runCase(c);
  for (const w of r.got.windows) {
    let e = 0;
    for (let i = 0; i < w.samples.length; i++) e += w.samples[i] * w.samples[i];
    assert.ok(Math.abs(e - w.energy) < 1e-12);
    assert.ok(Math.abs(w.rms - Math.sqrt(e / w.length)) < 1e-12);
  }
});

test('同高零点取较早帧（合成平顶峰）', () => {
  const N = 48000;
  const c = new Float64Array(N + 5000);
  c[N - 1 + 400] = -0.75;
  c[N - 1 + 700] = 0.75;
  const params = { f0: 80, f1: 6000, lo: 300, hi: 900, pre: 10, post: 20 };
  const got = Core.locateWindows(c, c.length, N, params);
  assert.equal(got.zero, N - 1 + 400);
  assert.equal(got.zeroValue, -0.75);
});
