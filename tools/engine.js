/*
 * Masked Richardson-Lucy deconvolution engine.
 * Implements 约定.txt exactly. No deconvolution library is used; only plain
 * Float64Array arithmetic. This file is shared verbatim by the web page
 * (inlined) and the Node validation harness.
 */
(function (global) {
  "use strict";

  var EPS = 1e-8;

  function reflectIndex(k, n) {
    if (n === 1) return 0;
    var p = ((k % (2 * n - 2)) + (2 * n - 2)) % (2 * n - 2);
    return p < n ? p : 2 * n - 2 - p;
  }

  /*
   * Normalize a non-negative kernel and precompute, for every kernel tap,
   * the reflected source index of each output pixel. The forward operator
   * gathers through these maps; the adjoint scatters through the very same
   * maps so edge multiplicity is accumulated, not mirrored twice.
   */
  function buildOperator(weights, anchor, H, W) {
    var kh = weights.length;
    var kw = weights[0].length;
    var ax = anchor[0], ay = anchor[1];
    var total = 0, a, b;
    for (a = 0; a < kh; a++)
      for (b = 0; b < kw; b++) {
        if (!(weights[a][b] >= 0)) {
          throw new Error("核权重必须为非负数（位于 [" + a + "," + b + "]）");
        }
        total += weights[a][b];
      }
    if (!(total > 0)) throw new Error("核权重总和为 0，无法归一化");

    var taps = [];
    var N = H * W;
    for (a = 0; a < kh; a++) {
      for (b = 0; b < kw; b++) {
        var w = weights[a][b] / total;
        if (w === 0) continue;
        var map = new Int32Array(N);
        for (var y = 0; y < H; y++) {
          var ry = reflectIndex(y + a - ay, H);
          var rowOff = y * W, srcRow = ry * W;
          for (var x = 0; x < W; x++) {
            var rx = reflectIndex(x + b - ax, W);
            map[rowOff + x] = srcRow + rx;
          }
        }
        taps.push({ w: w, map: map });
      }
    }
    return { taps: taps, H: H, W: W, N: N, sum: total, kh: kh, kw: kw };
  }

  // Forward: (Az)[i] = sum_taps w_t * z[map_t(i)]
  function forward(op, z, out) {
    var N = op.N, taps = op.taps, t, i;
    out.fill(0);
    for (t = 0; t < taps.length; t++) {
      var w = taps[t].w, map = taps[t].map;
      for (i = 0; i < N; i++) out[i] += w * z[map[i]];
    }
    return out;
  }

  // True adjoint of the reflected-boundary forward: each output position
  // scatters w_t * z[i] back into the same reflected source index, so
  // pixels hit by several reflected taps accumulate every contribution.
  function adjoint(op, z, out) {
    var N = op.N, taps = op.taps, t, i;
    out.fill(0);
    for (t = 0; t < taps.length; t++) {
      var w = taps[t].w, map = taps[t].map;
      for (i = 0; i < N; i++) out[map[i]] += w * z[i];
    }
    return out;
  }

  function makeRunner(op, yChannelsInput, maskInput) {
    var N = op.N;
    var channels = yChannelsInput.length;
    // Own the buffers: callers may reuse the input arrays for another run.
    var yChannels = yChannelsInput.map(function (a) { return new Float64Array(a); });
    var maskOnes = !maskInput;
    var M = maskInput ? new Float64Array(maskInput) : new Float64Array(N).fill(1);

    // A^T M is constant across iterations (kernel and mask do not change).
    var atm = adjoint(op, M, new Float64Array(N));
    var validCount = 0, i;
    for (i = 0; i < N; i++) if (M[i] > 0.5) validCount++;

    var x = [], ax = [], ratio = [], atRatio = [];
    for (var c = 0; c < channels; c++) {
      var sum = 0;
      for (i = 0; i < N; i++) if (M[i] > 0.5) sum += yChannels[c][i];
      if (validCount === 0) throw new Error("掩膜内没有任何有效观测像素");
      var init = Math.max(sum / validCount, EPS);
      x.push(new Float64Array(N).fill(init));
      ax.push(new Float64Array(N));
      ratio.push(new Float64Array(N));
      atRatio.push(new Float64Array(N));
    }

    function computeMse() {
      var s = 0;
      for (var c2 = 0; c2 < channels; c2++) {
        var yc = yChannels[c2], ac = ax[c2];
        for (var i2 = 0; i2 < N; i2++) {
          if (M[i2] > 0.5) {
            var d = ac[i2] - yc[i2];
            s += d * d;
          }
        }
      }
      return s / (validCount * channels);
    }

    var lastMseValue = 0;

    // Evaluate Ax for the current x and return its valid-zone MSE.
    function evaluate() {
      for (var c3 = 0; c3 < channels; c3++) {
        forward(op, x[c3], ax[c3]);
      }
      lastMseValue = computeMse();
      return lastMseValue;
    }

    // One Richardson-Lucy update. Call evaluate() first (iteration 0 is the
    // constant initial image); after k updates evaluate() gives iteration k.
    function step() {
      for (var c4 = 0; c4 < channels; c4++) {
        var yc2 = yChannels[c4], ac2 = ax[c4], rc = ratio[c4];
        for (var i3 = 0; i3 < N; i3++) {
          rc[i3] = M[i3] > 0.5 ? yc2[i3] / Math.max(ac2[i3], EPS) : 0;
        }
        adjoint(op, rc, atRatio[c4]);
        var xc = x[c4], ar = atRatio[c4];
        for (var i4 = 0; i4 < N; i4++) {
          if (atm[i4] > 0) xc[i4] = xc[i4] * ar[i4] / atm[i4];
          else xc[i4] = 0;
        }
      }
    }

    function reblur(currentX, outArr) {
      for (var c5 = 0; c5 < channels; c5++) forward(op, currentX[c5], outArr[c5]);
    }

    return {
      evaluate: evaluate,
      step: step,
      lastMse: function () { return lastMseValue; },
      reblur: reblur,
      getX: function () { return x; },
      getAx: function () { return ax; },
      getAtm: function () { return atm; },
      validCount: validCount,
      channels: channels,
      N: N,
      maskOnes: maskOnes
    };
  }

  var api = {
    EPS: EPS,
    reflectIndex: reflectIndex,
    buildOperator: buildOperator,
    forward: forward,
    adjoint: adjoint,
    makeRunner: makeRunner
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RLEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
