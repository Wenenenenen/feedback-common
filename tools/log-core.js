/*
 * log-core.js — scale-normalized Laplacian-of-Gaussian blob detection.
 *
 * Implements the convention in 约定.txt:
 *  - physical origin at the top-left pixel centre; row-major float32 input
 *  - level k: sigma_k = sigma0 * ratio^k
 *  - per-axis Gaussian G sampled at physical spacing, normalised to sum 1,
 *    truncated at ceil(3*sigma/spacing)
 *  - second-order kernel D = (r^2/sigma^4 - 1/sigma^2) G, zero-DC corrected
 *  - response R = -sigma^2 * (D_y*G_x + G_y*D_x) I
 *  - a response is valid only where the whole rectangular kernel footprint
 *    lies inside the image and the validity mask
 *  - 3x3x3 maxima (separately on R for bright and -R for dark), centre and
 *    neighbours all valid, first/last levels only take part in comparison,
 *    ties resolved by the first (level, row, col)
 *  - 3D quadratic sub-pixel refinement; accepted only when the Hessian is
 *    negative definite and every |axis displacement| <= 1
 *
 * Runs in Node (module.exports) and in the browser (window.LogCore).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LogCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function buildAxisKernel(sigma, spacing) {
    const radius = Math.ceil((3 * sigma) / spacing);
    const n = 2 * radius + 1;
    const g = new Float64Array(n);
    const d = new Float64Array(n);
    const s2 = sigma * sigma;
    const s4 = s2 * s2;
    let sumG = 0;
    for (let i = 0; i < n; i++) {
      const r = (i - radius) * spacing;
      const v = Math.exp(-(r * r) / (2 * s2));
      g[i] = v;
      sumG += v;
    }
    let sumD = 0;
    for (let i = 0; i < n; i++) {
      g[i] /= sumG;
      const r = (i - radius) * spacing;
      d[i] = (r * r / s4 - 1 / s2) * g[i];
      sumD += d[i];
    }
    for (let i = 0; i < n; i++) {
      d[i] -= sumD * g[i]; // zero DC
    }
    return { radius, g, d };
  }

  // Integral image of the mask (float64, (w+1)*(h+1)) for O(1) footprint tests.
  function buildIntegralMask(mask, w, h) {
    const W = w + 1;
    const intImg = new Float64Array(W * (h + 1));
    for (let r = 0; r < h; r++) {
      let rowSum = 0;
      const rowBase = r * w;
      const outBase = (r + 1) * W;
      for (let c = 0; c < w; c++) {
        rowSum += mask[rowBase + c] ? 1 : 0;
        intImg[outBase + c + 1] = intImg[r * W + c + 1] + rowSum;
      }
    }
    return intImg;
  }

  function footprintAllValid(intImg, w, h, r0, r1, c0, c1) {
    if (r0 < 0 || r1 >= h || c0 < 0 || c1 >= w) return false;
    const W = w + 1;
    const total = (r1 - r0 + 1) * (c1 - c0 + 1);
    const got =
      intImg[(r1 + 1) * W + (c1 + 1)] -
      intImg[r0 * W + (c1 + 1)] -
      intImg[(r1 + 1) * W + c0] +
      intImg[r0 * W + c0];
    return got === total;
  }

  // Separable convolution of img with vert kernel (y) then horz kernel (x);
  // output zero outside valid footprints.
  function convolveSeparable(img, w, h, vert, horz, intImg, tmp, out) {
    const rv = vert.radius;
    const rh = horz.radius;
    const kv = vert.kernel;
    const kh = horz.kernel;
    out.fill(0);
    // vertical pass (constant columns)
    for (let c = 0; c < w; c++) {
      for (let r = 0; r < h; r++) {
        if (r - rv < 0 || r + rv >= h) {
          tmp[r * w + c] = 0;
          continue;
        }
        let acc = 0;
        for (let i = 0; i < kv.length; i++) {
          acc += kv[i] * img[(r - rv + i) * w + c];
        }
        tmp[r * w + c] = acc;
      }
    }
    // horizontal pass with full-footprint validity
    for (let r = 0; r < h; r++) {
      const base = r * w;
      for (let c = 0; c < w; c++) {
        if (c - rh < 0 || c + rh >= w) continue;
        if (!footprintAllValid(intImg, w, h, r - rv, r + rv, c - rh, c + rh)) {
          continue;
        }
        let acc = 0;
        for (let j = 0; j < kh.length; j++) {
          acc += kh[j] * tmp[base + (c - rh + j)];
        }
        out[base + c] = acc;
      }
    }
  }

  function computeVolume(params) {
    const { width: w, height: h, dx, dy, sigma0, ratio, levels, image, mask } =
      params;
    const n = w * h;
    const intImg = buildIntegralMask(mask, w, h);
    const responses = new Array(levels);
    const valids = new Array(levels);
    const sigmas = new Float64Array(levels);
    const tmp = new Float64Array(n);
    const termA = new Float64Array(n);
    const termB = new Float64Array(n);

    for (let k = 0; k < levels; k++) {
      const sigma = sigma0 * Math.pow(ratio, k);
      sigmas[k] = sigma;
      const kx = buildAxisKernel(sigma, dx);
      const ky = buildAxisKernel(sigma, dy);
      // term A: D along y, G along x
      convolveSeparable(
        image, w, h,
        { radius: ky.radius, kernel: ky.d },
        { radius: kx.radius, kernel: kx.g },
        intImg, tmp, termA
      );
      // term B: G along y, D along x
      convolveSeparable(
        image, w, h,
        { radius: ky.radius, kernel: ky.g },
        { radius: kx.radius, kernel: kx.d },
        intImg, tmp, termB
      );
      const resp = new Float64Array(n);
      const valid = new Uint8Array(n);
      const negSigma2 = -sigma * sigma;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const idx = r * w + c;
          const inside =
            r - ky.radius >= 0 && r + ky.radius < h &&
            c - kx.radius >= 0 && c + kx.radius < w &&
            footprintAllValid(
              intImg, w, h,
              r - ky.radius, r + ky.radius,
              c - kx.radius, c + kx.radius
            );
          if (inside) {
            resp[idx] = negSigma2 * (termA[idx] + termB[idx]);
            valid[idx] = 1;
          }
        }
      }
      responses[k] = resp;
      valids[k] = valid;
    }
    return { responses, valids, sigmas };
  }

  function isNegativeDefinite(H) {
    // LDL^T: D pivots must all be strictly negative
    const a = H.map((row) => row.slice());
    const n = 3;
    for (let j = 0; j < n; j++) {
      let pivot = a[j][j];
      for (let p = 0; p < j; p++) {
        pivot -= (a[j][p] * a[p][j]) / a[p][p];
      }
      if (!(pivot < 0)) return false;
      a[j][j] = pivot;
      for (let i = j + 1; i < n; i++) {
        let v = a[i][j];
        for (let p = 0; p < j; p++) {
          v -= (a[i][p] * a[p][j]) / a[p][p];
        }
        a[i][j] = v / pivot;
      }
    }
    return true;
  }

  // Solve H delta = -g via Gaussian elimination with partial pivoting.
  function solve3(H, g) {
    const A = [
      [H[0][0], H[0][1], H[0][2], -g[0]],
      [H[1][0], H[1][1], H[1][2], -g[1]],
      [H[2][0], H[2][1], H[2][2], -g[2]],
    ];
    for (let i = 0; i < 3; i++) {
      let piv = i;
      for (let q = i + 1; q < 3; q++) {
        if (Math.abs(A[q][i]) > Math.abs(A[piv][i])) piv = q;
      }
      if (Math.abs(A[piv][i]) < 1e-15) return null;
      if (piv !== i) {
        for (let t = 0; t < 4; t++) {
          const tmpV = A[i][t];
          A[i][t] = A[piv][t];
          A[piv][t] = tmpV;
        }
      }
      for (let q = i + 1; q < 3; q++) {
        const f = A[q][i] / A[i][i];
        for (let t = i; t < 4; t++) A[q][t] -= f * A[i][t];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = A[i][3];
      for (let j = i + 1; j < 3; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  function detectPeaks(params, volume) {
    const { width: w, height: h, levels, dx, dy, sigma0, ratio,
      brightThreshold, darkThreshold } = params;
    const { responses, valids, sigmas } = volume;
    const peaks = [];

    const sample = (k, r, c) => {
      if (r < 0 || r >= h || c < 0 || c >= w) return null;
      if (!valids[k][r * w + c]) return null;
      return responses[k][r * w + c];
    };

    for (let k = 1; k < levels - 1; k++) {
      const resp = responses[k];
      const valid = valids[k];
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const idx = r * w + c;
          if (!valid[idx]) continue;
          const v0 = resp[idx];
          const kind = v0 > 0 ? "bright" : v0 < 0 ? "dark" : null;
          if (!kind) continue;
          const sign = kind === "bright" ? 1 : -1;
          const det0 = sign * v0;
          const thr = kind === "bright" ? brightThreshold : darkThreshold;
          if (det0 < thr) continue;

          let isPeak = true;
          outer:
          for (let dk = -1; dk <= 1; dk++) {
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dk === 0 && dr === 0 && dc === 0) continue;
                const nv = sample(k + dk, r + dr, c + dc);
                if (nv === null) {
                  isPeak = false;
                  break outer;
                }
                const nd = sign * nv;
                if (nd > det0 ||
                    (nd === det0 && (dk < 0 ||
                      (dk === 0 && (dr < 0 || (dr === 0 && dc < 0)))))) {
                  isPeak = false;
                  break outer;
                }
              }
            }
          }
          if (!isPeak) continue;

          // 3D quadratic refinement on the detection volume
          const detAt = (dk2, dr2, dc2) =>
            sign * sample(k + dk2, r + dr2, c + dc2);
          const s0 = det0;
          const grad = [
            (detAt(1, 0, 0) - detAt(-1, 0, 0)) / 2,
            (detAt(0, 1, 0) - detAt(0, -1, 0)) / 2,
            (detAt(0, 0, 1) - detAt(0, 0, -1)) / 2,
          ];
          const H = [
            [
              detAt(1, 0, 0) - 2 * s0 + detAt(-1, 0, 0),
              (detAt(1, 1, 0) - detAt(1, -1, 0) -
                detAt(-1, 1, 0) + detAt(-1, -1, 0)) / 4,
              (detAt(1, 0, 1) - detAt(1, 0, -1) -
                detAt(-1, 0, 1) + detAt(-1, 0, -1)) / 4,
            ],
            [0,
              detAt(0, 1, 0) - 2 * s0 + detAt(0, -1, 0),
              (detAt(0, 1, 1) - detAt(0, 1, -1) -
                detAt(0, -1, 1) + detAt(0, -1, -1)) / 4,
            ],
            [0, 0,
              detAt(0, 0, 1) - 2 * s0 + detAt(0, 0, -1),
            ],
          ];
          H[1][0] = H[0][1];
          H[2][0] = H[0][2];
          H[2][1] = H[1][2];

          let refined = false;
          let delta = [0, 0, 0];
          let refinedResponse = v0;
          let refinedLevel = k;
          let refinedRow = r;
          let refinedCol = c;
          let refinedSigma = sigmas[k];

          if (isNegativeDefinite(H)) {
            const sol = solve3(H, grad);
            if (sol && Math.abs(sol[0]) <= 1 &&
                Math.abs(sol[1]) <= 1 && Math.abs(sol[2]) <= 1) {
              refined = true;
              delta = sol;
              refinedLevel = k + sol[0];
              refinedRow = r + sol[1];
              refinedCol = c + sol[2];
              refinedSigma = sigma0 * Math.pow(ratio, refinedLevel);
              const detRefined =
                s0 + 0.5 * (grad[0] * sol[0] + grad[1] * sol[1] +
                  grad[2] * sol[2]);
              refinedResponse = sign * detRefined;
            }
          }

          peaks.push({
            kind,
            level: k,
            row: r,
            col: c,
            response: v0,
            sigma: sigmas[k],
            x: c * dx,
            y: r * dy,
            refined,
            deltaLevel: delta[0],
            deltaRow: delta[1],
            deltaCol: delta[2],
            refinedLevel,
            refinedRow,
            refinedCol,
            refinedX: refinedCol * dx,
            refinedY: refinedRow * dy,
            refinedSigma,
            refinedResponse,
          });
        }
      }
    }
    return peaks;
  }

  function run(params) {
    const volume = computeVolume(params);
    const peaks = detectPeaks(params, volume);
    return { volume, peaks };
  }

  return { buildAxisKernel, computeVolume, detectPeaks, run };
});
