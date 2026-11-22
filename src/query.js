/* Query evaluation for the tetrahedral light-probe inspector.

   Two paths, one rule: the answer must come from a non-negative barycentric weight set.
   Inside the hull, the containing tetrahedron gives those weights directly. Outside,
   the query point is first moved to the closest point of the hull surface, and the
   weights are those of that surface point in the tetrahedron that owns the face. This
   keeps coefficients bounded by the probe values, so a probe layout can never extrapolate
   a colour brighter than its neighbourhood.

   Coefficients are interpolated first (constant term and the three linear terms, per
   channel), then evaluated on the sphere normal, then clamped at zero. */

'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.TETRA_QUERY = factory(root.TETRA_CORE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CORE) {
  const { detOrientBig, faceOf } = CORE;

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /* 6 * signed volume of a tetrahedron given as four points. Exact in double precision
     for integer coordinates within the probe range. */
  function det3(a, b, c, d) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
  }

  function tetVolume6(points, tet) {
    return det3(points[tet[0]], points[tet[1]], points[tet[2]], points[tet[3]]);
  }

  /* Barycentric weights of r in a tetrahedron. w[i] belongs to tet[i]; the denominator
     sign is folded in, so a valid tet has all weights positive inside. */
  function barycentric(points, tet, r) {
    const a = points[tet[0]], b = points[tet[1]], c = points[tet[2]], d = points[tet[3]];
    const det = det3(a, b, c, d);
    const raw = [
      det3(r, b, c, d),
      det3(a, r, c, d),
      det3(a, b, r, d),
      det3(a, b, c, r),
    ];
    const s = det > 0 ? 1 : -1;
    const w = raw.map((v) => v * s);
    const W = Math.abs(det);
    const tol = 1e-9 * W;
    return {
      w,
      normalized: w.map((v) => v / W),
      denom: W,
      inside: w.every((v) => v >= -tol),
      strictlyInside: w.every((v) => v > tol),
    };
  }

  /* Containing tetrahedron, scanning in the triangulation's sorted order so ties on a
     shared face always resolve the same way. */
  function locate(points, tets, r) {
    let first = null;
    for (let ti = 0; ti < tets.length; ti++) {
      const b = barycentric(points, tets[ti], r);
      if (b.strictlyInside) return { tet: ti, bary: b, onFace: false };
      if (b.inside && !first) first = { tet: ti, bary: b, onFace: true };
    }
    return first;
  }

  /* Closest point of the convex hull to r, by projecting onto each hull triangle and
     clamping to the edge/vertex region. Exact triangle choice: ties go to the lowest
     hull index, which is stable because the hull list is sorted. */
  function projectToHull(points, hull, r) {
    let best = null;
    for (let hi = 0; hi < hull.length; hi++) {
      const tri = hull[hi].tri;
      const A = points[tri[0]], Bp = points[tri[1]], Cp = points[tri[2]];
      const e0 = sub(Bp, A), e1 = sub(Cp, A), v = sub(r, A);
      const a = dot(e0, e0), b = dot(e0, e1), c = dot(e1, e1);
      const d = dot(e0, v), e = dot(e1, v);
      const det = a * c - b * b;
      let u = 0, w = 0;
      if (Math.abs(det) > 1e-12) {
        u = (c * d - b * e) / det;
        w = (a * e - b * d) / det;
      }
      if (u < 0) { u = 0; w = w < 0 ? 0 : w > 1 ? 1 : w; }
      else if (w < 0) { w = 0; u = u > 1 ? 1 : u; }
      else if (u + w > 1) {
        const k = 1 / (u + w);
        u *= k; w *= k;
      }
      const q = [
        A[0] + u * e0[0] + w * e1[0],
        A[1] + u * e0[1] + w * e1[1],
        A[2] + u * e0[2] + w * e1[2],
      ];
      const dx = r[0] - q[0], dy = r[1] - q[1], dz = r[2] - q[2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (!best || dist2 < best.dist2 - 1e-9) {
        best = {
          point: q,
          hullIndex: hi,
          tet: hull[hi].tet,
          tri,
          dist2,
          faceWeights: [1 - u - w, u, w],
        };
      }
    }
    return best;
  }

  /* Evaluate a query.

     probeCoeffs[i] is [[k, ax, ay, az] for R, then G, then B].

     Returns the tetrahedron used, the four probes, weights, the projected point (null when
     inside), and per-channel raw and clamped radiance. */
  function evaluate(points, tets, hull, probeCoeffs, q, normal) {
    const hit = locate(points, tets, q);
    let tet, weights, probes, projected = null, distance = 0, outside = false;

    if (hit) {
      tet = hit.tet;
      /* A point on a shared face can pick up a -1e-16 from float rounding; the
         contract is non-negative weights, so pin those to zero and renormalise. */
      const raw = hit.bary.normalized;
      let pinned = false;
      weights = raw.map((v) => {
        if (v < 0 && v > -1e-9) { pinned = true; return 0; }
        return v;
      });
      if (pinned) {
        const sum = weights.reduce((s2, v) => s2 + v, 0) || 1;
        weights = weights.map((v) => v / sum);
      }
      probes = tets[tet];
    } else {
      outside = true;
      const near = projectToHull(points, hull, q);
      if (!near) {
        return { ok: false, message: '凸包为空，无法把查询点投影到表面。' };
      }
      projected = near.point;
      distance = Math.sqrt(near.dist2);
      tet = near.tet;
      const b = barycentric(points, tets[tet], near.point);
      /* Weights of the projected point; any tiny negative from rounding is pinned. */
      weights = b.normalized.map((v) => (v < 0 ? 0 : v));
      const sum = weights.reduce((s, v) => s + v, 0) || 1;
      weights = weights.map((v) => v / sum);
      probes = tets[tet];
    }

    const coeff = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let k = 0; k < 4; k++) {
      const c = probeCoeffs[probes[k]];
      for (let ch = 0; ch < 3; ch++) {
        for (let j = 0; j < 4; j++) coeff[ch][j] += weights[k] * c[ch][j];
      }
    }

    const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const nx = normal[0] / len, ny = normal[1] / len, nz = normal[2] / len;
    const raw = coeff.map((c) => c[0] + c[1] * nx + c[2] * ny + c[3] * nz);
    const clamped = raw.map((v) => (v < 0 ? 0 : v));

    return {
      ok: true,
      outside,
      tet,
      probes: probes.slice(),
      weights: weights.slice(),
      projected,
      distance,
      coeff,
      normal: [nx, ny, nz],
      raw,
      clamped,
      negative: raw.map((v) => v < 0),
    };
  }

  /* Closest hull point helper exposed for the projection marker and section view. */
  function project(points, hull, q) {
    return projectToHull(points, hull, q);
  }

  return { barycentric, tetVolume6, locate, evaluate, project, projectToHull, faceOf };
});
