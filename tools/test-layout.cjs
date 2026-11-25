/* 布局引擎验收点核对：node tools/test-layout.cjs */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../web/js/layout.js');
const Zip = require('../web/js/zip.js');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓', msg); }
function eq(a, b, msg) { assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); pass++; console.log('  ✓', msg, '=', a); }
function absOf(view, p) {
  const r = L.resolvePath(view, p);
  if (!r.ok) throw new Error(r.error);
  return r.abs;
}

(async () => {
const zipBuf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'shader-block-cases.zip'));
const entries = await Zip.unzip(zipBuf);
const layout = JSON.parse(Buffer.from(Zip.pickNamed(entries, 'layout.json').bytes).toString('utf8'));

/* ---------- 样例 ---------- */
console.log('\n[sample] legacy std140 column / reload std430 row');
const proj = L.compileRoot(layout);
eq(proj.views.length, 2, 'two views');
const legacy = proj.views[0], reload = proj.views[1];
eq(legacy.length, 96, 'legacy length 96');
eq(reload.length, 48, 'reload length 48');
eq(absOf(legacy, 'gain[0]'), 0, 'legacy gain[0] @0');
eq(absOf(legacy, 'gain[1]'), 16, 'legacy gain[1] @16');
eq(absOf(legacy, 'gain[2]'), 32, 'legacy gain[2] @32');
eq(absOf(legacy, 'basis.m[0][0]'), 48, 'legacy basis m00 @48');
eq(absOf(legacy, 'basis.m[1][0]'), 52, 'legacy basis m10 @52');
eq(absOf(legacy, 'basis.m[0][2]'), 80, 'legacy basis m02 @80');
eq(absOf(legacy, 'basis.m[1][2]'), 84, 'legacy basis m12 @84');
eq(absOf(reload, 'gain[0]'), 96, 'reload gain[0] abs96');
eq(absOf(reload, 'gain[1]'), 100, 'reload gain[1] abs100');
eq(absOf(reload, 'gain[2]'), 104, 'reload gain[2] abs104');
eq(absOf(reload, 'basis.m[0][0]'), 112, 'reload basis m00 abs112 (rel16)');
eq(absOf(reload, 'basis.m[0][1]'), 116, 'reload basis m01 abs116');
eq(absOf(reload, 'basis.m[1][0]'), 128, 'reload basis m10 abs128 (rel32)');
eq(absOf(reload, 'basis.m[1][2]'), 136, 'reload basis m12 abs136 (rel40)');

/* ---------- 验收点 2：256 字节嵌套 ---------- */
console.log('\n[ap2] head/pose/tail 256 region');
function ap2View(std, major) {
  return {
    name: std + '-' + major, offset: 0, length: 256, layout: std, major,
    endian: 'little',
    members: [
      {
        name: 'head', type: {
          struct: [
            { name: 'v3', type: { vec: 3, of: 'f32' } },
            { name: 'x', type: 'f32' },
            { name: 'qs', type: { array: 2, of: { struct: [{ name: 'f', type: 'u32' }] } } },
          ],
        },
      },
      {
        name: 'pose', align: 64, offset: 128,
        type: { array: 2, of: { mat: [2, 3] } },
      },
      { name: 'tail', type: 'u32' },
    ],
  };
}
const v140 = L.compileView(ap2View('std140', 'column'));
const v430 = L.compileView(ap2View('std430', 'row'));
eq(absOf(v140, 'head.qs[1].f'), 32, 'std140 head.qs[1].f @32');
eq(absOf(v430, 'head.qs[1].f'), 20, 'std430 head.qs[1].f @20');
eq(absOf(v140, 'pose[1].m[1][2]'), 212, 'std140 pose[1][1][2] @212');
eq(absOf(v430, 'pose[1].m[1][2]'), 184, 'std430 pose[1][1][2] @184');
// 简写 pose[1][1][2]
eq(absOf(v430, 'pose[1][1][2]'), 184, 'shorthand pose[1][1][2] @184');
eq(absOf(v140, 'tail'), 224, 'std140 tail @224');
eq(absOf(v430, 'tail'), 192, 'std430 tail @192');

// offset 21 反查
const q21_430 = L.locateRel(v430, 21);
eq(q21_430.padding, false, 'rel21 std430 is component');
eq(q21_430.path, 'head.qs[1].f', 'rel21 path head.qs[1].f');
eq(q21_430.byteIndex, 1, 'rel21 intra byte 1');
const q21_140 = L.locateRel(v140, 21);
eq(q21_140.padding, true, 'rel21 std140 is padding');

// 187 分量内偏移 3
const q187 = L.locateRel(v430, 187);
eq(q187.path, 'pose[1].m[1][2]', 'rel187 path pose comp');
eq(q187.byteIndex, 3, 'rel187 intra byte 3');
eq(q187.padding, false, 'rel187 component');

// pose offset 改 96 -> 对齐错误
const bad = ap2View('std140', 'column');
bad.members[1].offset = 96;
let threw = null;
try { L.compileView(bad); } catch (e) { threw = e; }
ok(threw && /pose/.test(threw.message) && /对齐/.test(threw.message), 'pose offset96 reports alignment error naming pose: ' + (threw && threw.message));

/* ---------- 验收点 3：动态数组 ---------- */
console.log('\n[ap3] dynamic elems');
function dynView(length) {
  return {
    name: 'dyn', offset: 0, length, layout: 'std430', major: 'row', endian: 'little',
    members: [
      { name: 'prefix', type: { vec: 2, of: 'i32' } },
      { name: 'elems', type: { array: null, of: { mat: [3, 2] } } },
    ],
  };
}
for (const [len, cnt] of [[8, 0], [32, 1], [56, 2]]) {
  const v = L.compileView(dynView(len));
  eq(v.dynamic.count, cnt, `length ${len} -> ${cnt} elems`);
}
threw = null;
try { L.compileView(dynView(55)); } catch (e) { threw = e; }
ok(threw && /elems/.test(threw.message) && /非法/.test(threw.message), 'length55 reports elems illegal: ' + (threw && threw.message));

// 源 std430 row elems[0].m[2][1] rel28
const ds = L.compileView(dynView(32));
eq(absOf(ds, 'elems[0].m[2][1]'), 28, 'dyn src elems[0][2][1] @28');
// 目标 std140 column 定长2
const dt = L.compileView({
  name: 'fixed140', offset: 0, length: 80, layout: 'std140', major: 'column', endian: 'little',
  members: [
    { name: 'prefix', type: { vec: 2, of: 'i32' } },
    { name: 'elems', type: { array: 2, of: { mat: [3, 2] } } },
  ],
});
eq(absOf(dt, 'elems[0].m[2][1]'), 40, 'std140 fixed elems[0][2][1] @40');

/* ---------- 非法声明 ---------- */
console.log('\n[invalid]');
// 显式 offset 重叠
threw = null;
try {
  L.compileView({
    name: 'x', offset: 0, length: 64, layout: 'std430', major: 'row', endian: 'little',
    members: [
      { name: 'a', type: 'u32', offset: 0 },
      { name: 'b', type: 'u32', offset: 2 }, // 不是4倍数 + 重叠
    ],
  });
} catch (e) { threw = e; }
ok(threw, 'explicit offset misalign/overlap rejected: ' + (threw && threw.message));

// 数组大小溢出（定长根 length 不匹配 / 溢出）
threw = null;
try {
  L.compileView({
    name: 'big', offset: 0, length: 16, layout: 'std140', major: 'row', endian: 'little',
    members: [{ name: 'arr', type: { array: 1000000, of: 'f32' } }],
  });
} catch (e) { threw = e; }
ok(threw && /arr/.test(threw.message), 'array overflow rejected naming arr: ' + (threw && threw.message));

// 嵌套成员带 align 非法
threw = null;
try {
  L.compileView({
    name: 'nx', offset: 0, length: 64, layout: 'std430', major: 'row', endian: 'little',
    members: [{ name: 's', type: { struct: [{ name: 'f', type: 'u32', align: 16 }] } }],
  });
} catch (e) { threw = e; }
ok(threw && /根 members/.test(threw.message), 'nested align rejected');

console.log(`\nALL LAYOUT TESTS PASSED: ${pass} assertions`);
})().catch((e) => { console.error(e); process.exit(1); });
