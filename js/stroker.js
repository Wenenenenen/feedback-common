// stroker.js — 虚线切割 + 描边轮廓 -> 三角网格。全部自实现,不调用任何现成描边/三角化接口。
import { EPS, pointAtLength, sliceByLength, dedupePoints } from './geometry.js';

// ---------- 虚线 ----------
// style.dash: 正数数组(奇数长度重复两遍);dashOffset: 正相位 = 沿重复图案向前移动。
// 返回 on 区间数组 [{s0, s1}](局部弧长,升序,可能跨接缝合并为 s1 > length 的区间)。
export function dashIntervals(length, dash, dashOffset, closed) {
  const none = { intervals: [], seamJoined: false };
  if (!(length > EPS)) return none;
  if (!dash || dash.length === 0) {
    return { intervals: [{ s0: 0, s1: length }], seamJoined: false };
  }
  const pat = dash.length % 2 === 1 ? dash.concat(dash) : dash.slice();
  const period = pat.reduce((a, b) => a + b, 0);
  if (!(period > EPS)) return none;
  let p0 = dashOffset % period;
  if (p0 < 0) p0 += period;
  // 定位相位落在哪一段
  let k = 0, acc = 0;
  while (k < pat.length && acc + pat[k] <= p0 + EPS) { acc += pat[k]; k++; }
  if (k >= pat.length) { k = 0; acc = 0; }
  let remain = pat[k] - (p0 - acc);
  const intervals = [];
  let pos = 0;
  let guard = 0;
  while (pos < length - EPS && guard++ < 100000) {
    const seg = Math.min(remain, length - pos);
    if (k % 2 === 0 && seg > EPS) intervals.push({ s0: pos, s1: pos + seg });
    pos += seg;
    if (seg < remain - EPS) break; // 到达路径末端
    k = (k + 1) % pat.length;
    remain = pat[k];
  }
  // 闭合路径:首区间从 0 开始、末区间到 length 结束 -> 跨接缝同属一段,接起来
  let seamJoined = false;
  if (closed && intervals.length >= 2) {
    const first = intervals[0], last = intervals[intervals.length - 1];
    if (first.s0 <= EPS && last.s1 >= length - EPS) {
      intervals.shift();
      intervals.pop();
      intervals.push({ s0: last.s0, s1: length + first.s1 });
      seamJoined = true;
    }
  }
  return { intervals, seamJoined };
}

// 把 on 区间切成折线(局部坐标)。闭合路径整体覆盖时返回 closed=true 的环。
export function dashPolylines(sp, dash, dashOffset) {
  const res = dashIntervals(sp.length, dash, dashOffset, sp.closed);
  const out = [];
  for (const iv of res.intervals) {
    if (sp.closed && iv.s0 <= EPS && iv.s1 >= sp.length - EPS) {
      // 整环:折线首尾相接,无端帽
      const pts = sp.pts.slice();
      out.push({ pts, closed: true, s0: iv.s0, s1: iv.s0 + sp.length });
    } else {
      const pts = sliceByLength(sp, iv.s0, iv.s1);
      if (pts.length >= 2) out.push({ pts, closed: false, s0: iv.s0, s1: iv.s1 });
    }
  }
  return { polylines: out, seamJoined: res.seamJoined };
}

// ---------- 三角网格构建 ----------
// 图元装配法:每弦段一个四边形(2 三角形),每个拐点按 join 补三角形,端点按 cap 补。
// 同路径内部三角形允许重叠;渲染时按路径整体一次栅格化(并集),不会因重叠变深。

function arcSteps(half, tol) {
  // 弦高 <= tol 所需的最少扇形步数(半圆)
  const t = Math.min(tol, half);
  const step = 2 * Math.acos(Math.max(-1, 1 - t / half));
  return Math.max(4, Math.ceil(Math.PI / step));
}

export function buildStrokeMesh(polylines, style, tol) {
  const half = style.width / 2;
  const positions = []; // [x0,y0,x1,y1,...] 局部坐标
  const triangles = []; // [i,j,k,...]
  const vcount = () => positions.length / 2;
  const addV = (p) => { positions.push(p[0], p[1]); return positions.length / 2 - 1; };
  const addTri = (a, b, c) => {
    if (a === b || b === c || a === c) return;
    // 统一为逆时针(局部坐标),保证同路径所有子三角形环绕方向一致,
    // 渲染时整个路径一次 nonzero 填充即为并集,重叠处不会变深也不会相消。
    const ax = positions[a * 2], ay = positions[a * 2 + 1];
    const bx = positions[b * 2], by = positions[b * 2 + 1];
    const cx = positions[c * 2], cy = positions[c * 2 + 1];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area < 0) triangles.push(a, c, b);
    else triangles.push(a, b, c);
  };

  const nArc = arcSteps(half, Math.max(tol, 1e-3));

  const emitJoin = (v, nPrev, nNext, dPrev, dNext) => {
    // nPrev/nNext: 单位左法向(未乘 half)
    const cross = dPrev[0] * dNext[1] - dPrev[1] * dNext[0];
    const dot = dPrev[0] * dNext[0] + dPrev[1] * dNext[1];
    const sides = [];
    if (cross > 1e-12) sides.push(-1);        // 右转,左侧为外侧? cross>0 为左转 -> 右侧外侧
    else if (cross < -1e-12) sides.push(1);
    else if (dot < 0) { sides.push(-1); sides.push(1); } // 近乎折返:两侧都补
    else return; // 几乎直行,四边形自然衔接
    // cross > 0(左转):左法向一侧为内侧(重叠),外侧在右 -> side = -1 表示用 -n
    for (const side of sides) {
      const s = side; // +1: 沿 +n 侧; -1: 沿 -n 侧
      const o0 = [v[0] + s * nPrev[0] * half, v[1] + s * nPrev[1] * half];
      const o1 = [v[0] + s * nNext[0] * half, v[1] + s * nNext[1] * half];
      const join = style.join;
      if (join === 'miter' && dot > -1 + 1e-9) {
        const denom = 1 + nPrev[0] * nNext[0] + nPrev[1] * nNext[1];
        if (denom > 1e-9) {
          const mx = (nPrev[0] + nNext[0]) * half / denom;
          const my = (nPrev[1] + nNext[1]) * half / denom;
          const miterRatio = Math.hypot(mx, my) / half;
          if (miterRatio <= style.miterLimit + 1e-9) {
            const iv = addV(v), i0 = addV(o0), im = addV([v[0] + s * mx, v[1] + s * my]), i1 = addV(o1);
            addTri(iv, i0, im);
            addTri(iv, im, i1);
            continue;
          }
        }
        // 超限时退化为 bevel
        const iv = addV(v), i0 = addV(o0), i1 = addV(o1);
        addTri(iv, i0, i1);
      } else if (join === 'round') {
        const a0 = Math.atan2(o0[1] - v[1], o0[0] - v[0]);
        let a1 = Math.atan2(o1[1] - v[1], o1[0] - v[0]);
        // 选择从 a0 到 a1 经过外侧的短弧
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / nArc)));
        const iv = addV(v);
        let prev = addV(o0);
        for (let i = 1; i <= steps; i++) {
          const a = a0 + (delta * i) / steps;
          const idx = addV([v[0] + Math.cos(a) * half, v[1] + Math.sin(a) * half]);
          addTri(iv, prev, idx);
          prev = idx;
        }
      } else {
        // bevel(或 miter 退化)
        const iv = addV(v), i0 = addV(o0), i1 = addV(o1);
        addTri(iv, i0, i1);
      }
    }
  };

  const emitCap = (p, dir, isStart) => {
    // dir: 该端朝路径内部的单位切向
    const cap = style.cap;
    if (cap === 'butt') return;
    const s = isStart ? 1 : -1; // 外伸方向 = -s*dir? 起点外伸 = -dir,终点外伸 = +dir
    const out = isStart ? [-dir[0], -dir[1]] : dir;
    if (cap === 'square') {
      const nx = -dir[1] * half, ny = dir[0] * half;
      const ex = out[0] * half, ey = out[1] * half;
      const a = addV([p[0] + nx, p[1] + ny]);
      const b = addV([p[0] - nx, p[1] - ny]);
      const c = addV([p[0] + nx + ex, p[1] + ny + ey]);
      const d = addV([p[0] - nx + ex, p[1] - ny + ey]);
      addTri(a, b, c);
      addTri(b, d, c);
    } else if (cap === 'round') {
      const nx = -out[1], ny = out[0]; // 垂直于外伸方向
      const a0 = Math.atan2(ny, nx);
      const ic = addV(p);
      let prev = addV([p[0] + nx * half, p[1] + ny * half]);
      const steps = nArc;
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (Math.PI * i) / steps;
        const idx = addV([p[0] + Math.cos(a) * half, p[1] + Math.sin(a) * half]);
        addTri(ic, prev, idx);
        prev = idx;
      }
    }
  };

  for (const poly of polylines) {
    let pts = dedupePoints(poly.pts, 1e-9);
    if (poly.closed && pts.length > 1) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-9) pts = pts.slice(0, -1);
    }
    const n = pts.length;
    if (n === 0) continue;

    if (n === 1 || (n === 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) <= 1e-9)) {
      // 退化点:仅 round/square 端帽可见
      const p = pts[0];
      if (style.cap === 'round') {
        const ic = addV(p);
        const steps = nArc * 2;
        let prev = addV([p[0] + half, p[1]]);
        for (let i = 1; i <= steps; i++) {
          const a = (2 * Math.PI * i) / steps;
          const idx = addV([p[0] + Math.cos(a) * half, p[1] + Math.sin(a) * half]);
          addTri(ic, prev, idx);
          prev = idx;
        }
      } else if (style.cap === 'square') {
        const a = addV([p[0] - half, p[1] - half]), b = addV([p[0] + half, p[1] - half]);
        const c = addV([p[0] + half, p[1] + half]), d = addV([p[0] - half, p[1] + half]);
        addTri(a, b, c); addTri(a, c, d);
      }
      continue;
    }

    const segCount = poly.closed ? n : n - 1;
    const dirs = [], norms = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (l <= 1e-12) { dirs.push(null); norms.push(null); continue; }
      dx /= l; dy /= l;
      dirs.push([dx, dy]);
      norms.push([-dy, dx]); // 左法向(单位)
    }

    // 弦段四边形
    for (let i = 0; i < segCount; i++) {
      if (!dirs[i]) continue;
      const a = pts[i], b = pts[(i + 1) % n];
      const nx = norms[i][0] * half, ny = norms[i][1] * half;
      const i0 = addV([a[0] + nx, a[1] + ny]);
      const i1 = addV([a[0] - nx, a[1] - ny]);
      const i2 = addV([b[0] + nx, b[1] + ny]);
      const i3 = addV([b[0] - nx, b[1] - ny]);
      addTri(i0, i1, i2);
      addTri(i1, i3, i2);
    }

    // 拐点
    const jointCount = poly.closed ? n : n - 2;
    for (let j = 0; j < jointCount; j++) {
      const vi = poly.closed ? j : j + 1;
      const iPrev = (vi - 1 + segCount) % segCount;
      const iNext = vi % segCount;
      if (!dirs[iPrev] || !dirs[iNext]) continue;
      emitJoin(pts[vi], norms[iPrev], norms[iNext], dirs[iPrev], dirs[iNext]);
    }

    // 端帽
    if (!poly.closed) {
      if (dirs[0]) emitCap(pts[0], dirs[0], true);
      if (dirs[segCount - 1]) emitCap(pts[n - 1], dirs[segCount - 1], false);
    }
  }

  return { positions, triangles, vertexCount: vcount() };
}
