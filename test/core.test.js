'use strict';

/* 求解器与核心模块的 Node 测试。
 * 覆盖：
 *   1. 与暴力枚举的字典序最优对照（含锁定、并列时的列表次序）。
 *   2. 局部 2×2「恰三去一留」即 L 形的判据与全局矩形合法性一致。
 *   3. 短边代价的像素规则（不含端点、掩膜为 0 剔除）。
 *   4. PGM / grid.json / zip 解析与越界、超限报错。
 *   5. 锁定冲突与不可行铺法的语义。
 *   6. 满额 24×8 的求解耗时与已知真值一致性。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const Solver = require('../src/solver.js');
const Core = require('../src/core.js');

// ---------- 工具：暴力枚举与独立评估 ----------
function allTilings(R, C) {
  const res = [];
  const cov = new Array(R * C).fill(false);
  const rects = [];
  (function rec() {
    let idx = -1;
    for (let i = 0; i < R * C; i++) if (!cov[i]) { idx = i; break; }
    if (idx < 0) { res.push(rects.slice()); return; }
    const t = Math.floor(idx / C), c0 = idx % C;
    for (let b = t + 1; b <= R; b++) {
      for (let rr = c0 + 1; rr <= C; rr++) {
        let ok = true;
        for (let y = t; y < b && ok; y++) for (let x = c0; x < rr; x++) if (cov[y * C + x]) { ok = false; break; }
        if (!ok) continue;
        for (let y = t; y < b; y++) for (let x = c0; x < rr; x++) cov[y * C + x] = true;
        rects.push([t, c0, b, rr]);
        rec();
        rects.pop();
        for (let y = t; y < b; y++) for (let x = c0; x < rr; x++) cov[y * C + x] = false;
      }
    }
  })();
  return res;
}

function evalTiling(R, C, til, keep, rem, locks) {
  locks = locks || {};
  const owner = new Array(R * C).fill(-1);
  til.forEach(([t, c0, b, rr], i) => {
    for (let y = t; y < b; y++) for (let x = c0; x < rr; x++) owner[y * C + x] = i;
  });
  let loss = 0;
  for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
    const v = owner[r * C + c - 1] === owner[r * C + c] ? 'remove' : 'keep';
    const e = `v,${r},${c}`;
    if (locks[e] && locks[e] !== v) return null;
    loss += v === 'remove' ? rem[e] : keep[e];
  }
  for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
    const v = owner[(r - 1) * C + c] === owner[r * C + c] ? 'remove' : 'keep';
    const e = `h,${r},${c}`;
    if (locks[e] && locks[e] !== v) return null;
    loss += v === 'remove' ? rem[e] : keep[e];
  }
  return {
    loss, count: til.length,
    til: til.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])
  };
}

function brute(R, C, keep, rem, locks) {
  let best = null;
  for (const til of allTilings(R, C)) {
    const e = evalTiling(R, C, til, keep, rem, locks);
    if (!e) continue;
    const key = [e.loss, e.count, JSON.stringify(e.til)];
    if (!best || key[0] < best.loss || (key[0] === best.loss &&
      (key[1] < best.count || (key[1] === best.count && key[2] < JSON.stringify(best.til))))) {
      best = e;
    }
  }
  return best;
}

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCosts(R, C, g, maxv) {
  const vKeep = [], vRem = [], hKeep = [], hRem = [];
  const keep = {}, rem = {};
  for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
    const k = Math.floor(g() * maxv), m = Math.floor(g() * maxv);
    vKeep.push(k); vRem.push(m); keep[`v,${r},${c}`] = k; rem[`v,${r},${c}`] = m;
  }
  for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
    const k = Math.floor(g() * maxv), m = Math.floor(g() * maxv);
    hKeep.push(k); hRem.push(m); keep[`h,${r},${c}`] = k; rem[`h,${r},${c}`] = m;
  }
  return { vKeep, vRem, hKeep, hRem, keep, rem };
}

function lockArr(locksMap) {
  return Object.keys(locksMap).map((e) => {
    const p = e.split(',');
    return { axis: p[0], row: +p[1], col: +p[2], keep: locksMap[e] === 'keep' };
  });
}

function assertSame(js, best, ctx) {
  assert.equal(!!js.feasible, !!best, ctx + ' 可行性');
  if (!best) return;
  assert.equal(js.loss, best.loss, ctx + ' 总损失');
  assert.equal(js.count, best.count, ctx + ' 矩形数');
  assert.deepEqual(js.rects, best.til, ctx + ' 矩形列表');
}

// ==========================================================================
test('求解器：小网格与暴力枚举字典序最优一致', () => {
  const grids = [[1, 1], [1, 3], [2, 2], [2, 3], [3, 2], [3, 3], [2, 4], [4, 2], [3, 4], [4, 3], [2, 5], [5, 2], [4, 4]];
  let n = 0;
  for (const [R, C] of grids) {
    const tilings = allTilings(R, C);
    const trials = R * C <= 9 ? 40 : 12;
    for (let trial = 0; trial < trials; trial++) {
      const g = rng(1000 + R * 37 + C * 97 + trial);
      const costs = buildCosts(R, C, g, 9);
      const locks = {};
      const edgeList = Object.keys(costs.keep);
      if (trial % 4 === 1 && edgeList.length) {
        const k = 1 + Math.floor(g() * Math.min(2, edgeList.length));
        for (let i = 0; i < k; i++) {
          const e = edgeList[Math.floor(g() * edgeList.length)];
          locks[e] = g() < 0.5 ? 'keep' : 'remove';
        }
      }
      const js = Solver.solve({
        R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem,
        locks: lockArr(locks)
      });
      const best = brute(R, C, costs.keep, costs.rem, locks);
      assertSame(js, best, `${R}x${C} #${trial}`);
      n++;
    }
    assert.ok(tilings.length > 0);
  }
  assert.ok(n >= 200, '样本数 ' + n);
});

test('求解器：并列损失下按矩形列表字典序取最优', () => {
  for (const [R, C] of [[2, 3], [3, 3], [3, 4], [4, 3], [2, 5], [5, 2]]) {
    for (let trial = 0; trial < 40; trial++) {
      const g = rng(9000 + R * 31 + C * 7 + trial);
      const maxv = trial % 2 ? 2 : 1;  // 大量并列
      const costs = buildCosts(R, C, g, maxv);
      const js = Solver.solve({
        R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem, locks: []
      });
      const best = brute(R, C, costs.keep, costs.rem, {});
      assertSame(js, best, `并列 ${R}x${C} #${trial}`);
    }
  }
});

test('求解器：中网格（含 1.6M 铺法量级）与暴力枚举一致', () => {
  // 3×5/4×4/4×5/5×4/3×6/2×8 的矩形铺法数分别为 3.1万/7万/161万/161万/31万/5.6万，
  // 用来检验 DP 的字典序剪枝在这些规模上仍然无损。
  // 161 万量级的网格减少重复次数，控制测试时长。
  const grids = [[3, 5, 4], [4, 4, 4], [4, 5, 1], [5, 4, 1], [3, 6, 2], [2, 8, 4]];
  let n = 0;
  for (const [R, C, trials] of grids) {
    for (let trial = 0; trial < trials; trial++) {
      const g = rng(R * 131 + C * 17 + trial * 7);
      const maxv = [1, 2, 3, 9][trial % 4];
      const costs = buildCosts(R, C, g, maxv);
      const locks = {};
      if (trial % 5 === 0) {
        const edgeList = Object.keys(costs.keep);
        const k = 1 + Math.floor(g() * 3);
        for (let i = 0; i < k; i++) {
          const e = edgeList[Math.floor(g() * edgeList.length)];
          locks[e] = g() < 0.5 ? 'keep' : 'remove';
        }
      }
      const js = Solver.solve({
        R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem,
        locks: lockArr(locks)
      });
      const best = brute(R, C, costs.keep, costs.rem, locks);
      assertSame(js, best, `中网格 ${R}x${C} #${trial}`);
      n++;
    }
  }
  assert.equal(n, 16);
});

test('求解器：局部 2×2 恰三去一留即 L 形，与全局矩形合法性等价', () => {
  // 独立实现全局判定：去掉的短边连成组件，组件必须填满其包围盒。
  function globalOk(R, C, remSet) {
    const par = new Array(R * C).fill(0).map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
      if (remSet.has(`v,${r},${c}`)) uni(r * C + c - 1, r * C + c);
    }
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
      if (remSet.has(`h,${r},${c}`)) uni((r - 1) * C + c, r * C + c);
    }
    const comp = new Map();
    for (let i = 0; i < R * C; i++) {
      const root = find(i);
      if (!comp.has(root)) comp.set(root, []);
      comp.get(root).push(i);
    }
    for (const cells of comp.values()) {
      const rs = cells.map((x) => Math.floor(x / C)), cs = cells.map((x) => x % C);
      const r0 = Math.min(...rs), r1 = Math.max(...rs), c0 = Math.min(...cs), c1 = Math.max(...cs);
      if ((r1 - r0 + 1) * (c1 - c0 + 1) !== cells.length) return false;
    }
    // 保留的内部边必须分开不同组件
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
      if (!remSet.has(`v,${r},${c}`) && find(r * C + c - 1) === find(r * C + c)) return false;
    }
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
      if (!remSet.has(`h,${r},${c}`) && find((r - 1) * C + c) === find(r * C + c)) return false;
    }
    return true;
  }
  function localOk(R, C, remSet) {
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < C - 1; c++) {
      const quad = [`v,${r},${c + 1}`, `v,${r + 1},${c + 1}`, `h,${r + 1},${c}`, `h,${r + 1},${c + 1}`];
      const removed = quad.filter((e) => remSet.has(e));
      if (removed.length === 3) return false;
      if (removed.length === 2) {
        const s = new Set(removed);
        const vert = quad[0] === [...s][0] || quad[1] === [...s][0];
        const allVert = s.has(quad[0]) && s.has(quad[1]);
        const allHorz = s.has(quad[2]) && s.has(quad[3]);
        if (!allVert && !allHorz) return false;
        void vert;
      }
    }
    return true;
  }
  for (const [R, C] of [[2, 3], [3, 3], [2, 4], [4, 2]]) {
    const edges = [];
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) edges.push(`v,${r},${c}`);
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) edges.push(`h,${r},${c}`);
    const total = 1 << edges.length;
    for (let m = 0; m < total; m++) {
      const set = new Set();
      edges.forEach((e, i) => { if ((m >> i) & 1) set.add(e); });
      assert.equal(localOk(R, C, set), globalOk(R, C, set), `${R}x${C} mask ${m}`);
    }
  }
});

test('求解器：无锁定时全集铺法必定可行', () => {
  for (const [R, C] of [[1, 1], [3, 3], [8, 8], [24, 8]]) {
    const g = rng(R * 100 + C);
    const costs = buildCosts(R, C, g, 7);
    const js = Solver.solve({
      R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem, locks: []
    });
    assert.equal(js.feasible, true);
    assert.ok(js.rects.length >= 1 && js.rects.length <= R * C);
  }
});

test('求解器：锁定冲突与不可行铺法分别报告', () => {
  const R = 2, C = 2;
  const base = { R, C, vKeep: [5, 5], vRem: [5, 5], hKeep: [5, 5], hRem: [5, 5] };
  const direct = Solver.solve(Object.assign({}, base, { locks: [
    { axis: 'v', row: 0, col: 1, keep: true },
    { axis: 'v', row: 0, col: 1, keep: false }
  ] }));
  assert.equal(direct.feasible, false);
  assert.equal(direct.reason, 'lock-conflict');

  // 2×2 中三点去掉、一点保留 ⇒ L 形，全局不可行
  const L = Solver.solve(Object.assign({}, base, { locks: [
    { axis: 'v', row: 0, col: 1, keep: false },
    { axis: 'h', row: 1, col: 0, keep: false },
    { axis: 'v', row: 1, col: 1, keep: true },
    { axis: 'h', row: 1, col: 1, keep: true }
  ] }));
  assert.equal(L.feasible, false);
  assert.equal(L.reason, 'no-tiling');

  // 四点全去掉 ⇒ 2×2 整块可行
  const ok = Solver.solve(Object.assign({}, base, { locks: [
    { axis: 'v', row: 0, col: 1, keep: false },
    { axis: 'h', row: 1, col: 0, keep: false },
    { axis: 'h', row: 1, col: 1, keep: false }
  ] }));
  // 注意：2x2 只有一条竖内边，需要把 v,1,1 也去掉（该网格 C=2 只有 c=1）
  assert.equal(ok.feasible, true);
});

test('求解器：强制相反决定可识别为不可行', () => {
  const R = 2, C = 2;
  const base = { R, C, vKeep: [5, 5], vRem: [5, 5], hKeep: [5, 5], hRem: [5, 5], locks: [
    { axis: 'v', row: 0, col: 1, keep: false },
    { axis: 'h', row: 1, col: 0, keep: false },
    { axis: 'v', row: 1, col: 1, keep: false }
  ] };
  const forced = Solver.solve(Object.assign({}, base, { force: { axis: 'h', row: 1, col: 1, keep: true } }));
  assert.equal(forced.feasible, false);
});

// ==========================================================================
test('核心：短边只取不含两端的像素，掩膜 0 剔除', () => {
  const W = 6, H = 5;
  const data = new Uint8Array(W * H).fill(200);
  // 竖线 x=2 在 y=1..3
  data[1 * W + 2] = 10; data[2 * W + 2] = 20; data[3 * W + 2] = 30;
  // 端点像素（y=0, y=4）应被忽略
  data[0 * W + 2] = 99; data[4 * W + 2] = 88;
  // 横线 y=2 在 x=1..4
  data[2 * W + 1] = 50; data[2 * W + 3] = 60; data[2 * W + 4] = 70;
  const scan = { width: W, height: H, maxval: 255, data };
  const grid = Core.parseGrid({ xs: [0, 2, 5], ys: [0, 2, 4], locks: [] });
  const costs = Core.edgeCosts(scan, null, grid);
  // v(0,1): x=2, y in (0,2) => y=1 => 10
  assert.equal(costs.vN[0], 1);
  assert.equal(costs.vKeep[0], 10);
  assert.equal(costs.vRem[0], 245);
  // v(1,1): x=2, y in (2,4) => y=3 => 30
  assert.equal(costs.vKeep[1], 30);
  // h(1,0): y=2, x in (0,2) => x=1 => 50
  assert.equal(costs.hKeep[0], 50);
  // h(1,1): y=2, x in (2,5) => x=3,4 => 60+70=130
  assert.equal(costs.hKeep[1], 130);

  // 掩膜：剔除 v(1,1) 的 y=3 像素
  const mask = { width: W, height: H, maxval: 255, data: new Uint8Array(W * H).fill(255) };
  mask.data[3 * W + 2] = 0;
  const costs2 = Core.edgeCosts(scan, mask, grid);
  assert.equal(costs2.vN[1], 0);
  assert.equal(costs2.vKeep[1], 0);
  assert.equal(costs2.vRem[1], 0);
});

test('核心：P5 解析支持注释、任意空白与单字节分隔', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const buf = Buffer.concat([Buffer.from('P5\n# a comment\n2 2\n255\n', 'ascii'), payload]);
  const img = Core.parsePGM(new Uint8Array(buf));
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.deepEqual(Array.from(img.data), [1, 2, 3, 4]);

  // 非 P5 拒绝
  assert.throws(() => Core.parsePGM(new Uint8Array(Buffer.from('P2\n2 2\n255\n'))), /P5/);
  // 超过 512 拒绝
  const big = Buffer.concat([Buffer.from('P5\n513 1\n255\n', 'ascii'), Buffer.alloc(513)]);
  assert.throws(() => Core.parsePGM(new Uint8Array(big)), /512/);
  // 数据不足
  assert.throws(() => Core.parsePGM(new Uint8Array(Buffer.from('P5\n2 2\n255\n\x01\x02', 'latin1'))), /不足/);
});

test('核心：grid.json 校验坐标递增、至少差 2、行列上限、锁定范围', () => {
  assert.throws(() => Core.parseGrid({ xs: [0], ys: [0, 2] }), /至少需要 2/);
  assert.throws(() => Core.parseGrid({ xs: [0, 1, 3], ys: [0, 2] }), /至少相差 2/);
  assert.throws(() => Core.parseGrid({ xs: [0, 2], ys: Array.from({ length: 27 }, (_, i) => i * 2) }), /24 行/);
  assert.throws(() => Core.parseGrid({ xs: Array.from({ length: 11 }, (_, i) => i * 2), ys: [0, 2] }), /8 列/);
  assert.throws(() => Core.parseGrid({ xs: [0, 2], ys: [0, 2], locks: [{ axis: 'v', row: 0, col: 5, keep: true }] }), /越界/);
  assert.throws(() => Core.parseGrid({ xs: [0, 2], ys: [0, 2], locks: [{ axis: 'x', row: 0, col: 1, keep: true }] }), /字段非法/);
  const good = Core.parseGrid({ xs: [0, 2, 4], ys: [0, 2], locks: [{ axis: 'v', row: 0, col: 1, keep: true }] });
  assert.equal(good.R, 1);
  assert.equal(good.C, 2);
  assert.equal(good.locks.length, 1);
});

test('核心：grid 坐标必须落在图像内', () => {
  const scan = { width: 10, height: 10, maxval: 255, data: new Uint8Array(100) };
  const grid = Core.parseGrid({ xs: [0, 12], ys: [0, 4] });
  assert.throws(() => Core.validateGridImage(grid, scan), /超出图像宽度/);
});

test('核心：读取内置 zip 并端到端求解', async () => {
  const zipPath = path.join(__dirname, '..', 'samples', 'paper-grid-cases.zip');
  const bytes = new Uint8Array(fs.readFileSync(zipPath));
  const files = await Core.readZipAsync(bytes, (d) => new Uint8Array(zlib.inflateRawSync(Buffer.from(d))));
  assert.ok(files['scan.pgm'] && files['grid.json']);
  const found = Core.casesFromFiles(files, 'sample');
  assert.equal(found.cases.length, 1);
  const c = found.cases[0];
  assert.equal(c.grid.R, 2);
  assert.equal(c.grid.C, 3);
  assert.ok(c.mask);
  const solved = Core.solveCase(c.scan, c.mask, c.grid, Solver, { locks: c.grid.locks });
  assert.equal(solved.result.feasible, true);
  // 已知真值：上排两格合并、下排三格各自独立
  assert.deepEqual(solved.result.rects, [[0, 0, 1, 2], [0, 2, 1, 3], [1, 0, 2, 1], [1, 1, 2, 2], [1, 2, 2, 3]]);
  assert.equal(solved.result.count, 5);
  assert.equal(solved.result.loss, 5083);
});

test('核心：掩膜尺寸不一致时报错', () => {
  const scan = { width: 4, height: 4, maxval: 255, data: new Uint8Array(16) };
  const maskBytes = new Uint8Array(Buffer.concat([Buffer.from('P5\n5 4\n255\n', 'ascii'), Buffer.alloc(20)]));
  const gridText = new TextEncoder().encode('{"xs":[0,2],"ys":[0,2]}');
  const scanBytes = new Uint8Array(Buffer.concat([Buffer.from('P5\n4 4\n255\n', 'ascii'), Buffer.alloc(16)]));
  const raw = { scan: scanBytes, mask: maskBytes, grid: gridText };
  assert.throws(() => Core.buildCase(raw, 'x'), /尺寸/);
  void scan;
});

test('核心：导出 JSON 含矩形、逐边决定与总损失', async () => {
  const zipPath = path.join(__dirname, '..', 'samples', 'paper-grid-cases.zip');
  const bytes = new Uint8Array(fs.readFileSync(zipPath));
  const files = await Core.readZipAsync(bytes, (d) => new Uint8Array(zlib.inflateRawSync(Buffer.from(d))));
  const c = Core.casesFromFiles(files, 'sample').cases[0];
  const solved = Core.solveCase(c.scan, c.mask, c.grid, Solver, { locks: [] });
  const exp = Core.exportJSON({ name: c.name, scan: c.scan, mask: c.mask, grid: c.grid, solved, locks: [] });
  assert.equal(exp.feasible, true);
  assert.equal(exp.totalLoss, solved.result.loss);
  assert.equal(exp.rectangleCount, solved.result.count);
  assert.equal(exp.rectangles.length, solved.result.count);
  assert.equal(exp.edges.length, c.grid.R * (c.grid.C - 1) + (c.grid.R - 1) * c.grid.C);
  for (const e of exp.edges) {
    assert.ok(e.decision === 'keep' || e.decision === 'remove');
    assert.equal(typeof e.keepLoss, 'number');
    assert.equal(typeof e.removeLoss, 'number');
  }
  // JSON 可序列化
  assert.ok(JSON.stringify(exp).length > 100);
});

test('满额 24×8：求解在 5 秒内完成', () => {
  const R = 24, C = 8;
  const g = rng(424242);
  const costs = buildCosts(R, C, g, 255);
  const t0 = process.hrtime.bigint();
  const js = Solver.solve({
    R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem, locks: []
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(js.feasible, true);
  assert.ok(ms < 5000, `耗时 ${ms.toFixed(0)} ms 超过 5 秒`);
  // 覆盖检查：每个基础格恰属一个矩形
  const cover = new Int32Array(R * C).fill(-1);
  js.rects.forEach((r, i) => {
    for (let y = r[0]; y < r[2]; y++) for (let x = r[1]; x < r[3]; x++) {
      assert.equal(cover[y * C + x], -1, '格重叠');
      cover[y * C + x] = i;
    }
  });
  for (let i = 0; i < cover.length; i++) assert.notEqual(cover[i], -1, '存在未覆盖格');
});

test('满额 24×8：大量并列代价仍在 5 秒内', () => {
  const R = 24, C = 8;
  const n = R * (C - 1), m = (R - 1) * C;
  const vK = new Array(n).fill(0), vR = new Array(n).fill(0);
  const hK = new Array(m).fill(0), hR = new Array(m).fill(0);
  const t0 = process.hrtime.bigint();
  const js = Solver.solve({ R, C, vKeep: vK, vRem: vR, hKeep: hK, hRem: hR, locks: [] });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(js.feasible, true);
  // 全零代价下，最优是最少矩形数 1（整表合并）且列表字典序最小
  assert.equal(js.loss, 0);
  assert.equal(js.count, 1);
  assert.deepEqual(js.rects, [[0, 0, R, C]]);
  assert.ok(ms < 5000, `耗时 ${ms.toFixed(0)} ms 超过 5 秒`);
});

test('求解器：矩形结果与从决定反推的矩形一致（互相校验）', () => {
  for (const [R, C] of [[3, 3], [4, 5], [6, 4], [8, 8]]) {
    const g = rng(R * 13 + C * 29);
    const costs = buildCosts(R, C, g, 20);
    const js = Solver.solve({
      R, C, vKeep: costs.vKeep, vRem: costs.vRem, hKeep: costs.hKeep, hRem: costs.hRem, locks: []
    });
    const dec = Solver.decisionsFromRects(R, C, js.rects);
    const owner = dec.owner;
    // 每个矩形的每个内部单元属于同一 owner，且是满矩形
    js.rects.forEach((r) => {
      const o = owner[r[0] * C + r[1]];
      for (let y = r[0]; y < r[2]; y++) for (let x = r[1]; x < r[3]; x++) {
        assert.equal(owner[y * C + x], o);
      }
    });
    // 独立累加损失
    let sum = 0;
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
      sum += costs.keep[`v,${r},${c}`] && dec.v[r * (C - 1) + c - 1] ? costs.keep[`v,${r},${c}`] : costs.rem[`v,${r},${c}`];
    }
    // 逐个边正确累加（避免上面简写的歧义，重新计算）
    sum = 0;
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
      const kept = dec.v[r * (C - 1) + (c - 1)] === 1;
      sum += kept ? costs.keep[`v,${r},${c}`] : costs.rem[`v,${r},${c}`];
    }
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
      const kept = dec.h[(r - 1) * C + c] === 1;
      sum += kept ? costs.keep[`h,${r},${c}`] : costs.rem[`h,${r},${c}`];
    }
    assert.equal(sum, js.loss, `${R}x${C} 独立累加`);
  }
});
