/*
 * zfail-core.js — Z-Fail(深度失败)模板阴影体核心算法
 *
 * 流程:闭合朝外索引网格 -> 提取轮廓边 -> 挤出侧面到无穷远(w=0 齐次坐标)
 *       -> 近/远封盖 -> 齐次空间裁剪(近裁面切入、相机在体内均安全)
 *       -> 软件光栅化(top-left 填充规则) -> 接收面写深度 -> 深度失败更新有符号模板计数
 * 另提供独立的"点到光源遮挡射线"参考,用于逐像素对照。
 * 浏览器(ZFail 全局)与 Node(module.exports)均可用。
 */
(function (global) {
'use strict';

// ---------------- vec3 ----------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = a => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------- mat4(列主序, OpenGL 风格) ----------------
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function xform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}
// 视图基向量 + 视图矩阵;返回 {view, bx, by, bz},世界坐标 = eye + x*bx + y*by + z*bz
function lookAt(eye, target, up) {
  const bz = norm(sub(eye, target)); // 相机看向 -z
  let bx = norm(cross(up, bz));
  if (!isFinite(bx[0]) || Math.hypot(...bx) < 1e-9) bx = norm(cross([0, 0, 1], bz));
  const by = cross(bz, bx);
  const view = [
    bx[0], by[0], bz[0], 0,
    bx[1], by[1], bz[1], 0,
    bx[2], by[2], bz[2], 0,
    -dot(bx, eye), -dot(by, eye), -dot(bz, eye), 1,
  ];
  return { view, bx, by, bz };
}
// 无穷远透视投影(无远裁面):z_ndc = 1 + 2n/z_e,z_e=-n -> -1,z_e->-inf -> 1
function perspInf(fovyDeg, aspect, near) {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, -1, -1,
    0, 0, -2 * near, 0,
  ];
}
function makeCam(opt) {
  const { view, bx, by, bz } = lookAt(opt.eye, opt.target, [0, 1, 0]);
  const proj = perspInf(opt.fovy, opt.W / opt.H, opt.near);
  return {
    eye: opt.eye.slice(), near: opt.near, fovy: opt.fovy,
    bx, by, bz, vp: mul4(proj, view),
  };
}

// ---------------- 阴影体构建 ----------------
const v4 = p => [p[0], p[1], p[2], 1];
const inf4 = (p, L) => [p[0] - L[0], p[1] - L[1], p[2] - L[2], 0]; // 远离光源到无穷远

// 约定:面向光源的面 dot(n, p-L) < 0(法线朝向光源)
function buildVolumes(casters, light) {
  const vols = [];
  const warnings = [];
  casters.forEach((c, ci) => {
    const V = c.v, F = c.f;
    const lit = F.map(t => {
      const a = V[t[0]], b = V[t[1]], d = V[t[2]];
      return dot(cross(sub(b, a), sub(d, a)), sub(a, light)) < 0;
    });
    // 边表:key 为无序顶点对,值为该边在各面中的有向出现
    const edges = new Map();
    F.forEach((t, ti) => {
      for (let e = 0; e < 3; e++) {
        const i = t[e], j = t[(e + 1) % 3];
        const key = i < j ? i + '_' + j : j + '_' + i;
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push({ ti, i, j });
      }
    });
    // 封盖:近盖 = 面向光源的面(原绕向);远盖 = 背光面挤出到无穷远(绕向不变)
    F.forEach((t, ti) => {
      if (lit[ti]) {
        vols.push({ pts: [v4(V[t[0]]), v4(V[t[1]]), v4(V[t[2]])], type: 'capNear', caster: ci, src: ti });
      } else {
        vols.push({ pts: [inf4(V[t[0]], light), inf4(V[t[1]], light), inf4(V[t[2]], light)], type: 'capFar', caster: ci, src: ti });
      }
    });
    // 侧面:轮廓边(一侧面向光、一侧背光)按背光面中的有向边挤出,保证朝外
    edges.forEach(list => {
      if (list.length !== 2) {
        warnings.push(`caster ${ci}: 非流形边(邻接面数 ${list.length})`);
        return;
      }
      const [e0, e1] = list;
      if (lit[e0.ti] === lit[e1.ti]) return;
      const dark = lit[e0.ti] ? e1 : e0;
      const A = v4(V[dark.i]), B = v4(V[dark.j]);
      const Ai = inf4(V[dark.i], light), Bi = inf4(V[dark.j], light);
      vols.push({ pts: [A, B, Bi], type: 'side', caster: ci, src: dark.ti });
      vols.push({ pts: [A, Bi, Ai], type: 'side', caster: ci, src: dark.ti });
    });
  });
  return { vols, warnings };
}

// ---------------- 齐次空间裁剪 ----------------
// 先裁近面(z+w>=0):裁完后所有顶点 w>0,再裁其余 5 面。w=0 的无穷远顶点天然支持。
function clipPoly(pts) {
  const planes = [
    p => p[2] + p[3],  // near:  z >= -w
    p => p[0] + p[3],  // left:  x >= -w
    p => -p[0] + p[3], // right: x <=  w
    p => p[1] + p[3],  // bottom
    p => -p[1] + p[3], // top
    p => -p[2] + p[3], // far:   z <=  w(无穷远顶点取等号保留)
  ];
  let poly = pts;
  for (const fn of planes) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length];
      const da = fn(A), db = fn(B);
      if (da >= 0) out.push(A);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([0, 1, 2, 3].map(k => A[k] + t * (B[k] - A[k])));
      }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

// ---------------- 光栅化 ----------------
const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// 定点化:吸附到 1/256 亚像素网格(与硬件光栅器同理)。
// 共享边两端点在两三角形中逐位一致,边函数恰为 0 时由 top-left 规则唯一归属,
// 避免浮点 1ulp 误差导致共享边被两侧重复计入/同时漏计。
const SUB = 256;
const snap = v => Math.round(v * SUB) / SUB;
const toScreen = (p, W, H) => [
  snap((p[0] + 1) * 0.5 * W),
  snap((1 - (p[1] + 1) * 0.5) * H),
  p[2],
];

// 单三角形在像素 (px,py) 中心的覆盖求值;命中返回 {z, front},否则 null
function triAt(p0, p1, p2, px, py, W, H) {
  const front = area2(p0, p1, p2) > 0; // NDC(y 向上)逆时针为正面
  let a = toScreen(p0, W, H), b = toScreen(p1, W, H), c = toScreen(p2, W, H);
  let A = area2(a, b, c);
  if (A === 0) return null;
  if (A < 0) { const t = b; b = c; c = t; A = -A; }
  const E = (qx, qy, s0, s1) => (qx - s0[0]) * (s1[1] - s0[1]) - (qy - s0[1]) * (s1[0] - s0[0]);
  const tl = (s0, s1) => (s1[1] - s0[1]) < 0 || ((s1[1] - s0[1]) === 0 && (s1[0] - s0[0]) > 0);
  const qx = px + 0.5, qy = py + 0.5;
  const e0 = E(qx, qy, a, b), e1 = E(qx, qy, b, c), e2 = E(qx, qy, c, a);
  const in0 = e0 < 0 || (e0 === 0 && tl(a, b));
  const in1 = e1 < 0 || (e1 === 0 && tl(b, c));
  const in2 = e2 < 0 || (e2 === 0 && tl(c, a));
  if (!(in0 && in1 && in2)) return null;
  const wa = e1 / -A, wb = e2 / -A, wc = e0 / -A;
  return { z: wa * a[2] + wb * b[2] + wc * c[2], front };
}

// 裁剪后多边形扇形三角化并光栅化;visit(x, y, z, front)
function rasterClipPoly(clip, W, H, visit) {
  if (!clip || clip.length < 3) return;
  const ndc = clip.map(p => [p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
  for (let k = 1; k < ndc.length - 1; k++) {
    const p0 = ndc[0], p1 = ndc[k], p2 = ndc[k + 1];
    const front = area2(p0, p1, p2) > 0;
    let a = toScreen(p0, W, H), b = toScreen(p1, W, H), c = toScreen(p2, W, H);
    let A = area2(a, b, c);
    if (A === 0) continue;
    if (A < 0) { const t = b; b = c; c = t; A = -A; }
    const E = (qx, qy, s0, s1) => (qx - s0[0]) * (s1[1] - s0[1]) - (qy - s0[1]) * (s1[0] - s0[0]);
    const tl = (s0, s1) => (s1[1] - s0[1]) < 0 || ((s1[1] - s0[1]) === 0 && (s1[0] - s0[0]) > 0);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const e0 = E(qx, qy, a, b), e1 = E(qx, qy, b, c), e2 = E(qx, qy, c, a);
        if (!((e0 < 0 || (e0 === 0 && tl(a, b))) &&
              (e1 < 0 || (e1 === 0 && tl(b, c))) &&
              (e2 < 0 || (e2 === 0 && tl(c, a))))) continue;
        const wa = e1 / -A, wb = e2 / -A, wc = e0 / -A;
        visit(x, y, wa * a[2] + wb * b[2] + wc * c[2], front);
      }
    }
  }
}

// ---------------- 渲染管线 ----------------
// opt: {light, eye, target, fovy, near, W, H}
function render(scene, opt) {
  const W = opt.W | 0, H = opt.H | 0;
  const cam = makeCam(opt);
  const { vols, warnings } = buildVolumes(scene.casters, opt.light);
  // 预先变换+裁剪所有体积三角形
  const volClipped = vols.map(v => ({
    type: v.type, caster: v.caster, src: v.src,
    clip: clipPoly(v.pts.map(p => xform(cam.vp, p))),
  }));

  // 深度:仅接收面写入
  const depth = new Float64Array(W * H).fill(1);
  const nrm = new Float32Array(W * H * 3);
  scene.receivers.forEach(r => {
    r.f.forEach(t => {
      const a = r.v[t[0]], b = r.v[t[1]], c = r.v[t[2]];
      const n = norm(cross(sub(b, a), sub(c, a)));
      const clip = clipPoly([a, b, c].map(p => xform(cam.vp, [p[0], p[1], p[2], 1])));
      rasterClipPoly(clip, W, H, (x, y, z) => {
        const i = y * W + x;
        if (z < depth[i]) {
          depth[i] = z;
          nrm[i * 3] = n[0]; nrm[i * 3 + 1] = n[1]; nrm[i * 3 + 2] = n[2];
        }
      });
    });
  });

  // 模板:深度失败规则(背面失败 +1,正面失败 -1)
  const stencil = new Int16Array(W * H);
  for (const v of volClipped) {
    rasterClipPoly(v.clip, W, H, (x, y, z, front) => {
      const i = y * W + x;
      if (z > depth[i]) stencil[i] += front ? -1 : 1;
    });
  }
  return { W, H, depth, nrm, stencil, vols: volClipped, cam, scene, light: opt.light.slice(), warnings };
}

// 由深度重建像素处接收面世界坐标(无接收面返回 null)
function worldPos(result, px, py) {
  const { cam, W, H, depth } = result;
  const z = depth[py * W + px];
  if (z >= 1) return null;
  const ze = (2 * cam.near) / (z - 1); // z_ndc = 1 + 2n/z_e
  const xn = ((px + 0.5) / W) * 2 - 1;
  const yn = 1 - ((py + 0.5) / H) * 2;
  const f = 1 / Math.tan((cam.fovy * Math.PI) / 360);
  const xe = xn * (-ze) * (W / H) / f;
  const ye = yn * (-ze) / f;
  return [
    cam.eye[0] + xe * cam.bx[0] + ye * cam.by[0] + ze * cam.bz[0],
    cam.eye[1] + xe * cam.bx[1] + ye * cam.by[1] + ze * cam.bz[1],
    cam.eye[2] + xe * cam.bx[2] + ye * cam.by[2] + ze * cam.bz[2],
  ];
}

// 指定像素处参与计数的体积三角形列表(点击检查用)
function contributionsAt(result, px, py) {
  const { W, H, depth } = result;
  const d = depth[py * W + px];
  const out = [];
  result.vols.forEach((v, vid) => {
    if (!v.clip || v.clip.length < 3) return;
    const ndc = v.clip.map(p => [p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
    for (let k = 1; k < ndc.length - 1; k++) {
      const r = triAt(ndc[0], ndc[k], ndc[k + 1], px, py, W, H);
      if (r) {
        const fail = r.z > d;
        out.push({
          volId: vid, caster: v.caster, type: v.type, src: v.src,
          front: r.front, z: r.z, depth: d, fail,
          delta: fail ? (r.front ? -1 : 1) : 0,
        });
      }
    }
  });
  return out;
}

// ---------------- 独立遮挡射线参考 ----------------
function rayTri(o, d, a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = dot(e2, q) * inv;
  return { t, u, v };
}
// 从 P 到光源 L 的线段与所有 caster 三角形的交点;命中边/角的退化情况微扰光源重试
function rayCast(P, L, casters) {
  let Ll = L;
  for (let attempt = 0; attempt < 5; attempt++) {
    const hits = [];
    let degenerate = false;
    const d = sub(Ll, P);
    casters.forEach((c, ci) => c.f.forEach((tri, ti) => {
      const r = rayTri(P, d, c.v[tri[0]], c.v[tri[1]], c.v[tri[2]]);
      if (r && r.t > 1e-6 && r.t < 1 - 1e-6) {
        hits.push({ caster: ci, tri: ti, t: r.t });
        if (Math.abs(r.u) < 1e-7 || Math.abs(r.v) < 1e-7 || Math.abs(r.u + r.v - 1) < 1e-7)
          degenerate = true;
      }
    }));
    if (!degenerate) return { hits: hits.sort((x, y) => x.t - y.t), degenerate: false };
    Ll = [L[0] + 1.1e-6 * (attempt + 1), L[1] - 0.7e-6 * (attempt + 1), L[2] + 1.3e-6 * (attempt + 1)];
  }
  return { hits: [], degenerate: true };
}
// 每个 caster 是否遮挡 P(用于参考掩码与期望计数)
function occlusionPerCaster(P, L, casters) {
  const { hits } = rayCast(P, L, casters);
  const occ = casters.map(() => false);
  hits.forEach(h => { occ[h.caster] = true; });
  return { occ, hits };
}

const API = {
  sub, dot, cross, norm, mul4, xform, lookAt, perspInf, makeCam,
  buildVolumes, clipPoly, rasterClipPoly, triAt, render, worldPos,
  contributionsAt, rayCast, occlusionPerCaster,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else global.ZFail = API;
})(typeof window !== 'undefined' ? window : globalThis);
