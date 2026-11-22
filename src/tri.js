/* Deterministic Delaunay tetrahedralization of integer points.

   Approach
   --------
   Bowyer-Watson insertion inside a large enclosing tetrahedron, using only exact
   predicates. The cavity of a new point is grown breadth-first from the tetrahedron
   that contains it, which keeps the work local.

   Ties.  Real probe layouts are full of ties: cube corners are co-spherical eight at a
   time, a sweep of equal spacings is co-planar everywhere. Floating-point noise would
   resolve those ties differently depending on the input order, and the triangulation
   would flicker. So every in-sphere test is symbolic: if the lifted determinant is zero
   the test falls back to a perturbation of each point's lifted coordinate by eps^rank,
   where ranks come from the sorted coordinates. The tie decision therefore depends only
   on the point set. Input order never enters any predicate, and the same points always
   produce the same tetrahedra with the same winding.

   Degeneracies.  Fewer than four points, duplicate coordinates, collinear and co-planar
   point sets are reported with a reason instead of being silently repaired. */

'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.TETRA_TRIANGULATE = factory(root.TETRA_CORE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CORE) {
  const { faceOf, faceKey, detOrientBig, insphereInfo, hashString } = CORE;

  /* Reported failure carries a stable machine code and a human reason. */
  function failure(code, message, detail) {
    return { ok: false, code, message, detail: detail || null };
  }

  function sortedByCoord(points) {
    return points
      .map((p, i) => ({ p, i }))
      .sort((A, B) =>
        (A.p[0] - B.p[0]) || (A.p[1] - B.p[1]) || (A.p[2] - B.p[2]));
  }

  /* Reason for a degenerate point set, or null when the points span 3D. */
  function diagnose(points) {
    const n = points.length;
    const order = sortedByCoord(points);
    const pts = order.map((o) => o.p);
    const idx = order.map((o) => o.i);

    let b = -1;
    for (let i = 1; i < n; i++) {
      if (pts[i][0] !== pts[0][0] || pts[i][1] !== pts[0][1] || pts[i][2] !== pts[0][2]) {
        b = i; break;
      }
    }
    if (b < 0) return failure('coincident', '所有探针坐标相同，无法确定任何方向。');

    let c = -1;
    for (let i = b + 1; i < n; i++) {
      const u = [pts[b][0] - pts[0][0], pts[b][1] - pts[0][1], pts[b][2] - pts[0][2]];
      const v = [pts[i][0] - pts[0][0], pts[i][1] - pts[0][1], pts[i][2] - pts[0][2]];
      if (u[1] * v[2] - u[2] * v[1] || u[2] * v[0] - u[0] * v[2] || u[0] * v[1] - u[1] * v[0]) {
        c = i; break;
      }
    }
    if (c < 0) {
      return failure('collinear',
        '全部 ' + n + ' 个探针落在同一条直线上。直线上的点无法围出体积，三维 Delaunay 剖分不存在；请把探针分散到至少一个不平行的方向。');
    }

    for (let i = 0; i < n; i++) {
      if (i === 0 || i === b || i === c) continue;
      if (detOrientBig(pts[0], pts[b], pts[c], pts[i]) !== 0n) return null;
    }
    /* Find the plane through three of the points to name it in the reason. */
    const oi = (k) => idx[k];
    return failure('coplanar',
      '全部 ' + n + ' 个探针共面（基准平面由探针 ' + oi(0) + '、' + oi(b) + '、' + oi(c) +
      ' 确定）。共面点的四面体体积为零，三维 Delaunay 剖分不存在；请把至少一个探针移出该平面。',
      { plane: [oi(0), oi(b), oi(c)], count: n });
  }

  function insideTet(points, t, p) {
    for (let fi = 0; fi < 4; fi++) {
      const f = faceOf(t, fi);
      const so = detOrientBig(points[f[0]], points[f[1]], points[f[2]], points[t[3 - fi]]);
      const sp = detOrientBig(points[f[0]], points[f[1]], points[f[2]], p);
      if (sp === 0n) continue;       /* on the face plane: still inside */
      if ((sp > 0n) !== (so > 0n)) return false;
    }
    return true;
  }

  function buildFaceMap(tets) {
    const fmap = new Map();
    for (let ti = 0; ti < tets.length; ti++) {
      for (let fi = 0; fi < 4; fi++) {
        const f = faceOf(tets[ti], fi);
        const k = faceKey(f[0], f[1], f[2]);
        const e = fmap.get(k);
        if (e) e.push(ti); else fmap.set(k, [ti]);
      }
    }
    return fmap;
  }

  function triangulate(rawPoints) {
    const n = rawPoints.length;
    if (n < 4) return failure('too-few', '只有 ' + n + ' 个探针，至少需要 4 个才能构成四面体。');

    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const k = rawPoints[i].join(',');
      if (seen.has(k)) {
        return failure('duplicate', '探针 ' + seen.get(k) + ' 与探针 ' + i + ' 的坐标完全重合。重合点之间没有可用的方向，请分开这两个探针。');
      }
      seen.set(k, i);
    }

    const diag = diagnose(rawPoints);
    if (diag) return diag;

    const order = sortedByCoord(rawPoints);
    const pts = order.map((o) => o.p);
    const orig = order.map((o) => o.i);
    /* Ranks come from sorted position, so they follow the coordinates, not the input order. */
    const rank = new Array(n);
    for (let i = 0; i < n; i++) rank[i] = i;

    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < lo[k]) lo[k] = p[k];
        if (p[k] > hi[k]) hi[k] = p[k];
      }
    }
    let span = 0;
    for (let k = 0; k < 3; k++) span = Math.max(span, hi[k] - lo[k]);
    const mid = [
      Math.floor((lo[0] + hi[0]) / 2),
      Math.floor((lo[1] + hi[1]) / 2),
      Math.floor((lo[2] + hi[2]) / 2),
    ];

    let lastError = null;
    /* An enclosing tetrahedron that is too small can leave the real hull touching the
       artificial walls; growing it and retrying fixes that without changing the result. */
    for (let attempt = 0; attempt < 4; attempt++) {
      const K = Math.floor(span * Math.pow(64, attempt + 1)) + (1 << 20);
      const shell = [
        [mid[0] - K, mid[1] - K, mid[2] - K],
        [mid[0] + 3 * K, mid[1] - K, mid[2] - K],
        [mid[0] - K, mid[1] + 3 * K, mid[2] - K],
        [mid[0] - K, mid[1] - K, mid[2] + 3 * K],
      ];
      const all = pts.concat(shell);
      const rankAll = rank.concat([n, n + 1, n + 2, n + 3]);

      let tets = [];
      {
        let t = [n, n + 1, n + 2, n + 3];
        if (detOrientBig(all[t[0]], all[t[1]], all[t[2]], all[t[3]]) < 0n) {
          t = [n, n + 2, n + 1, n + 3];
        }
        tets.push(t);
      }

      let failed = null;
      for (let pi = 0; pi < n && !failed; pi++) {
        const p = all[pi];
        const fmap = buildFaceMap(tets);

        let seed = -1;
        for (let ti = 0; ti < tets.length; ti++) {
          if (insideTet(all, tets[ti], p)) { seed = ti; break; }
        }
        if (seed < 0) { failed = 'locate'; break; }

        /* Grow the cavity. A tetrahedron joins when its circumsphere holds p, ties
           resolved symbolically. The seed always joins, so the cavity is never empty. */
        const bad = [seed];
        const badSet = new Set([seed]);
        for (let qi = 0; qi < bad.length; qi++) {
          const ti = bad[qi];
          for (let fi = 0; fi < 4; fi++) {
            const f = faceOf(tets[ti], fi);
            for (const nb of fmap.get(faceKey(f[0], f[1], f[2]))) {
              if (nb === ti || badSet.has(nb)) continue;
              const t = tets[nb];
              const r = insphereInfo(
                all[t[0]], all[t[1]], all[t[2]], all[t[3]], p,
                rankAll[t[0]], rankAll[t[1]], rankAll[t[2]], rankAll[t[3]], rankAll[pi]);
              if (r.sign > 0) { badSet.add(nb); bad.push(nb); }
            }
          }
        }

        /* Re-triangulate the cavity: one new tetrahedron per boundary face. */
        const boundary = [];
        for (const ti of badSet) {
          const t = tets[ti];
          for (let fi = 0; fi < 4; fi++) {
            const f = faceOf(t, fi);
            const k = faceKey(f[0], f[1], f[2]);
            const lst = fmap.get(k);
            let onBoundary = lst.length === 1;
            for (const nb of lst) if (nb !== ti && !badSet.has(nb)) onBoundary = true;
            if (!onBoundary) continue;
            const [a, b, c] = f;
            const o = detOrientBig(all[a], all[b], all[c], p);
            if (o === 0n) continue;
            boundary.push(o > 0n ? [a, b, c, pi] : [a, c, b, pi]);
          }
        }

        const kept = [];
        for (let ti = 0; ti < tets.length; ti++) if (!badSet.has(ti)) kept.push(tets[ti]);
        tets = kept.concat(boundary);
      }
      if (failed) { lastError = failed; continue; }

      const finalTets = [];
      for (const q of tets) {
        if (q.some((v) => v >= n)) continue;
        const o = detOrientBig(all[q[0]], all[q[1]], all[q[2]], all[q[3]]);
        if (o === 0n) continue;
        let r = q.slice();
        if (o < 0n) { const s = r[1]; r[1] = r[2]; r[2] = s; }
        finalTets.push(r);
      }
      if (!finalTets.length) { lastError = 'empty'; continue; }

      finalTets.sort((A, B) => {
        const ka = [...A].sort((x, y) => x - y);
        const kb = [...B].sort((x, y) => x - y);
        for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return 0;
      });

      const check = verify(pts, finalTets, rank, orig);
      if (!check.ok) { lastError = check.errors.join('；'); continue; }

      const outTets = finalTets.map((q) => q.map((v) => orig[v]));
      const structure = assemble(rawPoints, outTets);
      structure.ok = true;
      structure.validation = check;
      structure.attempt = attempt;
      structure.fingerprint = coordinateFingerprint(rawPoints, outTets);
      return structure;
    }

    return failure('build-failed', '剖分在四次尝试后仍不稳定：' + lastError + '。这通常意味着探针几乎排布在一个平面或球面上；移动个别探针后重试。');
  }

  /* ---------------------------------------------------------------- verification */

  function verify(points, tets, rank, orig) {
    const n = points.length;
    const errors = [];
    const fmap = new Map();
    const used = new Array(n).fill(0);
    const tetSeen = new Set();
    let tetVol6 = 0n;

    for (const t of tets) {
      const key = [...t].sort((a, b) => a - b).join(',');
      if (tetSeen.has(key)) errors.push('重复四面体 ' + key);
      tetSeen.add(key);
      const o = detOrientBig(points[t[0]], points[t[1]], points[t[2]], points[t[3]]);
      if (o === 0n) errors.push('退化四面体 ' + key);
      else if (o < 0n) errors.push('反向四面体 ' + key);
      else tetVol6 += o;
      for (const v of t) used[v]++;
      for (let fi = 0; fi < 4; fi++) {
        const f = faceOf(t, fi);
        const k = faceKey(f[0], f[1], f[2]);
        fmap.set(k, (fmap.get(k) || 0) + 1);
      }
    }
    for (let i = 0; i < n; i++) {
      if (!used[i]) errors.push('探针 ' + orig[i] + ' 未参与任何四面体');
    }
    for (const [k, c] of fmap) {
      if (c > 2) errors.push('面 ' + k + ' 被 ' + c + ' 个四面体共享');
    }

    /* Hull faces with outward winding, plus two independent checks on them:
       convexity (all points on the inner side) and a volume that matches the
       sum over tetrahedra. */
    let hullVol6 = 0n;
    let hullFaces = 0;
    for (const [k, c] of fmap) {
      if (c !== 1) continue;
      hullFaces++;
      const f = k.split(',').map(Number);
      let opposite = -1;
      for (const t of tets) {
        if (f.every((v) => t.includes(v))) { opposite = t.find((v) => !f.includes(v)); break; }
      }
      if (opposite < 0) continue;
      const g = f.slice();
      if (detOrientBig(points[g[0]], points[g[1]], points[g[2]], points[opposite]) > 0n) {
        const s = g[1]; g[1] = g[2]; g[2] = s;
      }
      hullVol6 -= detOrientBig(points[g[0]], points[g[1]], points[g[2]], [0, 0, 0]);
      const inner = detOrientBig(points[g[0]], points[g[1]], points[g[2]], points[opposite]);
      for (let i = 0; i < n; i++) {
        if (g.includes(i)) continue;
        if (detOrientBig(points[g[0]], points[g[1]], points[g[2]], points[i]) * inner < 0n) {
          errors.push('凸包面 ' + g.join(',') + ' 不是支撑面');
          break;
        }
      }
    }
    if (tetVol6 !== hullVol6) errors.push('体积不闭合');

    /* Empty-sphere property, with the same symbolic tie rule. */
    let sphereViolations = 0;
    for (const t of tets) {
      for (let i = 0; i < n; i++) {
        if (t.includes(i)) continue;
        const r = insphereInfo(
          points[t[0]], points[t[1]], points[t[2]], points[t[3]], points[i],
          rank[t[0]], rank[t[1]], rank[t[2]], rank[t[3]], rank[i]);
        if (r.sign > 0) { sphereViolations++; break; }
      }
    }
    if (sphereViolations) errors.push(sphereViolations + ' 个四面体的外接球包含其他探针');

    return {
      ok: errors.length === 0,
      errors,
      hullFaces,
      sphereViolations,
      tetVolume: Number(tetVol6) / 6,
    };
  }

  /* ---------------------------------------------------------------- structure */

  /* Fingerprint of the geometry, not of the indices: each tetrahedron is keyed by the
     sorted coordinate triples of its vertices. Two runs over the same point set in any
     input order produce the same string. Winding is included by keeping vertex order. */
  function coordinateFingerprint(points, tets) {
    const coordKey = (v) => points[v].join(':');
    const keys = tets.map((t) => {
      /* A positively oriented simplex can be written starting from any of its four
         vertices; rotating (not shuffling) keeps the orientation, so rotating the
         lexicographically smallest coordinate to the front gives one canonical form. */
      let best = 0, bestKey = null;
      for (let r = 0; r < 4; r++) {
        const k = [t[r], t[(r + 1) % 4], t[(r + 2) % 4], t[(r + 3) % 4]].map(coordKey).join('|');
        if (bestKey === null || k < bestKey) { bestKey = k; best = r; }
      }
      return [t[best], t[(best + 1) % 4], t[(best + 2) % 4], t[(best + 3) % 4]]
        .map(coordKey).join('|');
    }).sort();
    return hashString(keys.join(';'));
  }

  function assemble(points, tets) {
    const fmap = new Map();
    for (let ti = 0; ti < tets.length; ti++) {
      for (let fi = 0; fi < 4; fi++) {
        const f = faceOf(tets[ti], fi);
        const k = faceKey(f[0], f[1], f[2]);
        const e = fmap.get(k);
        if (e) e.push(ti); else fmap.set(k, [ti]);
      }
    }
    const neighbors = tets.map(() => [-1, -1, -1, -1]);
    for (let i = 0; i < tets.length; i++) {
      for (let fi = 0; fi < 4; fi++) {
        const f = faceOf(tets[i], fi);
        const lst = fmap.get(faceKey(f[0], f[1], f[2]));
        if (lst.length === 2) neighbors[i][fi] = lst[0] === i ? lst[1] : lst[0];
      }
    }

    const hull = [];
    for (const [k, lst] of fmap) {
      if (lst.length !== 1) continue;
      const ti = lst[0];
      let fi = -1;
      for (let q = 0; q < 4; q++) {
        const f = faceOf(tets[ti], q);
        if (faceKey(f[0], f[1], f[2]) === k) { fi = q; break; }
      }
      const tri = faceOf(tets[ti], fi).slice();
      const rest = tets[ti].find((v) => !tri.includes(v));
      if (detOrientBig(points[tri[0]], points[tri[1]], points[tri[2]], points[rest]) > 0n) {
        const s = tri[1]; tri[1] = tri[2]; tri[2] = s;
      }
      hull.push({ tet: ti, tri });
    }
    hull.sort((A, B) => {
      const ka = [...A.tri].sort((x, y) => x - y);
      const kb = [...B.tri].sort((x, y) => x - y);
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return 0;
    });

    const volume6 = tets.reduce(
      (s, t) => s + detOrientBig(points[t[0]], points[t[1]], points[t[2]], points[t[3]]), 0n);

    return { ok: true, points, tets, neighbors, hull, volume6 };
  }

  return { triangulate, diagnose, verify, assemble, failure, coordinateFingerprint };
});
