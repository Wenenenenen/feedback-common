// 拉丝金属（各向异性 GGX）反射采样校验 —— 数学核心
// 严格按 samples/microfacet-proof.json 的 format 约定实现：
//  - 世界：单位法向 +Z；观察 v 与出射 l 均指离表面
//  - 拉丝局部轴 = 世界 XY 绕 z 反转 angle 度
//  - xorshift32（每次尝试两次）
//  - 可见微表面法线（VNDF）采样 + 各向异性 GGX，全部手写，无第三方材质/采样库
// 本模块同时被浏览器页面与 node 自测脚本以 ES module 方式复用。

'use strict';

export const TAU = Math.PI * 2;

export const PARAM_LIMITS = Object.freeze({
  ax: [0.02, 1],
  ay: [0.02, 1],
  F0: [0, 1],
  seed: [1, 0xffffffff], // 非零 u32
  angleDeg: [-360, 360],
});

// ---------- 小向量工具（三元组 [x,y,z]，避免分配热路径上的对象） ----------
export const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const n = Math.hypot(a[0], a[1], a[2]);
    if (!(n > 0)) throw new Error('normalize: 零向量');
    return [a[0] / n, a[1] / n, a[2] / n];
  },
  cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
};

// ---------- xorshift32：依次 xor<<13、xor>>>17、xor<<5，各步保留低 32 位 ----------
export function xorshift32(s) {
  s = s >>> 0;
  s ^= (s << 13) >>> 0;
  s >>>= 0;
  s ^= s >>> 17;
  s >>>= 0;
  s ^= (s << 5) >>> 0;
  return s >>> 0;
}

// 一次推进，返回 [新状态, u]，u=(s+0.5)/2^32
export function nextU32(state) {
  const s2 = xorshift32(state);
  return [s2, (s2 + 0.5) / 4294967296];
}

// ---------- 材质与坐标架 ----------
// 拉丝局部轴将世界 XY 绕 z 反转 angle 度：
// 局部 = R(-angle)·世界。R(-a) 基 = [cos a, -sin a; sin a, cos a]。
export function makeFrame(angleDeg) {
  const a = (-angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    c,
    s,
    // 世界 -> 局部
    worldToLocal(w) {
      return [c * w[0] - s * w[1], s * w[0] + c * w[1], w[2]];
    },
    // 局部 -> 世界（R(-a) 的转置）
    localToWorld(l) {
      return [c * l[0] + s * l[1], -s * l[0] + c * l[1], l[2]];
    },
  };
}

export function validateParams(p) {
  const errs = [];
  const view = p.view;
  if (!Array.isArray(view) || view.length !== 3 || view.some((x) => !Number.isFinite(x))) {
    errs.push('观察方向须为 3 个有限数');
  } else {
    const n0 = Math.hypot(view[0], view[1], view[2]);
    if (!(n0 > 0)) errs.push('观察方向归一前须非零');
    else if (view[2] <= 0) errs.push('观察方向归一前 z 必须为正（指离表面）');
    else if (view[2] / n0 < 0.01) errs.push('归一后 vz 至少 0.01（观察方向过于贴地）');
  }
  const checkRange = (name, label) => {
    const [lo, hi] = PARAM_LIMITS[name];
    if (!Number.isFinite(p[name]) || p[name] < lo || p[name] > hi) {
      errs.push(`${label} 须在 [${lo}, ${hi}] 内`);
    }
  };
  checkRange('ax', '横向粗糙度 ax');
  checkRange('ay', '纵向粗糙度 ay');
  checkRange('F0', '反射率 F0');
  checkRange('seed', '种子');
  if (!Number.isFinite(p.angleDeg)) errs.push('拉丝角须为有限数（度）');
  if (!Number.isInteger(p.count) || p.count <= 0) errs.push('采样次数须为正整数');
  return errs;
}

// ---------- 各向异性 GGX（公式逐字对应 format） ----------
// D(h) = 1 / (π·ax·ay·((hx/ax)^2 + (hy/ay)^2 + hz^2)^2)
export function D_GGX(h, ax, ay) {
  const x = h[0] / ax;
  const y = h[1] / ay;
  const q = x * x + y * y + h[2] * h[2];
  return 1 / (Math.PI * ax * ay * q * q);
}

// Λ(w) = (sqrt(1 + ((ax·wx)^2 + (ay·wy)^2)/wz^2) - 1) / 2
export function lambda(w, ax, ay) {
  const x = ax * w[0];
  const y = ay * w[1];
  const t = (x * x + y * y) / (w[2] * w[2]);
  return (Math.sqrt(1 + t) - 1) / 2;
}

// 高度相关 Smith G2：G2(v,l) = 1 / (1 + Λ(v) + Λ(l))
export function G2_heightCorrelated(v, l, ax, ay) {
  return 1 / (1 + lambda(v, ax, ay) + lambda(l, ax, ay));
}

// F = F0 + (1-F0)·(1 - |v·h|)^5
export function fresnelSchlick(cosVH, F0) {
  const c = 1 - Math.abs(cosVH);
  return F0 + (1 - F0) * c * c * c * c * c;
}

// BRDF 几何项（不含 Fresnel）：D / (4·vz·lz·(1 + Λ(v) + Λ(l)))
export function brdfGeom(v, l, h, ax, ay) {
  const D = D_GGX(h, ax, ay);
  const denom = 4 * v[2] * l[2] * (1 + lambda(v, ax, ay) + lambda(l, ax, ay));
  return D / denom;
}

// BRDF = F·D / (4·vz·lz·(1 + Λ(v) + Λ(l)))（即 F·D·G2 / (4 vz lz)）
export function brdf(v, l, h, ax, ay, F0) {
  return fresnelSchlick(v3.dot(v, h), F0) * brdfGeom(v, l, h, ax, ay);
}

// VNDF 密度 p(h) = D(h)·max(0,v·h) / (vz·(1 + Λ(v)))
export function pH_vndf(v, h, ax, ay) {
  const D = D_GGX(h, ax, ay);
  const Lv = lambda(v, ax, ay);
  return (D * Math.max(0, v3.dot(v, h))) / (v[2] * (1 + Lv));
}

// 反射方向密度 p(l) = p(h) / (4·|v·h|)，h 用归一化 (v+l)
export function pL_reflect(v, l, ax, ay) {
  if (l[2] <= 0) return 0;
  const h = v3.normalize([v[0] + l[0], v[1] + l[1], v[2] + l[2]]);
  const pH = pH_vndf(v, h, ax, ay);
  const vdotH = v3.dot(v, h);
  if (Math.abs(vdotH) < 1e-12) return 0;
  return pH / (4 * Math.abs(vdotH));
}

// ---------- 一次 VNDF 采样尝试（Heitz 2018 Listing 3 的拉伸空间做法，
// 步骤与 format 中文字描述逐条对应）。返回完整尝试记录。 ----------
export function sampleOneAttempt(state, vWorld, frame, ax, ay) {
  // 每次尝试用两次 xorshift32
  let s = state >>> 0;
  let u1, u2;
  [s, u1] = nextU32(s);
  [s, u2] = nextU32(s);

  // 观察方向进拉丝局部系并归一
  const vRaw = frame.worldToLocal(vWorld);
  const v = v3.normalize(vRaw);

  // Vh = normalize(ax·vx, ay·vy, vz)
  const Vh = v3.normalize([ax * v[0], ay * v[1], v[2]]);
  // T1 = normalize(-Vhy, Vhx, 0)；正视时 Vh=(0,0,1) -> T1=(1,0,0)
  const t1len = Math.hypot(Vh[1], Vh[0]);
  const T1 = t1len > 0 ? [-Vh[1] / t1len, Vh[0] / t1len, 0] : [1, 0, 0];
  const T2 = v3.cross(Vh, T1);

  const r = Math.sqrt(u1);
  const phi = TAU * u2;
  let t1 = r * Math.cos(phi);
  const t2Init = r * Math.sin(phi);
  const blend = (1 + Vh[2]) / 2;
  const t2 = (1 - blend) * Math.sqrt(Math.max(0, 1 - t1 * t1)) + blend * t2Init;

  // Nh = t1·T1 + t2·T2 + sqrt(max(0,1-t1²-t2²))·Vh
  const nhz2 = Math.max(0, 1 - t1 * t1 - t2 * t2);
  const Nh = [
    t1 * T1[0] + t2 * T2[0] + Math.sqrt(nhz2) * Vh[0],
    t1 * T1[1] + t2 * T2[1] + Math.sqrt(nhz2) * Vh[1],
    t1 * T1[2] + t2 * T2[2] + Math.sqrt(nhz2) * Vh[2],
  ];

  // h = normalize(ax·Nhx, ay·Nhy, max(0, Nhz))
  const hLocal = v3.normalize([ax * Nh[0], ay * Nh[1], Math.max(0, Nh[2])]);

  // l = 2·(v·h)·h - v（局部系反射），再转回世界
  const vdotH = v3.dot(v, hLocal);
  const lLocal = [
    2 * vdotH * hLocal[0] - v[0],
    2 * vdotH * hLocal[1] - v[1],
    2 * vdotH * hLocal[2] - v[2],
  ];

  const accepted = lLocal[2] > 0; // lz<=0 为拒收（仅记录，不重抽）
  const hWorld = frame.localToWorld(hLocal);
  const lWorld = frame.localToWorld(lLocal);

  // 采样得到的半向量密度（局部、世界数值相同，量均为旋转不变量）
  const pH = pH_vndf(v, hLocal, ax, ay);

  let hEff = null;
  let pL = 0;
  if (accepted) {
    // 有效 l 取 h = normalize(v+l)
    hEff = v3.normalize([v[0] + lLocal[0], v[1] + lLocal[1], v[2] + lLocal[2]]);
    const pHeff = pH_vndf(v, hEff, ax, ay);
    const vdHe = v3.dot(v, hEff);
    pL = pHeff / (4 * Math.abs(vdHe));
    const fGeom = brdfGeom(v, lLocal, hEff, ax, ay); // D / (4 vz lz (1+Λv+Λl))，F 在外层乘
    return {
      state: s,
      u1,
      u2,
      v,
      h: hLocal,
      hWorld,
      l: lLocal,
      lWorld,
      accepted,
      pH,
      hEff,
      pL,
      brdfNoF: fGeom,
    };
  }

  return { state: s, u1, u2, v, h: hLocal, hWorld, l: lLocal, lWorld, accepted, pH, hEff, pL, brdfNoF: 0 };
}

// 完整一次尝试，含 Fresnel 与能量权重
export function sampleAttempt(state, vWorld, frame, ax, ay, F0) {
  const a = sampleOneAttempt(state, vWorld, frame, ax, ay);
  if (a.accepted) {
    const F = fresnelSchlick(v3.dot(a.v, a.hEff), F0);
    a.weight = (F * a.brdfNoF * a.l[2]) / a.pL;
  } else {
    a.weight = 0;
  }
  return a;
}

// ---------- 分格：世界空间 z 均分 8 带、方位 [0,2π) 均分 16 格 ----------
export const NB = 8; // z 带数
export const NP = 16; // 方位格数
export const BIN_REJECT = -1;

// 左闭右开；z=1 归最后带；极点（x=y=0）用方位 0
export function binOf(lWorld) {
  if (lWorld[2] <= 0) return BIN_REJECT;
  let band = Math.floor(lWorld[2] * NB);
  if (band >= NB) band = NB - 1;
  if (band < 0) band = 0;
  let phi = Math.atan2(lWorld[1], lWorld[0]);
  if (phi < 0) phi += TAU;
  let seg = Math.floor(phi / TAU * NP);
  if (seg >= NP) seg = NP - 1;
  if (lWorld[0] === 0 && lWorld[1] === 0) seg = 0;
  return band * NP + seg;
}

export function binBounds(bin) {
  const band = Math.floor(bin / NP);
  const seg = bin % NP;
  return {
    zLo: band / NB,
    zHi: (band + 1) / NB,
    phiLo: (seg / NP) * TAU,
    phiHi: ((seg + 1) / NP) * TAU,
  };
}

export const BIN_SOLID_ANGLE = TAU / (NB * NP); // 每格立体角 = 2π/128
