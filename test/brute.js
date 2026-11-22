'use strict';
// 独立参考实现：用空间网格做逐对判定，外扩量刻意放大。
// 与内核共享的只有「候选生成」和「冲突定义」，竞争流程另行实现，
// 因此能验证内核的外扩公式与索引是否正确。
const path = require('path');
const VegetationModule = require(path.join(__dirname, '..', 'src', 'core.js'));
const V = VegetationModule();

// 朴素桶索引：桶边长 = 层最大半径（格）。冲突只可能发生在 3×3 桶内。
function Grid(radTiles) {
  this.rad = Math.max(1, radTiles);
  this.map = new Map();
}
Grid.prototype.cell = function (x, y) {
  const c = this.rad;
  return Math.floor(x / c) + ',' + Math.floor(y / c);
};
Grid.prototype.add = function (c) {
  const k = this.cell(c.x, c.y);
  let a = this.map.get(k);
  if (!a) this.map.set(k, a = []);
  a.push(c);
};
Grid.prototype.hits = function (c) {
  const out = [];
  const bx = Math.floor(c.x / this.rad), by = Math.floor(c.y / this.rad);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const a = this.map.get((bx + dx) + ',' + (by + dy));
      if (a) for (let i = 0; i < a.length; i++) out.push(a[i]);
    }
  }
  return out;
};

function collect(cfg, layer, x0, y0, x1, y1) {
  const list = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = V.candidateAt(cfg, layer, x, y);
      if (c) list.push(c);
    }
  }
  return list;
}

// padScale: 外扩倍数（相对内核公式），用来确认更大外扩不改变结果
function bruteForce(cfg, win, padScale) {
  const W = win || cfg.window;
  const scale = padScale || 1;
  const Rt = V.maxRadiusUnits(cfg, V.LAYER_TREE);
  const Rg = V.maxRadiusUnits(cfg, V.LAYER_GRASS);
  const Rb = Math.max(Rt, Rg);
  const padT = Math.ceil((Rt + Rg + Rb) / 256 * scale) + 2;
  const padG = Math.ceil(Rg / 256 * scale) + 2;
  const rtT = Math.ceil(Rt / 256), rgT = Math.ceil(Rg / 256), rbT = Math.ceil(Rb / 256);

  const trees = collect(cfg, 0, W[0] - padT, W[1] - padT, W[0] + W[2] + padT, W[1] + W[3] + padT);
  trees.sort(V.compareRank);
  const tGrid = new Grid(rtT);
  const treeKept = [];
  const treeMark = new Map();
  for (const c of trees) {
    let conflict = false;
    const near = tGrid.hits(c);
    for (const o of near) if (V.conflicts(c, o)) { conflict = true; break; }
    treeMark.set(c.x + ',' + c.y, !conflict);
    if (!conflict) treeKept.push(c);
    tGrid.add(c); // 淘汰者也进网格
  }

  const grass = collect(cfg, 1, W[0] - padG, W[1] - padG, W[0] + W[2] + padG, W[1] + W[3] + padG);
  grass.sort(V.compareRank);
  // 树网格需要覆盖草区，重建
  const tGridOuter = new Grid(rbT);
  const keptTreesOnly = treeKept;
  for (const t of keptTreesOnly) tGridOuter.add(t);
  const gGrid = new Grid(rgT);
  const grassKept = [];
  for (const g of grass) {
    let blocked = false;
    for (const o of tGridOuter.hits(g)) if (V.conflicts(g, o)) { blocked = true; break; }
    if (blocked) continue;
    let conflict = false;
    for (const o of gGrid.hits(g)) if (V.conflicts(g, o)) { conflict = true; break; }
    if (!conflict) grassKept.push(g);
    gGrid.add(g); // 未被树挡住的草进网格，淘汰者也挡
  }

  const inWin = c => c.x >= W[0] && c.y >= W[1] && c.x < W[0] + W[2] && c.y < W[1] + W[3];
  const out = [];
  for (const c of treeKept) if (inWin(c)) out.push(c);
  for (const c of grassKept) if (inWin(c)) out.push(c);
  out.sort(V.compareSurvivor);
  return out;
}

module.exports = { bruteForce };
