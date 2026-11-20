/* 交叉验证：小画布上对比引擎结果与暴力枚举的可解性/最优位置，验证候选剪枝不丢解 */
const LMP = require('../js/packer.js');

function bruteForce(parsed) {
  // 暴力：对每块所有合法整数位置做全枚举回溯，返回是否存在可行布局
  const size = parsed.atlasSize;
  const grid = new Int32Array(size * size).fill(-1);
  const variants = parsed.charts.map(c => LMP.buildVariants(c, parsed.padding));
  const order = parsed.charts.slice().sort((a, b) =>
    variants[b.index][0].claimCount - variants[a.index][0].claimCount || a.index - b.index);

  function fits(v, px, py, self) {
    for (const [cx, cy] of v.claim) {
      const x = cx + px, y = cy + py;
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      const o = grid[y * size + x];
      if (o >= 0 && o !== self) return false;
    }
    return true;
  }
  function dfs(d) {
    if (d === order.length) return true;
    const ch = order[d];
    for (const v of variants[ch.index]) {
      for (let py = -size; py < size; py++) {
        for (let px = -size; px < size; px++) {
          if (!fits(v, px, py, ch.index)) continue;
          for (const [cx, cy] of v.claim) {
            const x = cx + px, y = cy + py;
            grid[y * size + x] = ch.index;
          }
          if (dfs(d + 1)) return true;
          for (const [cx, cy] of v.claim) {
            const x = cx + px, y = cy + py;
            if (x >= 0 && y >= 0 && x < size && y < size && grid[y * size + x] === ch.index)
              grid[y * size + x] = -1;
          }
        }
      }
    }
    return false;
  }
  return dfs(0);
}

// 确定性伪随机（线性同余），保证本脚本自身可复现
let seed = 1234567;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function makeCase(atlas, n, w, h, density, padding) {
  const charts = [];
  for (let i = 0; i < n; i++) {
    const mask = [];
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) row += rnd() < density ? '#' : '.';
      if (!row.includes('#')) row = '#' + row.slice(1);
      mask.push(row);
    }
    const verts = [[0, 0], [w, 0], [w, h], [0, h]];
    charts.push({ id: 'c' + i, mask, vertices: verts, triangles: [[0, 1, 2], [0, 2, 3]] });
  }
  return LMP.parseInput({ atlasSize: atlas, padding, charts });
}

let agree = 0, engOk = 0, bruteOk = 0, checked = 0;
const configs = [
  [8, 3, 4, 4, 0.6, 0], [8, 4, 3, 3, 0.7, 1], [10, 5, 4, 4, 0.5, 1],
  [8, 3, 5, 5, 0.4, 2], [12, 4, 5, 5, 0.6, 0], [10, 6, 3, 3, 0.8, 1],
  [8, 2, 6, 6, 0.5, 2], [14, 5, 4, 4, 0.5, 2]
];
for (const [atlas, n, w, h, dens, pad] of configs) {
  for (let rep = 0; rep < 12; rep++) {
    const parsed = makeCase(atlas, n, w, h, dens, pad);
    const r = LMP.pack(parsed, { nodeBudget: 200000 });
    const brute = bruteForce(parsed);
    checked++;
    if (brute) bruteOk++;
    if (r.status === 'ok') engOk++;
    // 暴力可解时引擎必须找到解（剪枝完备性）；暴力无解时引擎不得报 ok
    if (brute === (r.status === 'ok')) agree++;
    else {
      console.error('不一致!', { atlas, n, w, h, dens, pad, rep,
        engine: r.status, reason: r.reason, brute });
      process.exit(1);
    }
    if (r.status === 'ok') {
      const map = Object.fromEntries(r.placements.map(p => [p.id, p]));
      const layout = LMP.computeLayout(parsed, map);
      if (layout.conflicts.length) { console.error('布局存在冲突!'); process.exit(1); }
    }
  }
}
console.log('交叉验证 ' + checked + ' 例全部一致（暴力可解 ' + bruteOk +
  '，引擎找到 ' + engOk + '），无冲突布局。');

// 含孔洞/断开的确定性与重排稳定性
const hole = LMP.parseInput({
  atlasSize: 12, padding: 1,
  charts: [
    { id: 'ring', mask: ['#####', '#...#', '#.#.#', '#...#', '#####'],
      vertices: [[0, 0], [5, 0], [5, 5], [0, 5]], triangles: [[0, 1, 2], [0, 2, 3]] },
    { id: 'split', mask: ['#.#', '.#.', '#.#'],
      vertices: [[0, 0], [3, 0], [3, 3], [0, 3]], triangles: [[0, 1, 2], [0, 2, 3]] },
    { id: 'l', mask: ['#..', '#..', '###'],
      vertices: [[0, 0], [3, 0], [3, 3], [0, 3]], triangles: [[0, 1, 2], [0, 2, 3]] }
  ]
});
const a = LMP.pack(hole), b = LMP.pack(hole);
if (JSON.stringify(a.placements) !== JSON.stringify(b.placements))
  throw new Error('同输入结果不确定');
if (a.status !== 'ok') throw new Error('孔洞样例应可解: ' + a.message);
console.log('孔洞/断开样例排布成功且确定：', JSON.stringify(a.placements));

// 10x10 同组样例：面积够但几何上放不下时，只能报 not-found，绝不能报 ok 或缩放
const tightRaw = [
  { id: 'ring', mask: ['#####', '#...#', '#.#.#', '#...#', '#####'] },
  { id: 'split', mask: ['#.#', '.#.', '#.#'] },
  { id: 'l', mask: ['#..', '#..', '###'] }
];
const tight = LMP.parseInput({
  atlasSize: 10, padding: 1,
  charts: tightRaw.map(c => ({
    id: c.id, mask: c.mask,
    vertices: [[0, 0], [5, 0], [5, 5], [0, 5]],
    triangles: [[0, 1, 2], [0, 2, 3]]
  }))
});
const rt = LMP.pack(tight);
if (rt.status === 'ok') throw new Error('紧约束样例不应找到布局');
if (!['not-found', 'impossible'].includes(rt.status))
  throw new Error('意外状态: ' + rt.status);
console.log('紧约束样例正确报告 ' + rt.status + '（' + rt.reason + '），未缩放任何图块');
