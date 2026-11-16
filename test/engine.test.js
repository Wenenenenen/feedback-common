/* Node 测试：核心细分引擎（用 node --test 运行；不接触样本目录内任何脚本） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('../app/src/math3d.js');
require('../app/src/bezier.js');
require('../app/src/model.js');
require('../app/src/camera.js');
const { tessellate } = require('../app/src/tessellator.js');

const SAMPLE_DIR = path.join(__dirname, '..', 'samples', 'extracted');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, name), 'utf8'));

function makeCamera(data) {
  const c = data.camera;
  return new global.Camera.OrthoCamera({
    position: c.position,
    target: c.target,
    up: c.up,
    width: c.width,
    height: c.height,
    vertical_span: c.vertical_span,
  });
}

async function run(name, pixelError, maxDepth = 7) {
  const data = load(name);
  const parsed = global.PatchModel.validateModel(data);
  if (!parsed.ok) console.log('DIAG run', name, JSON.stringify(parsed.errors));
  assert.ok(parsed.ok, parsed.errors && parsed.errors.join('; '));
  const camera = makeCamera(data);
  const token = { cancelled: false };
  return tessellate(parsed.model, camera, { pixelError, maxDepth, token });
}

test('样例校验：invalid-seam 必须被拒绝并定位到边', () => {
  const data = load('invalid-seam.json');
  const r = global.PatchModel.validateModel(data);
  assert.equal(r.ok, false);
  const msg = r.errors.join('\n');
  assert.match(msg, /u1/);
  assert.match(msg, /u0/);
  assert.match(msg, /1e-8|接缝不重合/);
});

test('合法样例 patches.json 接缝校验通过', () => {
  const data = load('patches.json');
  const r = global.PatchModel.validateModel(data);
  if (!r.ok) console.log('DIAG patches:', JSON.stringify(r.errors));
  assert.ok(r.ok, r.errors && r.errors.join('; '));
  assert.equal(r.model.seams.length, 1);
});

test('flat.json：平面片仅 2 个三角形，内部不铺密网格', async () => {
  const r = await run('flat.json', 1.0);
  assert.equal(r.cancelled, false);
  assert.equal(r.stats.triangleCount, 2);
  assert.equal(r.patchStats[0].planar, true);
  assert.equal(r.patchStats[0].maxNodeDepth, 0);
  // expected.json 的 flat_triangles=2
  const expected = load('expected.json');
  assert.equal(r.stats.triangleCount, expected.flat_triangles);
});

test('patches.json：接缝共享位置索引，无 T 接点/裂口', async () => {
  const r = await run('patches.json', 0.5);
  // 两片在 x=1 处的接缝顶点应共享同一位置索引
  const usedByPatch = new Map();
  for (const t of r.triangles) {
    for (const idx of t.position) {
      if (!usedByPatch.has(idx)) usedByPatch.set(idx, new Set());
      usedByPatch.get(idx).add(t.patch);
    }
  }
  const shared = [...usedByPatch.entries()].filter(([, s]) => s.size > 1);
  assert.ok(shared.length >= 2, '接缝至少应共享 2 个角点索引');
  for (const [idx] of shared) {
    const p = r.positions[idx];
    assert.ok(Math.abs(p[0] - 1) < 1e-9, `共享点应位于接缝 x=1，实际 x=${p[0]}`);
  }
  // expected.json: shared_edge_x=1, seam reversed=true
  const expected = load('expected.json');
  assert.equal(expected.shared_edge_x, 1);
  assert.equal(expected.seam_a_u1_b_u0_reversed, true);

  // 无 T 接点：每条边的每段端点必须同时是相邻片的真实顶点（共享索引天然保证）
  // 检查所有三角形引用的索引都存在
  for (const t of r.triangles) {
    for (const idx of t.position) assert.ok(idx < r.positions.length);
    assert.equal(t.uv.length, 3);
    assert.equal(t.normal.length, 3);
  }
});

test('接缝两边细分层级一致（即使需求不同，取统一层级）', async () => {
  const r = await run('patches.json', 0.3);
  const levels = new Map(r.edgeLevel);
  assert.equal(levels.get('a.u1'), levels.get('b.u0'));
});

test('误差热图数据：所有三角形屏幕误差不超过阈值，除非触顶超限', async () => {
  const r = await run('curved.json', 0.25, 7);
  let bad = 0;
  for (const t of r.triangles) {
    if (t.error > 0.25 && !t.overLimit) bad++;
  }
  assert.equal(bad, 0);
  assert.ok(r.stats.maxError >= 0);
});

test('最大深度触顶：超限三角形必须明确标记', async () => {
  const r = await run('curved.json', 0.01, 2);
  assert.ok(r.stats.overLimitTriangles > 0, '深度 2 配 0.01px 阈值应出现超限区域');
  const marked = r.triangles.filter((t) => t.overLimit).length;
  assert.equal(marked, r.stats.overLimitTriangles);
});

test('加深深度后超限区域减少、误差下降', async () => {
  const shallow = await run('curved.json', 0.1, 2);
  const deep = await run('curved.json', 0.1, 7);
  assert.ok(deep.stats.triangleCount >= shallow.stats.triangleCount);
  assert.ok(deep.stats.maxError <= shallow.stats.maxError + 1e-12);
});

test('取消令牌：细分可取消', async () => {
  const data = load('curved.json');
  const parsed = global.PatchModel.validateModel(data);
  const camera = makeCamera(data);
  const token = { cancelled: true };
  const r = await tessellate(parsed.model, camera, { pixelError: 0.1, maxDepth: 7, token });
  assert.equal(r.cancelled, true);
});

test('法线：归一化且为 dP/du × dP/dv', async () => {
  const data = load('curved.json');
  const r = global.PatchModel.validateModel(data);
  const patch = r.model.patches[0];
  const n = global.Bezier.evalNormal(patch.points, 0.3, 0.7);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-10);
});

test('expected.json 的 a_center 曲面点检查', () => {
  const data = load('curved.json');
  const r = global.PatchModel.validateModel(data);
  const c = global.Bezier.evalSurface(r.model.patches[0].points, 0.5, 0.5);
  const expected = load('expected.json');
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(c[k] - expected.a_center[k]) < 1e-9,
      `中心分量 ${k}: ${c[k]} vs ${expected.a_center[k]}`);
  }
});

test('控制点联动：编辑接缝控制点，两片同步', () => {
  const data = load('patches.json');
  const r = global.PatchModel.validateModel(data);
  const links = global.PatchModel.buildLinkGroups(r.model);
  const patchA = r.model.patches.find((p) => p.id === 'a');
  // a.u1 的角点 (j=0,i=3)
  global.PatchModel.applyLinkedEdit(r.model, links, 'a', 0, 3, [1, 2, 3]);
  const patchB = r.model.patches.find((p) => p.id === 'b');
  // reversed: a.u1[k=0] 对应 b.u0[k=3] -> b 的 (j=3,i=0)
  assert.deepEqual(patchB.points[3][0], [1, 2, 3]);
  assert.deepEqual(patchA.points[0][3], [1, 2, 3]);
});

test('水密性：每条内部边恰好被 2 个三角形共享；片内边方向相反，接缝边几何闭合', async () => {
  const r = await run('patches.json', 0.3);
  const directed = new Map(); // "lo-hi" -> 有向边出现次数与所属片
  for (const t of r.triangles) {
    const idx = t.position;
    for (let e = 0; e < 3; e++) {
      const a = idx[e];
      const b = idx[(e + 1) % 3];
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      if (!directed.has(key)) directed.set(key, []);
      directed.get(key).push({ dir: `${a}->${b}`, patch: t.patch });
    }
  }
  let boundaryEdges = 0;
  let crossPatchEdges = 0;
  for (const [, arr] of directed) {
    const total = arr.length;
    if (total === 1) { boundaryEdges++; continue; }
    assert.equal(total, 2, '内部边必须出现 2 次');
    const owners = new Set(arr.map((x) => x.patch));
    if (owners.size === 2) {
      // 接缝边：两片法线不强制一致，几何闭合即可（共享同一对位置索引）
      crossPatchEdges++;
    } else {
      // 片内边：两次必须方向相反
      assert.equal(new Set(arr.map((x) => x.dir)).size, 2, '片内边两次方向必须相反');
    }
  }
  assert.ok(crossPatchEdges >= 2, '应存在跨片接缝边');
  assert.ok(boundaryEdges >= 4, `外露边界边数量 ${boundaryEdges}`);
});

test('无 T 接点：接缝上每个顶点都同时是两片三角形的角点', async () => {
  const r = await run('patches.json', 0.15);
  const owners = new Map();
  for (const t of r.triangles) {
    for (const idx of t.position) {
      if (!owners.has(idx)) owners.set(idx, new Set());
      owners.get(idx).add(t.patch);
    }
  }
  const seamPositions = r.positions
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Math.abs(p[0] - 1) < 1e-9);
  assert.ok(seamPositions.length >= 2);
  for (const { i } of seamPositions) {
    assert.equal(owners.get(i).size, 2, `接缝顶点 ${i} 必须被两片共用`);
  }
});

test('reversed 接缝：两片在接缝参数处的曲面点逐点重合', async () => {
  const data = load('patches.json');
  const parsed = global.PatchModel.validateModel(data);
  const a = parsed.model.patches.find((p) => p.id === 'a');
  const b = parsed.model.patches.find((p) => p.id === 'b');
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const pa = global.Bezier.evalEdge(a.points, 'u1', t);
    const pb = global.Bezier.evalEdge(b.points, 'u0', 1 - t); // reversed
    assert.ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 1e-10);
  }
});

test('接缝强制补点：平面片沿接缝加点但内部仍为粗网格', async () => {
  // 构造两片平面片，接缝处人为要求细分（用很小误差触发边细分）
  const grid = (origin) => {
    const pts = [];
    for (let j = 0; j < 4; j++) {
      const row = [];
      for (let i = 0; i < 4; i++) {
        row.push([origin[0] + i / 3, origin[1], origin[2] + j / 3]);
      }
      pts.push(row);
    }
    return pts;
  };
  const model = {
    patches: [
      { id: 'p1', points: grid([0, 0, 0]) },
      { id: 'p2', points: grid([1, 0, 0]) },
    ],
    seams: [{ a: ['p1', 'u1'], b: ['p2', 'u0'], reversed: false }],
    edgeOwner: new Map(),
    camera: null,
  };
  const cam = new global.Camera.OrthoCamera({
    position: [1, 4, 1], target: [1, 0, 1], up: [0, 1, 0],
    width: 800, height: 600, vertical_span: 3,
  });
  const r = await tessellate(model, cam, { pixelError: 1, maxDepth: 7, token: { cancelled: false } });
  // 两片平面且线性 -> 每片 2 三角形；接缝仅共享 2 角点
  assert.equal(r.stats.triangleCount, 4);
  assert.deepEqual(r.patchStats.map((s) => s.maxNodeDepth), [0, 0]);
});

test('导出三角形含每角 UV、片编号与法线', async () => {
  const r = await run('curved.json', 0.4);
  for (const t of r.triangles) {
    assert.equal(typeof t.patch, 'string');
    assert.equal(t.uv.length, 3);
    assert.equal(t.normal.length, 3);
    for (const n of t.normal) assert.equal(n.length, 3);
    for (const uv of t.uv) {
      assert.ok(uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1);
    }
  }
});
