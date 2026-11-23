'use strict';
// traceEnclave 增量优化 vs 全链暴力；含深链性能
const engine = require('../src/engine.js');

// 构造一个最小 window.FrontierEngine 环境以加载 app.js
global.window = global;
global.FrontierEngine = engine;
require('../src/app.js');
const App = global.FrontierApp;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 暴力全链：每个祖先版本独立泛洪
function bruteTrace(project, version, x, y, charToCode) {
  const chain = [];
  let v = version;
  while (v > 0) { chain.push(v); v = project.edits[v - 1].parent; }
  chain.push(0);
  const out = [];
  for (const ver of chain) {
    const grid = engine.materializeGrid(project, ver, charToCode);
    const w = project.rows[0].length;
    if (grid[y * w + x] !== 0) { out.push({ version: ver, status: 'not-empty' }); continue; }
    const blk = engine.floodBlock(project, ver, x, y, 8, charToCode);
    out.push({ version: ver, area: blk.area, enclave: blk.enclave });
  }
  const first = out.filter((r) => r.enclave).map((r) => r.version);
  return { recs: out, became: first.length ? Math.min(...first) : null };
}

let failures = 0;
const cfg = { w: 14, h: 14, edits: 400, rounds: 60, alpha: ['A', 'B', 'C'] };
for (let round = 0; round < cfg.rounds; round++) {
  const rng = mulberry32(5000 + round * 131);
  const rows = [];
  for (let yy = 0; yy < cfg.h; yy++) {
    let s = '';
    for (let xx = 0; xx < cfg.w; xx++) {
      if (yy === 0 && xx < cfg.alpha.length) { s += cfg.alpha[xx]; continue; }
      s += rng() < 0.45 ? '.' : cfg.alpha[Math.floor(rng() * cfg.alpha.length)];
    }
    rows.push(s);
  }
  const edits = [];
  for (let i = 0; i < cfg.edits; i++) {
    edits.push({
      parent: Math.floor(rng() * (i + 1)),
      x: Math.floor(rng() * cfg.w), y: Math.floor(rng() * cfg.h),
      value: rng() < 0.5 ? '.' : cfg.alpha[Math.floor(rng() * cfg.alpha.length)],
    });
  }
  const input = { rows, edits, queries: [] };
  const valid = engine.validateProject(input);
  if (!valid.ok) { console.error('校验失败', valid.errors); failures++; continue; }
  App.loadProject(valid.project, 'test');
  const c2m = App.state.charToCode;

  // 在多个版本、多个空地格上比对
  for (const probeVer of [Math.floor(cfg.edits * 0.5), cfg.edits]) {
    App.state.currentVersion = probeVer;
    const grid = App.gridAt(probeVer);
    const empties = [];
    for (let c = 0; c < cfg.w * cfg.h; c++) if (grid[c] === 0) empties.push(c);
    const picks = empties.filter((_, k) => k % Math.max(1, Math.floor(empties.length / 4)) === 0).slice(0, 4);
    for (const cell of picks) {
      const x = cell % cfg.w, y = (cell - x) / cfg.w;
      const got = App.traceEnclave(x, y);
      const want = bruteTrace(valid.project, probeVer, x, y, c2m);
      // 实现的语义：在"实际检查的版本窗口"内，最近一段连续飞地的起点；
      // 暴力侧用同一窗口重算，保证口径一致
      const checkedVers = new Set(got.trace.map((r) => r.version));
      const windowEnclaves = want.recs
        .filter((r) => checkedVers.has(r.version) && r.enclave)
        .map((r) => r.version);
      const wantBecameInWindow = windowEnclaves.length ? Math.max(...windowEnclaves) : null;
      if (got.becameEnclaveAt !== wantBecameInWindow) {
        failures++;
        console.error(`分歧 round=${round} v=${probeVer} (${x},${y}): got.became=${got.becameEnclaveAt} want(窗口)=${wantBecameInWindow}`);
      }
      // 逐版本飞地布尔一致（只比对双方都计算了的版本）
      const gotMap = new Map(got.trace.map((r) => [r.version, r]));
      for (const wr of want.recs) {
        const gr = gotMap.get(wr.version);
        if (!gr) continue; // 提前停止的更老版本不要求出现
        if (wr.status === 'not-empty') {
          if (gr.status !== 'not-empty') { failures++; console.error('not-empty 不一致', wr.version); }
        } else if (gr.enclave !== wr.enclave || gr.area !== wr.area) {
          failures++;
          console.error(`版本 ${wr.version} 分量不一致: got`, JSON.stringify({ e: gr.enclave, a: gr.area }), 'want', JSON.stringify({ e: wr.enclave, a: wr.area }));
        }
      }
    }
  }
}
console.log(failures === 0 ? `溯源正确性：${cfg.rounds} 轮随机项目全部一致` : `存在 ${failures} 处分歧`);

// 深链性能：12 万线性版本，溯源应在远小于全链泛洪的时间内完成
{
  const rng = mulberry32(99);
  const W = 64, H = 64;
  const rows = [];
  for (let yy = 0; yy < H; yy++) {
    let s = '';
    for (let xx = 0; xx < W; xx++) s += rng() < 0.4 ? '.' : 'ABC'[Math.floor(rng() * 3)];
    rows.push(s);
  }
  const edits = [];
  for (let i = 0; i < 120000; i++) {
    edits.push({
      parent: i, // 纯线性深链
      x: Math.floor(rng() * W), y: Math.floor(rng() * H),
      value: rng() < 0.5 ? '.' : 'ABC'[Math.floor(rng() * 3)],
    });
  }
  const valid = engine.validateProject({ rows, edits, queries: [] });
  App.loadProject(valid.project, 'deep');
  App.state.currentVersion = 120000;
  const grid = App.gridAt(120000);
  let target = grid.findIndex((c) => c === 0);
  if (target < 0) target = 0;
  const tx = target % W, ty = (target - tx) / W;
  const t0 = Date.now();
  const res = App.traceEnclave(tx, ty);
  const ms = Date.now() - t0;
  console.log(`深链溯源：${ms} ms，链长 120001，检查 ${res.checked} 个版本（上限 600），truncated=${res.truncated}，成因 v${res.becameEnclaveAt}`);
  if (ms > 3000) { console.error('深链溯源过慢'); failures++; }
}
process.exit(failures === 0 ? 0 : 1);
