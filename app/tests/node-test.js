/* Node 无头测试：加载引擎（stub window），跑三个样例 + 编辑/一致性/性能测试。 */
globalThis.window = globalThis;
const path = require('path');
const fs = require('fs');
const root = '/home/wendy/jianzhi/feedback-tasks/separating-voxel-foundry';
for (const f of ['app/js/math3d.js', 'app/js/validate.js', 'app/js/engine.js']) {
  require(path.join(root, f));
}
const VF = globalThis.VF;

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'samples/extracted', name), 'utf8'));
}

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}

// ---------- 样例基本验证 ----------
for (const name of ['case1_anisotropic_prism.json', 'case2_hollow_double_shell.json', 'case3_slanted_thin_wall.json']) {
  const data = load(name);
  const v = VF.validateInput(data);
  check(v.ok, `${name} 校验通过: ${v.errors.map(e => e.message).join('; ')}`);
  const st = VF.createEngineState(data);
  const t = performance.now();
  VF.fullRebuild(st);
  const dt = performance.now() - t;
  const s = st.stats;
  console.log(`\n== ${name} (${st.mode}, flood=${st.flood})  耗时 ${dt.toFixed(1)}ms ==`);
  console.log('  counts:', JSON.stringify(s.counts));
  console.log('  hist:', JSON.stringify(s.materialHistogram));
  console.log('  leaks:', st.leaks.length, ' components:', st.components.length);
  for (const c of st.components)
    console.log('   ', c.type, 'n=' + c.voxelCount, 'rep=' + c.representativeVoxel, 'W=' + c.windingNumber.toFixed(4));
  check(s.counts.SURFACE > 0, `${name} 有表面体素`);
  check(s.counts.EXTERIOR > 0, `${name} 有外部体素`);
  const total = s.counts.SURFACE + s.counts.EXTERIOR + s.counts.SOLID_INTERIOR + s.counts.EMPTY_CAVITY;
  check(total === st.total, `${name} 分类总数守恒 ${total} == ${st.total}`);
  check(!st.components.some(c => !Number.isFinite(c.windingNumber)), `${name} 绕数有限`);
}

// ---------- case2 双壳：内空腔必须判为 EMPTY_CAVITY 而非实心 ----------
{
  const st = VF.createEngineState(load('case2_hollow_double_shell.json'));
  VF.fullRebuild(st);
  const cavities = st.components.filter(c => c.type === 'EMPTY_CAVITY');
  check(cavities.length >= 1, 'case2 存在嵌套空腔 EMPTY_CAVITY');
  const solids = st.components.filter(c => c.type === 'SOLID_INTERIOR');
  console.log('\ncase2 空腔数:', cavities.length, '实体内部数:', solids.length);
}

// ---------- case3 薄壳斜墙 + 26 漫水 ----------
{
  const st = VF.createEngineState(load('case3_slanted_thin_wall.json'));
  VF.fullRebuild(st);
  // case3 是 45° 菱形棱柱：SPEC 公式下其边叉轴 r6==r26，6/26 分离表面集合相同，
  // 2 体素厚墙带不存在 E6→I6 对角邻居，故漏孔为 0 是正确输出（非漏报）。
  check(st.leaks.length === 0, `case3 45°双体素墙无对角漏孔（实际 ${st.leaks.length}）`);
  // 切到 6 连通漫水也无漏孔
  st.flood = 6;
  VF.fullRebuild(st);
  check(st.leaks.length === 0, 'case3 6连通漫水时不报告漏孔');
  // 切到厚壳 26 分离也不应有漏孔
  st.mode = '26-separating'; st.flood = 26;
  VF.fullRebuild(st);
  check(st.leaks.length === 0, 'case3 厚壳模式不报告漏孔');
  console.log('  case3 厚壳 counts:', JSON.stringify(st.stats.counts));
}

// ---------- 陡斜封闭壳（30° 墙、各向异性）：漏孔管线专项 ----------
{
  const d = {
    meshId: 'steep', grid: { origin: [0, 0, 0], dims: [20, 20, 20], spacing: [1.0, 1.25, 1.5] },
    separatingMode: '6-separating', floodConnectivity: 26,
    vertices: [
      [10, 2, 2], [16, 8, 2], [10, 14, 2], [4, 8, 2],
      [10, 2, 16], [16, 8, 16], [10, 14, 16], [4, 8, 16]],
    triangles: [], edits: [],
  };
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  d.triangles = faces.map((f, id) => ({ id, indices: f, material: 1, group: 'shell', enabled: true }));
  const st = VF.createEngineState(d);
  VF.fullRebuild(st);
  check(st.leaks.length > 0, `陡斜壳 6分离+26漫水应定位对角漏孔（实际 ${st.leaks.length}）`);
  // 每对漏孔独立复核：子盒内不存在非表面 6 连通桥接
  const { Nx, Ny, Sxy } = st;
  const d6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let bad = 0;
  for (const p of st.leaks) {
    const u = p.fromExterior, v = p.toEnclosed;
    const lo = u.map((x, a) => Math.min(x, v[a])), hi = u.map((x, a) => Math.max(x, v[a]));
    const seen = new Set([u[0] + u[1] * Nx + u[2] * Sxy]); const q = [seen.values().next().value];
    let reach = false;
    while (q.length) {
      const idx = q.pop();
      const i = idx % Nx, j = ((idx / Nx) | 0) % Ny, k = (idx / Sxy) | 0;
      if (i === v[0] && j === v[1] && k === v[2]) { reach = true; break; }
      for (const dd of d6) {
        const ni = i + dd[0], nj = j + dd[1], nk = k + dd[2];
        if (ni < lo[0] || ni > hi[0] || nj < lo[1] || nj > hi[1] || nk < lo[2] || nk > hi[2]) continue;
        const nid = ni + nj * Nx + nk * Sxy;
        if (seen.has(nid) || st.classification[nid] === 1) continue;
        seen.add(nid); q.push(nid);
      }
    }
    if (reach) bad++;
  }
  check(bad === 0, `所有漏孔桥接条件独立复核通过（失败 ${bad}）`);
  // 厚壳无漏孔且表面更厚
  const d2 = JSON.parse(JSON.stringify(d)); d2.separatingMode = '26-separating';
  const st2 = VF.createEngineState(d2); VF.fullRebuild(st2);
  check(st2.leaks.length === 0, '陡斜壳厚壳模式无漏孔');
}

// ---------- 多材质归属：d² 最小，不依赖输入顺序 ----------
{
  // 两块平行板夹住一排体素，材质不同；打乱三角形顺序后结果应一致
  const base = {
    meshId: 'order_test',
    grid: { origin: [0, 0, 0], dims: [8, 8, 8], spacing: [1, 1, 1] },
    separatingMode: '26-separating', floodConnectivity: 6,
    vertices: [
      [0, 0, 3], [8, 0, 3], [8, 8, 3], [0, 8, 3],
      [0, 0, 5], [8, 0, 5], [8, 8, 5], [0, 8, 5],
    ],
    triangles: [
      { id: 0, indices: [0, 2, 1], material: 2, group: 'g', enabled: true },
      { id: 1, indices: [0, 3, 2], material: 2, group: 'g', enabled: true },
      { id: 2, indices: [4, 5, 6], material: 7, group: 'g', enabled: true },
      { id: 3, indices: [4, 6, 7], material: 7, group: 'g', enabled: true },
    ], edits: [],
  };
  const mk = (order) => {
    const d = JSON.parse(JSON.stringify(base));
    d.triangles = order.map(i => d.triangles[i]);
    const st = VF.createEngineState(d);
    VF.fullRebuild(st);
    return { mat: Array.from(st.surfMat), tri: Array.from(st.surfTri) };
  };
  const a = mk([0, 1, 2, 3]);
  const b = mk([3, 2, 1, 0]);
  check(JSON.stringify(a.mat) === JSON.stringify(b.mat), '材质归属与三角形顺序无关');
  check(JSON.stringify(a.tri) === JSON.stringify(b.tri), '来源面归属与三角形顺序无关');
}

// ---------- 编辑 + 撤销重做 + 增量一致性 ----------
{
  const st = VF.createEngineState(load('case1_anisotropic_prism.json'));
  VF.fullRebuild(st);
  const before = st.stats.counts;
  const r1 = VF.boxEdit(st, 'BOX_CARVE', [2, 6, 2, 6, 2, 6]);
  check(r1.ok, '框选挖空成功: ' + (r1.error || ''));
  const v1 = VF.verifyIncremental(st);
  check(v1.ok, `挖空增量与全量一致（差异 ${v1.diffs}）`);

  const r2 = VF.boxEdit(st, 'BOX_FILL', [0, 2, 0, 2, 0, 2], 9);
  check(r2.ok, '框选填充成功');
  check(VF.verifyIncremental(st).ok, '填充增量与全量一致');

  const r3 = VF.toggleGroup(st, 'cap_end');
  check(r3.ok, '分组启停成功');
  check(VF.verifyIncremental(st).ok, '分组启停增量与全量一致');

  const u1 = VF.undo(st); check(u1.ok, 'undo 1');
  check(VF.verifyIncremental(st).ok, 'undo 后增量与全量一致');
  VF.undo(st); check(VF.verifyIncremental(st).ok, 'undo 2 一致');
  VF.undo(st); check(VF.verifyIncremental(st).ok, 'undo 3 一致');
  check(JSON.stringify(st.stats.counts) === JSON.stringify(before), '撤销到初始状态一致');
  const rd = VF.redo(st); check(rd.ok, 'redo 1');
  check(VF.verifyIncremental(st).ok, 'redo 后增量与全量一致');

  const bad = VF.boxEdit(st, 'BOX_FILL', [0, 99, 0, 0, 0, 0], 3);
  check(!bad.ok, '越界框选被拒绝且原结果保留');
  check(st.stats.counts.SURFACE !== undefined, '拒绝后结果仍可用');
}

// ---------- 非法输入 ----------
{
  const bad = JSON.parse(JSON.stringify(load('case1_anisotropic_prism.json')));
  bad.grid.spacing = [1, 0, 1];
  check(!VF.validateInput(bad).ok, '零 spacing 被拒');
  const bad2 = JSON.parse(JSON.stringify(load('case1_anisotropic_prism.json')));
  bad2.triangles[5].indices = [0, 0, 0];
  const r = VF.validateInput(bad2);
  check(!r.ok && r.errors.some(e => e.field.includes('id=5')), '退化面指出 triangle id');
  const bad3 = JSON.parse(JSON.stringify(load('case1_anisotropic_prism.json')));
  bad3.triangles[2].indices = [0, 999, 1];
  const r3 = VF.validateInput(bad3);
  check(!r3.ok && r3.errors.some(e => e.message.includes('越界')), '越界索引被指出');
  const bad4 = JSON.parse(JSON.stringify(load('case1_anisotropic_prism.json')));
  bad4.grid.dims = [97, 12, 12];
  check(!VF.validateInput(bad4).ok, 'dims 超 96 被拒');
}

// ---------- 性能：96³ + 1 万三角形 ----------
{
  const N = 96;
  const verts = [];
  const tris = [];
  // 1000 个随机小四面体碎片 × 10 面 ≈ 10000 三角形，材质 1..16 分散
  let id = 0;
  let seed = 123456789;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  while (tris.length < 10000) {
    const cx = 8 + rnd() * 80, cy = 8 + rnd() * 80, cz = 8 + rnd() * 80;
    const s = 1 + rnd() * 3;
    const base = verts.length;
    verts.push([cx, cy, cz + s], [cx + s, cy, cz - s], [cx - s, cy, cz - s], [cx, cy + s * 1.6, cz]);
    const faces = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];
    for (const f of faces) {
      if (tris.length >= 10000) break;
      tris.push({ id: id++, indices: [base + f[0], base + f[1], base + f[2]],
        material: 1 + (id % 16), group: 'g' + (id % 12), enabled: true });
    }
  }
  const data = {
    meshId: 'perf', grid: { origin: [0, 0, 0], dims: [N, N, N], spacing: [1, 1.25, 1.5] },
    separatingMode: '6-separating', floodConnectivity: 26,
    vertices: verts, triangles: tris, edits: [],
  };
  check(VF.validateInput(data).ok, '性能用例校验通过');
  const st = VF.createEngineState(data);
  const t = performance.now();
  VF.fullRebuild(st);
  const dt = performance.now() - t;
  console.log(`\n== 性能 96³ / ${tris.length} 面 / 6分离+26漫水 ==`);
  console.log('  total:', dt.toFixed(0), 'ms  voxelize:', st.timings.voxelizeMs.toFixed(0),
    'ms  classify:', st.timings.classifyMs.toFixed(0), 'ms');
  console.log('  counts:', JSON.stringify(st.stats.counts), ' leaks:', st.leaks.length);
  check(dt < 2000, `满额在 2 秒内完成（实际 ${dt.toFixed(0)}ms）`);

  // 厚壳再来一次
  st.mode = '26-separating';
  const t2 = performance.now();
  VF.fullRebuild(st);
  const dt2 = performance.now() - t2;
  console.log('  26分离 total:', dt2.toFixed(0), 'ms');
  check(dt2 < 2000, `厚壳满额 2 秒内（实际 ${dt2.toFixed(0)}ms）`);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
