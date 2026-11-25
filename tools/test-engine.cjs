/* 迁移/历史引擎核对：node tools/test-engine.cjs */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../web/js/layout.js');
const E = require('../web/js/engine.js');
const Zip = require('../web/js/zip.js');

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; console.log('  ✓', m); }
function eq(a, b, m) { assert.strictEqual(a, b, `${m} (got ${a}, want ${b})`); pass++; console.log('  ✓', m); }
function throws(fn, re, m) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  ok(e && (!re || re.test(e.message)), m + (e ? ` :: ${e.message}` : ' :: 未抛错'));
  return e;
}

function storeWith(viewsJson, bytes) {
  const s = E.createStore();
  E.importProject(s, { views: viewsJson }, bytes);
  return s;
}

/* ---------- AP1 样例迁移 ---------- */
(async () => {
console.log('\n[ap1] sample legacy -> reload');
{
  const _zip = fs.readFileSync(path.join(__dirname, '..', 'samples', 'shader-block-cases.zip'));
  const _entries = await Zip.unzip(_zip);
  const layout = JSON.parse(Buffer.from(Zip.pickNamed(_entries, 'layout.json').bytes).toString('utf8'));
  const bin = Buffer.from(Zip.pickNamed(_entries, 'dump.bin').bytes);
  const s = storeWith(layout.views, new Uint8Array(bin));
  const before = Buffer.from(s.dump);
  const r = E.runBatch(s, [['legacy', 'reload']]);
  eq(r.writes, 9, '9 matched scalars (3 gain + 6 basis)');
  // gains compacted
  eq(readLE(s, 96), 1.0, 'reload gain[0]=1.0');
  eq(readLE(s, 100), 0.5, 'reload gain[1]=0.5');
  eq(readLE(s, 104), 2.0, 'reload gain[2]=2.0');
  // row-major logical matrix matches source logical values
  const reload = s.views[1];
  for (let r0 = 0; r0 < 2; r0++) for (let c = 0; c < 3; c++) {
    const path = `basis.m[${r0}][${c}]`;
    const rr = L.resolvePath(reload, path);
    const src = s.views[0];
    const rs = L.resolvePath(src, path);
    const dv = new DataView(s.dump.buffer);
    eq(dv.getFloat32(rr.abs, true), dv.getFloat32(rs.abs, true), `logical ${path} equal`);
  }
  // undo restores byte-exact
  E.undo(s);
  ok(Buffer.from(s.dump).equals(before), 'undo restores exact bytes');
  E.redo(s);
  ok(!Buffer.from(s.dump).equals(before), 'redo changes again');
}

function readLE(s, off) { return new DataView(s.dump.buffer).getFloat32(off, true); }

/* ---------- AP6 双向端序交换 ---------- */
console.log('\n[ap6] bidirectional endian swap');
{
  // 视图 A @0 little scalar a；视图 B @4 big scalar b
  const views = [
    { name: 'A', offset: 0, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'f32' }] },
    { name: 'B', offset: 4, length: 4, layout: 'std430', major: 'row', endian: 'big', members: [{ name: 'x', type: 'f32' }] },
  ];
  const dump = new Uint8Array(16).fill(0xCC);
  dump.set([0x45, 0x23, 0xc1, 0x7f], 0);
  dump.set([0x80, 0x00, 0x00, 0x00], 4);
  const sentinel = dump[8];
  const s = storeWith(views, dump);
  E.runBatch(s, [['A', 'B'], ['B', 'A']]);
  eq(hex(s.dump, 0, 4), '00000080', 'off0 -> 00 00 00 80 (LE of 0x80000000)');
  eq(hex(s.dump, 4, 4), '7fc12345', 'off4 -> 7f c1 23 45 (BE of 0x7fc12345)');
  eq(s.dump[8], sentinel, 'sentinel outside preserved');
  eq(s.dump[15], 0xCC, 'last sentinel preserved');
}

/* ---------- AP6 重叠接受/拒绝 ---------- */
console.log('\n[ap6] target overlap byte rules');
{
  // 源视图 S1 @16 LE bytes 01 02 03 04 ; S2 @20 LE bytes aa bb 04 03
  // 目标 T1 @8 LE u32, T2 @10 BIG u32 （用两个视图制造不同端序）
  const views = [
    { name: 'S1', offset: 16, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }] },
    { name: 'S2', offset: 20, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }] },
    { name: 'T1', offset: 8, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }] },
    { name: 'T2', offset: 10, length: 4, layout: 'std430', major: 'row', endian: 'big', members: [{ name: 'x', type: 'u32' }] },
  ];
  const dump = new Uint8Array(32).fill(0x5A);
  dump.set([0x01, 0x02, 0x03, 0x04], 16);
  dump.set([0xaa, 0xbb, 0x04, 0x03], 20);
  const s = storeWith(views, dump);
  E.runBatch(s, [['S1', 'T1'], ['S2', 'T2']]);
  eq(hex(s.dump, 8, 6), '01020304bbaa', 'overlap identical bytes accepted: 01 02 03 04 bb aa');
  eq(s.dump[14], 0x5A, 'byte14 sentinel preserved');

  // 第二源末字节改 99 -> 冲突 @10，整批不变
  const dump2 = new Uint8Array(32).fill(0x5A);
  dump2.set([0x01, 0x02, 0x03, 0x04], 16);
  dump2.set([0xaa, 0xbb, 0x04, 0x99], 20);
  const s2 = storeWith(views, dump2);
  const snap = Buffer.from(s2.dump);
  const h0 = s2.undoStack.length;
  const e = throws(() => E.runBatch(s2, [['S1', 'T1'], ['S2', 'T2']]), /偏移 10/, 'conflict reports absolute offset 10');
  eq(e && e.conflict && e.conflict.offset, 10, 'conflict.offset=10');
  ok(Buffer.from(s2.dump).equals(snap), 'failed batch leaves dump unchanged');
  eq(s2.undoStack.length, h0, 'failed batch leaves history unchanged');
}

/* ---------- AP5 形状不符整批拒绝且不落盘 ---------- */
console.log('\n[ap5] shape mismatch atomic');
{
  const mk = (tail) => ([
    {
      name: 'src', offset: 0, length: 64, layout: 'std430', major: 'row', endian: 'little',
      members: [
        { name: 'v', type: { vec: 4, of: 'f32' } },
        { name: 'm', type: { mat: [2, 3] } },
        { name: 'onlySrc', type: 'u32' },
        tail.src,
      ].filter(Boolean),
    },
    {
      name: 'dst', offset: 128, length: 64, layout: 'std140', major: 'column', endian: 'big',
      members: [
        tail.dst,
        { name: 'm', type: { mat: [3, 2] } }, // 形状不同
        { name: 'v', type: { vec: 4, of: 'f32' } },
        { name: 'onlyDst', type: 'u32' },
      ].filter(Boolean),
    },
  ]);
  const views = mk({});
  const dump = new Uint8Array(256).fill(0xA5);
  // 放一些源数据
  new DataView(dump.buffer).setUint32(0, 0x7fc12345, true);
  const s = storeWith(views, dump);
  const snap = Buffer.from(s.dump);
  throws(() => E.runBatch(s, [['src', 'dst']]), /矩阵逻辑行列不一致/, '2x3 vs 3x2 rejected even same component count');
  ok(Buffer.from(s.dump).equals(snap), 'nothing lands on shape rejection');
}

/* ---------- AP5 跨端序位型保留 ---------- */
console.log('\n[ap5] bit pattern preserved cross endian');
{
  const views = [
    { name: 'LE', offset: 0, length: 8, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'f32' }, { name: 'y', type: 'u32' }] },
    { name: 'BE', offset: 8, length: 8, layout: 'std430', major: 'row', endian: 'big', members: [{ name: 'x', type: 'f32' }, { name: 'y', type: 'u32' }] },
  ];
  const dump = new Uint8Array(16);
  new DataView(dump.buffer).setUint32(0, 0x7fc12345, true);
  new DataView(dump.buffer).setUint32(4, 0x80000000, true);
  const s = storeWith(views, dump);
  E.runBatch(s, [['LE', 'BE']]);
  eq(new DataView(s.dump.buffer).getUint32(8, false) >>> 0, 0x7fc12345, 'BE target holds same word 7fc12345');
  eq(hex(s.dump, 8, 4), '7fc12345', 'BE bytes are 7f c1 23 45');
  eq(new DataView(s.dump.buffer).getUint32(12, false) >>> 0, 0x80000000, 'second word preserved');
}

/* ---------- AP7 失败批次保留重做链；新编辑清空 ---------- */
console.log('\n[ap7] redo chain semantics');
{
  const views = [
    { name: 'A', offset: 0, length: 8, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }, { name: 'y', type: 'u32' }] },
  ];
  const dump = new Uint8Array(8);
  const s = storeWith(views, dump);
  E.commitEdit(s, 0, 0x11111111, true);
  E.commitEdit(s, 4, 0x22222222, true);
  eq(s.undoStack.length, 2, 'two edits in history');
  E.undo(s);
  eq(s.redoStack.length, 1, 'one redo item');
  // 冲突批次（自重叠视图写不同值：构造两对不同源同目标不好搞，直接用非法对）
  throws(() => E.runBatch(s, [['A', 'missing']]), /不存在/, 'bad pair rejected');
  eq(s.redoStack.length, 1, 'redo preserved after failed batch');
  // 成功新编辑清空重做
  E.commitEdit(s, 0, 0x33333333, true);
  eq(s.redoStack.length, 0, 'redo chain cleared after new successful edit');
  eq(s.undoStack.length, 2, 'history has two items after undo+new edit');
}

/* ---------- 65 对 / 超限 ---------- */
console.log('\n[limits]');
{
  const views = [];
  for (let i = 0; i < 2; i++) views.push({ name: 'v' + i, offset: i * 8, length: 8, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }, { name: 'y', type: 'u32' }] });
  const s = storeWith(views, new Uint8Array(16));
  const pairs65 = Array.from({ length: 65 }, () => ['v0', 'v1']);
  throws(() => E.runBatch(s, pairs65), /最多 64 对/, '65 pairs rejected');
}

function hex(u8, off, len) {
  return Array.from(u8.subarray(off, off + len)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

console.log(`\nALL ENGINE TESTS PASSED: ${pass} assertions`);
})().catch((e) => { console.error(e); process.exit(1); });
