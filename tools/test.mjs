/**
 * 算子与求解器验证（node tools/test.mjs）。
 * 数据路径通过命令行参数传入，不依赖当前工作目录；不读取除样例外的任何输入。
 *
 * 覆盖：
 *  1. operator-probe.json：Ax、Aᵀz、内积与给定答案逐位比对；
 *  2. 随机伴随一致性 <Ax,z> == <x,Aᵀz>（多核/多位移/含越界）；
 *  3. H 的对称性与正定性（随机向量法）；
 *  4. 四相位合成数据端到端重建，与 truth 比对；
 *  5. 非对称核 + 掩膜 + 部分越界场景的残差与零掩膜行为；
 *  6. PNG 编解码往返一致性。
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, ETA } from '../js/model.js';
import { conjugateGradient } from '../js/solver.js';
import { decodePng, encodePng } from '../js/png-codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = process.argv[2] || join(HERE, '..', 'samples', 'extracted');

let failures = 0;
function check(name, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function close(a, b, tol = 1e-10) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

async function main() {
  // ---------- 1. operator-probe 硬验证 ----------
  console.log('\n[1] operator-probe.json 前向/转置/内积');
  const probe = JSON.parse(await readFile(join(CASES, 'operator-probe.json'), 'utf8'));
  const W = probe.low_width, H = probe.low_height;
  const model = buildModel(W, H, probe.kernel, [{ shift: probe.shift, weights: null }]);
  const B = new Float64Array(model.N);
  const out = new Float64Array(model.M);
  const x = Float64Array.from(probe.x);
  const z = Float64Array.from(probe.z);
  model.forward(x, 0, B, out);
  let maxAx = 0;
  probe.Ax.forEach((v, q) => { maxAx = Math.max(maxAx, Math.abs(v - out[q])); });
  check('A·x 与给定 Ax 一致（最大绝对误差 < 2e-15）', maxAx < 2e-15, `max|Δ|=${maxAx.toExponential(3)}`);

  const atz = new Float64Array(model.N);
  model.adjoint(z, 0, B, atz);
  let maxAT = 0;
  probe.ATz.forEach((v, n) => { maxAT = Math.max(maxAT, Math.abs(v - atz[n])); });
  check('Aᵀ·z 与给定 ATz 一致（最大绝对误差 < 2e-15）', maxAT < 2e-15, `max|Δ|=${maxAT.toExponential(3)}`);

  let ip = 0;
  for (let q = 0; q < model.M; q++) ip += out[q] * z[q];
  check('内积 <Ax,z> 与给定值一致', close(ip, probe.inner_product, 1e-12),
    `got=${ip}, expected=${probe.inner_product}`);

  let ip2 = 0;
  for (let n = 0; n < model.N; n++) ip2 += x[n] * atz[n];
  check('内积恒等 <Ax,z> == <x,Aᵀz>', close(ip, ip2, 1e-12), `${ip} vs ${ip2}`);

  // ---------- 2. 随机伴随测试 ----------
  console.log('\n[2] 随机伴随一致性（多种核尺寸/位移/含越界）');
  const kernels = {
    k1: [[1]],
    k3: [[0, 0.1, 0], [0.2, 0.5, 0], [0, 0, 0.2]],
    k5: normalize([
      [0, 0, 0.05, 0, 0],
      [0, 0.1, 0.2, 0.05, 0],
      [0.02, 0.08, 0.2, 0.1, 0.03],
      [0, 0.04, 0.06, 0.04, 0],
      [0.01, 0, 0.01, 0, 0.01],
    ]),
  };
  const rng = mulberry32(20261121);
  let worstAdj = 0;
  for (const [kn, k] of Object.entries(kernels)) {
    for (const shift of [[0, 0], [0.5, -0.5], [-3.7, 2.3], [4, -4], [1.25, -0.75]]) {
      const m = buildModel(6, 5, k, [{ shift, weights: null }]);
      const xr = randVec(m.N, rng).map((v) => v - 0.5);
      const zr = randVec(m.M, rng).map((v) => v - 0.5);
      const bb = new Float64Array(m.N);
      const fx = new Float64Array(m.M);
      const az = new Float64Array(m.N);
      m.forward(Float64Array.from(xr), 0, bb, fx);
      m.adjoint(Float64Array.from(zr), 0, bb, az);
      const lhs = fx.reduce((s, v, q) => s + v * zr[q], 0);
      const rhs = az.reduce((s, v, n) => s + v * xr[n], 0);
      worstAdj = Math.max(worstAdj, Math.abs(lhs - rhs) / Math.max(1, Math.abs(lhs)));
    }
  }
  check('全部随机用例 <Ax,z> ≈ <x,Aᵀz>（相对误差 < 1e-12）', worstAdj < 1e-12,
    `worst=${worstAdj.toExponential(3)}`);

  // 多帧 + 权重：复合算子 ΣA_fᵀW_fA_f 对称性
  console.log('\n[3] H = ΣAᵀWA + λL + ηI 对称正定');
  {
    const m = buildModel(8, 6, kernels.k3, [
      { shift: [0, 0], weights: randWeights(48, rng) },
      { shift: [0.5, 1.5], weights: randWeights(48, rng) },
      { shift: [-2.2, 0.8], weights: null },
    ]);
    const N = m.N;
    const u = Float64Array.from(randVec(N, rng).map((v) => v - 0.5));
    const v = Float64Array.from(randVec(N, rng).map((v) => v - 0.5));
    const Hu = new Float64Array(N), Hv = new Float64Array(N);
    m.hMatvec(u, 0.07, Hu);
    m.hMatvec(v, 0.07, Hv);
    const lhs = dot(Hu, v), rhs = dot(u, Hv);
    check('H 对称：<Hu,v> == <u,Hv>', close(lhs, rhs, 1e-10),
      `rel=${(Math.abs(lhs - rhs) / Math.abs(lhs)).toExponential(3)}`);
    const uHu = dot(u, Hu);
    check('H 正定（η 项保证严格正定）', uHu > 0, `uᵀHu=${uHu.toExponential(3)}`);
    // L 本身半正定
    const Lu = new Float64Array(N);
    m.laplacian(u, Lu);
    check('L 半正定：uᵀLu >= 0', dot(u, Lu) >= -1e-12, `uᵀLu=${dot(u, Lu).toExponential(3)}`);
  }

  // ---------- 4. 端到端：四相位灰度 ----------
  console.log('\n[4] 四相位灰度端到端重建 vs truth');
  await endToEnd('four-phase.json', 'truth.png', CASES, 0.02);

  // ---------- 5. 非对称核 + 掩膜 ----------
  console.log('\n[5] 非对称核 + 掩膜 + 越界采样');
  await endToEnd('asymmetric.json', null, CASES, null, true);

  // RGB
  console.log('\n[6] 四相位 RGB 端到端重建 vs truth-rgb');
  await endToEnd('four-phase-rgb.json', 'truth-rgb.png', CASES, 0.02);

  // ---------- 7. PNG 往返 ----------
  console.log('\n[7] PNG 编解码往返');
  {
    const orig = await readFile(join(CASES, 'phase-0.png'));
    const dec = await decodePng(orig);
    const re = await encodePng(dec.width, dec.height, dec.data, dec.channels);
    const dec2 = await decodePng(re);
    const same = dec2.data.every((v, i) => v === dec.data[i]) && dec2.channels === dec.channels;
    check('灰度 PNG 解码→编码→解码像素一致', same);
    const rgbOrig = await readFile(join(CASES, 'rgb-0.png'));
    const rgbDec = await decodePng(rgbOrig);
    const rgbRe = await encodePng(rgbDec.width, rgbDec.height, rgbDec.data, 3);
    const rgbDec2 = await decodePng(rgbRe);
    check('RGB PNG 往返像素一致', rgbDec2.data.every((v, i) => v === rgbDec.data[i]));
  }

  // b=0 短路
  console.log('\n[8] 边界情形');
  {
    const m = buildModel(4, 4, [[1]], [{ shift: [0.5, 0.5], weights: null }]);
    const r = conjugateGradient(m, new Float64Array(m.N), 0.01, 1e-7, 50);
    check('b=0 直接返回全 0，零次迭代', r.stopReason === 'zero-rhs' && r.iterations === 0 &&
      r.x.every((v) => v === 0));
    // 掩膜全 0 ⇒ 右端只有 0，解应全 0
    const zeroW = new Float64Array(16).fill(0);
    const m2 = buildModel(4, 4, [[1]], [{ shift: [0, 0], weights: zeroW }]);
    const y = Float64Array.from({ length: 16 }, () => 0.7);
    const b = m2.makeRhs([y]);
    check('全零掩膜时 b=0（不偷偷重归一化）', b.every((v) => v === 0));
  }

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

async function endToEnd(cfgName, truthName, base, maxRmse, checkMask = false) {
  const cfg = JSON.parse(await readFile(join(base, cfgName), 'utf8'));
  const dec0 = await decodePng(await readFile(join(base, cfg.frames[0].file)));
  const { width: W, height: H, channels } = dec0;
  const frames = [];
  const ys = [];
  for (const fr of cfg.frames) {
    const dec = await decodePng(await readFile(join(base, fr.file)));
    if (dec.width !== W || dec.height !== H || dec.channels !== channels) {
      throw new Error(`${fr.file} 尺寸/通道不一致`);
    }
    let weights = null;
    if (fr.mask) {
      const mk = await decodePng(await readFile(join(base, fr.mask)));
      weights = new Float64Array(mk.data.length);
      for (let i = 0; i < mk.data.length; i++) weights[i] = mk.data[i] / 255;
    }
    frames.push({ shift: fr.shift, weights });
    ys.push(dec);
  }
  const GW = 2 * W, GH = 2 * H;
  const model = buildModel(W, H, cfg.kernel, frames);
  const resultChannels = [];
  for (let ch = 0; ch < channels; ch++) {
    const yVecs = ys.map((d) => {
      const v = new Float64Array(W * H);
      for (let q = 0; q < W * H; q++) v[q] = d.data[q * channels + ch] / 255;
      return v;
    });
    const b = model.makeRhs(yVecs);
    const constY = model.frames.reduce((s, fd, f) =>
      s + yVecs[f].reduce((t, yv, q) => t + fd.weights[q] * yv * yv, 0), 0);
    const r = conjugateGradient(model, b, cfg.lambda ?? 0, cfg.tol ?? 1e-8, cfg.max_iter ?? 300, { constY });
    check(`[${cfgName}] ch${ch} CG 收敛`, r.stopReason === 'converged',
      `${r.iterations} iters, rel=${r.finalRelResidual.toExponential(2)}`);
    // 残差范数应与 CG 报告一致
    const Hx = new Float64Array(model.N);
    model.hMatvec(r.x, cfg.lambda ?? 0, Hx);
    let rr = 0;
    for (let n = 0; n < model.N; n++) { const e = Hx[n] - b[n]; rr += e * e; }
    check(`[${cfgName}] ch${ch} 正规方程残差与 CG 一致`,
      close(Math.sqrt(rr) / Math.max(Math.hypot(...b), 1e-12), r.finalRelResidual, 1e-8));
    resultChannels.push(r.x);
  }
  if (truthName) {
    const truth = await decodePng(await readFile(join(base, truthName)));
    if (truth.width !== GW || truth.height !== GH) throw new Error('truth 尺寸应为 2W×2H');
    let se = 0, nPix = 0, maxErr = 0;
    for (let ch = 0; ch < channels; ch++) {
      for (let n = 0; n < GW * GH; n++) {
        const got = Math.min(1, Math.max(0, resultChannels[ch][n]));
        const ref = truth.data[n * channels + ch] / 255;
        const e = got - ref;
        se += e * e; nPix++;
        maxErr = Math.max(maxErr, Math.abs(e));
      }
    }
    const rmse = Math.sqrt(se / nPix);
    check(`[${cfgName}] 重建 RMSE <= ${maxRmse}`, rmse <= maxRmse,
      `RMSE=${rmse.toExponential(3)}, max|Δ|=${maxErr.toExponential(3)}`);
  }
  if (checkMask) {
    // 零权重像素：其观测不得影响解——把这些像素的 Y 改掉，解必须不变
    const ch = 0;
    const yVecs = ys.map((d) => {
      const v = new Float64Array(W * H);
      for (let q = 0; q < W * H; q++) v[q] = d.data[q] / 255;
      return v;
    });
    const b1 = model.makeRhs(yVecs);
    const r1 = conjugateGradient(model, b1, cfg.lambda, cfg.tol, cfg.max_iter);
    const y2 = yVecs.map((v) => v.slice());
    model.frames.forEach((fd, f) => {
      for (let q = 0; q < model.M; q++) if (fd.weights[q] === 0) y2[f][q] += 10 * (q + 1);
    });
    const b2 = model.makeRhs(y2);
    check('零掩膜像素改变观测后 b 不变', b1.every((v, n) => v === b2[n]));
    const r2 = conjugateGradient(model, b2, cfg.lambda, cfg.tol, cfg.max_iter);
    const dmax = r1.x.reduce((m, v, n) => Math.max(m, Math.abs(v - r2.x[n])), 0);
    check('零掩膜像素不参与重建（解完全不变）', dmax === 0, `max|Δx|=${dmax}`);
    // 越界覆盖率统计：存在覆盖率 < 1 的观测像素
    let partial = 0;
    for (let f = 0; f < model.frames.length; f++) {
      for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
        if (model.bilinearCoverage(f, u, v) < 1 - 1e-15) partial++;
      }
    }
    check('检测到越界采样像素（保持零填充、无重归一化）', partial > 0, `${partial} 个`);
  }
}

function normalize(k) {
  const s = k.flat().reduce((a, b) => a + b, 0);
  return k.map((row) => row.map((v) => v / s));
}
function randVec(n, rng) {
  return Float64Array.from({ length: n }, () => rng());
}
function randWeights(n, rng) {
  // 约 20% 零权重，模拟缺测
  return Float64Array.from({ length: n }, () => (rng() < 0.2 ? 0 : rng()));
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
