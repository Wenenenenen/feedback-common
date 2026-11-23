/*
 * rolling-light-demixer core engine.
 * Pure logic, no DOM — usable from browser page, Web Worker and Node.
 *
 * Exposes (as window.Demixer or module.exports):
 *   validateConfig(cfg)            -> normalized cfg, throws ConfigError
 *   computeDuties(cfg)             -> Float64Array [F][H][3] duty cycles
 *   demix(cfg, frames)             -> {layers, mask, dropped, sse, validCount}
 *   ConfigError
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Demixer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_SIDE = 512;
  var MAX_FRAMES = 24;

  function ConfigError(scope, index, field, message) {
    var e = new Error(message);
    e.name = "ConfigError";
    e.scope = scope; // 'global' | 'frame' | 'lamp'
    e.index = index; // frame or lamp-group index, undefined for global
    e.field = field;
    throw e;
  }

  function isInt(v) {
    return typeof v === "number" && Number.isInteger(v);
  }

  /* ---------- configuration validation ---------- */

  function validateConfig(cfg) {
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
      ConfigError("global", undefined, "(root)", "配置必须是 JSON 对象");

    var W = cfg.width, H = cfg.height, P = cfg.period;

    if (!isInt(W) || W < 1 || W > MAX_SIDE)
      ConfigError("global", undefined, "width",
        "width 必须是 1.." + MAX_SIDE + " 的整数，收到 " + JSON.stringify(W));
    if (!isInt(H) || H < 1 || H > MAX_SIDE)
      ConfigError("global", undefined, "height",
        "height 必须是 1.." + MAX_SIDE + " 的整数，收到 " + JSON.stringify(H));
    if (!isInt(P) || P < 1 || P > 40000)
      ConfigError("global", undefined, "period",
        "period 必须是 1..40000 的整数微秒，收到 " + JSON.stringify(P));

    // lamps
    var lamps = cfg.lamps;
    if (!Array.isArray(lamps) || lamps.length !== 3)
      ConfigError("global", undefined, "lamps",
        "lamps 必须恰好包含 3 个灯组");
    var normLamps = [];
    for (var g = 0; g < 3; g++) {
      var grp = lamps[g];
      if (!Array.isArray(grp))
        ConfigError("lamp", g, "lamps[" + g + "]",
          "灯组 " + g + " 必须是区间数组");
      var ivs = [];
      for (var k = 0; k < grp.length; k++) {
        var iv = grp[k];
        if (!Array.isArray(iv) || iv.length !== 2 ||
            !isInt(iv[0]) || !isInt(iv[1]))
          ConfigError("lamp", g, "lamps[" + g + "][" + k + "]",
            "灯组 " + g + " 第 " + k + " 个区间必须是 [起, 止] 整数对");
        var a = iv[0], b = iv[1];
        if (!(0 <= a && a < b && b <= P))
          ConfigError("lamp", g, "lamps[" + g + "][" + k + "]",
            "灯组 " + g + " 区间 [" + a + ", " + b + ") 不满足 0<=起<止<=period");
        ivs.push([a, b]);
      }
      ivs.sort(function (x, y) { return x[0] - y[0]; });
      for (var m = 1; m < ivs.length; m++) {
        if (ivs[m][0] < ivs[m - 1][1])
          ConfigError("lamp", g, "lamps[" + g + "]",
            "灯组 " + g + " 内区间 [" + ivs[m - 1][0] + "," + ivs[m - 1][1] +
            ") 与 [" + ivs[m][0] + "," + ivs[m][1] + ") 重叠");
      }
      normLamps.push(ivs);
    }

    // frames
    var frames = cfg.frames;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES)
      ConfigError("global", undefined, "frames",
        "frames 必须包含 1.." + MAX_FRAMES + " 项");
    var normFrames = [];
    for (var f = 0; f < frames.length; f++) {
      var fr = frames[f];
      if (fr === null || typeof fr !== "object" || Array.isArray(fr))
        ConfigError("frame", f, "frames[" + f + "]",
          "帧 " + f + " 必须是对象");
      if (!isInt(fr.start) || Math.abs(fr.start) > 1e9)
        ConfigError("frame", f, "start",
          "帧 " + f + " 的 start 必须是 |start|<=1e9 的整数，收到 " +
          JSON.stringify(fr.start));
      if (!isInt(fr.rowDelay) || fr.rowDelay < 0 || fr.rowDelay > 4000)
        ConfigError("frame", f, "rowDelay",
          "帧 " + f + " 的 rowDelay 必须是 0..4000 的整数，收到 " +
          JSON.stringify(fr.rowDelay));
      if (!isInt(fr.span) || fr.span < 1 || fr.span > 200000)
        ConfigError("frame", f, "span",
          "帧 " + f + " 的 span 必须是 1..200000 的整数，收到 " +
          JSON.stringify(fr.span));
      if (typeof fr.reverse !== "boolean")
        ConfigError("frame", f, "reverse",
          "帧 " + f + " 的 reverse 必须是布尔值，收到 " +
          JSON.stringify(fr.reverse));
      normFrames.push({
        start: fr.start, rowDelay: fr.rowDelay,
        span: fr.span, reverse: fr.reverse
      });
    }

    return {
      width: W, height: H, period: P,
      lamps: normLamps, frames: normFrames
    };
  }

  /* ---------- duty cycles ---------- */

  // measure of (-inf, t) ∩ union_k [a+kp, b+kp)
  function pulseCum(t, a, len, p) {
    var u = t - a;
    var q = Math.floor(u / p);
    var r = u - q * p;
    return q * len + Math.min(Math.max(r, 0), len);
  }

  // duty cycles for every frame/row/lamp -> Float64Array [F][H][3]
  function computeDuties(cfg) {
    var F = cfg.frames.length, H = cfg.height, P = cfg.period;
    var out = new Float64Array(F * H * 3);
    for (var f = 0; f < F; f++) {
      var fr = cfg.frames[f];
      var base = f * H * 3;
      for (var y = 0; y < H; y++) {
        var rr = fr.reverse ? (H - 1 - y) : y;
        var t0 = fr.start + rr * fr.rowDelay;
        var t1 = t0 + fr.span;
        var o = base + y * 3;
        for (var g = 0; g < 3; g++) {
          var tot = 0;
          var ivs = cfg.lamps[g];
          for (var k = 0; k < ivs.length; k++) {
            var a = ivs[k][0], b = ivs[k][1];
            tot += pulseCum(t1, a, b - a, P) - pulseCum(t0, a, b - a, P);
          }
          out[o + g] = tot / fr.span;
        }
      }
    }
    return out;
  }

  /* ---------- small linear algebra (3 columns) ---------- */

  // rank-3 check of gram matrix G (3x3, symmetric), via pivoted elimination
  function gramRank3(g00, g01, g02, g11, g12, g22) {
    var m = [g00, g01, g02, g01, g11, g12, g02, g12, g22];
    var big = Math.abs(g00);
    if (Math.abs(g11) > big) big = Math.abs(g11);
    if (Math.abs(g22) > big) big = Math.abs(g22);
    if (big === 0) return false;
    var tol = 1e-10 * big;
    for (var c = 0; c < 3; c++) {
      var piv = c, pv = Math.abs(m[c * 3 + c]);
      for (var r = c + 1; r < 3; r++) {
        var v = Math.abs(m[r * 3 + c]);
        if (v > pv) { pv = v; piv = r; }
      }
      if (pv < tol) return false;
      if (piv !== c) {
        for (var cc = 0; cc < 3; cc++) {
          var tmp = m[c * 3 + cc]; m[c * 3 + cc] = m[piv * 3 + cc]; m[piv * 3 + cc] = tmp;
        }
      }
      var d = m[c * 3 + c];
      for (var rr = c + 1; rr < 3; rr++) {
        var fct = m[rr * 3 + c] / d;
        for (var k = c; k < 3; k++) m[rr * 3 + k] -= fct * m[c * 3 + k];
      }
    }
    return true;
  }

  // Solve symmetric n<=3 system in place. a: 3x3 row-major (only idx used),
  // returns solution into out, or false if singular.
  function solveSub(G, h, i0, i1, i2, n, out) {
    if (n === 1) {
      var d = G[i0 * 3 + i0];
      if (Math.abs(d) < 1e-300) return false;
      out[0] = h[i0] / d;
      return true;
    }
    // gather
    var a00 = G[i0 * 3 + i0], a01 = G[i0 * 3 + i1], a11 = G[i1 * 3 + i1];
    var b0 = h[i0], b1 = h[i1];
    if (n === 2) {
      var det = a00 * a11 - a01 * a01;
      var scale = Math.abs(a00) * Math.abs(a11);
      if (Math.abs(det) < 1e-14 * (scale || 1)) return false;
      out[0] = (b0 * a11 - b1 * a01) / det;
      out[1] = (a00 * b1 - a01 * b0) / det;
      return true;
    }
    var a02 = G[i0 * 3 + i2], a12 = G[i1 * 3 + i2], a22 = G[i2 * 3 + i2];
    var b2 = h[i2];
    // Cramer on symmetric 3x3
    var c00 = a11 * a22 - a12 * a12;
    var c01 = a02 * a12 - a01 * a22;
    var c02 = a01 * a12 - a02 * a11;
    var det3 = a00 * c00 + a01 * c01 + a02 * c02;
    var smax = Math.abs(a00) * Math.abs(a11) * Math.abs(a22) || 1;
    if (Math.abs(det3) < 1e-14 * smax) return false;
    out[0] = (b0 * c00 + b1 * c01 + b2 * c02) / det3;
    var c11 = a00 * a22 - a02 * a02;
    var c12 = a01 * a02 - a00 * a12;
    out[1] = (b0 * c01 + b1 * c11 + b2 * c12) / det3;
    var c22 = a00 * a11 - a01 * a01;
    out[2] = (b0 * c02 + b1 * c12 + b2 * c22) / det3;
    return true;
  }

  var SUBSETS = [
    [], [0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]
  ];

  // Exact NNLS for 3 variables by active-set enumeration.
  // G: 9 doubles (3x3 row-major), h: 3 doubles, btb: scalar.
  // Writes solution into x[0..2], returns SSE.
  function nnls3(G, h, btb, x) {
    var bestSse = btb; // empty set: x = 0
    x[0] = 0; x[1] = 0; x[2] = 0;
    var z = [0, 0, 0];
    for (var s = 1; s < 8; s++) {
      var idx = SUBSETS[s], n = idx.length;
      if (!solveSub(G, h, idx[0], idx[1], idx[2], n, z)) continue;
      var bad = false;
      for (var k = 0; k < n; k++) {
        if (z[k] < -1e-9) { bad = true; break; }
      }
      if (bad) continue;
      var x0 = 0, x1 = 0, x2 = 0;
      for (var q = 0; q < n; q++) {
        var v = z[q] < 0 ? 0 : z[q];
        if (idx[q] === 0) x0 = v; else if (idx[q] === 1) x1 = v; else x2 = v;
      }
      var sse = btb
        - 2 * (x0 * h[0] + x1 * h[1] + x2 * h[2])
        + x0 * (G[0] * x0 + G[1] * x1 + G[2] * x2)
        + x1 * (G[3] * x0 + G[4] * x1 + G[5] * x2)
        + x2 * (G[6] * x0 + G[7] * x1 + G[8] * x2);
      if (sse < bestSse - 1e-9) {
        bestSse = sse;
        x[0] = x0; x[1] = x1; x[2] = x2;
      }
    }
    return bestSse > 0 ? bestSse : 0;
  }

  /* ---------- main demix ---------- */

  // cfg: normalized config; frames: Uint16Array of F*W*H (frame-major).
  // onProgress(frac) optional. Returns layers/mask/dropped/sse.
  function demix(cfg, framesU16, onProgress) {
    var W = cfg.width, H = cfg.height, F = cfg.frames.length;
    var NP = W * H;
    var duties = computeDuties(cfg);

    var layers = [new Float32Array(NP), new Float32Array(NP), new Float32Array(NP)];
    var mask = new Uint8Array(NP);
    var dropped = new Int8Array(NP);
    var sseMap = new Float64Array(NP);

    // per-frame row pointers
    var validList = new Int32Array(F);
    var bvals = new Float64Array(F);
    var G = new Float64Array(9);
    var h = new Float64Array(3);
    var x = [0, 0, 0];
    // candidate buffers
    var Gc = new Float64Array(9);
    var hc = new Float64Array(3);

    var validCount = 0;
    var reportEvery = Math.max(1, (NP / 100) | 0);

    for (var p = 0; p < NP; p++) {
      if (onProgress && (p % reportEvery) === 0) onProgress(p / NP);
      var y = (p / W) | 0;

      // collect valid (unsaturated) observations
      var n = 0;
      for (var f = 0; f < F; f++) {
        var v = framesU16[f * NP + p];
        if (v !== 65535) {
          validList[n] = f;
          bvals[n] = v;
          n++;
        }
      }
      if (n < 4) {
        dropped[p] = -1;
        continue;
      }

      // full gram over all valid rows
      var g00 = 0, g01 = 0, g02 = 0, g11 = 0, g12 = 0, g22 = 0;
      var h0 = 0, h1 = 0, h2 = 0, btbFull = 0;
      for (var i = 0; i < n; i++) {
        var fi = validList[i];
        var d0 = duties[(fi * H + y) * 3];
        var d1 = duties[(fi * H + y) * 3 + 1];
        var d2 = duties[(fi * H + y) * 3 + 2];
        var b = bvals[i];
        g00 += d0 * d0; g01 += d0 * d1; g02 += d0 * d2;
        g11 += d1 * d1; g12 += d1 * d2; g22 += d2 * d2;
        h0 += d0 * b; h1 += d1 * b; h2 += d2 * b;
        btbFull += b * b;
      }

      var bestScore = Infinity;
      var bestDrop = -2; // dropped frame of best candidate (-1 for n==4)
      var bestSse = 0;
      var bx0 = 0, bx1 = 0, bx2 = 0;
      var found = false;

      // candidates: n==4 -> single all-in; n>=5 -> leave-one-out
      var nCand = (n === 4) ? 1 : n;
      for (var c = 0; c < nCand; c++) {
        var dropFrame = -1;
        if (n === 4) {
          Gc[0] = g00; Gc[1] = g01; Gc[2] = g02;
          Gc[3] = g01; Gc[4] = g11; Gc[5] = g12;
          Gc[6] = g02; Gc[7] = g12; Gc[8] = g22;
          hc[0] = h0; hc[1] = h1; hc[2] = h2;
          var btbC = btbFull;
        } else {
          dropFrame = validList[c];
          var dd0 = duties[(dropFrame * H + y) * 3];
          var dd1 = duties[(dropFrame * H + y) * 3 + 1];
          var dd2 = duties[(dropFrame * H + y) * 3 + 2];
          var db = bvals[c];
          Gc[0] = g00 - dd0 * dd0; Gc[1] = g01 - dd0 * dd1; Gc[2] = g02 - dd0 * dd2;
          Gc[3] = Gc[1]; Gc[4] = g11 - dd1 * dd1; Gc[5] = g12 - dd1 * dd2;
          Gc[6] = Gc[2]; Gc[7] = Gc[5]; Gc[8] = g22 - dd2 * dd2;
          hc[0] = h0 - dd0 * db; hc[1] = h1 - dd1 * db; hc[2] = h2 - dd2 * db;
          btbC = btbFull - db * db;
        }
        if (!gramRank3(Gc[0], Gc[1], Gc[2], Gc[4], Gc[5], Gc[8])) continue;
        var sse = nnls3(Gc, hc, btbC, x);
        var score = Math.floor(256 * sse + 0.5);
        // ascending score; tie -> keep candidate with larger dropped frame
        if (score < bestScore ||
            (score === bestScore && dropFrame > bestDrop)) {
          bestScore = score;
          bestDrop = dropFrame;
          bestSse = sse;
          bx0 = x[0]; bx1 = x[1]; bx2 = x[2];
          found = true;
        }
      }

      if (!found) {
        dropped[p] = -1;
        continue;
      }
      validCount++;
      mask[p] = 1;
      layers[0][p] = bx0;
      layers[1][p] = bx1;
      layers[2][p] = bx2;
      sseMap[p] = bestSse;
      dropped[p] = bestDrop >= 0 ? bestDrop : -1;
    }
    if (onProgress) onProgress(1);

    return {
      layers: layers, mask: mask, dropped: dropped,
      sse: sseMap, validCount: validCount, pixelCount: NP
    };
  }

  return {
    validateConfig: validateConfig,
    computeDuties: computeDuties,
    demix: demix,
    nnls3: nnls3,
    MAX_SIDE: MAX_SIDE,
    MAX_FRAMES: MAX_FRAMES
  };
});
