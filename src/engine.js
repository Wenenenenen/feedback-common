/*
 * continuous-skin-envelope 核心引擎
 * 纯计算模块，无 DOM 依赖，可在 Node / Worker / 页面中直接引用。
 *
 * 规范摘要（见 samples/continuous-envelope.json 的 format 字段）：
 *  - bones: {parent: 零基编号|null, axis: x/y/z 可带负号}，无循环
 *  - keys: 严格递增 t；pose 按骨顺序 [tx,ty,tz,turns]；分量各自线性插值
 *  - turns 以"圈"为单位（一圈 360°，右手为正），按原值插值，不折最短转角
 *  - 局部变换先旋再平移，从子到父串接
 *  - vertices: 每项至多四条 [骨号, 整数权重, lx,ly,lz]，权重非负、每项和 65536
 *  - 同一时刻对各骨变换点作加权和（多骨权重在同一时刻合成）
 *  - triangles 可选，仅用于显示
 */

'use strict';

/* ------------------------------------------------------------------ */
/* 常量与小工具                                                        */
/* ------------------------------------------------------------------ */

const MAX_BONES = 64;
const MAX_VERTS = 8192;
const MAX_INTERVALS = 128;
const WEIGHT_SUM = 65536;
const ABS_COORD_MAX = 100;
const NUM_TOL = 1e-8;           // 规范要求的数值比较容差
const LEAF_GAP = 9e-4;          // 证书间隙小于此值即停止细分（< 0.01 要求）
const MARGIN = 1e-3;            // 盒面外扩量，确保包住真实极值
const MAX_DEPTH = 64;

const AXIS_INFO = {
  x: [0, 1], y: [1, 1], z: [2, 1],
  '-x': [0, -1], '-y': [1, -1], '-z': [2, -1],
};

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* ------------------------------------------------------------------ */
/* 1. 导入与校验：错误时返回 {error}，调用方保证不覆盖旧结果            */
/* ------------------------------------------------------------------ */

function validateModel(raw) {
  const fail = (msg) => ({ error: msg });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('根节点必须是对象');
  }
  const bones = raw.bones;
  const keys = raw.keys;
  const vertices = raw.vertices;
  if (!Array.isArray(bones)) return fail('缺少 bones 数组');
  if (!Array.isArray(keys)) return fail('缺少 keys 数组');
  if (!Array.isArray(vertices)) return fail('缺少 vertices 数组');

  if (bones.length === 0) return fail('bones 不能为空');
  if (bones.length > MAX_BONES) return fail(`骨骼数超过上限 ${MAX_BONES}`);
  if (vertices.length > MAX_VERTS) return fail(`顶点数超过上限 ${MAX_VERTS}`);
  if (keys.length < 2) return fail('关键帧至少需要 2 帧');
  if (keys.length - 1 > MAX_INTERVALS) return fail(`关键帧区间数超过上限 ${MAX_INTERVALS}`);

  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (b === null || typeof b !== 'object') return fail(`骨骼 ${i} 必须是对象`);
    if (b.parent !== null && (!Number.isInteger(b.parent) || b.parent < 0 || b.parent >= bones.length)) {
      return fail(`骨骼 ${i} 的 parent 非法`);
    }
    if (b.parent === i) return fail(`骨骼 ${i} 不能以自身为父`);
    if (!Object.prototype.hasOwnProperty.call(AXIS_INFO, b.axis)) {
      return fail(`骨骼 ${i} 的 axis 非法（允许 x/y/z 及其负号形式）`);
    }
  }
  // 循环检测 + 拓扑序
  const color = new Array(bones.length).fill(0);
  const topo = [];
  const dfs = (i) => {
    if (color[i] === 1) return false;
    if (color[i] === 2) return true;
    color[i] = 1;
    if (bones[i].parent !== null && !dfs(bones[i].parent)) return false;
    color[i] = 2;
    topo.push(i);
    return true;
  };
  for (let i = 0; i < bones.length; i++) {
    if (!dfs(i)) return fail('骨骼层级存在循环');
  }

  let prevT = -Infinity;
  for (let k = 0; k < keys.length; k++) {
    const f = keys[k];
    if (f === null || typeof f !== 'object') return fail(`关键帧 ${k} 必须是对象`);
    if (!isFiniteNum(f.t)) return fail(`关键帧 ${k} 的 t 非法`);
    if (!(f.t > prevT)) return fail(`关键帧 ${k} 的 t 必须严格递增`);
    prevT = f.t;
    if (!Array.isArray(f.pose) || f.pose.length !== bones.length) {
      return fail(`关键帧 ${k} 的 pose 数量必须等于骨骼数`);
    }
    for (let b = 0; b < bones.length; b++) {
      const p = f.pose[b];
      if (!Array.isArray(p) || p.length !== 4) return fail(`关键帧 ${k} 骨骼 ${b} 的 pose 必须是 4 个数`);
      for (let c = 0; c < 4; c++) {
        if (!isFiniteNum(p[c])) return fail(`关键帧 ${k} 骨骼 ${b} 的 pose 含非数值`);
      }
      for (let c = 0; c < 3; c++) {
        if (Math.abs(p[c]) > ABS_COORD_MAX + NUM_TOL) {
          return fail(`关键帧 ${k} 骨骼 ${b} 的平移绝对值超过 100`);
        }
      }
    }
  }

  // 相邻角差不超过 2 圈（按原写值比较，不折角）
  for (let k = 1; k < keys.length; k++) {
    for (let b = 0; b < bones.length; b++) {
      const d = keys[k].pose[b][3] - keys[k - 1].pose[b][3];
      if (Math.abs(d) > 2 + NUM_TOL) {
        return fail(`关键帧 ${k} 骨骼 ${b} 的相邻角差绝对值超过 2 圈`);
      }
    }
  }

  for (let i = 0; i < vertices.length; i++) {
    const infl = vertices[i];
    if (!Array.isArray(infl) || infl.length === 0 || infl.length > 4) {
      return fail(`顶点 ${i} 必须含 1~4 条权重`);
    }
    let sum = 0;
    const seen = new Set();
    for (let j = 0; j < infl.length; j++) {
      const e = infl[j];
      if (!Array.isArray(e) || e.length !== 5) return fail(`顶点 ${i} 权重 ${j} 必须是 5 个数`);
      const [bi, w, lx, ly, lz] = e;
      if (!Number.isInteger(bi) || bi < 0 || bi >= bones.length) return fail(`顶点 ${i} 权重 ${j} 骨号非法`);
      if (seen.has(bi)) return fail(`顶点 ${i} 对同一骨骼 ${bi} 重复绑定`);
      seen.add(bi);
      if (!Number.isInteger(w) || w < 0 || w > WEIGHT_SUM) return fail(`顶点 ${i} 权重 ${j} 非法`);
      sum += w;
      for (const c of [lx, ly, lz]) {
        if (!isFiniteNum(c) || Math.abs(c) > ABS_COORD_MAX + NUM_TOL) {
          return fail(`顶点 ${i} 的局部坐标非法或绝对值超过 100`);
        }
      }
    }
    if (sum !== WEIGHT_SUM) return fail(`顶点 ${i} 权重和必须等于 65536（实际 ${sum}）`);
  }

  let triangles = null;
  if (raw.triangles !== undefined && raw.triangles !== null) {
    if (!Array.isArray(raw.triangles)) return fail('triangles 必须是数组');
    for (let i = 0; i < raw.triangles.length; i++) {
      const tri = raw.triangles[i];
      if (!Array.isArray(tri) || tri.length !== 3) return fail(`三角形 ${i} 必须含 3 个顶点号`);
      for (const vi of tri) {
        if (!Number.isInteger(vi) || vi < 0 || vi >= vertices.length) {
          return fail(`三角形 ${i} 含非法顶点号`);
        }
      }
    }
    triangles = raw.triangles.map((t) => t.slice());
  }

  const normBones = bones.map((b) => {
    const [axisIdx, axisSign] = AXIS_INFO[b.axis];
    return { parent: b.parent, axis: b.axis, axisIdx, axisSign };
  });
  const normKeys = keys.map((f) => ({ t: f.t, pose: f.pose.map((p) => p.slice()) }));
  const normVerts = vertices.map((infl) =>
    infl.map((e) => ({ bone: e[0], weight: e[1] / WEIGHT_SUM, local: [e[2], e[3], e[4]] }))
  );

  return {
    model: {
      bones: normBones,
      keys: normKeys,
      vertices: normVerts,
      triangles,
      topo,
      t0: normKeys[0].t,
      t1: normKeys[normKeys.length - 1].t,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. 标量姿态：按原写圈数线性插值（不折最短转角），父子骨依次变换       */
/* ------------------------------------------------------------------ */

function locateInterval(keys, t) {
  let lo = 0;
  let hi = keys.length - 1;
  if (t <= keys[0].t) return 0;
  if (t >= keys[hi].t) return hi - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid + 1].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function evalLocals(model, t, out) {
  const { keys, bones } = model;
  const i = locateInterval(keys, t);
  const k0 = keys[i];
  const k1 = keys[Math.min(i + 1, keys.length - 1)];
  const span = k1.t - k0.t;
  const a = span > 0 ? (t - k0.t) / span : 0;
  for (let b = 0; b < bones.length; b++) {
    const p0 = k0.pose[b];
    const p1 = k1.pose[b];
    const o = out[b];
    o[0] = p0[0] + (p1[0] - p0[0]) * a;
    o[1] = p0[1] + (p1[1] - p0[1]) * a;
    o[2] = p0[2] + (p1[2] - p0[2]) * a;
    const turns = p0[3] + (p1[3] - p0[3]) * a; // 保持整圈累计，不折角
    o[3] = turns * 2 * Math.PI * bones[b].axisSign;
  }
  return out;
}

function localMatrix(bone, locals, m) {
  const c = Math.cos(locals[3]);
  const s = Math.sin(locals[3]);
  m.fill(0);
  if (bone.axisIdx === 0) {
    m[0] = 1; m[5] = c; m[6] = -s; m[9] = s; m[10] = c;
  } else if (bone.axisIdx === 1) {
    m[0] = c; m[2] = s; m[5] = 1; m[8] = -s; m[10] = c;
  } else {
    m[0] = c; m[1] = -s; m[4] = s; m[5] = c; m[10] = 1;
  }
  m[3] = locals[0];
  m[7] = locals[1];
  m[11] = locals[2];
  return m;
}

function mulMat34(a, b, out) {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
    out[r * 4]     = a0 * b[0] + a1 * b[4] + a2 * b[8];
    out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
  return out;
}

function applyMat(m, p, out) {
  out[0] = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  out[1] = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
  out[2] = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
  return out;
}

function evalWorldMatrices(model, t, scratch) {
  const { bones, topo } = model;
  evalLocals(model, t, scratch.locals);
  for (const b of topo) {
    localMatrix(bones[b], scratch.locals[b], scratch.local[b]);
    if (bones[b].parent === null) {
      const wb = scratch.world[b], lb = scratch.local[b];
      for (let k = 0; k < 12; k++) wb[k] = lb[k];
    } else {
      mulMat34(scratch.world[bones[b].parent], scratch.local[b], scratch.world[b]);
    }
  }
  return scratch.world;
}

/* 同一时刻合成多骨权重 */
function skinVertex(model, world, vi, tmp, out) {
  const infl = model.vertices[vi];
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let j = 0; j < infl.length; j++) {
    const e = infl[j];
    applyMat(world[e.bone], e.local, tmp);
    const w = e.weight;
    out[0] += tmp[0] * w;
    out[1] += tmp[1] * w;
    out[2] += tmp[2] * w;
  }
  return out;
}

function makeScratch(model) {
  const n = model.bones.length;
  return {
    locals: Array.from({ length: n }, () => new Array(4)),
    local: Array.from({ length: n }, () => new Array(12).fill(0)),
    world: Array.from({ length: n }, () => new Array(12).fill(0)),
    tmp: [0, 0, 0],
    pos: [0, 0, 0],
  };
}

/* ------------------------------------------------------------------ */
/* 3. 区间算术（预分配、零堆分配）：线性参数化的严格 sin/cos 值域        */
/*    关键帧段内 θ(t)=α+βt 是时间的线性函数，区间随细分真正收紧         */
/* ------------------------------------------------------------------ */

/* 线性正弦 f(t)=sin(α+βt) 在 [tLo,tHi] 上的严格值域（β 可正可负可为 0） */
function sinRangeLinear(alpha, beta, tLo, tHi) {
  const aLo = alpha + beta * tLo;
  const aHi = alpha + beta * tHi;
  const lo = Math.min(aLo, aHi);
  const hi = Math.max(aLo, aHi);
  let min = Math.min(Math.sin(aLo), Math.sin(aHi));
  let max = Math.max(Math.sin(aLo), Math.sin(aHi));
  const kMaxLo = Math.ceil((lo - Math.PI / 2) / (2 * Math.PI));
  const kMaxHi = Math.floor((hi - Math.PI / 2) / (2 * Math.PI));
  if (kMaxHi >= kMaxLo) max = 1;
  const kMinLo = Math.ceil((lo + Math.PI / 2) / (2 * Math.PI));
  const kMinHi = Math.floor((hi + Math.PI / 2) / (2 * Math.PI));
  if (kMinHi >= kMinLo) min = -1;
  return [min, max];
}

function cosRangeLinear(alpha, beta, tLo, tHi) {
  return sinRangeLinear(alpha + Math.PI / 2, beta, tLo, tHi);
}

/* 兼容测试入口：普通角度区间（视为 t 即角度、β=1） */
function sinRange(lo, hi) {
  return sinRangeLinear(0, 1, lo, hi);
}
function cosRange(lo, hi) {
  return cosRangeLinear(0, 1, lo, hi);
}

/*
 * 区间 scratch 内存布局（全部预分配，递归中不产生垃圾）：
 *  locals[b]: Float64Array(10)，平移区间 [c*2,c*2+1]，角度端点 [6,7]，
 *             角速度 [8]、截距 [9]（单段时有效，跨段为 NaN）
 *  world[b]:  Float64Array(24)，3x4 矩阵每元素 [lo,hi]
 */
function makeIntervalScratch(model) {
  const n = model.bones.length;
  const nv = model.vertices.length;
  const zero24 = () => new Float64Array(24);
  return {
    locals: Array.from({ length: n }, () => new Float64Array(16)),
    world: Array.from({ length: n }, zero24),
    worldD: Array.from({ length: n }, zero24), // 世界矩阵对 t 的区间导数
    vert: new Float64Array(6), // 当前顶点的坐标区间 x,y,z
    vertD: new Float64Array(6), // 当前顶点的速度区间
    vel: new Float64Array(nv * 6), // 每顶点的段级速度界（预处理一次）
    midPos: new Float64Array(nv * 3), // 节点中点的实际位置
    mulTmp: new Float64Array(24), // 连乘专用独立缓冲，避免输入输出同址
    // 标量运动学速度上界（无区间包裹）：每骨世界角速度分量界、原点线速度分量界
    omega: Array.from({ length: model.bones.length }, () => new Float64Array(3)),
    vOrigin: Array.from({ length: model.bones.length }, () => new Float64Array(3)),
    scalarSpeed: new Float64Array(nv), // 每顶点标量速度上界（各轴共用的保守范数界）
  };
}

/* 时间区间上某骨局部参数区间，写入 li（li[0..5] 平移，li[6..7] 角度弧度） */
function evalLocalInterval(model, b, tLo, tHi, li) {
  const { keys, bones } = model;
  const i0 = locateInterval(keys, tLo);
  const i1 = locateInterval(keys, tHi);
  for (let c = 0; c < 3; c++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const k0 = keys[i];
      const k1 = keys[Math.min(i + 1, keys.length - 1)];
      const v0 = k0.pose[b][c];
      const v1 = k1.pose[b][c];
      if (v0 < lo) lo = v0; if (v0 > hi) hi = v0;
      if (v1 < lo) lo = v1; if (v1 > hi) hi = v1;
    }
    li[c * 2] = lo; li[c * 2 + 1] = hi;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const k0 = keys[i];
    const k1 = keys[Math.min(i + 1, keys.length - 1)];
    const v0 = k0.pose[b][3];
    const v1 = k1.pose[b][3];
    if (v0 < lo) lo = v0; if (v0 > hi) hi = v0;
    if (v1 < lo) lo = v1; if (v1 > hi) hi = v1;
  }
  const sign = bones[b].axisSign;
  li[6] = (sign > 0 ? lo : hi) * 2 * Math.PI;
  li[7] = (sign > 0 ? hi : lo) * 2 * Math.PI;
  // 单段：记录角速度 β（弧度/秒）与截距 α，供线性三角使用
  if (i0 === i1) {
    const k0 = keys[i0];
    const k1 = keys[Math.min(i0 + 1, keys.length - 1)];
    const span = k1.t - k0.t;
    const dTurns = k1.pose[b][3] - k0.pose[b][3];
    const beta = span > 0 ? (dTurns * 2 * Math.PI * sign) / span : 0;
    const alpha = k0.pose[b][3] * 2 * Math.PI * sign - beta * k0.t;
    li[8] = beta;
    li[9] = alpha;
  } else {
    li[8] = NaN; // 跨段回退到普通角度区间
    li[9] = 0;
  }
}

/* 区间局部矩阵 -> w（Float64Array(24)），先旋再平移 */
function localMatrixInterval(bone, li, w, tLo, tHi) {
  let sr, cr;
  if (Number.isNaN(li[8])) {
    sr = sinRange(li[6], li[7]);
    cr = cosRange(li[6], li[7]);
  } else {
    sr = sinRangeLinear(li[9], li[8], tLo, tHi);
    cr = cosRangeLinear(li[9], li[8], tLo, tHi);
  }
  w.fill(0);
  if (bone.axisIdx === 0) {
    w[0] = 1; w[1] = 1;
    w[10] = cr[0]; w[11] = cr[1]; w[12] = -sr[1]; w[13] = -sr[0];
    w[18] = sr[0]; w[19] = sr[1]; w[20] = cr[0]; w[21] = cr[1];
  } else if (bone.axisIdx === 1) {
    w[0] = cr[0]; w[1] = cr[1]; w[4] = sr[0]; w[5] = sr[1];
    w[10] = 1; w[11] = 1;
    w[16] = -sr[1]; w[17] = -sr[0]; w[20] = cr[0]; w[21] = cr[1];
  } else {
    w[0] = cr[0]; w[1] = cr[1]; w[2] = -sr[1]; w[3] = -sr[0];
    w[8] = sr[0]; w[9] = sr[1]; w[10] = cr[0]; w[11] = cr[1];
    w[20] = 1; w[21] = 1;
  }
  w[6] = li[0]; w[7] = li[1];
  w[14] = li[2]; w[15] = li[3];
  w[22] = li[4]; w[23] = li[5];
}

/* 区间 3x4 矩阵乘法 C = A * B，全部内联、零分配 */
function iMatMul(A, B, C) {
  for (let r = 0; r < 3; r++) {
    const ar = r * 8;
    for (let c = 0; c < 4; c++) {
      let lo = 0, hi = 0;
      for (let k = 0; k < 3; k++) {
        const aL = A[ar + k * 2], aH = A[ar + k * 2 + 1];
        const bL = B[k * 8 + c * 2], bH = B[k * 8 + c * 2 + 1];
        const x1 = aL * bL, x2 = aL * bH, x3 = aH * bL, x4 = aH * bH;
        lo += Math.min(x1, x2, x3, x4);
        hi += Math.max(x1, x2, x3, x4);
      }
      if (c === 3) { lo += A[ar + 6]; hi += A[ar + 7]; }
      C[ar + c * 2] = lo;
      C[ar + c * 2 + 1] = hi;
    }
  }
}

function evalWorldInterval(model, tLo, tHi, si) {
  const { bones, topo } = model;
  for (const b of topo) {
    evalLocalInterval(model, b, tLo, tHi, si.locals[b]);
    localMatrixInterval(bones[b], si.locals[b], si.world[b], tLo, tHi);
    const par = bones[b].parent;
    if (par !== null) {
      iMatMul(si.world[par], si.world[b], si.mulTmp);
      si.world[b].set(si.mulTmp);
    }
  }
}

/* 区间矩阵加法 C = A + B（逐元素区间和） */
function iMatAdd(A, B, C) {
  for (let k = 0; k < 24; k += 2) { C[k] = A[k] + B[k]; C[k + 1] = A[k + 1] + B[k + 1]; }
}

/* 标量区间乘以区间矩阵 A，结果写 C */
function iScaleMat(sL, sH, A, C) {
  for (let k = 0; k < 24; k += 2) {
    const aL = A[k], aH = A[k + 1];
    const x1 = sL * aL, x2 = sL * aH, x3 = sH * aL, x4 = sH * aH;
    C[k] = Math.min(x1, x2, x3, x4);
    C[k + 1] = Math.max(x1, x2, x3, x4);
  }
}

/*
 * 段级预处理：计算每根骨在关键帧段 seg 内的
 *   世界矩阵区间 W_b（随节点 [lo,hi] 重算时用 localMatrixInterval 的角度参数化）
 *   世界矩阵对时间的区间导数 dW_b/dt（在整个段 [T0,T1] 上，作为速度界）
 * 段内角度 θ_b(t)=α_b+β_b t、平移 p_b(t)=γ_b+s_b t 都是 t 的线性函数。
 */
function buildSegmentDerivatives(model, seg, tLo, tHi, si) {
  const { bones, topo, keys } = model;
  const k0 = keys[seg];
  const k1 = keys[Math.min(seg + 1, keys.length - 1)];
  const span = k1.t - k0.t;

  // 每骨段常数：角速度 beta、平移斜率 slope[3]、角度截距 alpha
  for (const b of topo) {
    const sign = bones[b].axisSign;
    const dTurns = k1.pose[b][3] - k0.pose[b][3];
    const beta = span > 0 ? (dTurns * 2 * Math.PI * sign) / span : 0;
    const li = si.locals[b];
    li[8] = beta;
    li[9] = k0.pose[b][3] * 2 * Math.PI * sign - beta * k0.t;
    li[10] = span; // 借用槽位记录段长（仅段内使用）
    for (let c = 0; c < 3; c++) {
      li[11 + c] = span > 0 ? (k1.pose[b][c] - k0.pose[b][c]) / span : 0;
    }
  }

  // 在整个段上求世界矩阵区间与其导数区间
  const localM = Array.from({ length: model.bones.length }, () => new Float64Array(24));
  const localDM = Array.from({ length: model.bones.length }, () => new Float64Array(24));
  // 缓存段常数：evalLocalInterval 可能在跨段边界把 li[8] 置 NaN，需在其后恢复
  const segBeta = new Float64Array(model.bones.length);
  const segAlpha = new Float64Array(model.bones.length);
  const segSlope = Array.from({ length: model.bones.length }, () => new Float64Array(3));
  for (const b of topo) {
    segBeta[b] = si.locals[b][8];
    segAlpha[b] = si.locals[b][9];
    for (let c = 0; c < 3; c++) segSlope[b][c] = si.locals[b][11 + c];
  }
  for (const b of topo) {
    const li = si.locals[b];
    // 局部矩阵区间（整段），存独立缓冲，不与 world 混用
    evalLocalInterval(model, b, tLo, tHi, li);
    // 恢复段常数（本函数的节点始终落在单一关键帧段 seg 内）
    li[8] = segBeta[b];
    li[9] = segAlpha[b];
    for (let c = 0; c < 3; c++) li[11 + c] = segSlope[b][c];
    localMatrixInterval(bones[b], li, localM[b], tLo, tHi);

    // 局部旋转对 t 的导数 = β·(∂R/∂θ)；平移导数 = slope
    const beta = li[8];
    const md = new Float64Array(24); // ∂R/∂θ（旋转部分），平移部分先为 0
    const sr = sinRangeLinear(li[9], beta, tLo, tHi);
    const cr = cosRangeLinear(li[9], beta, tLo, tHi);
    if (bones[b].axisIdx === 0) {
      md[10] = -sr[1]; md[11] = -sr[0]; md[12] = -cr[1]; md[13] = -cr[0];
      md[18] = cr[0];  md[19] = cr[1];  md[20] = -sr[1]; md[21] = -sr[0];
    } else if (bones[b].axisIdx === 1) {
      md[0] = -sr[1]; md[1] = -sr[0]; md[4] = cr[0]; md[5] = cr[1];
      md[16] = -cr[1]; md[17] = -cr[0]; md[20] = -sr[1]; md[21] = -sr[0];
    } else {
      md[0] = -sr[1]; md[1] = -sr[0]; md[2] = -cr[1]; md[3] = -cr[0];
      md[8] = cr[0];  md[9] = cr[1];  md[10] = -sr[1]; md[11] = -sr[0];
    }
    iScaleMat(beta, beta, md, localDM[b]);
    localDM[b][6] = li[11]; localDM[b][7] = li[11];
    localDM[b][14] = li[12]; localDM[b][15] = li[12];
    localDM[b][22] = li[13]; localDM[b][23] = li[13];

    const par = bones[b].parent;
    if (par === null) {
      si.world[b].set(localM[b]);
      si.worldD[b].set(localDM[b]);
    } else {
      // 世界矩阵 W_b = W_p · L_b（独立缓冲，避免同址）
      iMatMul(si.world[par], localM[b], si.mulTmp);
      si.world[b].set(si.mulTmp);
      // 乘积法则 W_b' = W_p'·L_b + W_p·L_b'
      const t1m = new Float64Array(24), t2m = new Float64Array(24);
      iMatMul(si.worldD[par], localM[b], t1m);
      iMatMul(si.world[par], localDM[b], t2m);
      iMatAdd(t1m, t2m, si.worldD[b]);
    }
  }

  // 标量运动学速度上界（无区间包裹）。
  // 骨 b 局部原点相对父关节的偏移 d_b（取局部平移，世界方向随姿态变化，故用范数）。
  // 世界角速度：Ω_b = Ω_p + R_p·(β_b·axis_b)，分量绝对值上界沿链相加。
  // 原点线速度：V_b = V_p + Ω_p × d_b + R_p·vLocal_b（vLocal 为平移斜率）。
  // 全部用绝对值三角不等式，得到严格的分量级上界。
  for (const b of topo) {
    const li = si.locals[b];
    const beta = li[8];
    const axis = new Float64Array(3);
    axis[bones[b].axisIdx] = bones[b].axisSign; // 局部旋转轴（单位向量）
    const par = bones[b].parent;

    // 本骨自转角速度在世界系的分量上界：|β|·|R_p·axis| = |β|（旋转保范，分量绝对值≤|β|）
    const self = new Float64Array(3);
    for (let c = 0; c < 3; c++) self[c] = Math.abs(beta); // R_p·axis 各分量绝对值 ≤ 1
    const omega = si.omega[b];
    const vOrig = si.vOrigin[b];
    if (par === null) {
      for (let c = 0; c < 3; c++) omega[c] = self[c];
      // 根骨原点线速度 = 世界系平移斜率（局部=世界，方向固定）
      for (let c = 0; c < 3; c++) vOrig[c] = Math.abs(li[11 + c]);
    } else {
      const omegaP = si.omega[par];
      for (let c = 0; c < 3; c++) omega[c] = omegaP[c] + self[c];
      // 局部偏移 d_b = 关键帧平移（取段内平移分量的绝对值上界）
      const dAbs = new Float64Array(3);
      for (let c = 0; c < 3; c++) {
        dAbs[c] = Math.max(Math.abs(li[c * 2]), Math.abs(li[c * 2 + 1]));
      }
      // |Ω_p × d| 分量上界：(Ω×d)_i = Σ εijk Ω_j d_k，绝对值 ≤ Σ_{j≠i} omegaP_j·dAbs_k
      const cross = new Float64Array(3);
      cross[0] = omegaP[1] * dAbs[2] + omegaP[2] * dAbs[1];
      cross[1] = omegaP[0] * dAbs[2] + omegaP[2] * dAbs[0];
      cross[2] = omegaP[0] * dAbs[1] + omegaP[1] * dAbs[0];
      // 平移斜率经父旋转后分量绝对值上界 = 平移速度范数（保守，旋转后单分量不超过范数）
      let vLocalNorm = 0;
      for (let c = 0; c < 3; c++) vLocalNorm += li[11 + c] * li[11 + c];
      vLocalNorm = Math.sqrt(vLocalNorm);
      const vP = si.vOrigin[par];
      for (let c = 0; c < 3; c++) vOrig[c] = vP[c] + cross[c] + vLocalNorm;
    }
  }
}

/* 顶点的标量速度上界：对每条权重，骨 e 上局部点 r 的速度 ≤ |V_origin(e)| + |Ω_e|·|r| */
function scalarVertexSpeed(model, si, vi) {
  const infl = model.vertices[vi];
  let speed = 0;
  for (let j = 0; j < infl.length; j++) {
    const e = infl[j];
    const r = e.local;
    const rNorm = Math.hypot(r[0], r[1], r[2]);
    let omegaNorm = 0;
    for (let c = 0; c < 3; c++) omegaNorm += si.omega[e.bone][c] * si.omega[e.bone][c];
    omegaNorm = Math.sqrt(omegaNorm);
    let vOrigNorm = 0;
    for (let c = 0; c < 3; c++) vOrigNorm += si.vOrigin[e.bone][c] * si.vOrigin[e.bone][c];
    vOrigNorm = Math.sqrt(vOrigNorm);
    speed += e.weight * (vOrigNorm + omegaNorm * rNorm);
  }
  return speed;
}

/* 顶点在整段上的速度界：对每条权重，把世界矩阵导数区间作用于局部点，再按权重求和 */
function vertexVelocityBound(model, si, vi) {
  const infl = model.vertices[vi];
  const d = si.vertD;
  d[0] = 0; d[1] = 0; d[2] = 0; d[3] = 0; d[4] = 0; d[5] = 0;
  for (let j = 0; j < infl.length; j++) {
    const e = infl[j];
    iApplyWorld(si.worldD[e.bone], e.local, si.vert); // 复用 vert 做临时
    const w = e.weight;
    for (let r = 0; r < 3; r++) {
      d[r * 2] += si.vert[r * 2] * w;
      d[r * 2 + 1] += si.vert[r * 2 + 1] * w;
    }
  }
  return d;
}

/* 单骨世界区间矩阵作用于局部点，结果写入 out[3]（lo/hi 三轴） */
function iApplyWorld(WB, p, out) {
  for (let r = 0; r < 3; r++) {
    const ar = r * 8;
    let lo = WB[ar + 6], hi = WB[ar + 7]; // 平移列
    for (let k = 0; k < 3; k++) {
      const aL = WB[ar + k * 2], aH = WB[ar + k * 2 + 1];
      const x = p[k];
      const x1 = aL * x, x2 = aH * x;
      lo += x >= 0 ? x1 : x2;
      hi += x >= 0 ? x2 : x1;
    }
    out[r * 2] = lo;
    out[r * 2 + 1] = hi;
  }
}

/* 蒙皮顶点的时间区间坐标，写入 si.vert（模块级累加器，串行使用） */
const accV = new Float64Array(6);
function skinVertexInterval(model, si, vi) {
  const infl = model.vertices[vi];
  const v = si.vert;
  accV[0] = 0; accV[1] = 0; accV[2] = 0; accV[3] = 0; accV[4] = 0; accV[5] = 0;
  for (let j = 0; j < infl.length; j++) {
    const e = infl[j];
    iApplyWorld(si.world[e.bone], e.local, v);
    const w = e.weight;
    for (let r = 0; r < 3; r++) {
      accV[r * 2] += v[r * 2] * w;
      accV[r * 2 + 1] += v[r * 2 + 1] * w;
    }
  }
  v.set(accV);
  return v;
}

/* ------------------------------------------------------------------ */
/* 4. 连续包围盒：区间分支定界（非固定采样，带证书）                    */
/* ------------------------------------------------------------------ */

function emptyFaces() {
  return [0, 1, 2, 3, 4, 5].map((q) => ({
    isMin: q % 2 === 0,
    axis: q >> 1,
    value: q % 2 === 0 ? Infinity : -Infinity,
    bound: q % 2 === 0 ? Infinity : -Infinity,
    witness: null,
  }));
}

/* 真实采样刷新各面最优值与见证 */
function sampleUpdate(model, world, t, faces, scratch) {
  const nv = model.vertices.length;
  for (let vi = 0; vi < nv; vi++) {
    skinVertex(model, world, vi, scratch.tmp, scratch.pos);
    for (let q = 0; q < 6; q++) {
      const f = faces[q];
      const val = scratch.pos[f.axis];
      if (f.isMin ? val < f.value : val > f.value) {
        f.value = val;
        f.witness = { vertex: vi, t, coord: val };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 连续包围盒：区间分支定界（非固定采样，带证书）                    */
/* ------------------------------------------------------------------ */

/* 节点落在单个关键帧段 seg 内：只重算世界矩阵区间，不触碰预计算的 worldD */
function recomputeWorldIntervalSeg(model, seg, lo, hi, si) {
  const { bones, topo, keys } = model;
  const k0 = keys[seg], k1 = keys[Math.min(seg + 1, keys.length - 1)];
  const span = k1.t - k0.t;
  for (const b of topo) {
    const li = si.locals[b];
    const sign = bones[b].axisSign;
    // 平移区间（线性，取两端）
    for (let c = 0; c < 3; c++) {
      const a0 = k0.pose[b][c], a1 = k1.pose[b][c];
      const vL = a0 + (a1 - a0) * ((lo - k0.t) / span);
      const vH = a0 + (a1 - a0) * ((hi - k0.t) / span);
      li[c * 2] = Math.min(vL, vH); li[c * 2 + 1] = Math.max(vL, vH);
    }
    // 角度参数化（li[8]=beta, li[9]=alpha 已在段预处理算好）
    localMatrixInterval(bones[b], li, si.world[b], lo, hi);
    const par = bones[b].parent;
    if (par !== null) {
      // 必须用独立缓冲：iMatMul 逐元素写入，同址会读到被污染的中间值
      iMatMul(si.world[par], si.world[b], si.mulTmp);
      si.world[b].set(si.mulTmp);
    }
  }
}

/* 采样并把该时刻所有顶点位置存入 si.midPos，同时刷新面最优值与见证 */
function sampleAndStore(model, world, t, faces, scratch, si) {
  const nv = model.vertices.length;
  for (let vi = 0; vi < nv; vi++) {
    skinVertex(model, world, vi, scratch.tmp, scratch.pos);
    const mb = vi * 3;
    si.midPos[mb] = scratch.pos[0];
    si.midPos[mb + 1] = scratch.pos[1];
    si.midPos[mb + 2] = scratch.pos[2];
    for (let q = 0; q < 6; q++) {
      const f = faces[q];
      const val = scratch.pos[f.axis];
      if (f.isMin ? val < f.value : val > f.value) {
        f.value = val;
        f.witness = { vertex: vi, t, coord: val };
      }
    }
  }
}

function solveSegment(model, seg, tLo, tHi, scratch, si, stats) {
  const nv = model.vertices.length;
  // 段级独立 faces：每段各自做完整 B&B，避免跨段共用状态造成错误剪枝
  const faces = emptyFaces();
  // 段级预处理：世界矩阵区间 + 标量运动学速度上界（无区间包裹，紧致严格）
  buildSegmentDerivatives(model, seg, tLo, tHi, si);
  for (let vi = 0; vi < nv; vi++) {
    si.scalarSpeed[vi] = scalarVertexSpeed(model, si, vi);
  }

  // 端点采样，给出初始 value 与见证
  evalWorldMatrices(model, tLo, scratch);
  sampleAndStore(model, scratch.world, tLo, faces, scratch, si);
  evalWorldMatrices(model, tHi, scratch);
  sampleAndStore(model, scratch.world, tHi, faces, scratch, si);

  // 叶子并集界：所有终止节点（剪枝叶 + 深叶）严格界的并集外包。
  // 细分把每个父区间划分为两个子区间，全部叶子的并恰好覆盖整段，
  // 故 leafLo/leafHi 始终是整段真实极值的严格界，并随细分收紧。
  const leafLo = new Float64Array(3 * nv).fill(Infinity);
  const leafHi = new Float64Array(3 * nv).fill(-Infinity);

  // 一次性计算节点内全部顶点的三轴严格界（IA ∩ MVT），6 面复用，避免重复区间求值
  const nodeBLo = new Float64Array(3 * nv);
  const nodeBHi = new Float64Array(3 * nv);
  const vertexNodeBounds = (lo, hi) => {
    recomputeWorldIntervalSeg(model, seg, lo, hi, si);
    const half = (hi - lo) * 0.5;
    for (let vi = 0; vi < nv; vi++) {
      const ia = skinVertexInterval(model, si, vi);
      const mb = vi * 3, speed = si.scalarSpeed[vi];
      for (let c = 0; c < 3; c++) {
        const pmid = si.midPos[mb + c];
        nodeBLo[vi * 3 + c] = Math.max(ia[c * 2], pmid - speed * half);
        nodeBHi[vi * 3 + c] = Math.min(ia[c * 2 + 1], pmid + speed * half);
      }
    }
  };
  const absorbNode = (vi) => {
    const cb = vi * 3;
    for (let c = 0; c < 3; c++) {
      if (nodeBLo[cb + c] < leafLo[cb + c]) leafLo[cb + c] = nodeBLo[cb + c];
      if (nodeBHi[cb + c] > leafHi[cb + c]) leafHi[cb + c] = nodeBHi[cb + c];
    }
  };

  /*
   * 无状态剪枝：节点界 vs 全局采样最优 value 独立判定，不用跨节点持久标记。
   * 某顶点六面全收敛 → 吸收为叶子；任一顶点任一面仍开放 → 继续二分。
   */
  const node = (lo, hi, depth) => {
    const mid = (lo + hi) * 0.5;
    const half = (hi - lo) * 0.5;
    evalWorldMatrices(model, mid, scratch);
    sampleAndStore(model, scratch.world, mid, faces, scratch, si);
    vertexNodeBounds(lo, hi);

    // MVT 早停：若所有顶点的速度上界 × 半宽都已 ≤ 容差，则节点内任意点离中点
    // 不超过 LEAF_GAP，六个面必然全部收敛，直接吸收整节点并终止该子树。
    let mvtSettled = true;
    for (let vi = 0; vi < nv; vi++) {
      if (si.scalarSpeed[vi] * half > LEAF_GAP) { mvtSettled = false; break; }
    }
    if (mvtSettled) {
      for (let vi = 0; vi < nv; vi++) absorbNode(vi);
      stats.evalCount += nv;
      return;
    }

    // 面级剪枝：先求每面在本节点所有顶点中的最优可达界。
    // 若该界离全局采样 value 已 ≤ 容差，则本节点不可能在此面产生更优值，该面在本节点关闭。
    const faceOpen = new Uint8Array(6);
    let anyFaceOpen = false;
    for (let q = 0; q < 6; q++) {
      const f = faces[q];
      let best = f.isMin ? Infinity : -Infinity;
      for (let vi = 0; vi < nv; vi++) {
        const cb = vi * 3;
        const bEnd = f.isMin ? nodeBLo[cb + f.axis] : nodeBHi[cb + f.axis];
        if (f.isMin) { if (bEnd < best) best = bEnd; }
        else if (bEnd > best) best = bEnd;
      }
      const gap = f.isMin ? f.value - best : best - f.value;
      if (gap > LEAF_GAP) { faceOpen[q] = 1; anyFaceOpen = true; }
    }
    if (!anyFaceOpen) {
      // 六面在本节点全部关闭 → 整节点成为叶子
      for (let vi = 0; vi < nv; vi++) absorbNode(vi);
      stats.evalCount += nv;
      return;
    }

    let anyOpen = false;
    for (let vi = 0; vi < nv; vi++) {
      const cb = vi * 3;
      let vertexOpen = false;
      for (let q = 0; q < 6; q++) {
        if (!faceOpen[q]) continue; // 该面在本节点已关闭，不驱动递归
        const f = faces[q];
        const bEnd = f.isMin ? nodeBLo[cb + f.axis] : nodeBHi[cb + f.axis];
        const gap = f.isMin ? f.value - bEnd : bEnd - f.value;
        if (gap > LEAF_GAP) vertexOpen = true;
      }
      if (vertexOpen) anyOpen = true;
      else absorbNode(vi);
      stats.evalCount++;
    }

    if (!anyOpen) return;
    if (depth >= MAX_DEPTH || hi - lo <= 1e-10) {
      // 深叶：仍开放的顶点强制吸收（节点界严格覆盖该叶区域）
      for (let vi = 0; vi < nv; vi++) absorbNode(vi);
      for (let q = 0; q < 6; q++) {
        const f = faces[q];
        const gap = f.isMin ? f.value - f.bound : f.bound - f.value;
        if (gap > LEAF_GAP + 1e-9) stats.deepLeaves.push({ axis: f.axis, isMin: f.isMin, gap });
      }
      return;
    }
    node(lo, mid, depth + 1);
    node(mid, hi, depth + 1);
  };

  node(tLo, tHi, 0);

  // 由叶子并集界确定每面的全局 bound（叶子并集精确覆盖整段，故严格）
  for (let vi = 0; vi < nv; vi++) {
    for (let c = 0; c < 3; c++) {
      if (leafLo[vi * 3 + c] < faces[2 * c].bound) faces[2 * c].bound = leafLo[vi * 3 + c];
      if (leafHi[vi * 3 + c] > faces[2 * c + 1].bound) faces[2 * c + 1].bound = leafHi[vi * 3 + c];
    }
  }
  // 仅当某面 bound 仍非有限（理论不会，因每个顶点至少在根被吸收一次）才用整段根界兜底
  if (faces.some((f) => !Number.isFinite(f.bound))) {
    recomputeWorldIntervalSeg(model, seg, tLo, tHi, si);
    for (let vi = 0; vi < nv; vi++) {
      const r = skinVertexInterval(model, si, vi);
      for (let c = 0; c < 3; c++) {
        if (!Number.isFinite(faces[2 * c].bound)) faces[2 * c].bound = r[c * 2];
        if (!Number.isFinite(faces[2 * c + 1].bound)) faces[2 * c + 1].bound = r[c * 2 + 1];
      }
    }
  }
  return faces;
}

/* 归并两个段级 faces：取更优采样值与见证、更激进的证书界（min 取小，max 取大） */
function mergeFaces(dst, src) {
  for (let q = 0; q < 6; q++) {
    const a = dst[q], b = src[q];
    if (a.isMin) {
      if (b.value < a.value) { a.value = b.value; a.witness = b.witness; }
      if (b.bound < a.bound) a.bound = b.bound;
    } else {
      if (b.value > a.value) { a.value = b.value; a.witness = b.witness; }
      if (b.bound > a.bound) a.bound = b.bound;
    }
  }
}

/*
 * 主入口：闭时间段 [ta,tb]（ta===tb 即单一时刻）
 */
function computeEnvelope(model, ta, tb) {
  if (!isFiniteNum(ta) || !isFiniteNum(tb)) throw new Error('查询时间必须是数值');
  if (ta > tb + NUM_TOL) throw new Error('查询起点不能晚于终点');
  if (ta < model.t0 - NUM_TOL || tb > model.t1 + NUM_TOL) {
    throw new Error(`查询须在关键帧起止闭区间 [${model.t0}, ${model.t1}] 内`);
  }
  ta = Math.max(model.t0, Math.min(model.t1, ta));
  tb = Math.max(model.t0, Math.min(model.t1, tb));

  const scratch = makeScratch(model);
  const si = makeIntervalScratch(model);
  const faces = emptyFaces();
  const stats = { evalCount: 0, segments: 0, deepLeaves: [], elapsedMs: 0, instant: false };
  const tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  if (tb - ta <= 1e-12) {
    const world = evalWorldMatrices(model, ta, scratch);
    sampleUpdate(model, world, ta, faces, scratch);
    for (const f of faces) f.bound = f.value;
    stats.instant = true;
  } else {
    const i0 = locateInterval(model.keys, ta);
    const i1 = locateInterval(model.keys, tb);
    for (let i = i0; i <= i1; i++) {
      const lo = Math.max(ta, model.keys[i].t);
      const hi = Math.min(tb, model.keys[Math.min(i + 1, model.keys.length - 1)].t);
      if (hi < lo - NUM_TOL) continue;
      const segFaces = solveSegment(model, i, lo, hi, scratch, si, stats);
      mergeFaces(faces, segFaces);
      stats.segments++;
    }
  }

  const box = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let q = 0; q < 6; q++) {
    const f = faces[q];
    if (stats.instant) {
      // 单一时刻盒子退化为该时刻点集
      if (f.isMin) box.min[f.axis] = f.value;
      else box.max[f.axis] = f.value;
      continue;
    }
    // 盒面取证书界 bound（严格覆盖真实极值），再外扩 MARGIN 兜底浮点误差。
    // bound 经 B&B 收紧到离采样极值 ≤ LEAF_GAP，故盒面离真实极值 ≤ 0.01。
    if (f.isMin) {
      f.value = f.bound - MARGIN;
      box.min[f.axis] = f.value;
    } else {
      f.value = f.bound + MARGIN;
      box.max[f.axis] = f.value;
    }
  }
  stats.elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart;
  return { box, faces, stats, range: [ta, tb] };
}

/* ------------------------------------------------------------------ */
/* 5. 满额长片（规范内置性能用例）                                      */
/* ------------------------------------------------------------------ */

function buildFullLengthFilm() {
  const bones = [];
  for (let k = 0; k < 64; k++) bones.push({ parent: null, axis: 'z' });
  const keys = [];
  for (let t = 0; t <= 128; t++) {
    const pose = [];
    for (let k = 0; k < 64; k++) pose.push([0, 0, 0, t + k / 64]);
    keys.push({ t, pose });
  }
  const vertices = [];
  for (let i = 0; i < 8192; i++) vertices.push([[i % 64, 65536, 10, 0, i % 8]]);
  return { bones, keys, vertices, triangles: null };
}

const api = {
  MAX_BONES, MAX_VERTS, MAX_INTERVALS, WEIGHT_SUM, NUM_TOL,
  LEAF_GAP, MARGIN,
  validateModel, locateInterval, evalLocals, localMatrix, mulMat34,
  evalWorldMatrices, skinVertex, makeScratch,
  sinRange, cosRange, makeIntervalScratch, evalWorldInterval,
  skinVertexInterval, buildSegmentDerivatives, vertexVelocityBound,
  recomputeWorldIntervalSeg, iMatMul, iMatAdd,
  computeEnvelope, buildFullLengthFilm,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.engine = api;
