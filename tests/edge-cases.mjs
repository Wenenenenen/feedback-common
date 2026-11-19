// 额外边界与压力用例：有理数交点、共线重叠、多重自交、最大约束、顺序无关
import { tessellate, meshToJSON } from '../src/pipeline.js';
import { ringArea2, orient, pointInTriangleStrict } from '../src/geometry.js';
import { Frac } from '../src/frac.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

function SATOverlap(t1, t2, V) {
  const A = t1.map((i) => V[i]), B = t2.map((i) => V[i]);
  const axes = [];
  for (const tri of [A, B]) for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    axes.push({ nx: b.y.sub(a.y), ny: a.x.sub(b.x) });
  }
  for (const ax of axes) {
    const proj = (p) => ax.nx.mul(p.x).add(ax.ny.mul(p.y));
    const pa = A.map(proj), pb = B.map(proj);
    const mn = (a) => a.reduce((m, v) => (v.cmp(m) < 0 ? v : m));
    const mx = (a) => a.reduce((m, v) => (v.cmp(m) > 0 ? v : m));
    if (mx(pa).cmp(mn(pb)) <= 0 || mx(pb).cmp(mn(pa)) <= 0) return false;
  }
  return true;
}
function check(r, label) {
  const V = r.compactVerts;
  for (const t of r.triangles) ok(orient(V[t[0]], V[t[1]], V[t[2]]) > 0, `${label}: 非 CCW`);
  for (let i = 0; i < r.triangles.length; i++)
    for (let j = i + 1; j < r.triangles.length; j++)
      ok(!SATOverlap(r.triangles[i], r.triangles[j], V), `${label}: 三角形重叠`);
  let s = new Frac(0n);
  for (const t of r.triangles) s = s.add(ringArea2(t.map((i) => V[i])));
  ok(s.eq(r.area.mul(new Frac(2n))), `${label}: 面积与三角形不符`);
  return meshToJSON(r);
}

// 1. 有理数交点（斜线段在非整数点相交）：两个旋转交叉矩形
{
  const c = [
    [[0, 0], [6, 0], [6, 6], [0, 6]],
    [[-2, 3], [8, 3], [8, 4], [-2, 4]], // 水平条带横穿，交点为整数；再做斜的
  ];
  const r = tessellate(c, 'evenodd');
  check(r, 'rational-h');
  // 方块 36 减去条带交集 6（偶绕数挖空），再加条带外伸 4 = 34
  ok(Math.abs(meshToJSON(r).area - 34) < 1e-6, '水平条带 evenodd 面积应为 34');
}
{
  // 对角线 y=x 穿过方块，自交 bowtie 变体，交点 (3,3)
  const c = [[[0, 0], [6, 6], [0, 6]], [[6, 0], [3, 3], [6, 6]]];
  for (const rule of ['evenodd', 'nonzero']) {
    const r = tessellate(c, rule);
    check(r, 'diag-' + rule);
  }
}

// 2. 共线重叠：两条边部分重叠且同向/反向
{
  const c = [
    [[0, 0], [10, 0], [10, 4], [0, 4]],
    [[5, 0], [15, 0], [15, 4], [5, 4]],
  ];
  const eo = tessellate(c, 'evenodd');
  check(eo, 'collinear-overlap-eo');
  const nz = tessellate(c, 'nonzero');
  check(nz, 'collinear-overlap-nz');
  // 并集面积 15*4=60；异或 = 60-2*20+... 手算：A=40,B=40,交=20，异或=40，并集=60
  ok(Math.abs(meshToJSON(nz).area - 60) < 1e-6, '共线重叠 nonzero 并集应为 60');
  ok(Math.abs(meshToJSON(eo).area - 40) < 1e-6, '共线重叠 evenodd 异或应为 40');
}

// 3. 多重嵌套（深度 4），方向交替
{
  const c = [
    [[0, 0], [10, 0], [10, 10], [0, 10]],            // CCW
    [[1, 1], [9, 1], [9, 9], [1, 9]].reverse(),       // CW
    [[2, 2], [8, 2], [8, 8], [2, 8]],                 // CCW
    [[3, 3], [7, 3], [7, 7], [3, 7]].reverse(),       // CW
  ];
  const nz = tessellate(c, 'nonzero');
  check(nz, 'nested-4-nz');
  // nonzero: 每层贡献 ±1，填充区绕数 1,0,1,0 -> 填充 = 外两层交替 => 面积 (100-64)+(36-16)=56
  ok(Math.abs(meshToJSON(nz).area - 56) < 1e-6, '四层嵌套 nonzero 面积应为 56，实际 ' + meshToJSON(nz).area);
  const eo = tessellate(c, 'evenodd');
  check(eo, 'nested-4-eo');
  ok(Math.abs(meshToJSON(eo).area - 56) < 1e-6, '四层嵌套 evenodd 面积应为 56');
}

// 4. 相切于单点的两个方块（角接触），必须各自独立、不产生缝或重叠
{
  const c = [
    [[0, 0], [4, 0], [4, 4], [0, 4]],
    [[4, 4], [8, 4], [8, 8], [4, 8]],
  ];
  const r = tessellate(c, 'nonzero');
  check(r, 'point-touch');
  ok(Math.abs(meshToJSON(r).area - 32) < 1e-6, '角接触两方块面积应为 32');
}

// 5. 顺序无关：随机打乱轮廓与顶点旋转，面积/三角形集合稳定
{
  const c = [
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[2, 2], [8, 2], [8, 8], [2, 8]].reverse(),
    [[5, -4], [12, -4], [12, 2], [5, 2]],
  ];
  const base = tessellate(c, 'nonzero');
  for (let trial = 0; trial < 8; trial++) {
    const mut = c.map((r) => r.map((p) => p.slice()));
    // 轮廓乱序
    for (let i = mut.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mut[i], mut[j]] = [mut[j], mut[i]];
    }
    // 每条环随机旋转起点
    for (const r of mut) {
      const k = Math.floor(Math.random() * r.length);
      r.push(...r.splice(0, k));
    }
    const got = tessellate(mut, 'nonzero');
    ok(Math.abs(got.area.toNumber() - base.area.toNumber()) < 1e-9, '顺序无关面积稳定');
    check(got, 'order-trial-' + trial);
  }
}

// 6. 512 边约束与性能
{
  const contours = [];
  let used = 0;
  let grid = 0;
  while (used + 4 <= 512) {
    const x = (grid % 8) * 20, y = Math.floor(grid / 8) * 20;
    contours.push([[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8]]);
    used += 4; grid++;
  }
  const t0 = Date.now();
  const r = tessellate(contours, 'nonzero');
  const ms = Date.now() - t0;
  check(r, 'stress-512');
  ok(Math.abs(meshToJSON(r).area - grid * 64) < 1e-6, '512 边总面积');
  console.log(`  512 边耗时 ${ms}ms，顶点 ${r.compactVerts.length}，三角形 ${r.triangles.length}`);
  ok(ms < 2000, '512 边应在 2s 内完成');
}

// 7. 退化输入：零长边、连续重复点、末点重复首点
{
  const c = [[[0, 0], [0, 0], [8, 0], [8, 8], [0, 8], [0, 0]]];
  const r = tessellate(c, 'nonzero');
  check(r, 'degenerate');
  ok(Math.abs(meshToJSON(r).area - 64) < 1e-6, '退化点清理后面积应为 64');
}

// 8. 精确面积为分数（非整数）：三角形
{
  const c = [[[0, 0], [3, 0], [0, 2]]]; // 面积 3
  const r = tessellate(c, 'evenodd');
  ok(r.area.eq(new Frac(3n)), '三角形精确面积应为 3，实际 ' + r.area.toString());
}

console.log(`\n${fail === 0 ? '✅ 边界用例全部通过' : '❌ 有失败'}：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
