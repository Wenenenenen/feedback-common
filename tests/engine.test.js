/* Node 测试：node tests/engine.test.js（从项目根目录运行） */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LMP = require('../js/packer.js');

const DATA = path.join(__dirname, '..', 'samples', 'extracted');
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}
function load(name) {
  return LMP.parseInput(JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')));
}

// 1. 旋转公式：格子 (x,y)->(h-1-y,x)；顶点 (x,y)->(h-y,x)
test('旋转公式与说明一致', () => {
  assert.deepStrictEqual(LMP.rotateCell(0, 0, 8), [7, 0]);
  assert.deepStrictEqual(LMP.rotateCell(7, 0, 8), [7, 7]);
  assert.deepStrictEqual(LMP.rotateCell(0, 7, 8), [0, 0]);
  assert.deepStrictEqual(LMP.rotatePoint(0, 0, 8), [8, 0]);
  assert.deepStrictEqual(LMP.rotatePoint(8, 8, 8), [0, 8]);
});

// 2. 补边是对占用格的切比雪夫膨胀，含孔洞且可自重叠
test('补边膨胀按占用格而非包围框，孔洞保留', () => {
  const parsed = load('small.json');
  const ring = parsed.charts[1]; // 方框带孔
  const v = LMP.buildVariant(ring, 0, 1);
  const has = (x, y) => v.claim.some(c => c[0] === x && c[1] === y);
  assert.ok(has(0, 0));            // 占用格本身
  assert.ok(has(1, 1));            // 孔边格被膨胀覆盖
  assert.ok(!has(3, 3), '孔洞中心不应被补边覆盖');
  assert.ok(!has(4, 4));
  // 旋转 90 后尺寸交换
  const v90 = LMP.buildVariant(ring, 90, 1);
  assert.strictEqual(v90.rw, 8);
  assert.strictEqual(v90.rh, 8);
  const parsed2 = LMP.parseInput({
    atlasSize: 16, padding: 1,
    charts: [{ id: 'a', mask: ['##..', '##..', '..##', '..##'],
      vertices: [[0, 0], [1, 0], [0, 1], [1, 1]], triangles: [[0, 1, 2]] }]
  });
  const vv = LMP.buildVariant(parsed2.charts[0], 90, 0);
  assert.strictEqual(vv.rw, 4);
  assert.strictEqual(vv.rh, 4);
  // 原占用 (0,0)->(3,0)；断开区域两块均保留
  assert.ok(vv.occ.some(c => c[0] === 3 && c[1] === 0));
  assert.ok(vv.occ.some(c => c[0] === 1 && c[1] === 3));
  assert.strictEqual(vv.occ.length, 8);
});

// 3. small 必须放下且无冲突；known-layout 合法；确定性
test('small 排布成功、无冲突、结果确定', () => {
  const parsed = load('small.json');
  const r1 = LMP.pack(parsed);
  const r2 = LMP.pack(parsed);
  assert.strictEqual(r1.status, 'ok', r1.message);
  assert.strictEqual(r1.placements.length, 4);
  assert.deepStrictEqual(r1.placements, r2.placements, '两次运行结果必须一致');
  const map = Object.fromEntries(r1.placements.map(p => [p.id, p]));
  const layout = LMP.computeLayout(parsed, map);
  assert.strictEqual(layout.conflicts.length, 0);
  // 锁定图块必须保持给定位置
  assert.deepStrictEqual(
    (({ x, y, rotation }) => ({ x, y, rotation }))(map['chart-0']),
    { x: 2, y: 2, rotation: 0 });
  // 所有补边格在画布内
  const inside = layout.placedCharts.every(pc =>
    pc.absClaim.every(c => c[0] >= 0 && c[1] >= 0 && c[0] < 32 && c[1] < 32));
  assert.ok(inside);

  // known-layout 作为外部布局必须校验通过
  const known = JSON.parse(fs.readFileSync(path.join(DATA, 'known-layout.json'), 'utf8'));
  const kMap = Object.fromEntries(known.placements.map(p => [p.id, p]));
  const v = LMP.validateLayout(parsed, kMap);
  assert.ok(v.valid, JSON.stringify(v.conflicts));
  assert.strictEqual(v.missing.length, 0);
});

// 4. 锁定冲突：逐格报告图块与格子
test('locked-conflict 报告图块和具体格子', () => {
  const parsed = load('locked-conflict.json');
  const r = LMP.pack(parsed);
  assert.strictEqual(r.status, 'locked-conflict');
  assert.strictEqual(r.lockedChart, 'locked-b');
  assert.ok(r.conflicts.length >= 1);
  const c = r.conflicts.find(x => x.kind === 'claim-overlap');
  assert.ok(c);
  assert.ok(c.cells.length > 0);
  assert.ok(Number.isInteger(c.cells[0][0]) && Number.isInteger(c.cells[0][1]));
  assert.ok(r.message.includes('locked-b'));
  // 直接用 computeLayout 也应发现双向冲突
  const layout = LMP.computeLayout(parsed, {
    'locked-a': { x: 2, y: 2, rotation: 0 },
    'locked-b': { x: 3, y: 2, rotation: 0 }
  });
  assert.ok(layout.conflicts.some(x => x.kind === 'claim-overlap'));
});

// 5. impossible：原占用面积下界可证明失败
test('impossible 以面积下界证明无解且不缩放', () => {
  const parsed = load('impossible.json');
  const r = LMP.pack(parsed);
  assert.strictEqual(r.status, 'impossible');
  assert.strictEqual(r.reason, 'area-lower-bound');
  assert.strictEqual(r.totalClaim, 320);
  assert.strictEqual(r.capacity, 256);
  assert.ok(r.message.includes('可证明无解'));
});

// 6. capacity：64 块全部放下
test('capacity 64 块全部放下且无冲突', () => {
  const parsed = load('capacity.json');
  const r = LMP.pack(parsed);
  assert.strictEqual(r.status, 'ok', r.message);
  assert.strictEqual(r.placements.length, 64);
  const map = Object.fromEntries(r.placements.map(p => [p.id, p]));
  const layout = LMP.computeLayout(parsed, map);
  assert.strictEqual(layout.conflicts.length, 0);
  // 统计自洽
  assert.strictEqual(
    layout.stats.occupiedCells + layout.stats.paddingCells + layout.stats.freeCells,
    128 * 128);
  // 确定性
  const r2 = LMP.pack(parsed);
  assert.deepStrictEqual(r.placements, r2.placements);
});

// 7. 同输入不同锁定 => 允许结果不同；同锁定 => 相同
test('锁定条件参与确定性，解锁后重排仍确定', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'small.json'), 'utf8'));
  const p1 = LMP.parseInput(raw);
  const rLocked = LMP.pack(p1);
  const raw2 = JSON.parse(JSON.stringify(raw));
  raw2.charts.forEach(c => { c.locked = false; delete c.placement; });
  const p2 = LMP.parseInput(raw2);
  const rFree = LMP.pack(p2);
  const rFree2 = LMP.pack(p2);
  assert.strictEqual(rFree.status, 'ok');
  assert.deepStrictEqual(rFree.placements, rFree2.placements);
  assert.ok(rLocked.placements[0].x === 2 && rLocked.placements[0].y === 2);
});

// 8. UV 变换手算核对（含旋转）
test('逐角 UV：平移与 90 度旋转数值正确，v 向下', () => {
  const parsed = LMP.parseInput({
    atlasSize: 10, padding: 0,
    charts: [{
      id: 'a', mask: ['##', '##'],
      vertices: [[0, 0], [2, 0], [2, 2], [0, 2]],
      triangles: [[0, 1, 2], [0, 2, 3]]
    }]
  });
  const pl0 = { x: 1, y: 3, rotation: 0 };
  const g0 = LMP.transformGeometry(parsed.charts[0], pl0, 10);
  assert.deepStrictEqual(g0.positions, [[1, 3], [3, 3], [3, 5], [1, 5]]);
  assert.deepStrictEqual(g0.uvs, [[0.1, 0.3], [0.3, 0.3], [0.3, 0.5], [0.1, 0.5]]);

  const pl90 = { x: 4, y: 5, rotation: 90 };
  const g90 = LMP.transformGeometry(parsed.charts[0], pl90, 10);
  // (0,0)->(2,0) 后平移 (4,5) = (6,5)；(2,2)->(0,2)+(4,5)=(4,7)
  assert.deepStrictEqual(g90.positions, [[6, 5], [6, 7], [4, 7], [4, 5]]);
  assert.deepStrictEqual(g90.uvs, [[0.6, 0.5], [0.6, 0.7], [0.4, 0.7], [0.4, 0.5]]);

  const corner = LMP.buildCornerUV(parsed, [{ id: 'a', ...pl90 }]);
  const tri = corner.charts[0].triangles[0];
  assert.strictEqual(tri.indices.length, 3);
  assert.deepStrictEqual(tri.corners[0].uv, [0.6, 0.5]);
});

// 9. 孔洞+断开区域的自定义小例：布局与归属统计
test('孔洞与断开区域可排布，统计正确', () => {
  const parsed = LMP.parseInput({
    atlasSize: 8, padding: 0,
    charts: [
      { id: 'hole', mask: ['####', '#..#', '#..#', '####'],
        vertices: [[0, 0], [4, 0], [4, 4], [0, 4]], triangles: [[0, 1, 2], [0, 2, 3]] },
      { id: 'split', mask: ['#.#', '...', '#.#'],
        vertices: [[0, 0], [1, 0], [0, 1]], triangles: [[0, 1, 2]] }
    ]
  });
  const r = LMP.pack(parsed);
  assert.strictEqual(r.status, 'ok', r.message);
  const map = Object.fromEntries(r.placements.map(p => [p.id, p]));
  const layout = LMP.computeLayout(parsed, map);
  assert.strictEqual(layout.conflicts.length, 0);
  assert.strictEqual(layout.stats.occupiedCells, 12 + 4);
  assert.strictEqual(layout.stats.paddingCells, 0);
});

// 10. padding 变化与越界报告
test('补边 4 格时越界被逐格报告', () => {
  const parsed = LMP.parseInput({
    atlasSize: 8, padding: 4,
    charts: [{
      id: 'big', mask: ['####', '####', '####', '####'],
      vertices: [[0, 0], [4, 0], [4, 4], [0, 4]], triangles: [[0, 1, 2]],
      locked: true, placement: { x: 0, y: 0, rotation: 0 }
    }]
  });
  const r = LMP.pack(parsed);
  assert.strictEqual(r.status, 'locked-conflict');
  assert.ok(r.conflicts.some(c => c.kind === 'out-of-bounds'));
});

// 11. 输入校验
test('非法输入被拒绝', () => {
  assert.throws(() => LMP.parseInput({ atlasSize: 999, padding: 0, charts: [] }));
  assert.throws(() => LMP.parseInput({ atlasSize: 8, padding: 5,
    charts: [{ id: 'a', mask: ['#'], vertices: [[0, 0]], triangles: [[0, 0, 0]] }] }));
  assert.throws(() => LMP.parseInput({ atlasSize: 8, padding: 0,
    charts: [{ id: 'a', mask: ['.'], vertices: [[0, 0]], triangles: [[0, 0, 0]] }] }));
  assert.throws(() => LMP.parseInput({ atlasSize: 8, padding: 0,
    charts: [{ id: 'a', mask: ['#'], vertices: [[0, 0]], triangles: [[0, 1, 0]] }] }));
});

// 12. 布局 JSON 往返：导出后重新校验仍合法
test('layout JSON 导出可往返校验', () => {
  const parsed = load('small.json');
  const r = LMP.pack(parsed);
  const exported = LMP.buildLayoutJSON(parsed, r.placements);
  assert.strictEqual(exported.atlasSize, 32);
  assert.strictEqual(exported.padding, 2);
  const map = Object.fromEntries(exported.placements.map(p => [p.id, p]));
  const v = LMP.validateLayout(parsed, map);
  assert.ok(v.valid);
  assert.ok(exported.stats.utilization > 0 && exported.stats.utilization <= 1);
});

console.log('\n' + passed + ' 个测试全部通过');
