/*
 * rectifier.js — gyro-assisted rolling-shutter rotation correction, core math.
 *
 * Conventions (from the sample package 说明.txt):
 *   - Camera axes: x right, y down, z forward; right-handed.
 *   - Gyro samples: [t(seconds), wx, wy, wz] in camera-axis rad/s,
 *     times strictly increasing, angular velocity linearly interpolated.
 *   - Rotation increments act on the RIGHT side of the pose:
 *         R(t + dt) = R(t) @ Exp(w_body * dt)
 *   - Raw row time: start + readout * ratio, denominator height - 1,
 *     direction "down": first row ratio 0; "up": last row ratio 0.
 *   - Pixel centers are integer coordinates.
 *   - Pinhole intrinsics fx, fy, cx, cy.
 *
 * Runs in both the browser (global Rectifier) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Rectifier = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 3x3 matrix / vector helpers ----------

  function matIdentity() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  function matMul(a, b) {
    const out = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        out[i * 3 + j] =
          a[i * 3] * b[j] +
          a[i * 3 + 1] * b[3 + j] +
          a[i * 3 + 2] * b[6 + j];
      }
    }
    return out;
  }

  function matVec(a, v) {
    return [
      a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
      a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
      a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
  }

  function matTranspose(a) {
    return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
  }

  // Rodrigues: Exp(skew(w) * dt)
  function rodrigues(w, dt) {
    const wn = Math.hypot(w[0], w[1], w[2]);
    const theta = wn * dt;
    if (Math.abs(theta) < 1e-15) {
      const e0 = w[0] * dt, e1 = w[1] * dt, e2 = w[2] * dt;
      // I + skew(e)
      return [1, -e2, e1, e2, 1, -e0, -e1, e0, 1];
    }
    const k = [w[0] / wn, w[1] / wn, w[2] / wn];
    const K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0];
    const s = Math.sin(theta), c = Math.cos(theta), g = 1 - c;
    const out = matIdentity();
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const K2ij = K[i * 3] * K[j] + K[i * 3 + 1] * K[3 + j] +
          K[i * 3 + 2] * K[6 + j];
        out[i * 3 + j] += s * K[i * 3 + j] + g * K2ij;
      }
    }
    return out;
  }

  // ---------- gyro integration ----------

  // Prefix rotations R(t0 -> t_k) cached at every sample time, so a query at
  // arbitrary time costs one in-interval integration instead of the full span.
  function createIntegrator(gyro) {
    if (!Array.isArray(gyro) || gyro.length < 1) {
      throw new Error("gyro 至少需要一条采样");
    }
    const times = new Array(gyro.length);
    const ws = new Array(gyro.length);
    for (let i = 0; i < gyro.length; i++) {
      const s = gyro[i];
      if (!Array.isArray(s) || s.length !== 4 ||
          !s.every((v) => Number.isFinite(v))) {
        throw new Error(`gyro[${i}] 必须是 4 个有限数 [t, wx, wy, wz]`);
      }
      times[i] = s[0];
      ws[i] = [s[1], s[2], s[3]];
      if (i > 0 && !(times[i] > times[i - 1])) {
        throw new Error("gyro 时间必须严格递增");
      }
    }

    const prefix = [matIdentity()];
    for (let i = 1; i < times.length; i++) {
      prefix.push(matMul(prefix[i - 1],
        integrateInterval(i - 1, times[i - 1], times[i])));
    }

    function wAt(t) {
      if (t <= times[0]) return ws[0].slice();
      if (t >= times[times.length - 1]) return ws[ws.length - 1].slice();
      const i = bracket(t);
      const u = (t - times[i]) / (times[i + 1] - times[i]);
      return [
        ws[i][0] + (ws[i + 1][0] - ws[i][0]) * u,
        ws[i][1] + (ws[i + 1][1] - ws[i][1]) * u,
        ws[i][2] + (ws[i + 1][2] - ws[i][2]) * u,
      ];
    }

    function bracket(t) {
      let lo = 0, hi = times.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid; else hi = mid;
      }
      return lo;
    }

    // Rotation across [ti, b] where ti = times[i] and b lies inside the
    // interval starting at sample i.
    function integrateInterval(i, ti, b) {
      const span = b - ti;
      if (span === 0) return matIdentity();
      const wa = ws[i];
      const wb = wAt(b);
      // Exact path when angular velocity is constant over the interval.
      if (wa[0] === wb[0] && wa[1] === wb[1] && wa[2] === wb[2]) {
        return rodrigues(wa, span);
      }
      const wmid = [
        (wa[0] + wb[0]) * 0.5,
        (wa[1] + wb[1]) * 0.5,
        (wa[2] + wb[2]) * 0.5,
      ];
      const wn = Math.hypot(wmid[0], wmid[1], wmid[2]);
      // Midpoint integration on SO(3) is locally second order; capping each
      // substep's rotation at 1e-4 rad drives the discretization error below
      // the floating-point accumulation floor (~1e-10). Verified empirically:
      // caps from 1e-4 down to 1e-8 give identical results.
      const n = Math.max(1, Math.ceil((wn * span) / 1e-4));
      let R = matIdentity();
      const h = span / n;
      for (let k = 0; k < n; k++) {
        const tm = ti + h * (k + 0.5);
        R = matMul(R, rodrigues(wAt(tm), h));
      }
      return R;
    }

    // R(t0 -> t1), right-side increments; works for t1 < t0 as well.
    function rotation(t0, t1) {
      if (t1 === t0) return matIdentity();
      const sign = t1 > t0 ? 1 : -1;
      const lo = Math.min(t0, t1);
      const hi = Math.max(t0, t1);
      let Rlo, Rhi;
      if (lo <= times[0]) Rlo = matIdentity();
      else {
        const i = bracket(lo);
        Rlo = matMul(prefix[i],
          integrateInterval(i, times[i], lo));
      }
      if (hi >= times[times.length - 1]) Rhi = prefix[prefix.length - 1];
      else {
        const j = bracket(hi);
        Rhi = matMul(prefix[j],
          integrateInterval(j, times[j], hi));
      }
      // R(lo -> hi); if going backwards use its inverse (rotation => transpose)
      const fwd = matMul(matTranspose(Rlo), Rhi);
      return sign > 0 ? fwd : matTranspose(fwd);
    }

    return {
      times,
      tMin: times[0],
      tMax: times[times.length - 1],
      wAt,
      rotation,
    };
  }

  // ---------- row timing ----------

  function rowTime(params, y, height) {
    const ratio = y / (height - 1);
    const r = params.direction === "up" ? 1 - ratio : ratio;
    return params.start + params.readout * r;
  }

  // ---------- projection ----------

  function unproject(params, x, y) {
    return [
      (x - params.cx) / params.fx,
      (y - params.cy) / params.fy,
      1,
    ];
  }

  function project(params, ray) {
    return [
      params.fx * (ray[0] / ray[2]) + params.cx,
      params.fy * (ray[1] / ray[2]) + params.cy,
    ];
  }

  // Forward: original pixel (x, y) -> float position on the rectified image.
  // Returns { x, y, t, covered }.
  function forwardPoint(params, integ, height, x, y, tRef) {
    const t = rowTime(params, y, height);
    const Q = integ.rotation(tRef, t);
    const p = project(params, matVec(Q, unproject(params, x, y)));
    const covered =
      integ.tMin <= t && t <= integ.tMax &&
      integ.tMin <= tRef && tRef <= integ.tMax;
    return { x: p[0], y: p[1], t, covered };
  }

  // Precompute, for every raw row, its time, coverage flag and the row
  // constants of the inverse rotation Q^T = R(t -> t_ref). For a normalized
  // reference ray (nx, ny, 1):
  //   r = Q^T [nx,ny,1] = [a*nx+b*ny+c, d*nx+e*ny+f, g*nx+h*ny+i]
  // so raw pixel mapping is a handful of multiplies per pixel.
  function buildRowTable(params, integ, height, tRef) {
    const refCovered = integ.tMin <= tRef && tRef <= integ.tMax;
    const rows = new Array(height);
    for (let y = 0; y < height; y++) {
      const t = rowTime(params, y, height);
      const M = matTranspose(integ.rotation(tRef, t));
      rows[y] = {
        t,
        covered: refCovered && integ.tMin <= t && t <= integ.tMax,
        a: M[0], b: M[1], c: M[2],
        d: M[3], e: M[4], f: M[5],
        g: M[6], h: M[7], i: M[8],
      };
    }
    return rows;
  }

  // Raw pixel coords of reference ray (nx, ny, 1) through one precomputed row.
  function rayToRaw(params, row, nx, ny) {
    const rz = row.g * nx + row.h * ny + row.i;
    const invZ = 1 / rz;
    return [
      params.fx * (row.a * nx + row.b * ny + row.c) * invZ + params.cx,
      params.fy * (row.d * nx + row.e * ny + row.f) * invZ + params.cy,
    ];
  }

  // Inverse resampling: rectified pixel (xp, yp) -> raw float sample position.
  // Monotone bisection on the raw row y, solving y_raw(Q(t(y))^T ray_ref) = yp.
  // Returns { x, y, t, covered, inside } or null when no bracket exists.
  function inversePoint(params, integ, width, height, xp, yp, tRef, rows) {
    const nx = (xp - params.cx) / params.fx;
    const ny = (yp - params.cy) / params.fy;
    const table = rows || buildRowTable(params, integ, height, tRef);

    function rawYAt(y) {
      if (y >= 0 && y <= height - 1 && Number.isInteger(y)) {
        return rayToRaw(params, table[y], nx, ny)[1];
      }
      const t = rowTime(params, y, height);
      const Q = integ.rotation(tRef, t);
      const r = matVec(matTranspose(Q), [nx, ny, 1]);
      return params.fy * (r[1] / r[2]) + params.cy;
    }

    let lo = -height, hi = 2 * height;
    const gLo = rawYAt(lo) - lo;
    const gHi = rawYAt(hi) - hi;
    if (!Number.isFinite(gLo) || !Number.isFinite(gHi) || gLo * gHi > 0) {
      return null;
    }
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) * 0.5;
      if (rawYAt(mid) - mid > 0) lo = mid; else hi = mid;
    }
    const y = (lo + hi) * 0.5;
    const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
    const hitXY = rayToRaw(params, table[yi], nx, ny);
    const eps = 1e-9;
    const inside = hitXY[0] >= -eps && hitXY[0] <= width - 1 + eps &&
      y >= -eps && y <= height - 1 + eps;
    return {
      x: hitXY[0],
      y,
      t: table[yi].t,
      inside,
      covered: table[yi].covered,
    };
  }

  // Full rectification against an RGBA Uint8ClampedArray (or Uint8Array).
  // Returns { out: Uint8ClampedArray (RGBA), stats }.
  function rectifyImage(params, integ, src, width, height, tRef) {
    const out = new Uint8ClampedArray(width * height * 4);
    const table = buildRowTable(params, integ, height, tRef);
    let nUncovered = 0, nOutside = 0, nValid = 0;
    const eps = 1e-9;

    const fy0 = params.fy, fx0 = params.fx;
    const cy0 = params.cy, cx0 = params.cx;

    for (let yp = 0; yp < height; yp++) {
      const ny = (yp - cy0) / fy0;
      for (let xp = 0; xp < width; xp++) {
        const o = (yp * width + xp) * 4;
        const nx = (xp - cx0) / fx0;

        // Bisection over integer rows: ceil(log2(height)) iterations shrink
        // the bracket to two adjacent rows. Only table lookups, no integration.
        let lo = 0, hi = height - 1;
        let rowL = table[lo], rowH = table[hi];
        const gLo = fy0 * (rowL.d * nx + rowL.e * ny + rowL.f) /
            (rowL.g * nx + rowL.h * ny + rowL.i) + cy0 - lo;
        const gHi = fy0 * (rowH.d * nx + rowH.e * ny + rowH.f) /
            (rowH.g * nx + rowH.h * ny + rowH.i) + cy0 - hi;
        if (!Number.isFinite(gLo) || !Number.isFinite(gHi) ||
            gLo * gHi > 0) {
          out[o + 3] = 0;
          nOutside++;
          continue;
        }
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const m = table[mid];
          const gMid = fy0 * (m.d * nx + m.e * ny + m.f) /
              (m.g * nx + m.h * ny + m.i) + cy0 - mid;
          if (gMid > 0) lo = mid; else hi = mid;
        }

        // Linearly interpolate the raw position between the bracketing rows,
        // using the smooth residual g(y) = y_raw(y) - y.
        rowL = table[lo];
        rowH = table[hi];
        const zL = rowL.g * nx + rowL.h * ny + rowL.i;
        const zH = rowH.g * nx + rowH.h * ny + rowH.i;
        const xL = fx0 * (rowL.a * nx + rowL.b * ny + rowL.c) / zL + cx0;
        const yL = fy0 * (rowL.d * nx + rowL.e * ny + rowL.f) / zL + cy0;
        const xH = fx0 * (rowH.a * nx + rowH.b * ny + rowH.c) / zH + cx0;
        const yH = fy0 * (rowH.d * nx + rowH.e * ny + rowH.f) / zH + cy0;
        const g0 = yL - lo;
        const g1 = yH - hi;
        const frac = g0 === g1 ? 0 : g0 / (g0 - g1);
        const yRaw = lo + frac;
        const xRaw = xL + (xH - xL) * frac;

        if (!rowL.covered) {
          out[o + 3] = 0;
          nUncovered++;
          continue;
        }
        if (xRaw < -eps || xRaw > width - 1 + eps ||
            yRaw < -eps || yRaw > height - 1 + eps) {
          out[o + 3] = 0;
          nOutside++;
          continue;
        }
        const c = sampleBilinear(src, width, height, xRaw, yRaw);
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 255;
        nValid++;
      }
    }
    return {
      out,
      stats: { nValid, nUncovered, nOutside, total: width * height },
    };
  }

  function sampleBilinear(src, width, height, fx, fy) {
    // Clamp sub-pixel residual overshoot from the iterative inverse solve.
    fx = Math.max(0, Math.min(width - 1, fx));
    fy = Math.max(0, Math.min(height - 1, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    return [
      src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11,
      src[i00 + 1] * w00 + src[i10 + 1] * w10 +
        src[i01 + 1] * w01 + src[i11 + 1] * w11,
      src[i00 + 2] * w00 + src[i10 + 2] * w10 +
        src[i01 + 2] * w01 + src[i11 + 2] * w11,
    ];
  }

  return {
    createIntegrator,
    rowTime,
    buildRowTable,
    forwardPoint,
    inversePoint,
    rectifyImage,
    rodrigues,
    matMul,
    matTranspose,
  };
});
