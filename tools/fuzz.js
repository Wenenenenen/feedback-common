'use strict';
/*
 * Randomised differential test: exact DP (src/solver.js) vs brute force.
 * Run: node tools/fuzz.js [iterations] [seed]
 */
const { solveProject } = require('../src/solver.js');
const { solveBrute } = require('./brute.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function makeProject(rng) {
  const W = randInt(rng, 6, 14);
  const H = randInt(rng, 5, 10);
  const cw = randInt(rng, 2, W);
  const ch = randInt(rng, 2, H);
  const n = randInt(rng, 1, 7);
  const sx = randInt(rng, 0, 4);
  const sy = randInt(rng, 0, 3);
  const ax = randInt(rng, 0, 3);
  const ay = randInt(rng, 0, 2);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const cut = i > 0 && rng() < 0.2;
    const cands = [];
    const nc = randInt(rng, 1, 6);
    for (let j = 0; j < nc; j++) cands.push([randInt(rng, 0, W - cw), randInt(rng, 0, H - ch)]);
    // dedupe
    const uniq = [];
    const seen = new Set();
    for (const c of cands) { const k = c[0] + ':' + c[1]; if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
    const must = [];
    if (rng() < 0.5) {
      const bw = randInt(rng, 1, cw), bh = randInt(rng, 1, ch);
      const bx = randInt(rng, 0, W - bw), by = randInt(rng, 0, H - bh);
      must.push([bx, by, bx + bw, by + bh]);
    }
    const soft = [];
    const ns = randInt(rng, 0, 3);
    for (let j = 0; j < ns; j++) {
      const bw = randInt(rng, 1, W), bh = randInt(rng, 1, H);
      const bx = randInt(rng, 0, W - bw), by = randInt(rng, 0, H - bh);
      soft.push({ box: [bx, by, bx + bw, by + bh], weight: randInt(rng, 0, 5) });
    }
    frames.push({ cut, candidates: uniq, must, soft });
  }
  const locks = {};
  for (let i = 0; i < n; i++) {
    if (rng() < 0.2 && frames[i].candidates.length) locks[String(i)] = pick(rng, frames[i].candidates);
  }
  return { width: W, height: H, crop: [cw, ch], speed: [sx, sy], accel: [ax, ay], locks, frames };
}

function samePositions(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

const iterations = parseInt(process.argv[2] || '3000', 10);
const seed = parseInt(process.argv[3] || '1', 10);
const rng = mulberry32(seed);
let failures = 0;
let feasibles = 0;
const t0 = Date.now();

for (let it = 0; it < iterations; it++) {
  const project = makeProject(rng);
  // Half the runs exercise the runtime lock-override path the app uses.
  let override = null;
  if (it % 2 === 1) {
    override = {};
    for (let i = 0; i < project.frames.length; i++) {
      if (rng() < 0.25) {
        const cw = project.crop[0], ch = project.crop[1];
        override[String(i)] = [randInt(rng, 0, project.width - cw), randInt(rng, 0, project.height - ch)];
      }
    }
  }
  const dp = solveProject(project, override);
  const bf = solveBrute(project, override || undefined);

  let bad = null;
  if (dp.ok !== bf.ok) bad = `ok mismatch dp=${dp.ok} bf=${bf.ok}`;
  else if (dp.ok) {
    feasibles++;
    if (dp.totalScore !== bf.totalScore) bad = `score dp=${dp.totalScore} bf=${bf.totalScore}`;
    else if (dp.totalAccel !== bf.totalAccel) bad = `accel dp=${dp.totalAccel} bf=${bf.totalAccel}`;
    else if (!samePositions(dp.positions, bf.positions)) bad = `positions dp=${JSON.stringify(dp.positions)} bf=${JSON.stringify(bf.positions)}`;
  } else {
    if (dp.failFrame !== bf.failFrame) bad = `failFrame dp=${dp.failFrame} bf=${bf.failFrame}`;
  }
  if (bad) {
    failures++;
    console.error(`\nFAIL #${it}: ${bad}`);
    console.error(JSON.stringify(project));
    if (failures >= 5) break;
  }
}

console.log(`\n${iterations} iterations, ${feasibles} feasible, ${failures} failures, ${Date.now() - t0}ms`);
process.exit(failures ? 1 : 0);
