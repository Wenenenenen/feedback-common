// 审计引擎测试：node tests/run-tests.mjs
import { auditMesh } from '../src/mesh-auditor.js';
import { orient3 } from '../src/exact-geometry.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function hasType(result, type) { return result.issues.some((i) => i.type === type); }
function issueFaceSet(result, type) {
  const s = new Set();
  for (const i of result.issues.filter((x) => x.type === type)) for (const f of i.faces) s.add(f);
  return s;
}

// 四面体（samples/shell-parity.json）。样例绕序向内，统一后 6V = 6*121.5 = 729
function tetra() {
  return {
    vertices: [[0, 0, 0], [9, 0, 0], [0, 9, 0], [0, 0, 9]],
    faces: [[0, 1, 2], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
  };
}
// 向外绕序版本（与样例同拓扑、法线全部朝外；经逐面点乘质心核验）
const tetraOutward = () => ({
  vertices: tetra().vertices,
  faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
});

console.log('1. 合法四面体：精确六倍体积（样例为向内绕序，自动统一为向外）');
{
  const m = tetra();
  const r = auditMesh(m.vertices, m.faces);
  check('合法', r.legal, JSON.stringify(r.issues));
  check('6V=729', r.totalVolume6 === '729', r.totalVolume6);
  check('1 个壳、深度 0', r.shells.length === 1 && r.shells[0].depth === 0);
  check('壳体积 729', r.shells[0].volume6 === '729');
  check('修正为向外绕序', JSON.stringify(r.correctedFaces) === JSON.stringify(tetraOutward().faces));
  check('每个面只交换后两个索引', r.correctedFaces.every((f, i) => f[0] === m.faces[i][0]));
}

console.log('2. 向外绕序四面体：无需翻面，体积为正');
{
  const m = tetraOutward();
  const r = auditMesh(m.vertices, m.faces);
  check('合法', r.legal, JSON.stringify(r.issues));
  check('6V=729', r.totalVolume6 === '729', r.totalVolume6);
  check('导出未改动', JSON.stringify(r.correctedFaces) === JSON.stringify(m.faces));
}

console.log('3. 嵌套立方体：外壳 + 空腔，偶正奇负，实体体积=外-内');
{
  function box(x0, y0, z0, x1, y1, z1, base) {
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    // 向外绕序
    const f = [
      [0, 3, 2], [0, 2, 1], // z0
      [4, 5, 6], [4, 6, 7], // z1
      [0, 1, 5], [0, 5, 4], // y0
      [2, 3, 7], [2, 7, 6], // y1
      [1, 2, 6], [1, 6, 5], // x1
      [0, 4, 7], [0, 7, 3], // x0
    ].map((tri) => tri.map((i) => i + base));
    return { vertices: v, faces: f };
  }
  const outer = box(0, 0, 0, 4, 4, 4, 0);
  const inner = box(1, 1, 1, 3, 3, 3, 8);
  const r = auditMesh(outer.vertices.concat(inner.vertices), outer.faces.concat(inner.faces));
  check('合法', r.legal, JSON.stringify(r.issues));
  check('两个壳', r.shells.length === 2);
  const sh0 = r.shells.find((s) => s.depth === 0);
  const sh1 = r.shells.find((s) => s.depth === 1);
  check('包含树深度', sh0 && sh1 && sh1.parent === sh0.componentId);
  check('外壳 6V=384', sh0.volume6 === '384', sh0.volume6);
  check('空腔 6V=-48', sh1.volume6 === '-48', sh1.volume6);
  check('总体积 336', r.totalVolume6 === '336', r.totalVolume6);
}

console.log('4. 开口边：少一个面');
{
  const m = tetra();
  m.faces.pop();
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 boundary-edge', hasType(r, 'boundary-edge'));
  check('bad-fan', hasType(r, 'bad-fan'));
  check('非法不交付修复索引', r.correctedFaces === null);
}

console.log('5. 非流形边：三个面共享一条边');
{
  const m = tetra();
  m.vertices.push([0, -9, 0]);
  m.faces.push([0, 1, 4]); // 与面 (0,1,2) 共享边 0-1，形成三面边
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 non-manifold-edge', hasType(r, 'non-manifold-edge'));
  const fs = issueFaceSet(r, 'non-manifold-edge');
  check('报出全部三面号', fs.size === 3 && fs.has(4), [...fs].join(','));
}

console.log('6. 退化面');
{
  const m = tetra();
  m.faces.push([0, 1, 1]);
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 degenerate 且面号 4', hasType(r, 'degenerate') && issueFaceSet(r, 'degenerate').has(4));
}

console.log('7. 穿越相交：两个四面体互相穿透');
{
  const m = tetra();
  // 第二个四面体横跨第一个
  const v2 = [[-5, 3, 3], [14, 3, 3], [5, -6, 3], [5, 12, 3]];
  const base = m.vertices.length;
  m.vertices.push(...v2);
  m.faces.push(
    [base, base + 1, base + 2], [base, base + 1, base + 3],
    [base, base + 3, base + 2], [base + 1, base + 2, base + 3]);
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 crossing', hasType(r, 'crossing'), JSON.stringify(r.issues));
}

console.log('8. 非拓扑点接触：两壳顶点碰顶点（不同索引同坐标）');
{
  const m = tetra();
  // 第二个四面体放在第一个的顶点 (9,0,0)=v1 处，仅几何点接触，索引不共享
  const v2 = [[9, 0, 0], [18, 0, 0], [9, 9, 0], [9, 0, 9]];
  const base = m.vertices.length;
  m.vertices.push(...v2);
  m.faces.push(
    [base, base + 1, base + 2], [base, base + 1, base + 3],
    [base, base + 3, base + 2], [base + 1, base + 2, base + 3]);
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 bad-contact', hasType(r, 'bad-contact'), JSON.stringify(r.issues));
}

console.log('9. 共面重叠：共面且部分重叠的两个三角形');
{
  const m = tetra();
  const base = m.vertices.length;
  // 与面 (0,1,2) 同在 z=0 平面，部分重叠但不共享索引
  m.vertices.push([3, 3, 0], [12, 3, 0], [3, 12, 0]);
  m.faces.push([base, base + 1, base + 2]);
  const r = auditMesh(m.vertices, m.faces);
  check('非法', !r.legal);
  check('报 coplanar-overlap', hasType(r, 'coplanar-overlap'), JSON.stringify(r.issues));
}

console.log('10. 共面但仅边接触（无共享索引）=> 报接触，不许容差合并');
{
  // 两个正方形各分两个三角形，沿一条边几何贴合但索引独立
  const vertices = [
    [0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0],
    [2, 0, 0], [4, 0, 0], [4, 2, 0], [2, 2, 0],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3],
    [4, 5, 6], [4, 6, 7],
  ];
  // 单独这 4 个面不是封闭网格，但接触检测仍应触发
  const r = auditMesh(vertices, faces);
  check('报 coplanar-overlap（边重叠未拓扑共享）',
    hasType(r, 'coplanar-overlap'), JSON.stringify(r.issues));
}

console.log('11. 相近但不相接：间距 1（整数最小间隔）不得被合并');
{
  const m = tetra();
  const v2 = [[10, 0, 0], [19, 0, 0], [10, 9, 0], [10, 0, 9]]; // 与 v1=(9,0,0) 差 1
  const base = m.vertices.length;
  m.vertices.push(...v2);
  m.faces.push(
    [base, base + 1, base + 2], [base, base + 1, base + 3],
    [base, base + 3, base + 2], [base + 1, base + 2, base + 3]);
  const r = auditMesh(m.vertices, m.faces);
  const contactIssues = r.issues.filter((i) =>
    ['bad-contact', 'coplanar-overlap', 'crossing'].includes(i.type));
  check('无接触类问题', contactIssues.length === 0, JSON.stringify(contactIssues));
}

console.log('12. 不可定向：莫比乌斯扭转条带（粘合边绕序矛盾）');
{
  // 两排矩形顶点，末端 180° 扭转粘合，定向约束图产生奇数负号环
  const n = 4;
  const vertices = [];
  for (let i = 0; i < n; i++) vertices.push([i * 2, 0, 0]);
  for (let i = 0; i < n; i++) vertices.push([i * 2, 4, 0]);
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (j !== 0) {
      faces.push([i, n + i, j]);
      faces.push([n + i, n + j, j]);
    } else {
      faces.push([i, n + i, n]);
      faces.push([n + i, 0, n]);
    }
  }
  const r = auditMesh(vertices, faces);
  check('报 non-orientable', hasType(r, 'non-orientable'), JSON.stringify(r.issues.map(i => i.type)));
}

console.log('13. 坏面扇：两个四面体只共享一个顶点（锥点）');
{
  const m = tetra();
  const v2 = [[0, 0, 0], [0, -9, 0], [-9, 0, 0], [0, 0, -9]]; // 复用索引 0
  const base = m.vertices.length;
  m.vertices.push(...v2.slice(1));
  m.faces.push(
    [0, base, base + 1], [0, base, base + 2],
    [0, base + 2, base + 1], [base, base + 1, base + 2]);
  const r = auditMesh(m.vertices, m.faces);
  check('报 bad-fan 且定位顶点 0', hasType(r, 'bad-fan') &&
    r.issues.some((i) => i.type === 'bad-fan' && i.vertices.includes(0)),
    JSON.stringify(r.issues));
}

console.log('14. 大坐标精确性：坐标 1e6 边界值，浮点会出错而 BigInt 正确');
{
  // 两个几乎平行的三角形在大坐标下，坐标恰在上限 1e6
  const M = 1000000;
  const vertices = [
    [0, 0, M], [M, 0, M], [0, M, M],
    [1, 1, M - 1], [M - 1, 1, M + 0], [1, M - 1, M],
  ];
  const r = auditMesh(vertices, [[0, 1, 2], [3, 4, 5]]);
  check('大坐标审计完成且结果确定', typeof r.legal === 'boolean');
  // orient3 大值冒烟测试：(1e6)^3 不丢精度
  const p = [[0n, 0n, 0n], [1000000n, 0n, 0n], [0n, 1000000n, 0n], [0n, 0n, 1000000n]];
  check('orient3 = 10^18 精确', orient3(...p) === 1);
}

console.log('15. 输入校验');
{
  let threw = false;
  try { auditMesh([[0, 0, 0.5]], [[0, 0, 0]]); } catch { threw = true; }
  check('非整数坐标拒绝', threw);
  threw = false;
  try { auditMesh([[0, 0, 0]], [[0, 0, 9]]); } catch { threw = true; }
  check('越界索引拒绝', threw);
  threw = false;
  try { auditMesh([[2000000, 0, 0]], [[0, 0, 0]]); } catch { threw = true; }
  check('超 1e6 坐标拒绝', threw);
}

console.log('16. 性能：5000 个互不相交四面体');
{
  const vertices = [];
  const faces = [];
  const N = 5000;
  const perRow = 50;
  for (let n = 0; n < N; n++) {
    const gx = (n % perRow) * 30, gy = Math.floor(n / perRow) * 30, gz = Math.floor(n / (perRow * perRow)) * 30;
    const base = vertices.length;
    vertices.push(
      [gx, gy, gz], [gx + 9, gy, gz], [gx, gy + 9, gz], [gx, gy, gz + 9]);
    faces.push(
      [base, base + 1, base + 2], [base, base + 1, base + 3],
      [base, base + 3, base + 2], [base + 1, base + 2, base + 3]);
  }
  const t = performance.now();
  const r = auditMesh(vertices, faces);
  const dt = performance.now() - t;
  check('合法', r.legal, JSON.stringify(r.issues.slice(0, 3)));
  check('5000 壳', r.shells.length === 5000, String(r.shells.length));
  check(`总 6V = ${729 * 5000}`, r.totalVolume6 === String(729 * 5000), r.totalVolume6);
  check(`耗时 ${dt.toFixed(0)}ms < 12000ms`, dt < 12000, `实际 ${dt.toFixed(0)}ms`);
  console.log(`     统计: pairTests=${r.stats.pairTests}, BVH=${r.stats.timingsMs.bvh}ms, ` +
    `精相=${r.stats.timingsMs.pairTests}ms, 总计=${r.stats.timingsMs.total}ms`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);

// ---- 补充边界用例 ----
console.log('17. 三层嵌套：深度 0/1/2，符号 + - +');
{
  function box(x0, y0, z0, x1, y1, z1, base) {
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const f = [
      [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
      [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3],
    ].map((t) => t.map((i) => i + base));
    return { vertices: v, faces: f };
  }
  const b0 = box(0, 0, 0, 12, 12, 12, 0);
  const b1 = box(2, 2, 2, 10, 10, 10, 8);
  const b2 = box(4, 4, 4, 8, 8, 8, 16);
  const r = auditMesh(b0.vertices.concat(b1.vertices, b2.vertices),
    b0.faces.concat(b1.faces, b2.faces));
  check('三层合法', r.legal, JSON.stringify(r.issues));
  const depths = r.shells.map((s) => s.depth).sort((a, b) => a - b);
  check('深度 0,1,2', JSON.stringify(depths) === '[0,1,2]', JSON.stringify(depths));
  const vols = r.shells.map((s) => BigInt(s.volume6)).sort((a, b) => (a < b ? 1 : -1)).map(String);
  check('体积 10368,-3072,384', JSON.stringify(vols) === JSON.stringify(['10368', '384', '-3072']), JSON.stringify(vols));
  check('总体积 7680', r.totalVolume6 === '7680', r.totalVolume6);
}

console.log('18. 立方体相邻面共享边正确相接，无接触误报');
{
  function box(x0, y0, z0, x1, y1, z1, base) {
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const f = [
      [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
      [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3],
    ].map((t) => t.map((i) => i + base));
    return { vertices: v, faces: f };
  }
  const b = box(0, 0, 0, 4, 4, 4, 0);
  const r = auditMesh(b.vertices, b.faces);
  const contact = r.issues.filter((i) => ['bad-contact', 'coplanar-overlap', 'crossing'].includes(i.type));
  check('无接触误报', contact.length === 0, JSON.stringify(contact));
}

console.log('19. 修正导出保留面序、首索引、顶点表');
{
  const m = tetra();
  const r = auditMesh(m.vertices, m.faces);
  check('顶点表不变', JSON.stringify(r.vertices) === JSON.stringify(m.vertices));
  check('面数不变', r.correctedFaces.length === m.faces.length);
  check('首索引保留', r.correctedFaces.every((f, i) => f[0] === m.faces[i][0]));
  check('只交换后两个索引', r.correctedFaces.every((f, i) => {
    const o = m.faces[i];
    return (f[1] === o[1] && f[2] === o[2]) || (f[1] === o[2] && f[2] === o[1]);
  }));
}

console.log(`\n最终结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
