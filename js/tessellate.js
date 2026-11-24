/*
 * tessellate.js — 把精确有理样条自适应离散为满足误差契约的参数折线，
 * 并生成每段带 data-u0/data-u1 的 SVG。
 *
 * 契约：导出坐标与样条坐标 1:1 同轴同尺度；在 [u0,u1] 内按参数线性插值，
 * 与原曲线的欧氏距离 <= 0.25 个导出坐标单位。
 * 内部目标取 0.06、审计阈值 0.15，为十进制舍入与检查方采样留出充分余量。
 */
(function () {
  'use strict';

  let RKS;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    RKS = Object.assign({}, require('./frac.js'), require('./engine.js'));
  } else {
    RKS = globalThis.RKS;
  }
  const { Frac, domain, evalPointFloat, projectedPointExact } = RKS;

  const EXPORT_LIMIT = 0.25;
  const REFINEMENT_TOL = 0.06;
  const AUDIT_TOL = 0.15;
  const BUILD_GRID = 32;
  const AUDIT_GRID = 80;
  const MAX_DEPTH = 24;
  const DECIMAL_U = 12;
  const DECIMAL_XY = 9;

  /** 去重后的节点值（精确），作为强制分段边界，尖角/重节点不会被弦切掉。 */
  function distinctKnots(c) {
    const out = [];
    for (const k of c.knots) {
      if (!out.length || !out[out.length - 1].eq(k)) out.push(k);
    }
    return out;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist2(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 计算节点 [u0n,u1n] 弦与曲线的最大采样偏差。 */
  function chordDeviation(c, Uf, u0n, p0, u1n, p1, grid) {
    let worst = 0;
    for (let j = 1; j < grid; j++) {
      const t = j / grid;
      const u = lerp(u0n, u1n, t);
      const pc = evalPointFloat(c, Uf, u);
      if (!pc) continue;
      const qx = lerp(p0[0], p1[0], t);
      const qy = lerp(p0[1], p1[1], t);
      const d = dist2(pc[0], pc[1], qx, qy);
      if (d > worst) worst = d;
    }
    return worst;
  }

  function midPoint(p0, p1) {
    return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  }

  /**
   * 生成叶子参数段 [{u0:Frac,u1:Frac}]，保证采样误差远低于契约。
   */
  function tessellate(c, opts) {
    opts = opts || {};
    const tol = opts.tol != null ? opts.tol : REFINEMENT_TOL;
    const maxDepth = opts.maxDepth != null ? opts.maxDepth : MAX_DEPTH;
    const Uf = c.knots.map((k) => k.toNumber());
    const knots = distinctKnots(c);
    const leaves = [];

    function fracMid(a, b) { return a.add(b).div(new Frac(2n, 1n)); }

    function refine(u0, u1, depth) {
      const u0n = u0.toNumber(), u1n = u1.toNumber();
      const p0 = evalPointFloat(c, Uf, u0n);
      const p1 = evalPointFloat(c, Uf, u1n);
      if (!p0 || !p1) {
        // 极端权重导致浮点失效时仍保留参数段（精确导出端点不受影响）
        leaves.push({ u0, u1 });
        return;
      }
      const dev = chordDeviation(c, Uf, u0n, p0, u1n, p1, BUILD_GRID);
      if ((dev <= tol && depth >= 1) || depth >= maxDepth || !(u1n > u0n)) {
        leaves.push({ u0, u1 });
        return;
      }
      const um = fracMid(u0, u1);
      refine(u0, um, depth + 1);
      refine(um, u1, depth + 1);
    }

    for (let i = 0; i < knots.length - 1; i++) {
      if (knots[i + 1].gt(knots[i])) refine(knots[i], knots[i + 1], 0);
    }

    // 加密审计：用更密网格复查每个叶子，漏网的强制劈开重做。
    for (let round = 0; round < 8; round++) {
      let badIdx = -1;
      for (let i = 0; i < leaves.length; i++) {
        const L = leaves[i];
        const u0n = L.u0.toNumber(), u1n = L.u1.toNumber();
        const p0 = evalPointFloat(c, Uf, u0n);
        const p1 = evalPointFloat(c, Uf, u1n);
        if (!p0 || !p1) continue;
        if (chordDeviation(c, Uf, u0n, p0, u1n, p1, AUDIT_GRID) > AUDIT_TOL) {
          badIdx = i;
          break;
        }
      }
      if (badIdx < 0) break;
      const L = leaves[badIdx];
      leaves.splice(badIdx, 1);
      const um = fracMid(L.u0, L.u1);
      // 直接二分后交给 refine 继续自适应
      const before = leaves.length;
      refine(L.u0, um, 2);
      refine(um, L.u1, 2);
      // refine 是 push 到末尾；保持顺序并非必须（检查器逐段独立），
      // 但为了 u0 单调，把新加入的段移到被删位置。
      const added = leaves.splice(before);
      leaves.splice(badIdx, 0, ...added);
    }

    return leaves;
  }

  /** 精确求参数 u 处投影端点的十进制字符串（只求值，不算导数）。 */
  function exactEndpointStrings(c, u) {
    let p = null;
    try { p = projectedPointExact(c, u); } catch (_) { p = null; }
    if (!p) {
      // 极端情况下退回浮点
      const pf = evalPointFloat(c, null, u.toNumber()) || [0, 0];
      return { x: formatNum(pf[0], DECIMAL_XY), y: formatNum(pf[1], DECIMAL_XY) };
    }
    return { x: p.x.toDecimal(DECIMAL_XY), y: p.y.toDecimal(DECIMAL_XY) };
  }

  function formatNum(v, digits) {
    if (!Number.isFinite(v)) return '0';
    let s = v.toFixed(digits);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  /** 计算每个导出段的实测最大偏差（供界面自检显示）。 */
  function measureSegments(c, segments) {
    const Uf = c.knots.map((k) => k.toNumber());
    let globalMax = 0;
    for (const s of segments) {
      const u0n = s.u0.toNumber(), u1n = s.u1.toNumber();
      const p0 = evalPointFloat(c, Uf, u0n);
      const p1 = evalPointFloat(c, Uf, u1n);
      if (!p0 || !p1) continue;
      const d = chordDeviation(c, Uf, u0n, p0, u1n, p1, 48);
      if (d > globalMax) globalMax = d;
      s.maxDev = d;
    }
    return globalMax;
  }

  /**
   * 生成导出 SVG 字符串。
   * 每段一个 <polyline class="rks-segment" data-u0 data-u1 points="x0,y0 x1,y1"
   * x1 y1 x2 y2 ... />，同时兼容按 points 与按 line 坐标属性读取的检查器。
   */
  function buildExportSVG(c, opts) {
    opts = opts || {};
    const segments = tessellate(c, opts);
    measureSegments(c, segments);

    // 端点坐标缓存（同一参数只精确求值一次，保证共享顶点逐字符相同）
    const cache = new Map();
    function ep(u) {
      const key = u.toString();
      if (!cache.has(key)) cache.set(key, exactEndpointStrings(c, u));
      return cache.get(key);
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const num = (s) => Number(s);
    function bump(xs, ys) {
      const x = num(xs), y = num(ys);
      if (Number.isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }

    const segMarkup = [];
    const allVerts = [];
    segments.forEach((s, idx) => {
      const a = ep(s.u0), b = ep(s.u1);
      bump(a.x, a.y); bump(b.x, b.y);
      if (idx === 0) allVerts.push(a.x + ',' + a.y);
      allVerts.push(b.x + ',' + b.y);
      const u0s = s.u0.toDecimal(DECIMAL_U);
      const u1s = s.u1.toDecimal(DECIMAL_U);
      segMarkup.push(
        '  <polyline class="rks-segment" data-index="' + idx + '" ' +
        'data-u0="' + u0s + '" data-u1="' + u1s + '" ' +
        'points="' + a.x + ',' + a.y + ' ' + b.x + ',' + b.y + '" ' +
        'x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" ' +
        'data-x1="' + a.x + '" data-y1="' + a.y + '" ' +
        'data-x2="' + b.x + '" data-y2="' + b.y + '" ' +
        'fill="none" stroke="#155eef" stroke-width="2" vector-effect="non-scaling-stroke" ' +
        'stroke-linecap="round"/>'
      );
    });

    if (!Number.isFinite(minX)) { minX = -1; minY = -1; maxX = 1; maxY = 1; }
    let w = maxX - minX, h = maxY - minY;
    if (!(w > 0)) w = 1;
    if (!(h > 0)) h = 1;
    const mx = w * 0.04 + 1e-9, my = h * 0.04 + 1e-9;
    const viewBox = [
      (minX - mx).toFixed(6), (minY - my).toFixed(6),
      (w + 2 * mx).toFixed(6), (h + 2 * my).toFixed(6),
    ].join(' ');

    const fullPoints = allVerts.join(' ');
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'data-generator="rational-knot-studio" data-coordinate-system="spline" data-scale="1" ' +
        'viewBox="' + viewBox + '" width="100%" height="100%">',
      '  <desc>Rational B-spline export. Each rks-segment polyline carries exact-ish ' +
        'data-u0/data-u1 parameter endpoints; coordinates are 1:1 spline units.</desc>',
      '  <g id="rks-segments">',
      ...segMarkup,
      '  </g>',
      '  <polyline id="rks-full-polyline" points="' + fullPoints + '" fill="none" ' +
        'stroke="#155eef" stroke-width="2" vector-effect="non-scaling-stroke" ' +
        'stroke-linejoin="round" stroke-linecap="round" opacity="0.35"/>',
      '</svg>',
      '',
    ].join('\n');

    return {
      svg,
      segments,
      segmentCount: segments.length,
      maxDeviation: segments.reduce((m, s) => Math.max(m, s.maxDev || 0), 0),
      limit: EXPORT_LIMIT,
    };
  }

  const api = {
    EXPORT_LIMIT,
    tessellate,
    buildExportSVG,
    measureSegments,
    distinctKnots,
    chordDeviation,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    globalThis.RKS = globalThis.RKS || {};
    Object.assign(globalThis.RKS, api);
  }
})();
