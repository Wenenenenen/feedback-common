'use strict';
/* 核心逻辑单测：Node 自带 test runner。npm test */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.resolve(__dirname, '..', 'src', 'core.js'));

function makeDoc(periods, offsets, maxDepth, pixels, width, height) {
  return {
    width: width || 1, height: height || 1,
    periods, offsets, maxDepth, pixels,
  };
}
function solveOne(raw, params) {
  const v = C.validateDocument(raw);
  assert.ok(v.ok, 'document should validate: ' + JSON.stringify(v.errors));
  const detail = C.solvePixelDetail(v.doc, 0, params);
  return { detail, summary: C.layerSummary(detail) };
}

/* ---------------------------- 校验 ---------------------------- */

test('合法记录通过并规范化', () => {
  const v = C.validateDocument(makeDoc([5, 7], [0, 0], 34, [[[[1, 4]], [[2, null], [3, 255]]]]));
  assert.equal(v.ok, true);
  assert.deepEqual(v.doc.periods, [5, 7]);
  assert.deepEqual(v.doc.pixels[0][1], [[2, null], [3, 255]]);
});

test('尺寸、周期、互素、上限约束', () => {
  let v = C.validateDocument(makeDoc([4, 6], [0, 0], 10, [[[], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /互素/);

  v = C.validateDocument(makeDoc([2, 5], [0, 0], 4, [[[], []]]));
  assert.equal(v.ok, false);

  v = C.validateDocument(makeDoc([5, 7], [0, 0], 35, [[[], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /小于两周期乘积/);

  v = C.validateDocument({ width: 257, height: 1, periods: [3, 5], offsets: [0, 0], maxDepth: 2, pixels: [] });
  assert.equal(v.ok, false);

  v = C.validateDocument(makeDoc([5, 7], [0, 0], 34, [[[[1, 2]], [[1, 2]]], [[[], []]]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /pixels 数量/);
});

test('每路最多 4 槽、最多 2 个 null、槽互异、读数范围', () => {
  let v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /超过每路 4 槽/);

  v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[0, null], [1, null], [2, null]], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /最多 2 处/);

  v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[2, 5], [2, 6]], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /重复/);

  v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[7, 5]], []]]));
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /超出 0\.\.6/);

  v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[1, 256]], []]]));
  assert.equal(v.ok, false);

  v = C.validateDocument(makeDoc([7, 11], [0, 0], 20, [[[[1, -1]], []]]));
  assert.equal(v.ok, false);
});

test('非法记录定位到像素与槽', () => {
  const raw = makeDoc([5, 7], [0, 0], 34, [
    [[], []],
    [[[2, 3], [2, 4]], []],
  ], 2, 1);
  const v = C.validateDocument(raw);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].x, 1);
  assert.equal(v.errors[0].y, 0);
  assert.equal(v.errors[0].pixelIndex, 1);
  assert.equal(v.errors[0].slot, 2);
  assert.equal(v.errors[0].lane, 0);
});

test('错误上限截断但保留总数', () => {
  const lane = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]];
  const raw = makeDoc([7, 11], [0, 0], 20, [[lane, []]] , 1, 1);
  const v = C.validateDocument(raw, 2);
  assert.equal(v.ok, false);
  assert.ok(v.totalErrors >= 5);
  assert.ok(v.errors.length <= 2);
});

/* ---------------------------- 求解 ---------------------------- */

test('验收 A：偏移 −2 / 1 时单回波两路分开', () => {
  const { detail } = solveOne(makeDoc([5, 7], [-2, 1], 34, [[[[4, 9]], [[2, 4], [0, 5]]]]));
  assert.equal(detail.kind, 'unique');
  assert.equal(detail.minEchoes, 2);
  assert.deepEqual(detail.groups, [{ depths: [1, 6], amps: [[4, 4], [5, 5]] }]);
});

test('验收 B1：255 与两路共同深度，幅度和 260', () => {
  const { detail } = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 255]], [[1, 120], [6, 140]]]]));
  assert.equal(detail.kind, 'unique');
  assert.equal(detail.minEchoes, 2);
  assert.deepEqual(detail.groups, [{ depths: [1, 6], amps: [[120, 120], [140, 140]] }]);
});

test('验收 B2：null 不约束，单层幅度 255..1023', () => {
  const { detail, summary } = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 255]], [[1, null]]]]));
  assert.equal(detail.kind, 'unique');
  assert.equal(detail.minEchoes, 1);
  assert.deepEqual(detail.groups, [{ depths: [1], amps: [[255, 1023]] }]);
  assert.deepEqual(summary.layers, [{ dLo: 1, dHi: 1, aLo: 255, aHi: 1023 }]);
});

test('验收 C：周期 3/5 上限 14 恰有两组 [0,1] 与 [6,10]', () => {
  const { detail, summary } = solveOne(makeDoc([3, 5], [0, 0], 14, [[[[0, 1], [1, 1]], [[0, 1], [1, 1]]]]));
  assert.equal(detail.kind, 'multi');
  assert.equal(detail.minEchoes, 2);
  assert.equal(detail.groupCount, 2);
  assert.deepEqual(detail.groups.map(g => g.depths), [[0, 1], [6, 10]]);
  assert.deepEqual(summary.layers, [
    { dLo: 0, dHi: 6, aLo: 1, aHi: 1 },
    { dLo: 1, dHi: 10, aLo: 1, aHi: 1 },
  ]);
});

test('验收 C：上限降到 8 只剩唯一 [0,1]，恢复 14 回到两组', () => {
  const raw = makeDoc([3, 5], [0, 0], 14, [[[[0, 1], [1, 1]], [[0, 1], [1, 1]]]]);
  const v = C.validateDocument(raw);
  const d8 = C.solvePixelDetail(v.doc, 0, { offsets: [0, 0], maxDepth: 8 });
  assert.equal(d8.kind, 'unique');
  assert.deepEqual(d8.groups, [{ depths: [0, 1], amps: [[1, 1], [1, 1]] }]);
  const d14 = C.solvePixelDetail(v.doc, 0, { offsets: [0, 0], maxDepth: 14 });
  assert.equal(d14.groupCount, 2);
});

test('空列表为无回波；一侧正读数为无解', () => {
  let r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[], []]]));
  assert.equal(r.detail.kind, 'empty');
  r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 3]], []]]));
  assert.equal(r.detail.kind, 'none');
});

test('null 与 0 都不产生回波', () => {
  const r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 0], [2, null]], [[3, 0]]]]));
  assert.equal(r.detail.kind, 'empty');
});

test('同一路共槽的幅度和必须一次分给两个回波', () => {
  // 深度 1 与 6 在周期 5 上同槽 1，周期 7 上分别是 1 与 6
  const r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 7]], [[1, 3], [6, 4]]]]));
  assert.equal(r.detail.kind, 'unique');
  assert.equal(r.detail.minEchoes, 2);
  assert.deepEqual(r.detail.groups[0].depths, [1, 6]);
  // 路 1 精确和 7：两个幅度都须 ≥1；路 2 分别固定 3 与 4
  assert.deepEqual(r.detail.groups[0].amps, [[3, 3], [4, 4]]);
});

test('255 求和与精确下界共同约束幅度区间', () => {
  // 深度 1 与 6 在周期 5 上同槽 1（和 ≥255），在周期 7 上分别落槽 1 与 6（各 ≥255）
  const r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 255]], [[1, 255], [6, 255]]]]));
  assert.equal(r.detail.kind, 'unique');
  assert.equal(r.detail.minEchoes, 2);
  assert.deepEqual(r.detail.groups[0].depths, [1, 6]);
  assert.deepEqual(r.detail.groups[0].amps, [[255, 1023], [255, 1023]]);
});

test('解按深度升序排层：靠前者为较近回波', () => {
  // 周期 3 / 5，上限 14，两路各两个正槽 → 最少 2 个回波，两组 [3,7] 与 [12,13]
  const r = solveOne(makeDoc([3, 5], [0, 0], 14,
    [[[[0, 1], [1, 1]], [[2, 1], [3, 1]]]]));
  assert.equal(r.detail.minEchoes, 2);
  assert.equal(r.detail.groupCount, 2);
  assert.deepEqual(r.detail.groups.map(g => g.depths), [[3, 7], [12, 13]]);
  r.detail.groups.forEach(g => assert.ok(g.depths[0] < g.depths[1]));
});

test('全部候选超过上限时无解', () => {
  const r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[4, 5]], []]]), { offsets: [0, 0], maxDepth: 0 });
  assert.equal(r.detail.kind, 'none');
});

test('候选深度是按两路槽的 CRT 组合取出的', () => {
  const r = solveOne(makeDoc([5, 7], [0, 0], 34, [[[[1, 5]], [[6, 5]]]]));
  assert.equal(r.detail.minEchoes, 1);
  assert.deepEqual(r.detail.groups[0].depths, [6]);
});

/* ---------------------------- 全图与导出 ---------------------------- */

function buildTwoPixelDoc() {
  // 3×1：空、唯一单层（深度 0）、多组深度、无解
  return makeDoc([3, 5], [0, 0], 14, [
    [[], []],
    [[[0, 1], [1, 1]], [[0, 1], [1, 1]]],
    [[[2, 50]], [[3, 70]]],
  ], 3, 1);
}

test('全图求解：空 / 多组 / 唯一 状态与导出层', () => {
  const v = C.validateDocument(makeDoc([3, 5], [0, 0], 14, [
    [[], []],
    [[[0, 1], [1, 1]], [[0, 1], [1, 1]]],
    [[], []],
  ], 3, 1));
  assert.ok(v.ok);
  const res = C.solveAll(v.doc, {});
  assert.equal(res.status[0], C.STATUS.EMPTY);
  assert.equal(res.status[1], C.STATUS.MULTI);
  assert.equal(res.status[2], C.STATUS.EMPTY);
  assert.equal(res.layer0[1], 0, '多组深度不导出');
});

test('唯一单层与唯一双层写深度 + 1，缺层写 0', () => {
  const v = C.validateDocument(makeDoc([5, 7], [0, 0], 34, [
    [[[2, 9]], [[2, 9]]],                 // 单层：深度 2
    [[[1, 9]], [[1, 4], [6, 5]]],          // 双层：深度 1 与 6
  ], 2, 1));
  assert.ok(v.ok);
  const res = C.solveAll(v.doc, {});
  assert.equal(res.status[0], C.STATUS.UNIQUE1);
  assert.equal(res.layer0[0], 3);
  assert.equal(res.layer1[0], 0);
  assert.equal(res.status[1], C.STATUS.UNIQUE2);
  assert.equal(res.layer0[1], 2);
  assert.equal(res.layer1[1], 7);
});

test('多组深度像素两层都写 0', () => {
  const v = C.validateDocument(makeDoc([3, 5], [0, 0], 14, [
    [[[0, 1], [1, 1]], [[0, 1], [1, 1]]],
  ], 1, 1));
  const res = C.solveAll(v.doc, {});
  assert.equal(res.status[0], C.STATUS.MULTI);
  assert.equal(res.layer0[0], 0);
  assert.equal(res.layer1[0], 0);
});

test('16 位 P5 头部与字节序为大端', () => {
  const data = new Uint16Array([0, 1, 258, 65535, 300]);
  const pgm = C.encodePGM16(5, 1, data);
  const header = 'P5\n5 1\n65535\n';
  assert.equal(pgm.length, header.length + 10);
  const text = Buffer.from(pgm.slice(0, header.length)).toString('latin1');
  assert.equal(text, header);
  const bytes = Array.from(pgm.slice(header.length));
  assert.deepEqual(bytes, [0, 0, 0, 1, 1, 2, 255, 255, 1, 44]);
});

test('样例文件全部像素可解且无非法记录', () => {
  const fs = require('node:fs');
  const sample = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'samples', 'echo-depth.json'), 'utf8'));
  const v = C.validateDocument(sample);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const res = C.solveAll(v.doc, {});
  assert.equal(res.counts.none, 0, '样例不应出现无解像素');
  assert.equal(res.counts.empty, 10, '样例每第 13 个像素为空，120 像素共 10 个');
  assert.equal(res.counts.unique1 + res.counts.unique2 + res.counts.multi + res.counts.empty, 120);
  // 已知像素 (5,3) 两层深度 4 与 9
  const detail = C.solvePixelDetail(v.doc, 3 * 12 + 5, {});
  assert.equal(detail.kind, 'unique');
  assert.deepEqual(detail.groups[0].depths, [4, 9]);
});

test('满额 256×256 在 12 秒内完成', () => {
  const px = [];
  for (let i = 0; i < 256 * 256; i++) {
    const d = i % 1147;
    const a = 1 + (i % 1023);
    px.push([[[d % 31, Math.min(a, 255)]], [[d % 37, Math.min(a, 255)]]]);
  }
  const v = C.validateDocument(makeDoc([31, 37], [0, 0], 1146, px, 256, 256));
  assert.ok(v.ok);
  const t0 = Date.now();
  const res = C.solveAll(v.doc, {});
  const ms = Date.now() - t0;
  assert.ok(ms < 12000, 'took ' + ms + 'ms');
  assert.equal(res.width, 256);
});

test('导出层数组只含唯一组的深度 + 1', () => {
  const v = C.validateDocument(makeDoc([5, 7], [0, 0], 34, [
    [[[3, 9]], [[3, 9]]],
    [[[1, 9]], [[1, 4], [6, 5]]],
    [[[2, 3]], []],
    [[], []],
  ], 4, 1));
  const res = C.solveAll(v.doc, {});
  assert.deepEqual(Array.from(res.status), [C.STATUS.UNIQUE1, C.STATUS.UNIQUE2, C.STATUS.NONE, C.STATUS.EMPTY]);
  assert.deepEqual(Array.from(res.layer0), [4, 2, 0, 0]);
  assert.deepEqual(Array.from(res.layer1), [0, 7, 0, 0]);
});

test('改偏移后同槽折叠方式改变，解随之改变', () => {
  const raw = makeDoc([5, 7], [0, 0], 34, [[[[1, 9]], [[1, 4], [6, 5]]]]);
  const v = C.validateDocument(raw);
  const a = C.solvePixelDetail(v.doc, 0, { offsets: [0, 0], maxDepth: 34 });
  assert.deepEqual(a.groups[0].depths, [1, 6]);
  const b = C.solvePixelDetail(v.doc, 0, { offsets: [1, 0], maxDepth: 34 });
  // 偏移 +1 后，深度 d 的第一路槽变为 d+1；记录的槽 1 对应深度 0
  assert.ok(b.kind !== 'unique' || b.groups[0].depths[0] !== 1);
});
