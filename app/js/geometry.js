// 纯几何核心：四边形校验、单应矩阵、距离与权重。无浏览器依赖，可在 Node 中单测。
(function (global) {
  'use strict';

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  // 校验四角（顺序 TL, TR, BR, BL）。返回 { ok, reason }
  // 拒绝：退化（重合/共线）、凹、自交。
  function validateQuad(q) {
    if (!Array.isArray(q) || q.length !== 4) {
      return { ok: false, reason: '四角必须为 4 个坐标点' };
    }
    for (const p of q) {
      if (!Array.isArray(p) || p.length !== 2 ||
          !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        return { ok: false, reason: '存在无效坐标' };
      }
    }
    const EPS = 1e-9;
    // 退化：任意相邻点重合
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS) {
        return { ok: false, reason: '退化四边形：存在相邻重合点' };
      }
    }
    // 有向叉积：凸且同向（含共线边 -> 面积退化）
    const crosses = [];
    let area2 = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const e1x = b[0] - a[0], e1y = b[1] - a[1];
      const e2x = c[0] - b[0], e2y = c[1] - b[1];
      const cr = cross(e1x, e1y, e2x, e2y);
      crosses.push(cr);
      area2 += cross(a[0], a[1], b[0], b[1]);
    }
    if (Math.abs(area2) <= EPS) {
      return { ok: false, reason: '退化四边形：面积为零（共线）' };
    }
    if (crosses.some((c) => Math.abs(c) <= EPS)) {
      return { ok: false, reason: '退化四边形：存在共线相邻边' };
    }
    const sign = area2 > 0 ? 1 : -1;
    if (crosses.some((c) => Math.sign(c) !== sign)) {
      // 顶点顺序固定为 TL,TR,BR,BL，正常为凸；符号不一致 => 凹或自交
      return { ok: false, reason: '四边形为凹或自交，必须为凸四边形' };
    }
    // 额外保险：非相邻边（对边）不相交（凸性已保证，防御性检查）
    if (segmentsIntersect(q[0], q[1], q[2], q[3]) ||
        segmentsIntersect(q[1], q[2], q[3], q[0])) {
      return { ok: false, reason: '四边形自交' };
    }
    return { ok: true, reason: '' };
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    function ccw(a, b, c) {
      return cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
    }
    const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2);
    const d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  // DLT 单应：src 四点 -> dst 四点，返回行优先 3x3（h33=1）
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      [M[col], M[piv]] = [M[piv], M[col]];
      const d = M[col][col];
      if (Math.abs(d) < 1e-12) throw new Error('单应矩阵求解失败：矩阵奇异');
      for (let k = 0; k <= n; k++) M[col][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let k = 0; k <= n; k++) M[r][k] -= f * M[col][k];
      }
    }
    const h = M.map((row) => row[n]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function invert3(m) {
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-12) throw new Error('矩阵不可逆');
    const idet = 1 / det;
    const c = new Array(9);
    c[0] = (m[4] * m[8] - m[5] * m[7]) * idet;
    c[1] = (m[2] * m[7] - m[1] * m[8]) * idet;
    c[2] = (m[1] * m[5] - m[2] * m[4]) * idet;
    c[3] = (m[5] * m[6] - m[3] * m[8]) * idet;
    c[4] = (m[0] * m[8] - m[2] * m[6]) * idet;
    c[5] = (m[2] * m[3] - m[0] * m[5]) * idet;
    c[6] = (m[3] * m[7] - m[4] * m[6]) * idet;
    c[7] = (m[1] * m[6] - m[0] * m[7]) * idet;
    c[8] = (m[0] * m[4] - m[1] * m[3]) * idet;
    return c;
  }

  // 用 H 映射点（H 行优先 3x3）
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [
      (H[0] * x + H[1] * y + H[2]) / w,
      (H[3] * x + H[4] * y + H[5]) / w
    ];
  }

  // 凸四边形四条边的内侧有符号距离线，内部点满足 a*x+b*y+c >= 0
  function edgeLines(quad) {
    const n = quad.length;
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = quad[i], b = quad[(i + 1) % n];
      area2 += cross(a[0], a[1], b[0], b[1]);
    }
    const s = area2 > 0 ? 1 : -1;
    const cx = quad.reduce((t, p) => t + p[0], 0) / n;
    const cy = quad.reduce((t, p) => t + p[1], 0) / n;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = quad[i];
      const [x2, y2] = quad[(i + 1) % n];
      let a = y2 - y1, b = x1 - x2, c = x2 * y1 - x1 * y2;
      const norm = Math.hypot(a, b);
      a /= norm; b /= norm; c /= norm;
      if ((a * cx + b * cy + c) * s < 0) { a = -a; b = -b; c = -c; }
      lines.push([a, b, c]);
    }
    return lines;
  }

  // 点在凸四边形内（含边界），同时返回到四边的有符号距离
  function pointInsideQuad(quad, x, y) {
    const lines = edgeLines(quad);
    let minD = Infinity;
    for (const [a, b, c] of lines) {
      const d = a * x + b * y + c;
      if (d < -1e-9) return { inside: false, minDistance: 0, distances: lines.map((l) => l[0] * x + l[1] * y + l[2]) };
      if (d < minD) minD = d;
    }
    return { inside: true, minDistance: Math.max(0, minD), distances: lines.map((l) => l[0] * x + l[1] * y + l[2]) };
  }

  // 融合权重（规格固定规则）
  // coverMask: 各投影是否覆盖该点；raw: 各投影原始权重 min(1, d/feather)
  function blendWeights(coverMask, raw, feather) {
    const n = coverMask.length;
    const raws = coverMask.map((cov, i) => (cov ? Math.min(1, raw[i] / feather) : 0));
    const total = raws.reduce((t, w) => t + w, 0);
    const coverCount = coverMask.reduce((t, c) => t + (c ? 1 : 0), 0);
    if (coverCount === 0) return new Array(n).fill(0);
    if (coverCount === 1) return coverMask.map((c) => (c ? 1 : 0));
    if (total <= 0) {
      // 权重总和为零：覆盖者均分
      return coverMask.map((c) => (c ? 1 / coverCount : 0));
    }
    return raws.map((w) => w / total);
  }

  // 帧缓冲角点（像素中心采样，角点对应边界四角）
  function frameCorners(width, height) {
    return [[0, 0], [width, 0], [width, height], [0, height]];
  }

  global.Geo = {
    validateQuad,
    homography,
    invert3,
    applyH,
    edgeLines,
    pointInsideQuad,
    blendWeights,
    frameCorners
  };
})(typeof window !== 'undefined' ? window : globalThis);
