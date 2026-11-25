/* AP3/AP5 迁移匹配细节：node tools/test-matching.cjs */
const assert = require('assert');
const L = require('../web/js/layout.js');
const E = require('../web/js/engine.js');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${a}, want ${b})`); pass++; console.log('  ✓', m); };

function run(views, bytes, pairs) {
  const s = E.createStore();
  E.importProject(s, { views }, bytes);
  E.runBatch(s, pairs);
  return s;
}

/* AP3：std430 行动态 -> std140 列定长2；elems[0][2][1] 28 -> 40；第二项保留 */
console.log('\n[ap3] dynamic->fixed matrix array');
{
  const src = {
    name: 'src', offset: 0, length: 32, layout: 'std430', major: 'row', endian: 'little',
    members: [
      { name: 'prefix', type: { vec: 2, of: 'i32' } },
      { name: 'elems', type: { array: null, of: { mat: [3, 2] } } },
    ],
  };
  const dst = {
    name: 'dst', offset: 32, length: 80, layout: 'std140', major: 'column', endian: 'little',
    members: [
      { name: 'prefix', type: { vec: 2, of: 'i32' } },
      { name: 'elems', type: { array: 2, of: { mat: [3, 2] } } },
    ],
  };
  const dump = new Uint8Array(112).fill(0x77);
  const dv = new DataView(dump.buffer);
  // 在源 elems[0].m[2][1] abs28 放位型
  dv.setUint32(28, 0x12345678, true);
  // 目标第二项 abs 起点：dst off32 + elems rel16 + 1*32 = 80，放原始字节标记
  dump.set([0xde, 0xad, 0xbe, 0xef], 80);
  const s = run([src, dst], dump, [['src', 'dst']]);
  // dst elems[0].m[2][1] rel40，视图 off32 -> abs72
  eq(new DataView(s.dump.buffer).getUint32(72, true) >>> 0, 0x12345678, 'bits migrate rel28 -> rel40 (abs72)');
  // abs40 = dst rel8，是 prefix 与 elems 间填充，不应被写
  eq(s.dump[40], 0x77, 'abs40 padding sentinel intact');
  // 第二项原始字节保留
  eq([s.dump[80], s.dump[81], s.dump[82], s.dump[83]].map((b) => b.toString(16)).join(''), 'deadbeef', 'second item original bytes preserved');
}

/* AP5：不同声明顺序的同名 vec/mat 仍按名匹配；独有字段保留；跨端序 */
console.log('\n[ap5] reorder + unique fields + endian');
{
  const src = {
    name: 'src', offset: 0, length: 48, layout: 'std430', major: 'row', endian: 'little',
    members: [
      { name: 'onlySrc', type: 'u32' },
      { name: 'v', type: { vec: 4, of: 'u32' } },   // @16
      { name: 'm', type: { mat: [2, 2] } },          // @32 size16 ->48
    ],
  };
  const dst = {
    name: 'dst', offset: 64, length: 64, layout: 'std140', major: 'column', endian: 'big',
    members: [
      { name: 'm', type: { mat: [2, 2] } },           // @0 size32
      { name: 'onlyDst', type: 'u32' },               // @32
      { name: 'v', type: { vec: 4, of: 'u32' } },     // @48
    ],
  };
  const dump = new Uint8Array(128).fill(0xa5);
  const dv = new DataView(dump.buffer);
  // v components @16..28
  for (let i = 0; i < 4; i++) dv.setUint32(16 + 4 * i, 0xa00 + i, true);
  // m logical values row-major std430: m[r][c] @32 + r*8 + c*4
  let k = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    dv.setUint32(32 + r * 8 + c * 4, 0xb00 + k++, true);
  }
  dv.setUint32(0, 0x51515151, true); // onlySrc
  dv.setUint32(64 + 32, 0xd00d, false); // onlyDst abs96 BE
  const s = run([src, dst], dump, [['src', 'dst']]);
  const out = new DataView(s.dump.buffer);
  // dst v @ abs 64+48=112, big endian, same words
  for (let i = 0; i < 4; i++) eq(out.getUint32(112 + 4 * i, false) >>> 0, 0xa00 + i, `reordered vec comp ${i} migrated`);
  // dst mat column-major BE: logical [r][c] abs 64 + c*16 + r*4
  k = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    eq(out.getUint32(64 + c * 16 + r * 4, false) >>> 0, 0xb00 + k, `matrix m[${r}][${c}] logical matched`);
    k++;
  }
  // 独有字段保留原位型（onlySrc 不动；onlyDst 保留）
  eq(out.getUint32(0, true) >>> 0, 0x51515151, 'src-only field untouched');
  eq(out.getUint32(96, false) >>> 0, 0xd00d, 'dst-only field preserved');
}

/* 标量类型不一致（f32 vs u32）整批拒绝 */
console.log('\n[type mismatch]');
{
  const views = [
    { name: 'a', offset: 0, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'f32' }] },
    { name: 'b', offset: 4, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }] },
  ];
  const s = E.createStore();
  E.importProject(s, { views }, new Uint8Array(8));
  let e = null;
  try { E.runBatch(s, [['a', 'b']]); } catch (err) { e = err; }
  ok(e && /标量类型不一致/.test(e.message), 'f32 vs u32 rejected');
  eq(s.undoStack.length, 0, 'no history on rejection');
}

/* 数组无共同索引仍检查元素形状 */
console.log('\n[array zero common]');
{
  const views = [
    { name: 'a', offset: 0, length: 8, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: { array: null, of: 'u32' } }] },
    { name: 'b', offset: 8, length: 16, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: { array: 4, of: 'f32' } }] },
  ];
  const s = E.createStore();
  E.importProject(s, { views }, new Uint8Array(24));
  let e = null;
  try { E.runBatch(s, [['a', 'b']]); } catch (err) { e = err; }
  ok(e && /标量类型不一致/.test(e.message), 'zero common indices still shape-checks element type');
}

console.log(`\nALL MATCHING TESTS PASSED: ${pass}`);
