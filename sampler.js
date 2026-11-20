/* sampler.js — 椭圆足迹采样核心，无 DOM 依赖，可在 Worker(importScripts) 与主线程中运行。
   数学与 cases-extracted/说明.txt 逐字对应，并已对照 reference.json 验证到机器精度。 */
(function (global) {
  'use strict';

  function srgbToLinear(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSRGBByte(l) {
    if (l <= 0) return 0;
    var v = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  // i 可为负；repeat 正模 N，mirror 先正模 2N 再镜像，clamp 夹取
  function wrapIndex(i, n, mode) {
    if (mode === 'repeat') {
      return ((i % n) + n) % n;
    }
    if (mode === 'mirror') {
      var m = ((i % (2 * n)) + 2 * n) % (2 * n);
      return m < n ? m : 2 * n - 1 - m;
    }
    return i < 0 ? 0 : (i >= n ? n - 1 : i);
  }

  // imageData: 8-bit RGBA；转成线性、straight alpha 的 Float32Array
  function makeTexture(imageData) {
    var d = imageData.data, w = imageData.width, h = imageData.height;
    var lin = new Float32Array(w * h * 4);
    for (var k = 0; k < w * h; k++) {
      lin[k * 4] = srgbToLinear(d[k * 4]);
      lin[k * 4 + 1] = srgbToLinear(d[k * 4 + 1]);
      lin[k * 4 + 2] = srgbToLinear(d[k * 4 + 2]);
      lin[k * 4 + 3] = d[k * 4 + 3] / 255;
    }
    return { w: w, h: h, lin: lin };
  }

  function fetchLinear(tex, i, j, mode) {
    var ii = wrapIndex(i, tex.w, mode);
    var jj = wrapIndex(j, tex.h, mode);
    var k = (jj * tex.w + ii) * 4;
    return { r: tex.lin[k], g: tex.lin[k + 1], b: tex.lin[k + 2], a: tex.lin[k + 3], i: ii, j: jj };
  }

  function project(H, X, Y) {
    var a = H[0] * X + H[1] * Y + H[2];
    var b = H[3] * X + H[4] * Y + H[5];
    var w = H[6] * X + H[7] * Y + H[8];
    return { a: a, b: b, w: w };
  }

  // J = s,t 对 x,y 的导数（投影函数商的导数）
  function jacobian(H, X, Y, a, b, w) {
    var w2 = w * w;
    return {
      dsdx: (H[0] * w - a * H[6]) / w2,
      dsdy: (H[1] * w - a * H[7]) / w2,
      dtdx: (H[3] * w - b * H[6]) / w2,
      dtdy: (H[4] * w - b * H[7]) / w2
    };
  }

  // C = J Jᵀ + 0.25I，对称 2×2 特征分解 + 各向异性限制（保持特征方向）
  function analyzeFootprint(J, aniso) {
    var c00 = J.dsdx * J.dsdx + J.dsdy * J.dsdy + 0.25;
    var c01 = J.dsdx * J.dtdx + J.dsdy * J.dtdy;
    var c11 = J.dtdx * J.dtdx + J.dtdy * J.dtdy + 0.25;
    var tr = c00 + c11;
    var det = c00 * c11 - c01 * c01;
    var half = tr * 0.5;
    var disc = Math.sqrt(Math.max(0, half * half - det));
    var lamMax = half + disc;
    var lamMin = half - disc;
    var lamMinLimited = Math.max(lamMin, lamMax / (aniso * aniso));

    var ex, ey; // λmax 特征方向
    if (Math.abs(c01) > 1e-12) {
      ex = c01; ey = lamMax - c00;
      var n = Math.hypot(ex, ey);
      ex /= n; ey /= n;
    } else {
      if (c00 >= c11) { ex = 1; ey = 0; } else { ex = 0; ey = 1; }
    }
    var vx = -ey, vy = ex; // λmin 特征方向

    // 限制后 C' 的逆：C'⁻¹ = v₁v₁ᵀ/λmax + v₂v₂ᵀ/λmin'
    var inv00 = ex * ex / lamMax + vx * vx / lamMinLimited;
    var inv01 = ex * ey / lamMax + vx * vy / lamMinLimited;
    var inv11 = ey * ey / lamMax + vy * vy / lamMinLimited;

    return {
      c00: c00, c01: c01, c11: c11,
      lamMax: lamMax, lamMin: lamMin, lamMinLimited: lamMinLimited,
      axisMajor: { x: ex, y: ey }, axisMinor: { x: vx, y: vy },
      rMajor: Math.sqrt(lamMax), rMinor: Math.sqrt(lamMinLimited),
      ratioRaw: Math.sqrt(lamMax / Math.max(lamMin, 1e-300)),
      ratioLimited: Math.sqrt(lamMax / lamMinLimited),
      inv00: inv00, inv01: inv01, inv11: inv11,
      angle: Math.atan2(ey, ex)
    };
  }

  function emptyResult() {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  function nearest(tex, s, t, mode) {
    var c = fetchLinear(tex, Math.floor(s), Math.floor(t), mode);
    if (c.a <= 0) return emptyResult();
    return { r: c.r, g: c.g, b: c.b, a: c.a };
  }

  // 中心网格双线性，四角各自独立寻址
  function bilinear(tex, s, t, mode) {
    var i0 = Math.floor(s - 0.5), j0 = Math.floor(t - 0.5);
    var u = s - (i0 + 0.5), v = t - (j0 + 0.5);
    var ar = 0, ag = 0, ab = 0, aa = 0;
    var taps = [
      [0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)],
      [0, 1, (1 - u) * v], [1, 1, u * v]
    ];
    for (var z = 0; z < 4; z++) {
      var c = fetchLinear(tex, i0 + taps[z][0], j0 + taps[z][1], mode);
      var wt = taps[z][2];
      ar += wt * c.r * c.a; ag += wt * c.g * c.a; ab += wt * c.b * c.a; aa += wt * c.a;
    }
    if (aa <= 0) return emptyResult();
    return { r: ar / aa, g: ag / aa, b: ab / aa, a: aa };
  }

  // 椭圆足迹加权采样；返回颜色与完整贡献清单
  function elliptic(tex, s, t, fp, mode) {
    var x0 = Math.floor(s - fp.rMajor), x1 = Math.ceil(s + fp.rMajor);
    var y0 = Math.floor(t - fp.rMajor), y1 = Math.ceil(t + fp.rMajor);
    var ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0;
    var contribs = [];
    for (var j = y0; j <= y1; j++) {
      for (var i = x0; i <= x1; i++) {
        var dx = i + 0.5 - s, dy = j + 0.5 - t;
        var q = fp.inv00 * dx * dx + 2 * fp.inv01 * dx * dy + fp.inv11 * dy * dy;
        if (q < 1) {
          var wgt = Math.exp(-2 * q) - Math.exp(-2);
          var c = fetchLinear(tex, i, j, mode);
          ar += wgt * c.r * c.a; ag += wgt * c.g * c.a; ab += wgt * c.b * c.a; aa += wgt * c.a;
          wsum += wgt;
          contribs.push({ i: i, j: j, ii: c.i, jj: c.j, q: q, w: wgt, rgba: [c.r, c.g, c.b, c.a] });
        }
      }
    }
    var out;
    if (wsum <= 0 || aa <= 0) {
      out = emptyResult();
    } else {
      out = { r: ar / aa, g: ag / aa, b: ab / aa, a: aa / wsum };
    }
    return { color: out, contribs: contribs, wsum: wsum, bbox: { x0: x0, x1: x1, y0: y0, y1: y1 } };
  }

  // 计算单个输出像素的完整信息（检视器与全量渲染共用）
  function computePixel(tex, H, x, y, mode, aniso, maxRadius, methods) {
    var X = x + 0.5, Y = y + 0.5;
    var p = project(H, X, Y);
    var rec = { x: x, y: y, X: X, Y: Y, invalid: false, overflow: false };
    if (p.w <= 1e-6) {
      rec.invalid = true;
      rec.s = rec.t = null;
      rec.color = emptyResult();
      return rec;
    }
    rec.w = p.w;
    rec.s = p.a / p.w;
    rec.t = p.b / p.w;
    var J = jacobian(H, X, Y, p.a, p.b, p.w);
    rec.J = J;
    var fp = analyzeFootprint(J, aniso);
    rec.fp = fp;
    if (fp.rMajor > maxRadius) rec.overflow = true;

    rec.colors = {};
    if (methods.indexOf('nearest') >= 0) rec.colors.nearest = nearest(tex, rec.s, rec.t, mode);
    if (methods.indexOf('bilinear') >= 0) rec.colors.bilinear = bilinear(tex, rec.s, rec.t, mode);
    if (methods.indexOf('elliptic') >= 0) {
      var e = elliptic(tex, rec.s, rec.t, fp, mode);
      rec.colors.elliptic = e.color;
      rec.elliptic = e;
    }
    rec.color = rec.colors.elliptic || rec.colors.bilinear || rec.colors.nearest;
    return rec;
  }

  // 全量渲染；onProgress(rowsDone, total) 可选
  function renderAll(params, onProgress) {
    var tex = params.tex, H = params.H, W = params.outW, Hh = params.outH;
    var mode = params.address, aniso = params.aniso, maxRadius = params.maxRadius;
    var methods = params.methods || ['nearest', 'bilinear', 'elliptic'];
    var bufs = {};
    methods.forEach(function (m) { bufs[m] = new Uint8ClampedArray(W * Hh * 4); });
    var invalidPixels = [], overflowPixels = [];
    var maxObserved = 0, totalContrib = 0, ellipticCount = 0;
    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    for (var y = 0; y < Hh; y++) {
      for (var x = 0; x < W; x++) {
        var rec = computePixel(tex, H, x, y, mode, aniso, maxRadius, methods);
        var idx = (y * W + x) * 4;
        if (rec.invalid) {
          invalidPixels.push([x, y]);
          continue; // 缓冲已清零 → 透明
        }
        if (rec.overflow) {
          overflowPixels.push([x, y]);
          if (rec.fp.rMajor > maxObserved) maxObserved = rec.fp.rMajor;
          continue; // 超限位置不采样，输出透明并由统计标出
        }
        if (rec.fp.rMajor > maxObserved) maxObserved = rec.fp.rMajor;
        for (var mi = 0; mi < methods.length; mi++) {
          var mth = methods[mi];
          var c = rec.colors[mth];
          var buf = bufs[mth];
          buf[idx] = linearToSRGBByte(c.r);
          buf[idx + 1] = linearToSRGBByte(c.g);
          buf[idx + 2] = linearToSRGBByte(c.b);
          buf[idx + 3] = Math.max(0, Math.min(255, Math.round(c.a * 255)));
        }
        if (rec.elliptic) { totalContrib += rec.elliptic.contribs.length; ellipticCount++; }
      }
      if (onProgress && (y % 4 === 3 || y === Hh - 1)) onProgress(y + 1, Hh);
    }
    var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    return {
      buffers: bufs,
      stats: {
        width: W, height: Hh,
        invalidPixels: invalidPixels,
        overflowPixels: overflowPixels,
        maxObservedRadius: maxObserved,
        avgContrib: ellipticCount ? totalContrib / ellipticCount : 0,
        elapsedMs: t1 - t0
      }
    };
  }

  global.Sampler = {
    srgbToLinear: srgbToLinear,
    linearToSRGBByte: linearToSRGBByte,
    wrapIndex: wrapIndex,
    makeTexture: makeTexture,
    project: project,
    jacobian: jacobian,
    analyzeFootprint: analyzeFootprint,
    computePixel: computePixel,
    renderAll: renderAll,
    fetchLinear: fetchLinear
  };
})(typeof self !== 'undefined' ? self : this);
