/* Exact integer geometric predicates for the tetrahedral inspector.

   Coordinates are integers, so every determinant is computed with BigInt and is exact.
   Two predicates are provided:

     orient3d  — signed volume of a tetrahedron (used for orientation and volume)
     insphere  — lifted 4x4 determinant (used for the Delaunay empty-sphere test),
                 with a simulation-of-simplicity fallback that breaks co-spherical ties
                 by ranks rather than by floating-point noise.

   Everything else (weights, projections) is float because query points are real-valued. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TETRA_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function B(x) { return typeof x === 'bigint' ? x : BigInt(x); }

  /* Determinant of an n x n BigInt matrix (cofactor expansion; n <= 5 here). */
  function detN(rows) {
    const n = rows.length;
    if (n === 1) return rows[0][0];
    if (n === 2) return rows[0][0] * rows[1][1] - rows[0][1] * rows[1][0];
    if (n === 3) {
      const a = rows;
      return a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
           - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
           + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    }
    if (n === 4) {
      const a = rows;
      const m0 = a[1][1] * (a[2][2] * a[3][3] - a[2][3] * a[3][2])
               - a[1][2] * (a[2][1] * a[3][3] - a[2][3] * a[3][1])
               + a[1][3] * (a[2][1] * a[3][2] - a[2][2] * a[3][1]);
      const m1 = a[1][0] * (a[2][2] * a[3][3] - a[2][3] * a[3][2])
               - a[1][2] * (a[2][0] * a[3][3] - a[2][3] * a[3][0])
               + a[1][3] * (a[2][0] * a[3][2] - a[2][2] * a[3][0]);
      const m2 = a[1][0] * (a[2][1] * a[3][3] - a[2][3] * a[3][1])
               - a[1][1] * (a[2][0] * a[3][3] - a[2][3] * a[3][0])
               + a[1][3] * (a[2][0] * a[3][1] - a[2][1] * a[3][0]);
      const m3 = a[1][0] * (a[2][1] * a[3][2] - a[2][2] * a[3][1])
               - a[1][1] * (a[2][0] * a[3][2] - a[2][2] * a[3][0])
               + a[1][2] * (a[2][0] * a[3][1] - a[2][1] * a[3][0]);
      return a[0][0] * m0 - a[0][1] * m1 + a[0][2] * m2 - a[0][3] * m3;
    }
    let d = 0n;
    for (let c = 0; c < n; c++) {
      const v = rows[0][c];
      if (v === 0n) continue;
      const sub = new Array(n - 1);
      for (let r = 1; r < n; r++) sub[r - 1] = rows[r].filter((_, j) => j !== c);
      d += (c & 1 ? -1n : 1n) * v * detN(sub);
    }
    return d;
  }

  function sgn(x) { return x > 0n ? 1 : x < 0n ? -1 : 0; }

  /* 6 * signed volume of the tetrahedron (a,b,c,d). Positive when d lies on the
     right-hand side of triangle (a,b,c). */
  function detOrientBig(a, b, c, d) {
    const ax = B(a[0]), ay = B(a[1]), az = B(a[2]);
    return detN([
      [B(b[0]) - ax, B(b[1]) - ay, B(b[2]) - az],
      [B(c[0]) - ax, B(c[1]) - ay, B(c[2]) - az],
      [B(d[0]) - ax, B(d[1]) - ay, B(d[2]) - az],
    ]);
  }

  function orient3d(a, b, c, d) { return sgn(detOrientBig(a, b, c, d)); }

  function wof(p) {
    const x = B(p[0]), y = B(p[1]), z = B(p[2]);
    return x * x + y * y + z * z;
  }

  /* Lifted in-sphere determinant (4x4), computed relative to e. Exact. */
  function insphere4Big(a, b, c, d, e) {
    const ex = B(e[0]), ey = B(e[1]), ez = B(e[2]);
    const rows = [a, b, c, d].map((p) => {
      const x = B(p[0]) - ex, y = B(p[1]) - ey, z = B(p[2]) - ez;
      return [x, y, z, x * x + y * y + z * z];
    });
    return detN(rows);
  }

  /* +1: e strictly inside the circumsphere (for positive orientation), -1 outside, 0 cospherical. */
  function insphereSign(a, b, c, d, e) {
    const o = orient3d(a, b, c, d);
    if (o === 0) return 0;
    const det = insphere4Big(a, b, c, d, e);
    return (-sgn(det) * o) > 0 ? 1 : -1;
  }

  /* In-sphere test with simulation-of-simplicity tie breaking.
     ranks: five distinct integers (coordinate-derived). Returns { sign, tie, degenerate }.
     Ties in the lifted determinant are resolved by perturbing the lifted coordinate with
     eps^rank; the lowest-order non-zero term decides. This makes co-spherical inputs
     produce a stable, order-independent triangulation instead of relying on rounding. */
  function insphereInfo(a, b, c, d, e, ra, rb, rc, rd, re) {
    const o = orient3d(a, b, c, d);
    if (o === 0) return { sign: 0, tie: false, degenerate: true };
    const pts = [a, b, c, d, e];
    const ws = [wof(a), wof(b), wof(c), wof(d), wof(e)];
    const mk = (wv) => pts.map((p, i) => [B(p[0]), B(p[1]), B(p[2]), wv[i], 1n]);
    const D0 = detN(mk(ws));
    if (D0 !== 0n) {
      return { sign: (-sgn(D0) * o) > 0 ? 1 : -1, tie: false, degenerate: false };
    }
    const ranks = [ra, rb, rc, rd, re];
    const D = new Array(32);
    for (let m = 0; m < 32; m++) {
      D[m] = detN(mk(ws.map((w, i) => ((m >> i) & 1) ? 1n : 0n)));
    }
    const pop = new Array(32).fill(0);
    for (let i = 0; i < 32; i++) {
      let q = 0, x = i;
      while (x) { q += x & 1; x >>= 1; }
      pop[i] = q;
    }
    const C = new Array(32).fill(0n);
    for (let S = 0; S < 32; S++) {
      let sum = 0n;
      for (let T = S; ; T = (T - 1) & S) {
        sum += ((pop[S] - pop[T]) & 1 ? -1n : 1n) * D[T];
        if (T === 0) break;
      }
      C[S] = sum;
    }
    const poly = new Map();
    for (let S = 0; S < 32; S++) {
      if (C[S] === 0n) continue;
      let terms = new Map([[0, C[S]]]);
      for (let i = 0; i < 5; i++) {
        if (!((S >> i) & 1)) continue;
        const next = new Map();
        for (const [exp, co] of terms) {
          next.set(exp, (next.get(exp) || 0n) + co * ws[i]);
          next.set(exp + ranks[i], (next.get(exp + ranks[i]) || 0n) + co);
        }
        terms = next;
      }
      for (const [exp, co] of terms) poly.set(exp, (poly.get(exp) || 0n) + co);
    }
    let minExp = Infinity, lead = 0n;
    for (const [exp, co] of poly) {
      if (co !== 0n && exp < minExp) { minExp = exp; lead = co; }
    }
    if (minExp === Infinity) return { sign: 0, tie: true, degenerate: false };
    return { sign: (-sgn(lead) * o) > 0 ? 1 : -1, tie: true, degenerate: false };
  }

  function insphere5(a, b, c, d, e, ra, rb, rc, rd, re) {
    return insphereInfo(a, b, c, d, e, ra, rb, rc, rd, re).sign;
  }

  /* The four triangular faces of a tetrahedron, as triples of local vertex slots. */
  const FACE_LOCAL = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  function faceOf(t, i) {
    const f = FACE_LOCAL[i];
    return [t[f[0]], t[f[1]], t[f[2]]];
  }
  function faceKey(a, b, c) {
    const x = a < b
      ? (b < c ? [a, b, c] : a < c ? [a, c, b] : [c, a, b])
      : (a < c ? [b, a, c] : b < c ? [b, c, a] : [c, b, a]);
    return x[0] + ',' + x[1] + ',' + x[2];
  }

  /* FNV-1a over a string; used for a stable triangulation fingerprint. */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  return {
    detN, detOrientBig, orient3d, wof,
    insphere4Big, insphereSign, insphereInfo, insphere5,
    faceOf, faceKey, hashString, sgn,
  };
});
