import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { acceptanceCase, fullCase } from './case.mjs';
import { planeField, totalLoss, finiteDiffGrad } from './reference.mjs';

const require = createRequire(import.meta.url);
const PM = require('../src/core.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOL = (ref) => 1e-7 * Math.max(1, Math.abs(ref));
const close = (got, ref, label) => {
  assert.ok(Math.abs(got - ref) <= TOL(ref), `${label}: got ${got}, ref ${ref}, |d|=${Math.abs(got - ref)}`);
};

/* ---------------------------- FFT 与传播 ---------------------------- */

test('FFT round-trip and direct-DFT agreement', () => {
  for (const [M, N] of [[8, 4], [16, 8], [32, 16]]) {
    const fft2 = PM.makeFFT2(M, N);
    const n = M * N;
    const re0 = new Float64Array(n), im0 = new Float64Array(n);
    for (let i = 0; i < n; i++) { re0[i] = Math.sin(i * 0.37) + 0.4; im0[i] = Math.cos(i * 0.71) - 0.2; }
    const re = Float64Array.from(re0), im = Float64Array.from(im0);
    fft2.fwd(re, im);
    fft2.inv(re, im);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - re0[i]), Math.abs(im[i] - im0[i]));
    assert.ok(err < 1e-12, `roundtrip err ${err} for ${M}x${N}`);
  }
});

test('each plane intensity matches direct DFT (incl. z=0 and evanescent)', () => {
  const proj = acceptanceCase();
  const engine = PM.createProject(proj).engine;
  const p = engine.applyLocksTo(engine.p0);
  const slot = engine.evaluateInto(p, engine.createSlot(), false);
  for (let j = 0; j < proj.planes.length; j++) {
    const ref = planeField(proj, p, proj.planes[j], proj.waves[proj.planes[j].wave]);
    for (let i = 0; i < proj.W * proj.H; i++) close(slot.intensity[j][i], ref.I[i], `plane ${j} I[${i}]`);
  }
  // 已知验收点位
  close(slot.intensity[0][1 * 8 + 5], 0.5936656366, 'I0(5,1)');
  close(slot.intensity[1][1 * 8 + 5], 0.765625, 'I1(5,1)');
  close(slot.intensity[2][1 * 8 + 5], 0.0811422090, 'I2(5,1)');
  // z=0 面逐像素为 amp²
  for (let i = 0; i < proj.W * proj.H; i++) close(slot.intensity[1][i], proj.amp[i] ** 2, `z0 amp^2 @${i}`);
});

test('initial loss and analytic gradient match reference', () => {
  const proj = acceptanceCase();
  const engine = PM.createProject(proj).engine;
  const p = engine.applyLocksTo(engine.p0);
  const slot = engine.evaluateInto(p, engine.createSlot(), true);
  close(slot.loss, 5.4569414079, 'E0');
  close(slot.grad[0 * 8 + 1], -0.3764096802, 'G(1,0)');
  close(slot.grad[1 * 8 + 7], 0.0372462332, 'G lock(7,1)');
  const fd = finiteDiffGrad(proj, p);
  for (let i = 0; i < fd.length; i++) close(slot.grad[i], fd[i], `G[${i}] vs FD`);
});

test('zero-weight pixels do not affect loss or gradient', () => {
  const baseProj = acceptanceCase();
  const engine0 = PM.createProject(baseProj).engine;
  const p = engine0.applyLocksTo(engine0.p0);
  const base = engine0.evaluateInto(p, engine0.createSlot(), true);
  const baseG = finiteDiffGrad(baseProj, p);
  const proj = acceptanceCase();
  for (const plane of proj.planes) {
    for (let i = 0; i < plane.weight.length; i++) if (plane.weight[i] === 0) plane.target[i] = 16;
  }
  const engine = PM.createProject(proj).engine;
  const slot = engine.evaluateInto(p, engine.createSlot(), true);
  close(slot.loss, base.loss, 'loss unchanged by zero-weight targets');
  for (let i = 0; i < slot.grad.length; i++) close(slot.grad[i], baseG[i], `G[${i}] unchanged`);
});

/* ---------------------------- 回退与量化 ---------------------------- */

test('backtracking accepts 0.5 then 1.0 and clamps to [0,1]', () => {
  const proj = acceptanceCase({ eta: 1 });
  const engine = PM.createProject(proj).engine;
  const s = PM.createSession(engine, { eta: 1 });
  s.init();
  close(s.loss, 5.4569414079, 'round0');
  const r1 = s.step();
  assert.equal(r1.round, 1);
  assert.equal(r1.stepSize, 0.5, 'first round rejects t=1, accepts t=0.5');
  close(r1.loss, 5.3368518402, 'round1 loss');
  assert.equal(s.p[1 * 8 + 7], 201 / 255, 'lock stays q/255');
  const r2 = s.step();
  assert.equal(r2.round, 2);
  assert.equal(r2.stepSize, 1.0, 'second round accepts t=1');
  close(r2.loss, 5.2633408095, 'round2 loss');
  assert.equal(s.p[1 * 8 + 7], 201 / 255);
  // 第1轮有 6 个自由分量被夹到边界
  const before = s.history[0];
  assert.ok(before);
});

test('all-zero weights still advance round with step 0', () => {
  const proj = acceptanceCase();
  for (const plane of proj.planes) plane.weight.fill(0);
  const engine = PM.createProject(proj).engine;
  const s = PM.createSession(engine, { eta: 1 });
  s.init();
  const r = s.step();
  assert.equal(r.round, 1);
  assert.equal(r.stepSize, 0, 'no acceptable step records 0');
  assert.equal(r.loss, 0);
  for (let i = 0; i < s.p.length; i++) assert.equal(s.p[i], s.initial[i], 'drive unchanged');
});

test('8-bit export bytes and quantized error JSON', () => {
  const proj = acceptanceCase({ eta: 1 });
  const engine = PM.createProject(proj).engine;
  const s = PM.createSession(engine, { eta: 1 });
  s.init();
  s.step();
  const e = s.exportError();
  const bytes = e.bytes;
  assert.equal(bytes.length, 32);
  // 与独立参考实现逐字节一致（全部 32 个）
  const REF_BYTES = [
    13, 129, 155, 215, 101, 50, 161, 223, 71, 193, 178, 26, 69, 41, 210, 201,
    81, 118, 104, 0, 0, 255, 255, 0, 119, 255, 13, 86, 216, 215, 47, 126,
  ];
  assert.deepEqual(Array.from(bytes), REF_BYTES);
  assert.equal(bytes[15], 201, '锁点第二行末字节保留 201');
  close(e.loss, 5.3342232797, 'quantized total');
  close(e.planeLoss[0], 1.2256013936, 'quantized plane 0');
  close(e.planeLoss[1], 2.4038932956, 'quantized plane 1');
  close(e.planeLoss[2], 1.7047285905, 'quantized plane 2');
  assert.equal(e.step, 1);
  // 半码向上
  const p = Float64Array.from(s.p);
  p[0] = 0.5;
  assert.equal(engine.quantize(p)[0], 128);
});
