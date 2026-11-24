// 确定性（数值）积分模块
// 半球按立体角均匀分格（世界空间 z 均分 8 带 × 方位均分 16 格），
// 对每格做中点法则 + 自适应四叉细化：
//   积分 ∫ f(l) dΩ，dΩ = dφ·d(cosθ)，l=(sqrt(1-z²)cosφ, sqrt(1-z²)sinφ, z)
// 目标：总能量误差 ≤ 0.0005，逐格 p(l) 概率积分误差 ≤ 0.001（见 microfacet-proof.json）。

'use strict';

import { v3, pL_reflect, brdf, TAU, NB, NP, BIN_SOLID_ANGLE, binBounds } from './microfacet-core.js';

function makeL(z, phi) {
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

// 自适应积分一个分格（bin），返回 { integral, evals, depth, err }
// 中点法则在尖锐 GGX lobe 上单次理查森外推不可靠（峰可能恰好落在网格点之间），
// 故采用“两级稳定”判据：细分一次后若差值已小于容限，再细分一级确认仍稳定才接受。
function integrateBin(bin, evalFn, opt) {
  const b = binBounds(bin);
  const root = { z0: b.zLo, z1: b.zHi, p0: b.phiLo, p1: b.phiHi };
  let evals = 0;
  let maxDepth = 0;

  function quad(cell) {
    const zc = (cell.z0 + cell.z1) / 2;
    const pc = (cell.p0 + cell.p1) / 2;
    const area = (cell.z1 - cell.z0) * (cell.p1 - cell.p0);
    const l = makeL(zc, pc);
    return evalFn(l) * area;
  }

  function split(cell) {
    const zm = (cell.z0 + cell.z1) / 2;
    const pm = (cell.p0 + cell.p1) / 2;
    return [
      { z0: cell.z0, z1: zm, p0: cell.p0, p1: pm },
      { z0: zm, z1: cell.z1, p0: cell.p0, p1: pm },
      { z0: cell.z0, z1: zm, p0: pm, p1: cell.p1 },
      { z0: zm, z1: cell.z1, p0: pm, p1: cell.p1 },
    ];
  }

  const tolOf = (x) => opt.absTol + opt.relTol * Math.abs(x);

  // 返回该单元的积分值与保守误差（=与上一级估计的实际差值，非外推）
  function rec(cell, depth, prevLevel) {
    const cur = quad(cell);
    evals++;
    if (depth >= opt.maxDepth) return { value: cur, err: Infinity, hitCap: true };
    const kids = split(cell);
    let fine = 0;
    for (const c of kids) { fine += quad(c); evals++; }
    const diff = Math.abs(fine - cur);
    // 两级稳定：本级差已达标，且与更上一级相比也稳定
    const stableNow = diff <= tolOf(fine);
    const stablePrev = prevLevel === null || Math.abs(fine - prevLevel) <= tolOf(fine) * 4;
    if (stableNow && stablePrev) {
      maxDepth = Math.max(maxDepth, depth);
      return { value: fine, err: diff, hitCap: false };
    }
    let sum = 0;
    let errSum = 0;
    let hitCap = false;
    for (const c of kids) {
      const r = rec(c, depth + 1, cur);
      sum += r.value;
      errSum += r.err;
      hitCap = hitCap || r.hitCap;
    }
    maxDepth = Math.max(maxDepth, depth + 1);
    return { value: sum, err: Math.min(errSum, diff + errSum), hitCap };
  }

  const { value, err, hitCap } = rec(root, 0, null);
  return { integral: value, err, evals, maxDepth, hitCap };
}

// 全半球确定性积分。
// vWorld：世界系观察方向；frame：拉丝坐标架。
// 返回逐格 p(l) 概率、逐格能量密度积分、总量与诊断信息。
export function integrateHemisphere(vWorld, frame, ax, ay, F0, opts = {}) {
  const opt = {
    maxDepth: opts.maxDepth ?? 10, // 最深 10 层（单元面积 ≈ 格面积 / 1e6），尖 lobe 兜底
    absTol: opts.absTol ?? 2e-5, // 每单元绝对容限（128 格累计仍远小于规格 5e-4）
    relTol: opts.relTol ?? 1e-3, // 每单元相对容限
  };

  // 计算在局部系进行（v 转局部；世界分格只与 z、φ 有关，而局部系 z 与世界相同，
  // φ 仅整体旋转 angle：分格边界在局部系中平移，逐 bin 结果通过 l 转回世界后归类）。
  // 为严格对应“世界空间分格”，直接在世界系取 l，再转局部系算 v/l 点积类量。
  const vLocal = v3.normalize(frame.worldToLocal(vWorld));

  const evalPL = (lWorld) => {
    const lLocal = frame.worldToLocal(lWorld);
    return pL_reflect(vLocal, lLocal, ax, ay);
  };
  const evalEnergy = (lWorld) => {
    const lLocal = frame.worldToLocal(lWorld);
    if (lLocal[2] <= 0) return 0;
    const hLocal = v3.normalize([
      vLocal[0] + lLocal[0],
      vLocal[1] + lLocal[1],
      vLocal[2] + lLocal[2],
    ]);
    return brdf(vLocal, lLocal, hLocal, ax, ay, F0) * lLocal[2];
  };

  const nBins = NB * NP;
  const binProb = new Float64Array(nBins);
  const binEnergy = new Float64Array(nBins);
  const binDensity = new Float64Array(nBins); // 格内 p(l) 平均密度 = 概率 / 格立体角
  const binErrP = new Float64Array(nBins); // 逐格概率的自适应误差估计
  const binErrE = new Float64Array(nBins);
  let totalProb = 0;
  let totalEnergy = 0;
  let totalEvals = 0;
  let maxDepthSeen = 0;
  let capBins = 0;

  for (let bin = 0; bin < nBins; bin++) {
    const rp = integrateBin(bin, evalPL, opt);
    const re = integrateBin(bin, evalEnergy, opt);
    binProb[bin] = rp.integral;
    binEnergy[bin] = re.integral;
    binDensity[bin] = rp.integral / BIN_SOLID_ANGLE;
    binErrP[bin] = rp.err;
    binErrE[bin] = re.err;
    totalProb += rp.integral;
    totalEnergy += re.integral;
    totalEvals += rp.evals + re.evals;
    maxDepthSeen = Math.max(maxDepthSeen, rp.maxDepth, re.maxDepth);
    if (rp.hitCap || re.hitCap) capBins++;
  }

  return {
    binProb,
    binEnergy,
    binDensity,
    binErrP,
    binErrE,
    totalProb, // 解析拒收率 = 1 - totalProb
    totalEnergy,
    evals: totalEvals,
    maxDepth: maxDepthSeen,
    capBins,
    binSolidAngle: BIN_SOLID_ANGLE,
  };
}

// 单点查询：给定世界系出射方向，返回半向量密度与反射方向密度等完整量。
export function queryPoint(lWorld, vWorld, frame, ax, ay, F0) {
  const v = v3.normalize(frame.worldToLocal(vWorld));
  const l = frame.worldToLocal(lWorld);
  if (l[2] <= 0) {
    return { accepted: false, reason: '查询方向位于下半球（lz≤0）' };
  }
  const h = v3.normalize([v[0] + l[0], v[1] + l[1], v[2] + l[2]]);
  const D = 1 / (Math.PI * ax * ay *
    ((h[0] / ax) ** 2 + (h[1] / ay) ** 2 + h[2] ** 2) ** 2);
  const Lv = (() => {
    const x = ax * v[0], y = ay * v[1];
    return (Math.sqrt(1 + (x * x + y * y) / (v[2] * v[2])) - 1) / 2;
  })();
  const Ll = (() => {
    const x = ax * l[0], y = ay * l[1];
    return (Math.sqrt(1 + (x * x + y * y) / (l[2] * l[2])) - 1) / 2;
  })();
  const vdotH = v3.dot(v, h);
  const pH = (D * Math.max(0, vdotH)) / (v[2] * (1 + Lv));
  const pL = pH / (4 * Math.abs(vdotH));
  const F = F0 + (1 - F0) * (1 - Math.abs(vdotH)) ** 5;
  const b = (F * D) / (4 * v[2] * l[2] * (1 + Lv + Ll));
  return {
    accepted: true,
    v, l, h,
    D, LambdaV: Lv, LambdaL: Ll, F,
    brdf: b,
    pH,
    pL,
    vdotH,
    energyDensity: b * l[2],
  };
}

export { TAU };
