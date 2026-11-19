#!/usr/bin/env node
/*
 * 合成回归：不依赖样例文件，在内存里造出已知答案的 3:2 下拉序列，
 * 检查核心的判源、场序、孤场、节奏与像素还原。
 *
 * 覆盖：
 *   - 上场优先 / 下场优先
 *   - 2/3 与 3/2 两种节奏相位
 *   - 剪辑点后换场序（新素材从剪辑点起用另一种场序）
 *   - 剪辑点后场序不变
 *   - 单场格（孤场）
 *   - 纯隔行段（两场互不同源）
 *
 * 用法：node tools/test-synthetic.js
 */
'use strict';

const PCR = require('../js/core.js');

const W = 96, H = 72;

/* ---- 确定性伪随机 ---- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 带二维纹理的缓慢运动画面：行间相关强，相邻格差异也足够大 */
function makeCells(n, seed) {
  const r = rng(seed);
  const cx = 20 + r() * (W - 40), cy = 20 + r() * (H - 40);
  const vx = 4.5 + r() * 3, vy = 2.5 + r() * 2;
  const rad = 9 + r() * 5, bg = 70 + r() * 40;
  const cells = [];
  for (let i = 0; i < n; i++) {
    const arr = new Uint8Array(W * H);
    const px = cx + vx * i, py = cy + vy * i;
    const barx = ((Math.floor(cx * 1.7 + vx * i * 1.3) % W) + W) % W;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = bg + Math.sin(y * 0.55) * 9 + Math.sin(x * 0.31 + y * 0.17) * 5 + Math.cos(x * 0.7 - y * 0.4) * 3;
        const d = Math.hypot(x - px, y - py);
        if (d < rad) v = bg + 50 + Math.sin(d * 1.4) * 7;
        if (x >= barx - 2 && x < barx + 2) v = Math.min(255, bg + 110);
        arr[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    cells.push(arr);
  }
  return cells;
}

/* 场序列：空间奇偶全局交替；size=3 的格输出 [p, p^1, p]；shortCell 只留一场 */
function fieldsFor(nCells, pattern, startParity, opts) {
  opts = opts || {};
  const phase = opts.phase || 0, shortCell = opts.shortCell;
  const fields = [];
  let p = startParity;
  for (let ci = 0; ci < nCells; ci++) {
    const size = pattern[(ci + phase) % 2];
    let seq = [p];
    for (let j = 1; j < size; j++) seq.push((p + j) % 2);
    if (shortCell === ci) seq = seq.slice(0, 1);
    seq.forEach(par => fields.push([ci, par]));
    p = (p + seq.length) % 2;
  }
  return fields;
}

/* 把多段素材拼成视频帧；返回帧数组与每帧偶行/奇行来源格编号 */
function assemble(segments) {
  const all = [];
  segments.forEach(seg => {
    seg.fields.forEach(([ci, par]) => all.push({ cells: seg.cells, base: seg.base, cid: seg.base + ci, par }));
  });
  if (all.length % 2) all.pop();
  const frames = [], truth = [];
  for (let i = 0; i < all.length / 2; i++) {
    const a = all[2 * i], b = all[2 * i + 1];
    const img = new Uint8Array(W * H);
    /* 真实 telecine：场在画面里的行位置固定（偶行 / 奇行），
       场序只影响时间先后。所以按场的空间奇偶落位，不按显示顺序。 */
    [a, b].forEach(ent => {
      const src = ent.cells[ent.cid - ent.base];
      for (let k = 0; k < H / 2; k++) {
        const srow = (k * 2 + ent.par) * W;
        const drow = (k * 2 + ent.par) * W;
        img.set(src.subarray(srow, srow + W), drow);
      }
    });
    frames.push(img);
    const ev = a.par === 0 ? a.cid : b.cid;
    const od = a.par === 1 ? a.cid : b.cid;
    truth.push([ev, od]);
  }
  return { frames, truth };
}

function buildCase(specs) {
  const segments = specs.map(s => ({
    cells: s.cells, base: s.base,
    fields: fieldsFor(s.cells.length, s.pattern, s.start, { phase: s.phase, shortCell: s.short })
  }));
  const { frames, truth } = assemble(segments);
  const cellMap = {};
  specs.forEach(s => s.cells.forEach((c, k) => { cellMap[s.base + k] = c; }));
  return { frames, truth, cellMap };
}

/* ------------------------------------------------------------------ */
/* 检查                                                                */
/* ------------------------------------------------------------------ */

let failures = 0;
function fail(msg) { failures++; console.log('  ✗ ' + msg); }

function runCase(name, spec, expect) {
  const c = buildCase(spec);
  const t0 = Date.now();
  const r = PCR.analyze({ frames: c.frames, width: W, height: H });
  const ms = Date.now() - t0;

  let exact = 0, orphan = 0, inter = 0, badPixel = 0, badOrphan = 0, checked = 0;
  const declaredCells = new Set();

  r.outputs.forEach(o => {
    if (o.type === 'interlaced') { inter++; return; }
    if (o.interpolated) {
      orphan++;
      const ref = c.cellMap[o.topFrame !== null ? c.truth[o.topFrame][0] : c.truth[o.bottomFrame][1]];
      if (!ref) return;
      const ren = PCR.renderOutput({ frames: c.frames, width: W, height: H }, r, o);
      const par = o.topFrame !== null ? 0 : 1;
      for (let y = par; y < H; y += 2) {
        for (let x = 0; x < W; x++) {
          if (ren.pixels[y * W + x] !== ref[y * W + x]) { badOrphan++; return; }
        }
      }
      return;
    }
    exact++;
    const cands = new Set();
    if (o.topFrame !== null) cands.add(c.truth[o.topFrame][0]);
    if (o.bottomFrame !== null) cands.add(c.truth[o.bottomFrame][1]);
    const ren = PCR.renderOutput({ frames: c.frames, width: W, height: H }, r, o);
    let matched = false;
    cands.forEach(cid => {
      if (matched) return;
      const ref = c.cellMap[cid];
      if (!ref) return;
      let same = true;
      for (let k = 0; k < ref.length; k++) { if (ren.pixels[k] !== ref[k]) { same = false; break; } }
      if (same) { matched = true; declaredCells.add(cid); }
    });
    checked++;
    if (!matched) badPixel++;
  });

  const okCounts = exact === expect.exact && orphan === expect.orphan && inter === expect.inter;
  const okPixel = badPixel === 0 && badOrphan === 0;
  const okOrderRuns = expect.orderRuns ? JSON.stringify(r.orderRuns) === JSON.stringify(expect.orderRuns) : true;

  if (!okCounts) fail(`${name}: 计数不符——期望 exact=${expect.exact} orphan=${expect.orphan} inter=${expect.inter}，实际 ${exact}/${orphan}/${inter}`);
  if (!okPixel) fail(`${name}: 像素不符——exact 错 ${badPixel}/${checked}，孤场错 ${badOrphan}`);
  if (!okOrderRuns) fail(`${name}: 场序分段不符——实际 ${JSON.stringify(r.orderRuns)}`);
  if (expect.orphanSources) {
    const got = r.orphans.map(o => o.sourceFrame).sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(expect.orphanSources)) {
      fail(`${name}: 孤场帧不符——期望 ${JSON.stringify(expect.orphanSources)}，实际 ${JSON.stringify(got)}`);
    }
  }
  if (expect.reLockFrames) {
    const got = [...new Set(r.reLock.map(x => x.frame))].sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(expect.reLockFrames)) {
      fail(`${name}: 重锁点不符——期望 ${JSON.stringify(expect.reLockFrames)}，实际 ${JSON.stringify(got)}`);
    }
  }
  if (expect.cells !== undefined && declaredCells.size !== expect.cells) {
    fail(`${name}: 还原格数不符——期望 ${expect.cells}，实际 ${declaredCells.size}`);
  }

  const status = (okCounts && okPixel && okOrderRuns) ? '✓' : '✗';
  console.log(`${status} ${name}：${c.frames.length} 帧 → ${r.outputs.length} 画面（精确 ${exact} / 孤场 ${orphan} / 隔行 ${inter}），${ms} ms`);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const cA = makeCells(34, 11), cB = makeCells(34, 12), cC = makeCells(30, 13), cE = makeCells(20, 23);

console.log('合成回归：\n');

runCase('上场优先 2/3', [
  { cells: cA, base: 1000, pattern: [2, 3], start: 0 }
], { exact: 34, orphan: 0, inter: 0, cells: 34, orderRuns: [{ start: 0, end: 41, order: 'tff' }] });

runCase('下场优先 2/3', [
  { cells: cA, base: 1000, pattern: [2, 3], start: 1 }
], { exact: 34, orphan: 0, inter: 0, cells: 34, orderRuns: [{ start: 0, end: 41, order: 'bff' }] });

runCase('上场优先 3/2 相位相反', [
  { cells: cA, base: 1000, pattern: [3, 2], start: 0 }
], { exact: 33, orphan: 1, inter: 0, cells: 33 });

runCase('剪辑点 + 换场序', [
  { cells: cA.slice(0, 16), base: 1000, pattern: [2, 3], start: 0 },
  { cells: cB, base: 2000, pattern: [2, 3], start: 1 }
], { exact: 50, orphan: 0, inter: 0, cells: 50, reLockFrames: [20] });

runCase('剪辑点、场序不变', [
  { cells: cA.slice(0, 16), base: 1000, pattern: [2, 3], start: 0 },
  { cells: cC, base: 3000, pattern: [2, 3], start: 0 }
], { exact: 46, orphan: 0, inter: 0, cells: 46 });

runCase('孤场（第 8 格只有一场）', [
  { cells: cE, base: 1000, pattern: [2, 3], start: 0, short: 8 }
], { exact: 19, orphan: 1, inter: 0, cells: 19 });

/* 纯隔行：两场各自来自不同时刻的相邻格，彼此无同源关系 */
(function interlacedCase() {
  const cells = makeCells(40, 31);
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const img = new Uint8Array(W * H);
    const c1 = cells[10 + i], c2 = cells[16 + i];
    for (let k = 0; k < H / 2; k++) {
      img.set(c1.subarray((2 * k) * W, (2 * k) * W + W), (2 * k) * W);
      img.set(c2.subarray((2 * k) * W, (2 * k) * W + W), (2 * k + 1) * W);
    }
    frames.push(img);
  }
  const r = PCR.analyze({ frames, width: W, height: H });
  const allInter = r.frameStates.every(s => s === 'interlaced');
  console.log(`${allInter ? '✓' : '✗'} 纯隔行段：${frames.length} 帧，输出 ${r.outputs.length} 个隔行画面`);
  if (!allInter) failures++;
})();

console.log('\n' + (failures === 0 ? '✓ 全部通过' : `✗ ${failures} 处失败`));
process.exit(failures === 0 ? 0 : 1);
