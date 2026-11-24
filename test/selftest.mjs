// Node 自测：与页面共用同一份数学实现（web/microfacet-core.js、web/integrator.js）
// 运行：node --check 之外，用 node test/selftest.mjs
'use strict';

import {
  xorshift32, nextU32, makeFrame, v3, D_GGX, lambda, sampleAttempt,
  pL_reflect, brdf, binOf, binBounds, validateParams, NB, NP, BIN_SOLID_ANGLE, PARAM_LIMITS,
} from '../web/microfacet-core.js';
import { integrateHemisphere, queryPoint } from '../web/integrator.js';
import { SamplerController } from '../web/sampler.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

// 1. xorshift32 手算核对（种子 1）
{
  let s = 1 >>> 0;
  const seq = [];
  for (let k = 0; k < 4; k++) { s = xorshift32(s); seq.push(s >>> 0); }
  // 参考序列经独立 Python xorshift32 实现交叉核对
  check('xorshift32 参考序列', seq.join(',') === '270369,67634689,2647435461,307599695', seq.join(','));
  let s2 = 1; const [s3, u] = nextU32(s2);
  check('xorshift32 u=(s+0.5)/2^32', s3 === 270369 && approx(u, (270369 + 0.5) / 2 ** 32, 1e-18));
  check('u 落在 (0,1)', u > 0 && u < 1);
}

// 2. NDF 归一化：∫ D(h) cosθ dΩ = 1（各向异性 GGX 关于法向的投影面积=1）
{
  const ax = 0.22, ay = 0.58;
  // 确定性积分：z 细分 400、方位 256
  const NZ = 400, NP2 = 256;
  let sum = 0;
  for (let iz = 0; iz < NZ; iz++) {
    const z = (iz + 0.5) / NZ;
    const r = Math.sqrt(1 - z * z);
    for (let ip = 0; ip < NP2; ip++) {
      const phi = (ip + 0.5) / NP2 * 2 * Math.PI;
      const h = [r * Math.cos(phi), r * Math.sin(phi), z];
      sum += D_GGX(h, ax, ay) * z * (1 / NZ) * (2 * Math.PI / NP2);
    }
  }
  check('∫ D(h) cosθ dΩ ≈ 1', approx(sum, 1, 2e-3), `got ${sum}`);
}

// 3. 确定性积分：Σ 逐格概率 + 拒收率 = 1，能量在物理范围，误差容限核对
{
  const params = { view: [0.3, 0.1, 1], ax: 0.22, ay: 0.58, angleDeg: 25, F0: 0.85 };
  const frame = makeFrame(params.angleDeg);
  const vWorld = v3.normalize(params.view);
  const r = integrateHemisphere(vWorld, frame, params.ax, params.ay, params.F0);
  check('逐格概率之和 ≤ 1', r.totalProb <= 1 + 1e-9, `sum=${r.totalProb}`);
  check('解析接受率在 [0,1]', r.totalProb >= 0 && r.totalProb <= 1);
  check('能量 E∈[0,F0]（导体反射能量不超 F0）', r.totalEnergy > 0 && r.totalEnergy <= params.F0 + 1e-6, `E=${r.totalEnergy}`);
  // 逐格概率非负
  let nonNeg = true;
  for (let i = 0; i < NB * NP; i++) if (r.binProb[i] < -1e-12) nonNeg = false;
  check('逐格概率非负', nonNeg);
  // 细化收敛性：更紧容限 + 更深层级重算，比较差值
  const r2 = integrateHemisphere(vWorld, frame, params.ax, params.ay, params.F0,
    { maxDepth: 12, absTol: 2e-6, relTol: 2e-4 });
  check('总能量收敛误差 ≤ 5e-4', approx(r.totalEnergy, r2.totalEnergy, 5e-4),
    `${r.totalEnergy} vs ${r2.totalEnergy}`);
  let worstBin = 0;
  for (let i = 0; i < NB * NP; i++) worstBin = Math.max(worstBin, Math.abs(r.binProb[i] - r2.binProb[i]));
  check('逐格概率收敛误差 ≤ 1e-3', worstBin <= 1e-3, `worst=${worstBin}`);
  console.log(`    诊断: 评估点=${r.evals}, 最深层级=${r.maxDepth}, 解析拒收率=${(1 - r.totalProb).toFixed(5)}, E_direct=${r.totalEnergy.toFixed(6)}`);
}

// 4. 采样：种子可复现；经验拒收率≈解析拒收率；蒙特卡洛能量≈确定性能量
{
  const params = { view: [0.3, 0.1, 1], ax: 0.22, ay: 0.58, angleDeg: 25, F0: 0.85, seed: 12345, count: 200000 };
  const frame = makeFrame(params.angleDeg);
  const vWorld = v3.normalize(params.view);
  const direct = integrateHemisphere(vWorld, frame, params.ax, params.ay, params.F0);

  const runOnce = async () => {
    const ctl = new SamplerController();
    return ctl.run(params, null);
  };
  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  check('同种子结果可复现', a.store.seedState[0] === b.store.seedState[0] &&
    a.store.lx[7] === b.store.lx[7] && a.energyEstimate === b.energyEstimate);

  const empReject = a.rejectRate;
  const anaReject = 1 - direct.totalProb;
  console.log(`    经验拒收率=${empReject.toFixed(5)} 解析拒收率=${anaReject.toFixed(5)}`);
  check('经验/解析拒收率一致（3σ）', Math.abs(empReject - anaReject) < 3 * Math.sqrt(anaReject * (1 - anaReject) / params.count));

  console.log(`    E_MC=${a.energyEstimate.toFixed(6)} E_direct=${direct.totalEnergy.toFixed(6)} 差=${Math.abs(a.energyEstimate - direct.totalEnergy).toFixed(6)}`);
  check('蒙特卡洛能量与确定性能量一致（2%）', approx(a.energyEstimate, direct.totalEnergy, 0.02 * direct.totalEnergy));

  // 拒收样本权重为 0 且留在分母
  let denomOK = a.store.acceptedCount + a.store.rejectCount === params.count;
  let rejWeightZero = true;
  for (let i = 0; i < params.count; i++) if (a.store.bin[i] === -1 && a.store.weight[i] !== 0) rejWeightZero = false;
  check('拒收不重抽且计入分母', denomOK && rejWeightZero);
}

// 5. 逐格经验频率 vs 解析概率（卡方式粗检 + 最大偏差）
{
  const params = { view: [0.3, 0.1, 1], ax: 0.22, ay: 0.58, angleDeg: 25, F0: 0.85, seed: 777, count: 300000 };
  const frame = makeFrame(params.angleDeg);
  const vWorld = v3.normalize(params.view);
  const direct = integrateHemisphere(vWorld, frame, params.ax, params.ay, params.F0);
  const ctl = new SamplerController();
  const res = await ctl.run(params, null);
  const counts = new Array(NB * NP).fill(0);
  for (let i = 0; i < params.count; i++) if (res.store.bin[i] >= 0) counts[res.store.bin[i]]++;
  let worstZ = 0, worstBin2 = -1;
  for (let bin = 0; bin < NB * NP; bin++) {
    const p = direct.binProb[bin];
    if (p < 1e-5) continue;
    const expected = p * params.count;
    const z = (counts[bin] - expected) / Math.sqrt(expected);
    if (Math.abs(z) > worstZ) { worstZ = Math.abs(z); worstBin2 = bin; }
  }
  console.log(`    逐格最大标准化偏差 |z|=${worstZ.toFixed(2)} (bin ${worstBin2})，128 格下 4σ 可接受`);
  check('逐格频率与解析概率吻合（|z|<4.5）', worstZ < 4.5);
}

// 6. 各向异性行为：ax≠ay 时 lobe 随拉丝角旋转；ax=ay 时与角度无关
{
  const vWorld = v3.normalize([0, 0, 1]);
  const r1 = integrateHemisphere(vWorld, makeFrame(0), 0.3, 0.3, 0.9);
  const r2 = integrateHemisphere(vWorld, makeFrame(47), 0.3, 0.3, 0.9);
  check('各向同性时能量与拉丝角无关', approx(r1.totalEnergy, r2.totalEnergy, 1e-12));
  // 各向异性：绕轴旋转角度后，旋转对称位置的格概率应互换
  const ra = integrateHemisphere(vWorld, makeFrame(0), 0.2, 0.6, 0.9);
  const rb = integrateHemisphere(vWorld, makeFrame(90), 0.2, 0.6, 0.9);
  // 方位格旋转 90° = 4 格（16 格/圈）
  let match = true;
  for (let band = 0; band < NB; band++) {
    for (let seg = 0; seg < NP; seg++) {
      const bA = band * NP + seg;
      const bB = band * NP + ((seg + 4) % NP);
      if (!approx(ra.binProb[bA], rb.binProb[bB], 1e-10)) match = false;
    }
  }
  check('各向异性 lobe 随拉丝角旋转 90°（格概率同步旋转）', match);
}

// 7. 查询接口：pH 与 pL 自洽，pL 与积分器一致
{
  const frame = makeFrame(25);
  const vWorld = v3.normalize([0.3, 0.1, 1]);
  const lWorld = v3.normalize([0.35, 0.12, 0.93]);
  const q = queryPoint(lWorld, vWorld, frame, 0.22, 0.58, 0.85);
  const vLocal = v3.normalize(frame.worldToLocal(vWorld));
  const pL2 = pL_reflect(vLocal, frame.worldToLocal(lWorld), 0.22, 0.58);
  check('查询 pL 与 pL_reflect 一致', approx(q.pL, pL2, 1e-14));
  check('查询同时给出 pH 与 pL', q.pH > 0 && q.pL > 0);
  const below = queryPoint([0, 0, -1], vWorld, frame, 0.22, 0.58, 0.85);
  check('下半球查询被标记拒收', below.accepted === false);
}

// 8. 取消语义：取消后旧 promise 不产出 ok 结果；代际保护
{
  const params = { view: [0.3, 0.1, 1], ax: 0.22, ay: 0.58, angleDeg: 25, F0: 0.85, seed: 1, count: 5_000_000 };
  const ctl = new SamplerController();
  const p1 = ctl.run(params, null);
  ctl.cancel();
  const r1 = await p1;
  check('取消返回 cancelled 且非 ok', r1.cancelled === true && r1.ok === false);
  // 立即重跑新参数
  const params2 = { ...params, count: 2000, seed: 999 };
  const r2 = await ctl.run(params2, null);
  check('取消后重跑成功且结果属于新参数', r2.ok === true && r2.params.seed === 999 && r2.store.count === 2000);
}

// 9. 输入校验
{
  const bad = [
    { view: [0, 0, 1], ax: 0.01, ay: 0.5, angleDeg: 0, F0: 0.5, seed: 1, count: 10 }, // ax 越界
    { view: [1, 0, 0.005], ax: 0.2, ay: 0.5, angleDeg: 0, F0: 0.5, seed: 1, count: 10 }, // vz<0.01
    { view: [0, 0, -1], ax: 0.2, ay: 0.5, angleDeg: 0, F0: 0.5, seed: 1, count: 10 }, // z 负
    { view: [0, 0, 1], ax: 0.2, ay: 0.5, angleDeg: 0, F0: 0.5, seed: 0, count: 10 }, // 种子零
  ];
  let allCaught = true;
  for (const p of bad) if (validateParams(p).length === 0) allCaught = false;
  check('非法参数全部被拒', allCaught);
  const good = { view: [0, 0, 1], ax: 0.2, ay: 0.5, angleDeg: 0, F0: 0.5, seed: 1, count: 10 };
  check('合法参数通过校验', validateParams(good).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
