/* engine.js — 保守体素化引擎（SPEC §3-§6），纯手写，无体素化/三维库依赖。 */
'use strict';
window.VF = window.VF || {};

const SAT_EPS = 1e-9;
const TIE_EPS = 1e-11;
const CLASS = { UNKNOWN: 0, SURFACE: 1, EXTERIOR: 2, SOLID: 3, CAVITY: 4 };
VF.CLASS = CLASS;
VF.CLASS_NAME = ['UNKNOWN', 'SURFACE', 'EXTERIOR', 'SOLID_INTERIOR', 'EMPTY_CAVITY'];

/* ---------- 构建状态：预计算每个三角形的 13 个分离轴 ---------- */
VF.createEngineState = (data) => {
  const { origin, dims, spacing } = data.grid;
  const [Nx, Ny, Nz] = dims;
  const total = Nx * Ny * Nz;
  const Sxy = Nx * Ny;
  const h = spacing.map((s) => s / 2);

  const tris = data.triangles.map((t) => {
    const ia = t.indices[0], ib = t.indices[1], ic = t.indices[2];
    const v0 = data.vertices[ia].slice();
    const v1 = data.vertices[ib].slice();
    const v2 = data.vertices[ic].slice();
    const e0 = VF.sub3(v1, v0);
    const e1 = VF.sub3(v2, v1);
    const e2 = VF.sub3(v0, v2);
    const edges = [e0, e1, e2];
    const cr = VF.cross3(e0, VF.sub3(v2, v0));
    const crl = Math.hypot(cr[0], cr[1], cr[2]);
    const n = [cr[0] / crl, cr[1] / crl, cr[2] / crl];

    // 主法线轴 u* = argmax |n_u| h_u，并列按 x,y,z
    let uStar = 0;
    for (let u = 1; u < 3; u++) {
      if (Math.abs(n[u]) * h[u] > Math.abs(n[uStar]) * h[uStar]) uStar = u;
    }

    // 13 个轴槽位：0..2 坐标轴；3 法线；4..12 边叉积（4 + m*3 + u）
    const axes = new Array(13);
    const putAxis = (slot, a) => {
      const nl = Math.hypot(a[0], a[1], a[2]);
      const r26 = Math.abs(a[0]) * h[0] + Math.abs(a[1]) * h[1] + Math.abs(a[2]) * h[2];
      axes[slot] = {
        a,
        skip: false,
        av: [VF.dot3(a, v0), VF.dot3(a, v1), VF.dot3(a, v2)],
        r26,
        r6: r26, // 默认与厚壳一致，下面按需覆盖
      };
      return nl;
    };
    putAxis(0, [1, 0, 0]);
    putAxis(1, [0, 1, 0]);
    putAxis(2, [0, 0, 1]);
    // 法线轴（槽 3）：厚半径 Σ|n|h，薄半径 max|n|h
    {
      const a = n;
      const r26 = Math.abs(a[0]) * h[0] + Math.abs(a[1]) * h[1] + Math.abs(a[2]) * h[2];
      const r6 = Math.max(Math.abs(a[0]) * h[0], Math.abs(a[1]) * h[1], Math.abs(a[2]) * h[2]);
      axes[3] = {
        a,
        skip: false,
        av: [VF.dot3(a, v0), VF.dot3(a, v1), VF.dot3(a, v2)],
        r26,
        r6,
      };
    }
    const basis = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
    ];
    for (let m = 0; m < 3; m++) {
      const e = edges[m];
      for (let u = 0; u < 3; u++) {
        const a = VF.cross3(basis[u], e); // û × e_m
        const slot = 4 + m * 3 + u;
        const nl = Math.hypot(a[0], a[1], a[2]);
        if (nl <= 1e-10) {
          axes[slot] = { a, skip: true, av: [0, 0, 0], r26: 0, r6: 0 };
          continue;
        }
        putAxis(slot, a);
        if (u === uStar) {
          axes[slot].r6 = Math.max(
            Math.abs(a[0]) * h[0], Math.abs(a[1]) * h[1], Math.abs(a[2]) * h[2]);
        }
      }
    }

    const pmin = [
      Math.min(v0[0], v1[0], v2[0]),
      Math.min(v0[1], v1[1], v2[1]),
      Math.min(v0[2], v1[2], v2[2]),
    ];
    const pmax = [
      Math.max(v0[0], v1[0], v2[0]),
      Math.max(v0[1], v1[1], v2[1]),
      Math.max(v0[2], v1[2], v2[2]),
    ];

    return {
      id: t.id, ia, ib, ic, material: t.material, group: t.group,
      enabled: t.enabled === true,
      v0, v1, v2, n, axes, pmin, pmax,
    };
  });

  const Bx = Math.ceil(Nx / 8), By = Math.ceil(Ny / 8), Bz = Math.ceil(Nz / 8);
  const st = {
    meshId: data.meshId || '',
    origin: origin.slice(), dims: [Nx, Ny, Nz], spacing: spacing.slice(), h,
    mode: data.separatingMode,
    flood: data.floodConnectivity,
    verts: data.vertices.map((v) => v.slice()),
    tris,
    Nx, Ny, Nz, total, Sxy,
    Bx, By, Bz, brickTotal: Bx * By * Bz,
    classification: new Uint8Array(total),
    surfMat: new Int8Array(total).fill(-1),
    surfTri: new Int32Array(total).fill(-1),
    surfD2: new Float64Array(total).fill(Infinity),
    boxEdits: [],           // {type:'BOX_CARVE'|'BOX_FILL', b:[i0,i1,j0,j1,k0,k1], material?}
    history: [],
    redo: [],
    stats: null,
    leaks: [],
    components: [],
    timings: {},
    _queue: new Int32Array(total),
  };
  return st;
};

const linIdx = (st, i, j, k) => i + j * st.Nx + k * st.Sxy;

/* 三角形物理 AABB 覆盖到的体素候选范围（含 h+ε 余量，保证闭合盒判定不漏） */
function candidateRange(st, tri) {
  const r = [0, 0, 0];
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let u = 0; u < 3; u++) {
    lo[u] = Math.floor((tri.pmin[u] - st.h[u] - SAT_EPS - st.origin[u]) / st.spacing[u]);
    hi[u] = Math.floor((tri.pmax[u] + st.h[u] + SAT_EPS - st.origin[u]) / st.spacing[u]);
    lo[u] = Math.max(0, lo[u]);
    hi[u] = Math.min(st.dims[u] - 1, hi[u]);
  }
  return lo.concat(hi); // [i0,j0,k0,i1,j1,k1]
}

/* 标量内联版点-闭合三角形距离²（热点路径，避免数组分配）。Ericson 5.1.5。 */
function pointTriDistSqFast(px, py, pz, a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - b[0], bpy = py - b[1], bpz = pz - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - c[0], cpy = py - c[1], cpz = pz - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const bcx = c[0] - b[0], bcy = c[1] - b[1], bcz = c[2] - b[2];
    const dx = bpx - w * bcx, dy = bpy - w * bcy, dz = bpz - w * bcz;
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const fx = a[0] + abx * v + acx * w - px;
  const fy = a[1] + aby * v + acy * w - py;
  const fz = a[2] + abz * v + acz * w - pz;
  return fx * fx + fy * fy + fz * fz;
}

/* 单三角形 vs 单体素的 13 轴 SAT（SPEC §3）。center 为体素物理中心。
 * 轴顺序：平面法线（剔除率最高）→ 9 边叉轴 → 3 坐标轴（候选 AABB 已基本保证）。 */
function satHit(st, tri, cx, cy, cz) {
  const thin = st.mode === '6-separating';
  const axes = tri.axes;
  for (const s of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 1, 2]) {
    const ax = axes[s];
    if (ax.skip) continue;
    const dc = ax.a[0] * cx + ax.a[1] * cy + ax.a[2] * cz;
    const q0 = ax.av[0] - dc, q1 = ax.av[1] - dc, q2 = ax.av[2] - dc;
    const mn = q0 < q1 ? (q0 < q2 ? q0 : q2) : (q1 < q2 ? q1 : q2);
    const mx = q0 > q1 ? (q0 > q2 ? q0 : q2) : (q1 > q2 ? q1 : q2);
    const r = thin ? ax.r6 : ax.r26;
    if (!(mn <= r + SAT_EPS && mx >= -r - SAT_EPS)) return false;
  }
  return true;
}

/* 归属比较：d² 最小 → 材质号小 → 面 id 小（SPEC §4）。返回 true 表示新候选更优。 */
function betterCandidate(st, idx, d2, mat, id) {
  const cur = st.surfTri[idx];
  if (cur === -1) return true;
  const oldD2 = st.surfD2[idx];
  if (d2 < oldD2 - TIE_EPS) return true;
  if (Math.abs(d2 - oldD2) <= TIE_EPS) {
    const oldMat = st.surfMat[idx];
    if (mat < oldMat) return true;
    if (mat === oldMat && id < cur) return true;
  }
  return false;
}

/* 表面体素化。brickMask 为 null 时全量重算，否则只重算脏 8³ 分块。 */
function voxelize(st, brickMask) {
  const { Nx, Ny, Nz, Sxy } = st;
  const full = brickMask === null;
  if (full) {
    st.classification.fill(CLASS.UNKNOWN);
    st.surfMat.fill(-1);
    st.surfTri.fill(-1);
    st.surfD2.fill(Infinity);
  } else {
    for (let bz = 0; bz < st.Bz; bz++) {
      for (let by = 0; by < st.By; by++) {
        for (let bx = 0; bx < st.Bx; bx++) {
          if (!brickMask[bx + by * st.Bx + bz * st.Bx * st.By]) continue;
          const i0 = bx * 8, j0 = by * 8, k0 = bz * 8;
          const i1 = Math.min(Nx, i0 + 8), j1 = Math.min(Ny, j0 + 8), k1 = Math.min(Nz, k0 + 8);
          for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
            const idx = i + j * Nx + k * Sxy;
            st.classification[idx] = CLASS.UNKNOWN;
            st.surfMat[idx] = -1;
            st.surfTri[idx] = -1;
            st.surfD2[idx] = Infinity;
          }
        }
      }
    }
  }

  for (let t = 0; t < st.tris.length; t++) {
    const tri = st.tris[t];
    if (!tri.enabled) continue;
    const [i0, j0, k0, i1, j1, k1] = candidateRange(st, tri);
    if (i1 < i0 || j1 < j0 || k1 < k0) continue;
    const { v0, v1, v2 } = tri;
    for (let k = k0; k <= k1; k++) {
      const cz = st.origin[2] + (k + 0.5) * st.spacing[2];
      const bz = k >> 3;
      for (let j = j0; j <= j1; j++) {
        const cy = st.origin[1] + (j + 0.5) * st.spacing[1];
        const by = j >> 3;
        const base = j * Nx + k * Sxy;
        const bbase = (by * st.Bx + bz * st.Bx * st.By);
        for (let i = i0; i <= i1; i++) {
          const idx = i + base;
          if (!full && !brickMask[(i >> 3) + bbase]) continue;
          const cx = st.origin[0] + (i + 0.5) * st.spacing[0];
          if (!satHit(st, tri, cx, cy, cz)) continue;
          const d2 = pointTriDistSqFast(cx, cy, cz, v0, v1, v2);
          if (betterCandidate(st, idx, d2, tri.material, tri.id)) {
            st.surfD2[idx] = d2;
            st.surfMat[idx] = tri.material;
            st.surfTri[idx] = tri.id;
            st.classification[idx] = CLASS.SURFACE;
          }
        }
      }
    }
  }
}

/* 重放框选编辑层（CARVE 强制空气；FILL 强制指定材质表面，sourceTriangleId=-1）。 */
function applyBoxEdits(st) {
  const { Nx, Sxy } = st;
  for (const e of st.boxEdits) {
    const [i0, i1, j0, j1, k0, k1] = e.b;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const idx = i + j * Nx + k * Sxy;
      if (e.type === 'BOX_CARVE') {
        st.classification[idx] = CLASS.UNKNOWN;
        st.surfMat[idx] = -1;
        st.surfTri[idx] = -1;
        st.surfD2[idx] = Infinity;
      } else {
        st.classification[idx] = CLASS.SURFACE;
        st.surfMat[idx] = e.material;
        st.surfTri[idx] = -1;
        st.surfD2[idx] = Infinity;
      }
    }
  }
}

/* 通用漫水：从外边界非表面体素出发，conn=6|26，返回 Uint8 可达掩码。 */
function floodFromBoundary(st, conn) {
  const { Nx, Ny, Nz, Sxy, total } = st;
  const reach = new Uint8Array(total);
  const q = st._queue;
  let qh = 0, qt = 0;
  const pushSeed = (idx) => {
    if (st.classification[idx] !== CLASS.SURFACE && !reach[idx]) {
      reach[idx] = 1; q[qt++] = idx;
    }
  };
  for (let i = 0; i < Nx; i++) for (let j = 0; j < Ny; j++) {
    pushSeed(i + j * Nx);                       // k=0
    pushSeed(i + j * Nx + (Nz - 1) * Sxy);     // k=Nz-1
  }
  for (let i = 0; i < Nx; i++) for (let k = 0; k < Nz; k++) {
    pushSeed(i + k * Sxy);                     // j=0
    pushSeed(i + (Ny - 1) * Nx + k * Sxy);     // j=Ny-1
  }
  for (let j = 0; j < Ny; j++) for (let k = 0; k < Nz; k++) {
    pushSeed(j * Nx + k * Sxy);                // i=0
    pushSeed((Nx - 1) + j * Nx + k * Sxy);     // i=Nx-1
  }

  const d6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (qh < qt) {
    const idx = q[qh++];
    const i = idx % Nx;
    const j = ((idx / Nx) | 0) % Ny;
    const k = (idx / Sxy) | 0;
    if (conn === 6) {
      for (let d = 0; d < 6; d++) {
        const ni = i + d6[d][0], nj = j + d6[d][1], nk = k + d6[d][2];
        if (ni < 0 || ni >= Nx || nj < 0 || nj >= Ny || nk < 0 || nk >= Nz) continue;
        const nid = ni + nj * Nx + nk * Sxy;
        if (!reach[nid] && st.classification[nid] !== CLASS.SURFACE) {
          reach[nid] = 1; q[qt++] = nid;
        }
      }
    } else {
      for (let dz = -1; dz <= 1; dz++) {
        const nk = k + dz; if (nk < 0 || nk >= Nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const nj = j + dy; if (nj < 0 || nj >= Ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const ni = i + dx; if (ni < 0 || ni >= Nx) continue;
            const nid = ni + nj * Nx + nk * Sxy;
            if (!reach[nid] && st.classification[nid] !== CLASS.SURFACE) {
              reach[nid] = 1; q[qt++] = nid;
            }
          }
        }
      }
    }
  }
  return reach;
}

/* 对角漏孔定位（SPEC §5）：仅 6 分离 + 26 连通漫水时计算。 */
function findDiagonalLeaks(st, ext6) {
  const { Nx, Ny, Nz, Sxy } = st;
  const pairs = [];
  const d6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  // 子盒内 6 连通 BFS：u、v 之间是否存在完全由非表面体素构成的桥接路径
  const boxPathExists = (ui, uj, uk, vi, vj, vk) => {
    const lo = [Math.min(ui, vi), Math.min(uj, vj), Math.min(uk, vk)];
    const hi = [Math.max(ui, vi), Math.max(uj, vj), Math.max(uk, vk)];
    const start = ui + uj * Nx + uk * Sxy;
    const target = vi + vj * Nx + vk * Sxy;
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const idx = q.pop();
      if (idx === target) return true;
      const i = idx % Nx;
      const j = ((idx / Nx) | 0) % Ny;
      const k = (idx / Sxy) | 0;
      for (let d = 0; d < 6; d++) {
        const ni = i + d6[d][0], nj = j + d6[d][1], nk = k + d6[d][2];
        if (ni < lo[0] || ni > hi[0] || nj < lo[1] || nj > hi[1] || nk < lo[2] || nk > hi[2]) continue;
        const nid = ni + nj * Nx + nk * Sxy;
        if (seen.has(nid) || st.classification[nid] === CLASS.SURFACE) continue;
        seen.add(nid); q.push(nid);
      }
    }
    return false;
  };

  for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) for (let i = 0; i < Nx; i++) {
    const uidx = i + j * Nx + k * Sxy;
    if (!ext6[uidx]) continue; // u ∈ E6
    for (let dz = -1; dz <= 1; dz++) {
      const vk = k + dz; if (vk < 0 || vk >= Nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const vj = j + dy; if (vj < 0 || vj >= Ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const man = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (man < 2) continue; // 只要对角邻居（曼哈顿距 2 或 3）
          const vi = i + dx; if (vi < 0 || vi >= Nx) continue;
          const vidx = vi + vj * Nx + vk * Sxy;
          if (ext6[vidx] || st.classification[vidx] === CLASS.SURFACE) continue; // v ∈ I6
          if (boxPathExists(i, j, k, vi, vj, vk)) continue; // 桥接格未被 SURFACE 堵死
          pairs.push({
            fromExterior: [i, j, k],
            toEnclosed: [vi, vj, vk],
          });
        }
      }
    }
  }
  // 线性扫描顺序即 fromExterior 字典序；同 u 的邻域遍历也是 v 的字典序
  return pairs;
}

/* 漫水 + 封闭分量绕数分类（SPEC §5）。 */
function classify(st) {
  const { Nx, Ny, Nz, Sxy, total } = st;
  const t0 = performance.now();
  const ext = floodFromBoundary(st, st.flood);
  for (let idx = 0; idx < total; idx++) {
    if (st.classification[idx] === CLASS.SURFACE) continue;
    st.classification[idx] = ext[idx] ? CLASS.EXTERIOR : CLASS.UNKNOWN;
  }

  // 对角漏孔：6 分离薄壳 + 26 连通漫水时，对照 6 连通漫水结果
  st.leaks = [];
  let ext6 = null;
  if (st.mode === '6-separating' && st.flood === 26) {
    ext6 = floodFromBoundary(st, 6);
    st.leaks = findDiagonalLeaks(st, ext6);
  }

  // 封闭分量：一律按 6 连通划分
  const d6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const seen = new Uint8Array(total);
  const components = [];
  // 预收集启用三角形的物理顶点，绕数内联计算避免数组分配
  const eTris = st.tris.filter((t) => t.enabled);
  const eCoords = eTris.map((t) => [t.v0, t.v1, t.v2]);
  const q = st._queue;
  let compId = 0;
  for (let start = 0; start < total; start++) {
    if (seen[start] || st.classification[start] !== CLASS.UNKNOWN) continue;
    let qh = 0, qt = 0;
    q[qt++] = start; seen[start] = 1;
    let minIdx = start, count = 0;
    while (qh < qt) {
      const idx = q[qh++];
      count++;
      if (idx < minIdx) minIdx = idx;
      const i = idx % Nx;
      const j = ((idx / Nx) | 0) % Ny;
      const k = (idx / Sxy) | 0;
      for (let d = 0; d < 6; d++) {
        const ni = i + d6[d][0], nj = j + d6[d][1], nk = k + d6[d][2];
        if (ni < 0 || ni >= Nx || nj < 0 || nj >= Ny || nk < 0 || nk >= Nz) continue;
        const nid = ni + nj * Nx + nk * Sxy;
        if (!seen[nid] && st.classification[nid] === CLASS.UNKNOWN) {
          seen[nid] = 1; q[qt++] = nid;
        }
      }
    }
    const ri = minIdx % Nx;
    const rj = ((minIdx / Nx) | 0) % Ny;
    const rk = (minIdx / Sxy) | 0;
    const c = [
      st.origin[0] + (ri + 0.5) * st.spacing[0],
      st.origin[1] + (rj + 0.5) * st.spacing[1],
      st.origin[2] + (rk + 0.5) * st.spacing[2],
    ];
    // Van Oosterom & Strackee 内联求和
    const [px, py, pz] = c;
    let omega = 0;
    for (let tt = 0; tt < eTris.length; tt++) {
      const [A, B, D] = eCoords[tt];
      const ax = A[0] - px, ay = A[1] - py, az = A[2] - pz;
      const bx = B[0] - px, by = B[1] - py, bz = B[2] - pz;
      const dx = D[0] - px, dy = D[1] - py, dz = D[2] - pz;
      const al = Math.sqrt(ax * ax + ay * ay + az * az);
      const bl = Math.sqrt(bx * bx + by * by + bz * bz);
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const num = ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx);
      const den = al * bl * dl
        + (ax * bx + ay * by + az * bz) * dl
        + (bx * dx + by * dy + bz * dz) * al
        + (dx * ax + dy * ay + dz * az) * bl;
      omega += 2 * Math.atan2(num, den);
    }
    const W = omega / (4 * Math.PI);
    const type = Math.abs(W) >= 0.5 ? CLASS.SOLID : CLASS.CAVITY;
    for (let p = 0; p < qt; p++) st.classification[q[p]] = type;
    components.push({
      componentId: compId++,
      type: type === CLASS.SOLID ? 'SOLID_INTERIOR' : 'EMPTY_CAVITY',
      voxelCount: count,
      representativeVoxel: [ri, rj, rk],
      windingNumber: W,
    });
  }
  components.sort((a, b) => {
    const va = a.representativeVoxel, vb = b.representativeVoxel;
    for (let u = 0; u < 3; u++) if (va[u] !== vb[u]) return va[u] - vb[u];
    return 0;
  });
  components.forEach((c, i) => { c.componentId = i; });
  st.components = components;
  st.timings.classifyMs = performance.now() - t0;
}

function bricksOfBox(st, i0, i1, j0, j1, k0, k1) {
  const mask = new Uint8Array(st.brickTotal);
  const bx0 = Math.max(0, i0 >> 3), bx1 = Math.min(st.Bx - 1, i1 >> 3);
  const by0 = Math.max(0, j0 >> 3), by1 = Math.min(st.By - 1, j1 >> 3);
  const bz0 = Math.max(0, k0 >> 3), bz1 = Math.min(st.Bz - 1, k1 >> 3);
  for (let bz = bz0; bz <= bz1; bz++)
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        mask[bx + by * st.Bx + bz * st.Bx * st.By] = 1;
  return mask;
}

function unionMask(st, masks) {
  const m = new Uint8Array(st.brickTotal);
  for (const mm of masks) for (let i = 0; i < m.length; i++) m[i] |= mm[i];
  return m;
}

/* 主管线：增量（脏分块）或全量。 */
function rebuild(st, brickMask) {
  const t0 = performance.now();
  voxelize(st, brickMask);
  applyBoxEdits(st);
  st.timings.voxelizeMs = performance.now() - t0;
  classify(st);
  st.timings.totalMs = performance.now() - t0;
  st.stats = VF.computeStats(st);
}

VF.fullRebuild = (st) => rebuild(st, null);

VF.computeStats = (st) => {
  const counts = { SURFACE: 0, EXTERIOR: 0, SOLID_INTERIOR: 0, EMPTY_CAVITY: 0 };
  const hist = {};
  for (let idx = 0; idx < st.total; idx++) {
    const c = st.classification[idx];
    if (c === CLASS.SURFACE) {
      counts.SURFACE++;
      const m = st.surfMat[idx];
      if (m >= 0) hist[String(m)] = (hist[String(m)] || 0) + 1;
    } else if (c === CLASS.EXTERIOR) counts.EXTERIOR++;
    else if (c === CLASS.SOLID) counts.SOLID_INTERIOR++;
    else if (c === CLASS.CAVITY) counts.EMPTY_CAVITY++;
  }
  return { counts, materialHistogram: hist };
};

/* ---------- 编辑操作（SPEC §6），均带撤销/重做快照 ---------- */
function snapshot(st, mask, label) {
  return {
    label,
    mask,
    enabled: Uint8Array.from(st.tris.map((t) => t.enabled ? 1 : 0)),
    boxEdits: st.boxEdits.map((e) => ({ type: e.type, b: e.b.slice(), material: e.material })),
  };
}

function restoreSnapshot(st, snap) {
  st.tris.forEach((t, i) => { t.enabled = snap.enabled[i] === 1; });
  st.boxEdits = snap.boxEdits.map((e) => ({ type: e.type, b: e.b.slice(), material: e.material }));
  rebuild(st, snap.mask);
}

VF.toggleGroup = (st, group) => {
  const members = st.tris.filter((t) => t.group === group);
  if (members.length === 0) return { ok: false, error: `不存在分组 ${group}` };
  const masks = [];
  for (const t of members) {
    const [i0, j0, k0, i1, j1, k1] = candidateRange(st, t);
    if (i1 >= i0 && j1 >= j0 && k1 >= k0) masks.push(bricksOfBox(st, i0, i1, j0, j1, k0, k1));
  }
  const mask = masks.length ? unionMask(st, masks) : new Uint8Array(st.brickTotal);
  st.history.push(snapshot(st, mask, `启停分组 ${group}`));
  st.redo.length = 0;
  const next = !members[0].enabled;
  for (const t of members) t.enabled = next;
  rebuild(st, mask);
  return { ok: true, enabled: next };
};

VF.boxEdit = (st, type, b, material) => {
  const [i0, i1, j0, j1, k0, k1] = b;
  const inRange = [i0, i1, j0, j1, k0, k1].every((v) => Number.isInteger(v));
  if (!inRange || i0 < 0 || j0 < 0 || k0 < 0 ||
      i1 >= st.Nx || j1 >= st.Ny || k1 >= st.Nz ||
      i1 < i0 || j1 < j0 || k1 < k0) {
    return { ok: false, error: `框选范围越界或非法：[${b.join(', ')}]，网格 dims=[${st.dims.join(', ')}]` };
  }
  if (type === 'BOX_FILL') {
    if (!Number.isInteger(material) || material < 1 || material > 16) {
      return { ok: false, error: `BOX_FILL 的 material 必须是 [1,16] 整数，实际 ${material}` };
    }
  } else if (type !== 'BOX_CARVE') {
    return { ok: false, error: `未知编辑类型 ${type}` };
  }
  const mask = bricksOfBox(st, i0, i1, j0, j1, k0, k1);
  st.history.push(snapshot(st, mask, type === 'BOX_CARVE' ? '框选挖空' : '框选填充'));
  st.redo.length = 0;
  st.boxEdits.push({ type, b: b.slice(), material: material || null });
  rebuild(st, mask);
  return { ok: true };
};

VF.undo = (st) => {
  const snap = st.history.pop();
  if (!snap) return { ok: false, error: '没有可撤销的操作' };
  st.redo.push(snapshot(st, snap.mask, snap.label));
  restoreSnapshot(st, snap);
  return { ok: true, label: snap.label };
};

VF.redo = (st) => {
  const snap = st.redo.pop();
  if (!snap) return { ok: false, error: '没有可重做的操作' };
  st.history.push(snapshot(st, snap.mask, snap.label));
  restoreSnapshot(st, snap);
  return { ok: true, label: snap.label };
};

/* 增量结果 vs 全量重算一致性自检（编辑正确性保障）。 */
VF.verifyIncremental = (st) => {
  const a = {
    cls: st.classification.slice(),
    mat: st.surfMat.slice(),
    tri: st.surfTri.slice(),
  };
  VF.fullRebuild(st);
  let diffs = 0;
  const first = [];
  for (let idx = 0; idx < st.total; idx++) {
    if (st.classification[idx] !== a.cls[idx] ||
        st.surfMat[idx] !== a.mat[idx] ||
        st.surfTri[idx] !== a.tri[idx]) {
      diffs++;
      if (first.length < 5) {
        const i = idx % st.Nx;
        const j = ((idx / st.Nx) | 0) % st.Ny;
        const k = (idx / st.Sxy) | 0;
        first.push([i, j, k]);
      }
    }
  }
  return { ok: diffs === 0, diffs, first };
};

/* SPEC §7 导出。 */
VF.exportJSON = (st) => ({
  meshId: st.meshId,
  separatingMode: st.mode,
  floodConnectivity: st.flood,
  dims: st.dims.slice(),
  spacing: st.spacing.slice(),
  counts: st.stats.counts,
  materialHistogram: st.stats.materialHistogram,
  diagonalLeaks: st.leaks.map((p) => ({
    fromExterior: p.fromExterior.slice(),
    toEnclosed: p.toEnclosed.slice(),
  })),
  enclosedComponents: st.components.map((c) => ({
    componentId: c.componentId,
    type: c.type,
    voxelCount: c.voxelCount,
    representativeVoxel: c.representativeVoxel.slice(),
    windingNumber: c.windingNumber,
  })),
});
