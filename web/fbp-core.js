/*
 * fbp-core.js — parallel-beam Ram-Lak filtered back projection.
 *
 * Convention (from the test-bench README, implemented literally):
 *   detector physical position s = (k - (D-1)/2 - offset[row]) * ds
 *   pixel center x = (col - (W-1)/2) * pixel_size
 *                  y = ((H-1)/2 - row) * pixel_size
 *   angular gaps are circular on period pi; angle weight is half the sum of
 *   the two neighbouring gaps; a single angle gets weight pi.
 *   Ram-Lak discrete kernel: h[0] = 1/(4 ds^2), even n != 0 -> 0,
 *   odd n -> -1/(pi^2 n^2 ds^2); q[k] = ds * sum_j h[k-j] p[j] is a full
 *   linear convolution (kernel symmetric, h[-n] = h[n]), never circular.
 *   f(x,y) = sum_theta w * q((x cos + y sin)/ds + (D-1)/2 + offset),
 *   q sampled by linear interpolation, zero outside the detector range.
 *
 * No tomographic-reconstruction library is used: only Float64Array/Float32Array
 * arithmetic and an explicit discrete kernel. The unfiltered control path sets
 * q = p. Reconstruction values keep their raw scale and sign (negatives kept).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FBPCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PI = Math.PI;

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  /** Validate raw + metadata and return a normalized case object. */
  function buildCase(meta, rawBuffer) {
    assert(meta && typeof meta === "object", "缺少 JSON 参数");
    var D = meta.detectors | 0;
    var angles = meta.angles;
    var offset = meta.offset;
    var ds = +meta.ds;
    var W0 = meta.width | 0;
    var H0 = meta.height | 0;
    var ps0 = +meta.pixel_size;
    assert(D >= 1 && D <= 257, "探测器数量须在 1..257 之间，当前 " + D);
    assert(Array.isArray(angles) && angles.length >= 1, "angles 为空");
    assert(angles.length <= 180, "角度数不能超过 180，当前 " + angles.length);
    assert(Array.isArray(offset) && offset.length === angles.length,
      "offset 数量必须与角度数一致");
    assert(isFinite(ds) && ds > 0, "ds 必须为正数");
    assert(W0 >= 1 && H0 >= 1 && W0 <= 256 && H0 <= 256,
      "JSON 内 width/height 须在 1..256");
    assert(isFinite(ps0) && ps0 > 0, "pixel_size 必须为正数");
    for (var i = 0; i < angles.length; i++) {
      var a = +angles[i];
      assert(isFinite(a) && a >= 0 && a < PI,
        "角度 " + i + " 超出 [0, pi)：" + a);
      assert(isFinite(+offset[i]), "offset[" + i + "] 不是有限数");
    }
    // Duck-type rather than instanceof: callers may hand over an ArrayBuffer
    // from another realm (vm context, detached-window polyfills, ...).
    assert(rawBuffer && typeof rawBuffer.byteLength === "number",
      "raw 数据缺失（需要 ArrayBuffer）");
    var n = rawBuffer.byteLength / 4;
    assert(n === angles.length * D,
      "raw 浮点数 " + n + " 与 angles*detectors " + (angles.length * D) + " 不一致");
    assert(rawBuffer.byteLength % 4 === 0, "raw 长度不是 4 的倍数（非 float32？）");
    // little-endian float32
    var p = new Float32Array(rawBuffer);
    var sino = new Float64Array(angles.length * D);
    for (var r = 0; r < angles.length; r++) {
      for (var k = 0; k < D; k++) sino[r * D + k] = p[r * D + k];
    }
    return {
      D: D,
      angles: angles.map(Number),
      offset: offset.map(Number),
      ds: ds,
      W0: W0,
      H0: H0,
      ps0: ps0,
      sino: sino
    };
  }

  /**
   * Sort by angle, carrying data rows and offsets along. Rejects exact
   * duplicate angles (the spec forbids them; shuffled input is fine).
   * Returns sorted {angles, offset, rows (Float64Array A*D), order}.
   */
  function sortCase(c) {
    var A = c.angles.length;
    var order = [];
    for (var i = 0; i < A; i++) order.push(i);
    order.sort(function (a, b) { return c.angles[a] - c.angles[b]; });
    var angles = new Float64Array(A);
    var off = new Float64Array(A);
    var rows = new Float64Array(A * c.D);
    for (var r2 = 0; r2 < A; r2++) {
      var src = order[r2];
      angles[r2] = c.angles[src];
      off[r2] = c.offset[src];
      for (var k2 = 0; k2 < c.D; k2++) {
        rows[r2 * c.D + k2] = c.sino[src * c.D + k2];
      }
      if (r2 > 0 && angles[r2] === angles[r2 - 1]) {
        throw new Error("检测到重复角度 " + angles[r2] +
          "（弧度），按规范拒绝导入；请合并或删除后重试。");
      }
    }
    return { angles: angles, offset: off, rows: rows, order: order };
  }

  /**
   * Circular Voronoi weights on period pi: half the sum of the gaps to the
   * previous and next angle along the circle. Single angle -> pi.
   */
  function angleWeights(angles) {
    var n = angles.length;
    var w = new Float64Array(n);
    if (n === 1) {
      w[0] = PI;
      return w;
    }
    for (var i = 0; i < n; i++) {
      var prev = angles[(i - 1 + n) % n];
      var next = angles[(i + 1) % n];
      var gapLo = (angles[i] - prev + PI) % PI;
      var gapHi = (next - angles[i] + PI) % PI;
      w[i] = 0.5 * (gapLo + gapHi);
    }
    return w;
  }

  /** Ram-Lak kernel h[n] for n = 0..D-1 (symmetric; use h[|lag|]). */
  function ramLakKernel(D, ds) {
    var h = new Float64Array(D);
    h[0] = 0.25 / (ds * ds);
    var c = -1 / (PI * PI * ds * ds);
    for (var n = 1; n < D; n++) {
      if (n % 2 === 1) h[n] = c / (n * n);
    }
    return h;
  }

  /**
   * Full linear convolution of one row with the Ram-Lak kernel, evaluated at
   * detector indices 0..D-1: q[k] = ds * sum_j h[|k-j|] p[j]. No wrap-around.
   */
  function filterRow(p, D, h, ds) {
    var q = new Float64Array(D);
    for (var k = 0; k < D; k++) {
      var acc = 0;
      for (var j = 0; j < D; j++) acc += h[Math.abs(k - j)] * p[j];
      q[k] = ds * acc;
    }
    return q;
  }

  function filterAll(rows, A, D, ds) {
    var h = ramLakKernel(D, ds);
    var q = new Float64Array(A * D);
    for (var r = 0; r < A; r++) {
      var qr = filterRow(rows.subarray(r * D, r * D + D), D, h, ds);
      q.set(qr, r * D);
    }
    return q;
  }

  /** Linear interpolation of q at detector index t; 0 outside [0, D-1]. */
  function sampleQ(q, D, t) {
    if (!(t >= 0 && t <= D - 1)) return 0; // also catches NaN
    var k = Math.floor(t);
    if (k === D - 1) return q[D - 1];
    var f = t - k;
    return q[k] * (1 - f) + q[k + 1] * f;
  }

  /**
   * Back projection over all angles.
   * opts: {W, H, pixelSize, extraOffset, filtered}
   * Returns {image: Float64Array(W*H, row-major), q, sorted, weights, D, ds}.
   */
  function reconstruct(c, opts) {
    opts = opts || {};
    var W = opts.W || c.W0;
    var H = opts.H || c.H0;
    var ps = opts.pixelSize != null ? opts.pixelSize : c.ps0;
    var extra = opts.extraOffset || 0;
    var filtered = opts.filtered !== false;
    assert(W >= 1 && H >= 1 && W <= 256 && H <= 256,
      "输出尺寸须在 1..256 之间");
    assert(isFinite(ps) && ps > 0, "像素间距必须为正数");
    assert(isFinite(extra), "附加中心偏移必须为有限数");

    var sorted = sortCase(c);
    var A = sorted.angles.length;
    var D = c.D;
    var weights = angleWeights(sorted.angles);
    var q = filtered
      ? filterAll(sorted.rows, A, D, c.ds)
      : sorted.rows.slice();

    var img = new Float64Array(W * H);
    var cx = (W - 1) / 2;
    var cy = (H - 1) / 2;
    var base = (D - 1) / 2;
    for (var row = 0; row < H; row++) {
      var y = (cy - row) * ps;
      for (var col = 0; col < W; col++) {
        var x = (col - cx) * ps;
        var acc = 0;
        for (var i = 0; i < A; i++) {
          var theta = sorted.angles[i];
          var t = (x * Math.cos(theta) + y * Math.sin(theta)) / c.ds
            + base + sorted.offset[i] + extra;
          acc += weights[i] * sampleQ(q.subarray(i * D, i * D + D), D, t);
        }
        img[row * W + col] = acc;
      }
    }
    return {
      image: img, W: W, H: H, q: q, sorted: sorted, weights: weights,
      D: D, A: A, ds: c.ds, pixelSize: ps, extraOffset: extra,
      filtered: filtered
    };
  }

  /**
   * Contribution of one sorted angle index to every output pixel
   * (weight * interpolated q), so summing these over angles == image.
   */
  function angleContribution(rec, angleIndex) {
    var W = rec.W, H = rec.H, D = rec.D;
    var theta = rec.sorted.angles[angleIndex];
    var w = rec.weights[angleIndex];
    var qr = rec.q.subarray(angleIndex * D, angleIndex * D + D);
    var base = (D - 1) / 2;
    var cx = (W - 1) / 2, cy = (H - 1) / 2;
    var out = new Float64Array(W * H);
    var cosT = Math.cos(theta), sinT = Math.sin(theta);
    for (var row = 0; row < H; row++) {
      var y = (cy - row) * rec.pixelSize;
      for (var col = 0; col < W; col++) {
        var x = (col - cx) * rec.pixelSize;
        var t = (x * cosT + y * sinT) / rec.ds
          + base + rec.sorted.offset[angleIndex] + rec.extraOffset;
        out[row * W + col] = w * sampleQ(qr, D, t);
      }
    }
    return out;
  }

  /** Detector index (continuous) hit by pixel (row,col) under angle i. */
  function detectorIndexForPixel(rec, angleIndex, row, col) {
    var W = rec.W, H = rec.H, D = rec.D;
    var cx = (W - 1) / 2, cy = (H - 1) / 2;
    var x = (col - cx) * rec.pixelSize;
    var y = (cy - row) * rec.pixelSize;
    var theta = rec.sorted.angles[angleIndex];
    return (x * Math.cos(theta) + y * Math.sin(theta)) / rec.ds
      + (D - 1) / 2 + rec.sorted.offset[angleIndex] + rec.extraOffset;
  }

  /** Stats over an array-like, ignoring NaN. Negatives reported honestly. */
  function stats(a) {
    var lo = Infinity, hi = -Infinity, sum = 0;
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (isNaN(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    return { min: lo, max: hi, mean: sum / a.length };
  }

  /** Order-statistic percentile (p in 0..100), NaN ignored. When ignoreZero
   * is true, exact-zero entries are excluded first (sinogram rows are mostly
   * empty background, which would otherwise dominate the order statistic). */
  function percentile(a, p, ignoreZero) {
    var vals = [];
    for (var i = 0; i < a.length; i++) {
      if (isNaN(a[i])) continue;
      if (ignoreZero && a[i] === 0) continue;
      vals.push(a[i]);
    }
    if (vals.length === 0) return 0;
    vals.sort(function (x, y) { return x - y; });
    var rank = (p / 100) * (vals.length - 1);
    var lo = Math.floor(rank), hi = Math.ceil(rank);
    if (lo === hi) return vals[lo];
    return vals[lo] + (vals[hi] - vals[lo]) * (rank - lo);
  }

  /**
   * Encode a Float64/Float32 image as little-endian grayscale PFM.
   * PFM is bottom-row-first with negative scale; our image is top-row-first,
   * so rows are written in reverse. Values are float32, scale and sign kept.
   */
  function encodePFM(image, W, H) {
    var header = "Pf\n" + W + " " + H + "\n-1.0\n";
    var headerBytes = [];
    for (var i = 0; i < header.length; i++) headerBytes.push(header.charCodeAt(i));
    var out = new Uint8Array(headerBytes.length + W * H * 4);
    out.set(headerBytes, 0);
    var dv = new DataView(out.buffer);
    var pos = headerBytes.length;
    for (var row = H - 1; row >= 0; row--) {           // bottom row first
      for (var col = 0; col < W; col++) {
        dv.setFloat32(pos, image[row * W + col], true); // little-endian
        pos += 4;
      }
    }
    return out;
  }

  return {
    buildCase: buildCase,
    sortCase: sortCase,
    angleWeights: angleWeights,
    ramLakKernel: ramLakKernel,
    filterRow: filterRow,
    filterAll: filterAll,
    sampleQ: sampleQ,
    reconstruct: reconstruct,
    angleContribution: angleContribution,
    detectorIndexForPixel: detectorIndexForPixel,
    stats: stats,
    percentile: percentile,
    encodePFM: encodePFM
  };
});
