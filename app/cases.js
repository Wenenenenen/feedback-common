/* Extra built-in layouts for quick exploration.

   The two cases in samples/tetra-probe-cases.json stay the reference samples; these
   add a minimal tetrahedron, a 64-probe lattice, a shell of probes and a layout that
   makes the zero clamp visible. Coefficients are generated from a smooth field so the
   colours are plausible rather than noise. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TETRA_CASES = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const rng = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  /* Coefficients that behave like a smooth light probe: a warm-to-cool gradient across
     the volume, a directional lobe, plus a small per-probe offset. */
  function fieldCoefficients(p, i, r) {
    const t = (p[0] + 1000) / 2000, u = (p[1] + 1000) / 2000, v = (p[2] + 1000) / 2000;
    const jitter = (r() - 0.5) * 0.04;
    return [
      [0.12 + 0.38 * t + jitter, 0.35, 0.22, 0.10],
      [0.10 + 0.34 * u + jitter, 0.16, 0.40, 0.12],
      [0.14 + 0.30 * v - jitter, 0.22, 0.14, 0.36],
    ];
  }

  function makeProbes(points, seed) {
    const r = rng(seed);
    return points.map((p, i) => ({
      id: String(i),
      p: p.slice(),
      c: fieldCoefficients(p, i, r),
    }));
  }

  function lattice(dims, step, origin) {
    const o = origin || [0, 0, 0];
    const out = [];
    for (let x = 0; x < dims[0]; x++)
      for (let y = 0; y < dims[1]; y++)
        for (let z = 0; z < dims[2]; z++)
          out.push([o[0] + x * step, o[1] + y * step, o[2] + z * step]);
    return out;
  }

  function shell(n, seed) {
    const r = rng(seed);
    const out = [];
    const seen = new Set();
    while (out.length < n) {
      const p = [
        Math.floor(r() * 2001) - 1000,
        Math.floor(r() * 2001) - 1000,
        Math.floor(r() * 2001) - 1000,
      ];
      p[Math.floor(r() * 3)] = r() < 0.5 ? -1000 : 1000;
      const k = p.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  }

  const cases = [
    {
      id: 'tetra',
      name: '最小四面体',
      desc: '4 个探针，只有一个单元',
      probes: makeProbes([[0, 0, 0], [8, 0, 0], [0, 8, 0], [0, 0, 8]], 21),
      queries: [[2, 2, 2], [6, 1, 1], [-3, 2, 2]],
    },
    {
      id: 'cube27',
      name: '3×3×3 立方网格',
      desc: '27 个探针，规则排布',
      probes: makeProbes(lattice([3, 3, 3], 8, [-8, -8, -8]), 33),
      queries: [[0, 0, 0], [9, -9, 4], [14, 0, 0]],
    },
    {
      id: 'lattice64',
      name: '4×4×4 立方网格',
      desc: '64 个探针，上限规模',
      probes: makeProbes(lattice([4, 4, 4], 10, [-15, -15, -15]), 47),
      queries: [[0, 0, 0], [7, 7, 7], [22, 0, 0]],
    },
    {
      id: 'shell',
      name: '随机外壳',
      desc: '24 个探针贴在外壳上',
      probes: makeProbes(shell(24, 91), 91),
      queries: [[0, 0, 0], [400, 400, 400], [-700, 100, 300]],
    },
    {
      id: 'clamp',
      name: '负值钳制',
      desc: '法线与线性项反向时归零',
      probes: makeProbes([[-10, -10, -10], [10, -10, -10], [-10, 10, -10], [-10, -10, 10], [0, 0, 0], [10, 10, 10]], 7)
        .map((p, i) => ({
          id: p.id,
          p: p.p,
          c: [
            [0.10 + i * 0.05, -0.55, 0.20, 0.10],
            [0.24 + i * 0.03, 0.10, -1.05, 0.20],
            [0.05 + i * 0.04, 0.15, 0.10, -0.50],
          ],
        })),
      queries: [[0, 0, 0], [6, 0, 0]],
    },
  ];

  return { cases };
});
