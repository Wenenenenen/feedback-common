/* math3d.js — 纯手写三维数学，不依赖任何库。所有几何均在物理空间计算。 */
'use strict';
window.VF = window.VF || {};

VF.sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
VF.add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
VF.scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
VF.dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
VF.cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
VF.len3 = (a) => Math.hypot(a[0], a[1], a[2]);
VF.distSq3 = (a, b) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/*
 * 点 p 到闭合三角形 (a, b, c)（含内部、三条边、三个顶点）的距离平方。
 * Real-Time Collision Detection (Christer Ericson), 5.1.5 节。
 */
VF.pointTriangleDistSq = (p, a, b, c) => {
  const ab = VF.sub3(b, a);
  const ac = VF.sub3(c, a);
  const ap = VF.sub3(p, a);
  const d1 = VF.dot3(ab, ap);
  const d2 = VF.dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return VF.dot3(ap, ap); // 顶点 a

  const bp = VF.sub3(p, b);
  const d3 = VF.dot3(ab, bp);
  const d4 = VF.dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return VF.dot3(bp, bp); // 顶点 b

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return VF.distSq3(p, VF.add3(a, VF.scale3(ab, v))); // 边 ab
  }

  const cp = VF.sub3(p, c);
  const d5 = VF.dot3(ab, cp);
  const d6 = VF.dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return VF.dot3(cp, cp); // 顶点 c

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return VF.distSq3(p, VF.add3(a, VF.scale3(ac, w))); // 边 ac
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return VF.distSq3(p, VF.add3(b, VF.scale3(VF.sub3(c, b), w))); // 边 bc
  }

  // 三角形内部
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const inside = VF.add3(a, VF.add3(VF.scale3(ab, v), VF.scale3(ac, w)));
  return VF.distSq3(p, inside);
};

/*
 * Van Oosterom & Strackee 有向立体角，返回该三角形对观测点 p 的立体角（弧度，范围 ±2π）。
 */
VF.triangleSolidAngle = (p, v0, v1, v2) => {
  const a = VF.sub3(v0, p);
  const b = VF.sub3(v1, p);
  const d = VF.sub3(v2, p);
  const al = Math.hypot(a[0], a[1], a[2]);
  const bl = Math.hypot(b[0], b[1], b[2]);
  const dl = Math.hypot(d[0], d[1], d[2]);
  const num = VF.dot3(a, VF.cross3(b, d));
  const den = al * bl * dl
    + VF.dot3(a, b) * dl
    + VF.dot3(b, d) * al
    + VF.dot3(d, a) * bl;
  return 2 * Math.atan2(num, den);
};

/* 广义绕数 W(c) = (1/4π) Σ Ω_t，只对 triangles 给出的索引集合求和。 */
VF.windingNumber = (p, verts, tris) => {
  let sum = 0;
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t];
    sum += VF.triangleSolidAngle(p, verts[tri.ia], verts[tri.ib], verts[tri.ic]);
  }
  return sum / (4 * Math.PI);
};

/* 两个浮点距离平方的并列判定（SPEC §4，阈值 1e-11）。 */
VF.TIE_EPS = 1e-11;
