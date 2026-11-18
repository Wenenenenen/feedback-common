// 核心算法验证脚本（node test/run-tests.mjs <样例目录>）
// 运行：node test/run-tests.mjs .work/samples-extract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeMesh,
  HeatSolver,
  extractIsolines,
  compareFields,
  MeshRejectError,
} from '../src/lib/heat-method.js';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node test/run-tests.mjs <样例目录>');
  process.exit(2);
}
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const ref = load('reference.json');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- 1. flat：对称性、源点零值、逼近平面欧氏距离 ----------
console.log('[flat] 规则平面网格');
{
  const d = load('flat.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const solver = new HeatSolver(an);
  const r = solver.solve(d.sources, d.tau);
  ok(r.distances[ref.source] === 0, '源点距离为 0');
  for (const [p, q] of ref.flat_symmetry_pairs) {
    ok(approx(r.distances[p], r.distances[q], 1e-10), `对称顶点 ${p}/${q} 距离相等`);
  }
  // 与平面欧氏距离比较（规则 9x9 网格，间距 1；粗网格源点附近热方法有约 15% 固有偏差，
  // 与独立 NumPy 参照实现逐值一致——这是热方法的离散特性，不是实现误差）
  let maxRel = 0;
  for (let v = 0; v < an.nV; v++) {
    const eu = Math.hypot(
      d.positions[v][0] - d.positions[ref.source][0],
      d.positions[v][1] - d.positions[ref.source][1]
    );
    if (eu > 0) maxRel = Math.max(maxRel, Math.abs(r.distances[v] - eu) / eu);
  }
  console.log(`    对欧氏距离最大相对误差 ${(maxRel * 100).toFixed(2)}%（粗网格固有，独立参照实现同值）`);
  ok(maxRel < 0.2, '平面网格距离逼近欧氏距离（粗网格阈值 <20%）');

  // 不能是边图最短路：对角线顶点上，边图 L1 路径明显长于热方法
  const edgePath = edgeShortestPaths(an, ref.source);
  const probe = ref.flat_symmetry_pairs[0][0];
  console.log(`    顶点 ${probe}: 热方法=${r.distances[probe].toFixed(4)} 边图最短路=${edgePath.get(probe).toFixed(4)}`);
  ok(r.distances[probe] < edgePath.get(probe) - 0.05, '热方法距离明显短于边图最短路（未退回图距离）');
  ok(r.distances.every((x) => x === null || (Number.isFinite(x) && x >= 0)), '距离全部有限且非负');
}

// ---------- 2. folded vs flat：等距折叠距离一致 ----------
console.log('[folded] 折弯不改边长 → 距离场一致');
{
  const flat = load('flat.json');
  const fold = load('folded.json');
  const anF = analyzeMesh(flat.positions, flat.triangles);
  const anG = analyzeMesh(fold.positions, fold.triangles);
  const rF = new HeatSolver(anF).solve(flat.sources, flat.tau);
  const rG = new HeatSolver(anG).solve(fold.sources, fold.tau);
  const cmp = compareFields(rF, rG, anF, anG);
  console.log(
    `    maxAbs=${cmp.maxAbsDifference.toExponential(2)} meanAbs=${cmp.meanAbsDifference.toExponential(2)}`
  );
  ok(cmp.maxAbsDifference <= ref.flat_folded_max_difference, '折叠/平面最大差异 ≤ 1e-6');

  // 折弯墙（x>=0 被折起）上的顶点：空间直线从地面源点穿过折角下方的空气，表面路径必须绕行
  const foldV = 48;
  const straight = Math.hypot(
    ...fold.positions[foldV].map((c, k) => c - fold.positions[ref.source][k])
  );
  console.log(`    折弯墙顶点 ${foldV}: 表面距离=${rG.distances[foldV].toFixed(4)} 空间直线=${straight.toFixed(4)}`);
  ok(rG.distances[foldV] > straight, '折弯处表面距离正确地长于穿过模型/空气的空间直线');
}

// ---------- 3. disconnected：无源分量不可达 ----------
console.log('[disconnected] 断开分量');
{
  const d = load('disconnected.json');
  const an = analyzeMesh(d.positions, d.triangles);
  ok(an.components.length === 2, '识别出 2 个连通分量');
  const r = new HeatSolver(an).solve(d.sources, d.tau);
  const [lo, hi] = ref.disconnected_unreachable_range;
  let good = true;
  for (let v = 0; v < an.nV; v++) {
    const expectNull = v >= lo && v <= hi;
    if (expectNull && r.distances[v] !== null) good = false;
    if (!expectNull && r.distances[v] === null) good = false;
  }
  ok(good, `顶点 ${lo}..${hi} 输出 null（不可达），其余可达`);
  ok(
    r.componentDiagnostics.find((c) => !c.sourced && !c.solved && c.reachable === false),
    '诊断中无源分量标记为未求解/不可达'
  );
}

// ---------- 4. isolated：孤立顶点 ----------
console.log('[isolated] 孤立顶点');
{
  const d = load('isolated.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const isoComp = an.components.find((c) => c.isolated);
  ok(isoComp && isoComp.verts[0] === ref.isolated_null_index, `孤立顶点 ${ref.isolated_null_index} 被识别`);
  const r = new HeatSolver(an).solve(d.sources, d.tau);
  ok(r.distances[ref.isolated_null_index] === null, '未选源时孤立顶点为 null');
  const r2 = new HeatSolver(an).solve([ref.isolated_null_index], d.tau);
  ok(r2.distances[ref.isolated_null_index] === 0, '孤立顶点被选为源时距离为 0');
  ok(r2.distances[ref.source] === null, '此时其余分量不可达');
}

// ---------- 5. degenerate：退化面列出并排除 ----------
console.log('[degenerate] 退化面');
{
  const d = load('degenerate.json');
  const an = analyzeMesh(d.positions, d.triangles);
  ok(an.excludedFaces.length === 1, '列出 1 个退化面');
  ok(an.excludedFaces[0].face === 128, '退化面编号 128');
  ok(an.validFaces.length === d.triangles.length - 1, '有效面数 = 总面数 - 1');
  const r = new HeatSolver(an).solve(d.sources, d.tau);
  ok(r.distances.every((x) => x === null || Number.isFinite(x)), '排除后求解正常完成');
}

// ---------- 6. invalid-nonmanifold：拒绝 ----------
console.log('[invalid-nonmanifold] 非流形拒绝');
{
  const d = load('invalid-nonmanifold.json');
  let threw = false;
  try {
    analyzeMesh(d.positions, d.triangles);
  } catch (e) {
    threw = e instanceof MeshRejectError;
  }
  ok(threw, '一边超过 2 面时抛 MeshRejectError 拒绝导入');
}

// ---------- 7. obtuse：钝角三角形（负 cot 保留） ----------
console.log('[obtuse] 钝角三角形');
{
  const d = load('obtuse.json');
  const an = analyzeMesh(d.positions, d.triangles);
  ok(an.obtuseFaces.length === 2, `两个钝角三角形均被标记（实际 ${an.obtuseFaces.length}）`);
  const solver = new HeatSolver(an);
  const r = solver.solve(d.sources, d.tau);
  ok(r.distances[0] === 0 && r.distances.slice(1).every((x) => x > 0 && Number.isFinite(x)), '钝角网格得到有限正距离');
  const heatRel = r.componentDiagnostics[0].heat.relativeResidual;
  const poiRel = r.componentDiagnostics[0].poisson.relativeResidual;
  console.log(`    热方程相对残差=${heatRel.toExponential(2)} Poisson=${poiRel.toExponential(2)}`);
  ok(heatRel < 1e-8 && poiRel < 1e-8, '两步求解相对残差均 < 1e-8');
}

// ---------- 8. stress：8192 面性能与残差 ----------
console.log('[stress] 大规模网格（8192 面 / 4225 顶点）');
{
  const d = load('stress.json');
  ok(d.triangles.length === ref.stress_triangles, '面数 8192');
  const an = analyzeMesh(d.positions, d.triangles);
  const solver = new HeatSolver(an);
  const t0 = performance.now();
  const r = solver.solve(d.sources, d.tau);
  const ms = performance.now() - t0;
  console.log(`    求解耗时 ${ms.toFixed(0)} ms`);
  ok(ms < 5000, '5 秒内完成求解');
  const c = r.componentDiagnostics[0];
  ok(c.heat.relativeResidual < 1e-8 && c.poisson.relativeResidual < 1e-8, '残差 < 1e-8');
  ok(r.unreachableCount === 0, '全网格可达，无 null');
}

// ---------- 9. 多源 ----------
console.log('[multi-source] 多源点');
{
  const d = load('flat.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const solver = new HeatSolver(an);
  const s1 = solver.solve([31], d.tau);
  const s2 = solver.solve([49], d.tau);
  const mm = solver.solve([31, 49], d.tau);
  ok(mm.distances[31] === 0 && mm.distances[49] === 0, '两个源点距离均为 0');
  ok(
    mm.distances.every((x) => x === null || (Number.isFinite(x) && x >= 0)),
    '多源距离全部有限且非负'
  );
  // 结构性质：单源可达的顶点在多源下同样可达；两源附近各有一个低距离区
  ok(
    mm.distances.every((x, v) => x === null || (s1.distances[v] !== null && s2.distances[v] !== null)),
    '多源不改变可达性'
  );
  // 两个源点各自形成近零距离区（粗网格源点邻域距离约 0.84）
  const near1 = mm.distances.filter((_, v) => s1.distances[v] !== null && s1.distances[v] < 0.9).length;
  ok(near1 >= 2, `多个源邻域形成低距离区（${near1} 个近源点）`);
  // 双源在分量中点附近应不大于两单源中的较大者（扩散叠加的合理上界）
  const mid = 40;
  ok(
    mm.distances[mid] <= Math.max(s1.distances[mid], s2.distances[mid]) + 1e-9,
    '双源中点距离不超过较差单源'
  );
}

// ---------- 10. 缓存复用 ----------
console.log('[cache] 矩阵分解缓存');
{
  const d = load('flat.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const solver = new HeatSolver(an);
  solver.solve([40], 1);
  ok(solver.stats.heat.misses === 1 && solver.stats.poisson.misses === 1, '首次求解两次分解均为 miss');
  solver.solve([40], 1);
  ok(solver.stats.heat.hits >= 1 && solver.stats.poisson.hits >= 1, '同源同 tau 重复求解命中缓存');
  solver.resetStats();
  solver.solve([41], 1); // 移动源点
  ok(solver.stats.heat.hits === 1 && solver.stats.heat.misses === 0, '移动源点复用热方程分解（与源点无关矩阵）');
  ok(solver.stats.poisson.misses === 1 && solver.stats.poisson.hits === 0, '源集合变化时 Poisson 约束分解重建');
  solver.solve([41], 2); // 改 tau
  ok(solver.stats.heat.misses === 1, 'tau 变化时热方程分解重建');
}

// ---------- 11. 等值线 ----------
console.log('[isolines] 等值线提取');
{
  const d = load('flat.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const r = new HeatSolver(an).solve(d.sources, d.tau);
  const segs = extractIsolines(r, an, 1.0);
  ok(segs.length > 0, '间距 1.0 提取出等值线段');
  ok(segs.every((s) => s.a.length === 3 && s.b.length === 3 && isFinite(s.a[0])), '线段坐标合法');
  const levels = new Set(segs.map((s) => s.level));
  ok([...levels].every((l) => l > 0 && l <= r.maxDistance), '等值层级落在 (0, maxDistance]');
  const segs2 = extractIsolines(r, an, 0.5);
  ok(segs2.length > segs.length, '间距缩小后等值线段增多');
  // 不可达分量不产生等值线
  const dd = load('disconnected.json');
  const an2 = analyzeMesh(dd.positions, dd.triangles);
  const r2 = new HeatSolver(an2).solve(dd.sources, dd.tau);
  const segD = extractIsolines(r2, an2, 1.0);
  const inUnreachable = segD.some((s) =>
    dd.triangles[s.face].some((v) => v >= ref.disconnected_unreachable_range[0])
  );
  ok(!inUnreachable, '不可达分量不产生等值线');
}

// ---------- 12. 与独立 NumPy 参照实现逐值交叉校验 ----------
console.log('[cross-check] 与 NumPy 参照实现逐值对比');
{
  const refPath = new URL('../.work/reference-distances.json', import.meta.url);
  let refs = null;
  try {
    refs = JSON.parse(readFileSync(refPath, 'utf8'));
  } catch {
    console.log('  （跳过：未生成 .work/reference-distances.json）');
  }
  if (refs) {
    for (const name of ['flat', 'folded', 'obtuse', 'stress', 'disconnected', 'isolated', 'degenerate']) {
      const d = load(`${name}.json`);
      const an = analyzeMesh(d.positions, d.triangles);
      const r = new HeatSolver(an).solve(d.sources, d.tau);
      let maxAbs = 0;
      let mismatchNull = 0;
      for (let v = 0; v < an.nV; v++) {
        const ref = refs[name][v];
        if (ref === null || r.distances[v] === null) {
          if (ref !== r.distances[v]) mismatchNull++;
          continue;
        }
        maxAbs = Math.max(maxAbs, Math.abs(ref - r.distances[v]));
      }
      ok(mismatchNull === 0, `${name}: 可达性标记与参照一致`);
      ok(maxAbs < 1e-9, `${name}: 距离逐值一致（最大差异 ${maxAbs.toExponential(2)}）`);
    }
  }
}

// ---------- 13. tau 边界与导出结构 ----------
console.log('[misc] tau 校验与诊断导出');
{
  const d = load('flat.json');
  const an = analyzeMesh(d.positions, d.triangles);
  const solver = new HeatSolver(an);
  let threw = false;
  try {
    solver.solve(d.sources, 11);
  } catch {
    threw = true;
  }
  ok(threw, 'tau 超出 [0.1,10] 被拒绝');
  const r = solver.solve(d.sources, 0.5);
  const diag = buildDiagnosticExport(an, r, 1.0, []);
  ok(
    ['mesh', 'excludedFaces', 'components', 'residuals', 'cacheStats', 'tau', 'sources'].every((k) => k in diag),
    '诊断 JSON 含组件/排除面/残差/缓存字段'
  );
}

// ---------- 辅助：边图最短路（仅作对照，绝不在产品代码中使用） ----------
function edgeShortestPaths(an, source) {
  const adj = new Map();
  for (const fi of an.validFaces) {
    const t = an.triangles[fi];
    for (let k = 0; k < 3; k++) {
      const u = t[k];
      const v = t[(k + 1) % 3];
      const w = Math.hypot(...an.positions[u].map((c, j) => c - an.positions[v][j]));
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u).push([v, w]);
      adj.get(v).push([u, w]);
    }
  }
  const dist = new Map([[source, 0]]);
  const heap = [[0, source]];
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0]);
    const [du, u] = heap.shift();
    if (du > dist.get(u)) continue;
    for (const [v, w] of adj.get(u) || []) {
      const nd = du + w;
      if (!dist.has(v) || nd < dist.get(v)) {
        dist.set(v, nd);
        heap.push([nd, v]);
      }
    }
  }
  return dist;
}

function buildDiagnosticExport(an, result, spacing, isoSegments) {
  return {
    mesh: {
      vertexCount: an.nV,
      faceCount: an.nF,
      validFaceCount: an.validFaces.length,
      boundaryEdgeCount: an.boundaryEdges.length,
      obtuseFaceCount: an.obtuseFaces.length,
    },
    excludedFaces: an.excludedFaces,
    components: an.components.map((c) => ({
      id: c.id,
      isolated: c.isolated,
      faceCount: c.faces.length,
      vertexCount: c.verts.length,
    })),
    residuals: result.componentDiagnostics
      .filter((c) => c.solved)
      .map((c) => ({
        component: c.component,
        heatRelativeResidual: c.heat.relativeResidual,
        poissonRelativeResidual: c.poisson.relativeResidual,
      })),
    cacheStats: result.cacheStats,
    tau: result.tau,
    sources: result.sources,
    isolineCount: isoSegments.length,
    isolineSpacing: spacing,
  };
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
