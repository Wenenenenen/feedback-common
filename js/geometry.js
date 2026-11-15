// geometry.js — 基础几何:向量、矩阵、贝塞尔自适应细分、弧长参数化。
// 纯 ES 模块,不依赖 DOM,可在浏览器与 Node 测试中共用。

export const EPS = 1e-9;

// ---------- 矩阵 [a,b,c,d,e,f]: x' = a*x + c*y + e; y' = b*x + d*y + f ----------
export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-15) return null;
  const id = 1 / det;
  return [d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id];
}

// 线性部分最大列范数 —— 用于把导出坐标容差折算回局部坐标(保守上界)。
export function matMaxScale(m) {
  return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12);
}

// ---------- 贝塞尔求值 ----------
export function evalQuad(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

export function evalCubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

function distToLine(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / len;
}

// ---------- 自适应细分 ----------
// 每个输出弦段记录其在原曲线上的参数区间 [t0,t1],供弧长积分与精确求值使用。
// 返回 pieces: [{p0, p1, t0, t1, seg}],seg 为 {kind:'quad'|'cubic', cps:[...]} 或 null(直线)。

function flattenCurveRecurse(kind, cps, t0, t1, p0, p1, tol, depth, out, origCps) {
  // 平直度:控制点到弦的距离
  let flat;
  if (kind === 'quad') {
    flat = distToLine(cps[1], p0, p1) <= tol;
  } else {
    flat = distToLine(cps[1], p0, p1) <= tol && distToLine(cps[2], p0, p1) <= tol;
  }
  if (flat || depth >= 24) {
    // 注意:seg 保存原始曲线控制点,t0/t1 为其上的全局参数区间
    out.push({ p0, p1, t0, t1, seg: { kind, cps: origCps } });
    return;
  }
  const tm = (t0 + t1) / 2;
  if (kind === 'quad') {
    const [q0, q1, q2] = cps;
    const a = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2];
    const b = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    flattenCurveRecurse(kind, [q0, a, m], t0, tm, p0, m, tol, depth + 1, out, origCps);
    flattenCurveRecurse(kind, [m, b, q2], tm, t1, m, p1, tol, depth + 1, out, origCps);
  } else {
    const [q0, q1, q2, q3] = cps;
    const a = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2];
    const b = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    const c = [(q2[0] + q3[0]) / 2, (q2[1] + q3[1]) / 2];
    const d = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const e = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    const m = [(d[0] + e[0]) / 2, (d[1] + e[1]) / 2];
    flattenCurveRecurse(kind, [q0, a, d, m], t0, tm, p0, m, tol, depth + 1, out, origCps);
    flattenCurveRecurse(kind, [m, e, c, q3], tm, t1, m, p1, tol, depth + 1, out, origCps);
  }
}

// ---------- 3 点高斯-勒让德积分(用于曲线段精确弧长) ----------
const GL_T = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
const GL_W = [5 / 9, 8 / 9, 5 / 9];

function speedAt(seg, t) {
  if (seg.kind === 'quad') {
    const [p0, p1, p2] = seg.cps;
    const dx = 2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const dy = 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    return Math.hypot(dx, dy);
  }
  const [p0, p1, p2, p3] = seg.cps;
  const u = 1 - t;
  const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const dy = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  return Math.hypot(dx, dy);
}

function curvePieceLength(seg, t0, t1) {
  const half = (t1 - t0) / 2, mid = (t0 + t1) / 2;
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += GL_W[i] * speedAt(seg, mid + half * GL_T[i]);
  return sum * half;
}

function evalSeg(seg, t) {
  return seg.kind === 'quad'
    ? evalQuad(seg.cps[0], seg.cps[1], seg.cps[2], t)
    : evalCubic(seg.cps[0], seg.cps[1], seg.cps[2], seg.cps[3], t);
}

// ---------- 命令 -> 子路径 ----------
// commands: [["M",x,y],["L",x,y],["Q",x1,y1,x,y],["C",x1,y1,x2,y2,x,y],["Z"]]
// tol: 局部坐标下的细分容差(由导出容差/矩阵缩放折算)。
// 返回 subpaths: [{ pts, cum, length, closed, pieces }]
// pieces[i] 描述 pts[i] -> pts[i+1] 这一弦段对应的原始曲线参数区间(直线段 seg 为 null)。
export function commandsToSubpaths(commands, tol) {
  const subpaths = [];
  let cur = null; // { pts, pieces, start }
  let pen = null;

  const closePath = () => {
    if (!cur) return;
    // 闭合:若末点与起点不同,补一条回到起点的直线段
    const s = cur.pts[0], e = cur.pts[cur.pts.length - 1];
    if (Math.hypot(e[0] - s[0], e[1] - s[1]) > EPS) {
      cur.pieces.push({ p0: e, p1: s, t0: 0, t1: 1, seg: null });
      cur.pts.push([s[0], s[1]]);
    }
    cur.closed = true;
    finish();
  };

  const finish = () => {
    if (!cur) return;
    subpaths.push(cur);
    cur = null;
  };

  for (const cmd of commands) {
    const op = cmd[0];
    if (op === 'M') {
      finish();
      cur = { pts: [[cmd[1], cmd[2]]], pieces: [], closed: false };
      pen = [cmd[1], cmd[2]];
    } else if (!cur) {
      // 容错:非 M 开头忽略
      continue;
    } else if (op === 'L') {
      const p = [cmd[1], cmd[2]];
      cur.pieces.push({ p0: pen, p1: p, t0: 0, t1: 1, seg: null });
      cur.pts.push(p);
      pen = p;
    } else if (op === 'Q') {
      const cps = [pen, [cmd[1], cmd[2]], [cmd[3], cmd[4]]];
      const end = cps[2];
      const pieces = [];
      flattenCurveRecurse('quad', cps, 0, 1, pen, end, tol, 0, pieces, cps);
      for (const pc of pieces) { cur.pieces.push(pc); cur.pts.push(pc.p1); }
      pen = end;
    } else if (op === 'C') {
      const cps = [pen, [cmd[1], cmd[2]], [cmd[3], cmd[4]], [cmd[5], cmd[6]]];
      const end = cps[3];
      const pieces = [];
      flattenCurveRecurse('cubic', cps, 0, 1, pen, end, tol, 0, pieces, cps);
      for (const pc of pieces) { cur.pieces.push(pc); cur.pts.push(pc.p1); }
      pen = end;
    } else if (op === 'Z') {
      closePath();
      pen = null;
    }
  }
  finish();

  // 计算弧长表 + 清理零长弦段(重复点)
  for (const sp of subpaths) buildArcTable(sp);
  return subpaths;
}

function buildArcTable(sp) {
  // 先按精确弧长过滤零长弦段(重复点),避免坏网格
  const pts = [sp.pts[0]];
  const pieces = [];
  const cum = [0];
  let acc = 0;
  for (let i = 0; i < sp.pieces.length; i++) {
    const pc = sp.pieces[i];
    const len = pc.seg ? curvePieceLength(pc.seg, pc.t0, pc.t1)
                       : Math.hypot(pc.p1[0] - pc.p0[0], pc.p1[1] - pc.p0[1]);
    if (len <= 1e-12) continue; // 丢弃零长段
    pieces.push(pc);
    pts.push(pc.p1);
    acc += len;
    cum.push(acc);
  }
  sp.pts = pts;
  sp.pieces = pieces;
  sp.cum = cum;
  sp.length = acc;
}

// ---------- 弧长参数化查询 ----------
export function pointAtLength(sp, s) {
  const n = sp.pieces.length;
  if (n === 0) return { point: sp.pts[0].slice(), tangent: [1, 0] };
  const L = sp.length;
  let ss = s;
  if (sp.closed) { ss = ((s % L) + L) % L; } else { ss = Math.min(Math.max(s, 0), L); }
  // 二分查找所在弦段
  let lo = 0, hi = n;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (sp.cum[mid] <= ss) lo = mid; else hi = mid;
  }
  const pc = sp.pieces[lo];
  const segLen = sp.cum[lo + 1] - sp.cum[lo];
  const u = segLen > 0 ? (ss - sp.cum[lo]) / segLen : 0;
  let point, tangent;
  if (pc.seg) {
    const t = pc.t0 + u * (pc.t1 - pc.t0);
    point = evalSeg(pc.seg, t);
    // 切线用数值微分(足够稳定)
    const dt = Math.min(1e-6, (pc.t1 - pc.t0) / 4) || 1e-6;
    const pa = evalSeg(pc.seg, Math.max(pc.t0, t - dt));
    const pb = evalSeg(pc.seg, Math.min(pc.t1, t + dt));
    tangent = [pb[0] - pa[0], pb[1] - pa[1]];
  } else {
    point = [pc.p0[0] + u * (pc.p1[0] - pc.p0[0]), pc.p0[1] + u * (pc.p1[1] - pc.p0[1])];
    tangent = [pc.p1[0] - pc.p0[0], pc.p1[1] - pc.p0[1]];
  }
  const tl = Math.hypot(tangent[0], tangent[1]);
  if (tl > EPS) tangent = [tangent[0] / tl, tangent[1] / tl];
  else tangent = [1, 0];
  return { point, tangent };
}

// 截取弧长区间 [s0, s1] 上的折线(局部坐标)。s1 > s0;闭合子路径允许 s1 > length(跨接缝)。
export function sliceByLength(sp, s0, s1) {
  const out = [];
  const a = pointAtLength(sp, s0);
  out.push(a.point);
  // 收集中间折点
  const n = sp.pieces.length;
  for (let i = 0; i < n; i++) {
    // 对闭合跨接缝情形,s 可能超过 length:用取模后的累计长度比较
    let s = sp.cum[i + 1];
    if (sp.closed && s <= s0 + EPS) s += sp.length;
    if (s > s0 + EPS && s < s1 - EPS) {
      out.push(sp.pts[(i + 1) % sp.pts.length]);
    }
  }
  const b = pointAtLength(sp, s1);
  const last = out[out.length - 1];
  if (Math.hypot(b.point[0] - last[0], b.point[1] - last[1]) > 1e-9) out.push(b.point);
  // 去重(防御)
  return dedupePoints(out);
}

export function dedupePoints(pts, eps = 1e-9) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  // 闭合折线首尾去重由调用方决定
  return out;
}
