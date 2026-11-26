'use strict';
/* Max-scale benchmark: 900 frames x 96 candidates. */
const { solveProject } = require('../src/solver.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function build(opts) {
  const rng = mulberry32(opts.seed || 1);
  const W = 1920, H = 1080;
  const cw = opts.cw || 608, ch = opts.ch || 1080;
  const n = opts.n || 900;
  const nc = opts.nc || 96;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const cands = [];
    const seen = new Set();
    while (cands.length < nc) {
      const x = Math.floor(rng() * (W - cw + 1));
      const y = Math.floor(rng() * (H - ch + 1));
      const k = x + ':' + y;
      if (seen.has(k)) continue;
      seen.add(k); cands.push([x, y]);
    }
    const must = [];
    if (opts.must) {
      const bw = Math.floor(rng() * cw * 0.4) + 50;
      const bh = Math.floor(rng() * ch * 0.4) + 50;
      const bx = Math.floor(rng() * (W - bw));
      const by = Math.floor(rng() * (H - bh));
      must.push([bx, by, bx + bw, by + bh]);
    }
    const soft = [];
    for (let j = 0; j < 8; j++) {
      const bw = Math.floor(rng() * 500) + 100;
      const bh = Math.floor(rng() * 500) + 100;
      soft.push({ box: [Math.floor(rng() * (W - bw)), Math.floor(rng() * (H - bh)),
                        Math.floor(rng() * (W - bw)) + bw, Math.floor(rng() * (H - bh)) + bh], weight: Math.floor(rng() * 1001) });
    }
    frames.push({ cut: i > 0 && i % 120 === 0, candidates: cands, must, soft });
  }
  return { width: W, height: H, crop: [cw, ch], speed: opts.speed || [40, 30], accel: opts.accel || [10, 8], locks: {}, frames };
}

const cases = [
  { name: 'wide crop 608x1080, speed 40/30', cw: 608, ch: 1080, speed: [40, 30], accel: [10, 8] },
  { name: 'square 640x640, speed 30/30', cw: 640, ch: 640, speed: [30, 30], accel: [10, 10] },
  { name: 'very loose speed 200/200', cw: 608, ch: 1080, speed: [200, 200], accel: [100, 100] },
  { name: 'tiny crop 100x100 speed 20', cw: 100, ch: 100, speed: [20, 20], accel: [8, 8] },
  { name: 'speed 0 (static)', cw: 608, ch: 1080, speed: [0, 0], accel: [0, 0] },
];

for (const c of cases) {
  const project = build(c);
  const t0 = Date.now();
  const r = solveProject(project);
  console.log(`${c.name}: ok=${r.ok} ${Date.now() - t0}ms (reported ${r.solveMs | 0}ms) score=${r.totalScore} accel=${r.totalAccel}`);
}
