/*
 * Poisson 无缝合成核心求解器。
 * 同时被 Web Worker（importScripts）与 Node 测试（require）使用。
 *
 * 约定（见 samples/cases/约定.json）：
 *  - 8 位 sRGB 按标准分段传递函数解码到线性 RGB 后求解，显示/导出时才编码回 sRGB。
 *  - 有效区域 = 平移后的掩膜与底图画布的交集；目标坐标 = 源坐标 + (dx, dy)。
 *  - 对每个区域内像素 p，只枚举画布内四邻 q，度数 deg(p) 为画布内邻居数：
 *      deg(p)*u(p) - sum(q 为未知量, u(q)) = sum(g(p,q)) + sum(q 非未知量, target(q))
 *    画布外邻居不计入。
 *  - 引导梯度 g(p,q)：源邻居存在（q-(dx,dy) 在源图内）时为 source(p)-source(q)，
 *    否则退回底图梯度 target(p)-target(q)；混合模式取两种 RGB 向量平方模较大者，平局取源。
 *  - 若整个画布均被选中，以左上像素固定为底图值作为锚点，其余方程照常求解。
 *  - 相对残差 = ||Au-b||2 / max(||b||2, 1e-12)，三通道分别报告，空区域为 0。
 */
(function (global) {
  'use strict';

  // 标准分段 sRGB 传递函数：8 位 -> 线性
  var S2L = new Float64Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // 线性 -> 8 位 sRGB（仅用于显示/导出 PNG，限幅只发生在这里，不影响求解）
  function linearToSrgbByte(x) {
    var c = x;
    if (Number.isNaN(c)) c = 0;
    if (c < 0) c = 0; else if (c > 1) c = 1;
    var s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    var v = Math.round(s * 255);
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  function bytesToLinear(bytes, n) {
    var out = new Float64Array(n * 3);
    for (var i = 0; i < n * 3; i++) out[i] = S2L[bytes[i]];
    return out;
  }

  /**
   * 求解 Poisson 方程。
   * params: {
   *   srcBytes: Uint8Array(srcW*srcH*3), srcW, srcH,   // 源图 8 位 sRGB
   *   tgtBytes: Uint8Array(tgtW*tgtH*3), tgtW, tgtH,   // 底图 8 位 sRGB
   *   mask: Uint8Array(srcW*srcH),                     // 非零=选中（与源图同尺寸）
   *   dx, dy,                                          // 整数平移：目标坐标 = 源坐标 + (dx,dy)
   *   mode: 'source' | 'mixed',                        // 源梯度 / 混合梯度
   *   tol: 相对残差收敛阈值, maxIter: 每通道最大迭代次数
   * }
   * onProgress(channel, iter, relres) 可选。
   * 返回 { solution(线性未限幅 Float64Array tgtW*tgtH*3), regionPixels, anchored,
   *        bbox:{x,y,width,height}|null, residuals[3], iterations[3], converged[3],
   *        rangeMin[3], rangeMax[3] }
   */
  function solve(params, onProgress) {
    var srcW = params.srcW, srcH = params.srcH;
    var tgtW = params.tgtW, tgtH = params.tgtH;
    var dx = params.dx | 0, dy = params.dy | 0;
    var mode = params.mode === 'mixed' ? 'mixed' : 'source';
    var tol = params.tol > 0 ? params.tol : 1e-8;
    var maxIter = params.maxIter > 0 ? params.maxIter : 3000;

    var np = tgtW * tgtH;
    var tgt = bytesToLinear(params.tgtBytes, np);
    var src = bytesToLinear(params.srcBytes, srcW * srcH);
    var mask = params.mask;

    // ---- 有效区域：平移掩膜 ∩ 画布 ----
    var inRegion = new Uint8Array(np);
    var count = 0;
    var bx0 = tgtW, by0 = tgtH, bx1 = -1, by1 = -1;
    for (var sy = 0; sy < srcH; sy++) {
      var ty = sy + dy;
      if (ty < 0 || ty >= tgtH) continue;
      for (var sx = 0; sx < srcW; sx++) {
        if (!mask[sy * srcW + sx]) continue;
        var tx = sx + dx;
        if (tx < 0 || tx >= tgtW) continue;
        inRegion[ty * tgtW + tx] = 1;
        count++;
        if (tx < bx0) bx0 = tx;
        if (tx > bx1) bx1 = tx;
        if (ty < by0) by0 = ty;
        if (ty > by1) by1 = ty;
      }
    }
    var hadRegion = count > 0;
    var bbox = hadRegion ? { x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 } : null;

    // ---- 奇异区域：整幅画布被选中时，左上角固定为底图值作为锚点 ----
    var anchored = false;
    if (count === np && np > 0) {
      inRegion[0] = 0; // 锚点不再是未知量，其值固定为 target(0,0)
      count--;
      anchored = true;
    }

    // 未知量编号
    var idx = new Int32Array(np);
    idx.fill(-1);
    var upix = new Int32Array(count); // 未知量 -> 画布像素
    var n = 0;
    for (var p0 = 0; p0 < np; p0++) {
      if (inRegion[p0]) { idx[p0] = n; upix[n] = p0; n++; }
    }

    var emptyResult = {
      solution: tgt,
      regionPixels: n,
      anchored: anchored,
      bbox: bbox,
      residuals: [0, 0, 0],
      iterations: [0, 0, 0],
      converged: [true, true, true],
      rangeMin: [0, 0, 0],
      rangeMax: [0, 0, 0]
    };
    if (n === 0) {
      if (hadRegion) { // 仅锚点（如 1×1 全选）：值即底图值
        for (var ch0 = 0; ch0 < 3; ch0++) {
          emptyResult.rangeMin[ch0] = tgt[ch0];
          emptyResult.rangeMax[ch0] = tgt[ch0];
        }
      }
      return emptyResult;
    }

    // ---- 构造 deg、未知量邻居表、右端项 b（含引导梯度与边界项）----
    var deg = new Float64Array(n);
    var nbr = new Int32Array(n * 4);
    nbr.fill(-1);
    var b = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    var OX = [-1, 1, 0, 0], OY = [0, 0, -1, 1];

    for (var y = 0; y < tgtH; y++) {
      for (var x = 0; x < tgtW; x++) {
        var i = idx[y * tgtW + x];
        if (i < 0) continue;
        var spx = x - dx, spy = y - dy; // p 在源图中的坐标（必在源图内）
        var sBase = (spy * srcW + spx) * 3;
        var tBase = (y * tgtW + x) * 3;
        var d = 0, k = 0;
        for (var o = 0; o < 4; o++) {
          var qx = x + OX[o], qy = y + OY[o];
          if (qx < 0 || qy < 0 || qx >= tgtW || qy >= tgtH) continue; // 画布外不计入
          d++;
          var qi = idx[qy * tgtW + qx];
          nbr[i * 4 + k] = qi;
          k++;
          var tBase2 = (qy * tgtW + qx) * 3;
          var sqx = qx - dx, sqy = qy - dy;
          var srcAvail = sqx >= 0 && sqy >= 0 && sqx < srcW && sqy < srcH;
          var g0, g1, g2;
          if (mode === 'mixed') {
            // 底图梯度向量
            var t0 = tgt[tBase] - tgt[tBase2];
            var t1 = tgt[tBase + 1] - tgt[tBase2 + 1];
            var t2 = tgt[tBase + 2] - tgt[tBase2 + 2];
            g0 = t0; g1 = t1; g2 = t2;
            if (srcAvail) {
              var sBase2 = (sqy * srcW + sqx) * 3;
              var s0 = src[sBase] - src[sBase2];
              var s1 = src[sBase + 1] - src[sBase2 + 1];
              var s2 = src[sBase + 2] - src[sBase2 + 2];
              // 平方模较大者，平局取源
              if (s0 * s0 + s1 * s1 + s2 * s2 >= t0 * t0 + t1 * t1 + t2 * t2) {
                g0 = s0; g1 = s1; g2 = s2;
              }
            }
          } else if (srcAvail) {
            var sb2 = (sqy * srcW + sqx) * 3;
            g0 = src[sBase] - src[sb2];
            g1 = src[sBase + 1] - src[sb2 + 1];
            g2 = src[sBase + 2] - src[sb2 + 2];
          } else {
            g0 = tgt[tBase] - tgt[tBase2];
            g1 = tgt[tBase + 1] - tgt[tBase2 + 1];
            g2 = tgt[tBase + 2] - tgt[tBase2 + 2];
          }
          b[0][i] += g0;
          b[1][i] += g1;
          b[2][i] += g2;
          if (qi < 0) { // 边界（区域外邻居或锚点）：Dirichlet 项
            b[0][i] += tgt[tBase2];
            b[1][i] += tgt[tBase2 + 1];
            b[2][i] += tgt[tBase2 + 2];
          }
        }
        deg[i] = d;
      }
    }

    // ---- 预条件共轭梯度（Jacobi）逐通道求解 ----
    var u = new Float64Array(n);
    var r = new Float64Array(n);
    var z = new Float64Array(n);
    var pj = new Float64Array(n);
    var ap = new Float64Array(n);

    function applyA(v, out) {
      for (var i2 = 0; i2 < n; i2++) {
        var s = deg[i2] * v[i2];
        var base = i2 * 4;
        var j0 = nbr[base], j1 = nbr[base + 1], j2 = nbr[base + 2], j3 = nbr[base + 3];
        if (j0 >= 0) s -= v[j0];
        if (j1 >= 0) s -= v[j1];
        if (j2 >= 0) s -= v[j2];
        if (j3 >= 0) s -= v[j3];
        out[i2] = s;
      }
    }

    var solution = new Float64Array(np * 3);
    solution.set(tgt); // 区域外保持底图值
    var residuals = [0, 0, 0];
    var iterations = [0, 0, 0];
    var converged = [true, true, true];
    var rangeMin = [Infinity, Infinity, Infinity];
    var rangeMax = [-Infinity, -Infinity, -Infinity];

    for (var ch = 0; ch < 3; ch++) {
      var bc = b[ch];
      var normB = 0;
      var i3;
      for (i3 = 0; i3 < n; i3++) normB += bc[i3] * bc[i3];
      normB = Math.sqrt(normB);
      var denom = normB > 1e-12 ? normB : 1e-12;

      // 初值取底图（直接粘贴），通常已是良好猜测
      for (i3 = 0; i3 < n; i3++) u[i3] = tgt[upix[i3] * 3 + ch];

      // r = b - A u
      applyA(u, ap);
      var rz = 0;
      for (i3 = 0; i3 < n; i3++) {
        r[i3] = bc[i3] - ap[i3];
        z[i3] = r[i3] / deg[i3];
        pj[i3] = z[i3];
        rz += r[i3] * z[i3];
      }

      var it = 0, conv = false;
      var rnorm0 = 0;
      for (i3 = 0; i3 < n; i3++) rnorm0 += r[i3] * r[i3];
      if (Math.sqrt(rnorm0) / denom <= tol) {
        conv = true;
      }
      while (!conv && it < maxIter) {
        applyA(pj, ap);
        var pap = 0;
        for (i3 = 0; i3 < n; i3++) pap += pj[i3] * ap[i3];
        if (pap === 0) break; // 数值退化，停止
        var alpha = rz / pap;
        var rn = 0;
        for (i3 = 0; i3 < n; i3++) {
          u[i3] += alpha * pj[i3];
          r[i3] -= alpha * ap[i3];
          rn += r[i3] * r[i3];
        }
        it++;
        var relres = Math.sqrt(rn) / denom;
        if (onProgress && (it & 15) === 0) onProgress(ch, it, relres);
        if (relres <= tol) { conv = true; break; }
        var rz2 = 0;
        for (i3 = 0; i3 < n; i3++) {
          z[i3] = r[i3] / deg[i3];
          rz2 += r[i3] * z[i3];
        }
        var beta = rz2 / rz;
        rz = rz2;
        for (i3 = 0; i3 < n; i3++) pj[i3] = z[i3] + beta * pj[i3];
      }

      // 报告真实相对残差 ||Au-b|| / max(||b||,1e-12)
      applyA(u, ap);
      var rr = 0;
      for (i3 = 0; i3 < n; i3++) {
        var e = ap[i3] - bc[i3];
        rr += e * e;
      }
      residuals[ch] = Math.sqrt(rr) / denom;
      iterations[ch] = it;
      converged[ch] = conv;

      var mn = Infinity, mx = -Infinity;
      for (i3 = 0; i3 < n; i3++) {
        var v = u[i3];
        solution[upix[i3] * 3 + ch] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      rangeMin[ch] = mn;
      rangeMax[ch] = mx;
    }

    return {
      solution: solution,
      regionPixels: n,
      anchored: anchored,
      bbox: bbox,
      residuals: residuals,
      iterations: iterations,
      converged: converged,
      rangeMin: rangeMin,
      rangeMax: rangeMax
    };
  }

  var api = {
    solve: solve,
    srgbByteToLinear: function (v) { return S2L[v]; },
    linearToSrgbByte: linearToSrgbByte
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.PoissonSolver = api;
  }
})(typeof self !== 'undefined' ? self : this);
