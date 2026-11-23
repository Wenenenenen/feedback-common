'use strict';
// 高强度模糊：复用 test.js 的暴力参考，独立跑更大规模
const path = require('path');
const engine = require('../src/engine.js');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const D8 = D4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

function bruteQuery(project, version, x, y) {
  const g = project.rows.map((r) => r.split(''));
  const chain = [];
  let v = version;
  while (v > 0) { chain.push(v - 1); v = project.edits[v - 1].parent; }
  for (let k = chain.length - 1; k >= 0; k--) {
    const e = project.edits[chain[k]];
    g[e.y][e.x] = e.value;
  }
  const w = g[0].length, h = g.length;
  const target = g[y][x];
  const dirs = target === '.' ? D8 : D4;
  const seen = Array.from({ length: h }, () => new Array(w).fill(false));
  const stack = [[x, y]];
  seen[y][x] = true;
  let area = 0, perimeter = 0, touch = false;
  const owners = new Set();
  while (stack.length) {
    const [cx, cy] = stack.pop();
    area++;
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touch = true;
    for (const [dx, dy] of D4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) perimeter++;
      else if (g[ny][nx] !== target) {
        perimeter++;
        if (target === '.' && g[ny][nx] !== '.') owners.add(g[ny][nx]);
      }
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (seen[ny][nx] || g[ny][nx] !== target) continue;
      seen[ny][nx] = true;
      stack.push([nx, ny]);
    }
  }
  if (target === '.') {
    return { type: 'empty', version, x, y, area, enclave: !touch, owner: owners.size === 1 ? [...owners][0] : null };
  }
  return { type: 'territory', version, x, y, faction: target, area, perimeter };
}

function randomProject(rng, w, h, editN, queryN, alphabet) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      if (y === 0 && x < alphabet.length) { s += alphabet[x]; continue; }
      s += rng() < 0.4 ? '.' : alphabet[Math.floor(rng() * alphabet.length)];
    }
    rows.push(s);
  }
  const edits = [];
  for (let i = 0; i < editN; i++) {
    edits.push({
      parent: Math.floor(rng() * (i + 1)),
      x: Math.floor(rng() * w), y: Math.floor(rng() * h),
      value: rng() < 0.45 ? '.' : alphabet[Math.floor(rng() * alphabet.length)],
    });
  }
  const V = editN + 1;
  const queries = [];
  for (let i = 0; i < queryN; i++) {
    queries.push({ version: Math.floor(rng() * V), x: Math.floor(rng() * w), y: Math.floor(rng() * h) });
  }
  return { rows, edits, queries };
}

const configs = [
  { w: 12, h: 12, edits: 300, queries: 400, alpha: ['A', 'B', 'C'], rounds: 120 },
  { w: 20, h: 16, edits: 500, queries: 600, alpha: ['A', 'B', 'C', 'D', 'E'], rounds: 60 },
  { w: 5, h: 5, edits: 200, queries: 300, alpha: ['A', 'B'], rounds: 150 },
  { w: 30, h: 30, edits: 800, queries: 800, alpha: ['A', 'B', 'C'], rounds: 30 },
];

let totalRounds = 0;
let failures = 0;
const t0 = Date.now();
for (const cfg of configs) {
  for (let r = 0; r < cfg.rounds; r++) {
    const rng = mulberry32(7000 + totalRounds * 104729);
    totalRounds++;
    const input = randomProject(rng, cfg.w, cfg.h, cfg.edits, cfg.queries, cfg.alpha);
    const v = engine.validateProject(input);
    if (!v.ok) { failures++; console.error('校验失败', v.errors.join(';')); continue; }
    const got = engine.runBatch(v.project);
    for (let i = 0; i < got.length; i++) {
      const q = input.queries[i];
      const want = bruteQuery(v.project, q.version, q.x, q.y);
      if (JSON.stringify(got[i]) !== JSON.stringify(want)) {
        failures++;
        console.error(`分歧 cfg=${cfg.w}x${cfg.h} round=${totalRounds} q#${i}`);
        console.error('  got =', JSON.stringify(got[i]));
        console.error('  want=', JSON.stringify(want));
        if (failures > 5) process.exit(1);
        break;
      }
    }
  }
}
console.log(`高强度模糊：${totalRounds} 个随机项目、全部查询比对暴力，${failures} 失败，耗时 ${Date.now() - t0}ms`);
process.exit(failures === 0 ? 0 : 1);
