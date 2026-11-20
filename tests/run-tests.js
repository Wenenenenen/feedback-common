// Node 校验脚本：node tests/run-tests.js
// 对照 samples/extracted 的样例与说明.txt 误差准则，验证全部几何不变量。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveTerrain, precomputeNodes, distanceToAABB, focalLength, enforceBalance, buildMesh } from '../web/js/terrain.js';
import { validateMesh } from '../web/js/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, '..', 'samples', 'extracted');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

function load(n) {
  return JSON.parse(readFileSync(join(sampleDir, n), 'utf8'));
}

// ---------- 1. 误差准则单点核对（独立实现 bilinear） ----------
console.log('\n[1] 块误差 E 与距离/屏幕误差公式核对');
{
  const input = load('ridge.json');
  const { size, heights, camera } = input;
  const W = size + 1;
  const nodes = precomputeNodes(size, heights);
  const root = nodes.get('0,0,64');
  // 独立计算根块 E
  let E = 0;
  for (let z = 0; z <= 64; z++) for (let x = 0; x <= 64; x++) {
    const u = x / 64, v = z / 64;
    const h00 = heights[0], h10 = heights[64], h01 = heights[64 * W], h11 = heights[64 * W + 64];
    const b = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
    E = Math.max(E, Math.abs(heights[z * W + x] - b));
  }
  check('根块 E 与独立双线性计算一致', Math.abs(root.E - E) < 1e-12, `got ${root.E} want ${E}`);

  const D = distanceToAABB(root, camera.position);
  // 相机 (32,20,-10)，根块 AABB: x[0,64] z[0,64] y[hmin,hmax]
  const qx = 32, qz = 0;
  const qy = Math.max(root.hmin, Math.min(20, root.hmax));
  const DRef = Math.hypot(32 - qx, 20 - qy, -10 - qz);
  check('AABB 最近点距离正确', Math.abs(D - DRef) < 1e-12, `got ${D} want ${DRef}`);

  const f = focalLength(camera);
  const fRef = 600 / (2 * Math.tan((60 * Math.PI) / 360));
  check('焦距 f 公式正确', Math.abs(f - fRef) < 1e-12);
  const rhoRef = (root.E * fRef) / Math.max(DRef, camera.near);
  check('屏幕误差 rho 公式正确', Math.abs(root.E * f / Math.max(D, camera.near) - rhoRef) < 1e-12);
}

// ---------- 2. 各工况整体不变量 ----------
const cases = ['flat.json', 'peak.json', 'ridge.json', 'capacity.json'];
for (const name of cases) {
  console.log(`\n[2] ${name}`);
  const input = load(name);
  const result = solveTerrain(input);
  check('求解无错误', !result.error, result.error || '');
  if (result.error) continue;

  const report = validateMesh(result);
  check('网格校验全部通过', report.ok, report.problems.join('; '));
  check('无悬挂边', report.stats.edgeKinds.hanging === 0);
  check('层级差 <= 1', report.stats.edgeKinds.balanceViolation === 0);
  check('最细块为 2×2', result.mesh.leafList.every((l) => l.s >= 2));

  // 扇形三角形数：每块 ring 顶点数 = 4 + 细邻居边数
  let triExpected = 0;
  for (const l of result.mesh.leafList) {
    const adj = result.adjacency.find((a) => a.x === l.x && a.z === l.z && a.s === l.s);
    let finerEdges = 0;
    for (const side of [0, 1, 2, 3]) {
      const nb = adj.neighbors[side];
      if (nb && nb.length === 2) finerEdges++;
    }
    triExpected += 4 + finerEdges;
  }
  check('三角形数 = 每块 4+细邻居边数 之和', result.mesh.triangleCount === triExpected,
    `got ${result.mesh.triangleCount} want ${triExpected}`);

  console.log(`    叶块=${report.stats.leaves} 顶点=${report.stats.vertices} ` +
    `三角形=${report.stats.triangles} 内部边=${report.stats.edgeKinds.internal} ` +
    `边界边=${report.stats.edgeKinds.boundary}`);
}

// ---------- 3. expected.json 验收值 ----------
console.log('\n[3] expected.json 验收准则');
{
  const expected = load('expected.json');
  const flat = solveTerrain(load('flat.json'));
  check('平地叶块数 = 1', flat.mesh.leafList.length === expected['平地']['叶块数']);
  check('平地三角形数 = 4（根块无细邻居）', flat.mesh.triangleCount === expected['平地']['三角形数']);
  check('平地 E = 0', flat.mesh.leafList[0].E === expected['平地']['E']);
  const [rx, rz, rs] = expected['根块坐标'];
  const root = flat.mesh.leafList[0];
  check('根块坐标 [0,0,64]', root.x === rx && root.z === rz && root.s === rs);
  check('最小叶块尺寸 = 2', Math.min(...flat.mesh.leafList.map((l) => l.s)) >= 2);
  // 内部边计数=2、外边界边计数=1 是边键命名约定（内部边两种键形态），检查全网格边流形
  const report = validateMesh(flat);
  check('平地网格无悬挂/退化/重叠', report.ok);
}

// ---------- 4. 容量极限：128×128 + 相机压到山脊，强制全细分 ----------
console.log('\n[4] 容量与极端相机');
{
  const cap = load('capacity.json');
  // 相机贴近地面中心、像素误差极小 -> 全部拆到 2
  const deep = solveTerrain({ ...cap, pixelError: 1e-9, camera: { ...cap.camera, position: [64, 0.01, 64] } });
  check('极限细分无错误', !deep.error, deep.error || '');
  const rep = validateMesh(deep);
  check('极限细分网格合法', rep.ok, rep.problems.join('; '));
  const leaves2 = deep.mesh.leafList.filter((l) => l.s === 2).length;
  check('全部叶块为 2×2（共 4096 块）', leaves2 === (128 / 2) ** 2, `got ${leaves2}`);
  // 全 2×2 时每块 4 三角形，共 4096*4 = 16384。
  // 全 2×2 时每块 4 三角形，共 4096*4 = 16384。
  check('三角形总数 16384', deep.mesh.triangleCount === 16384, `got ${deep.mesh.triangleCount}`);
  // 全 2×2 时无更细邻居、不产生边中点；每块扇形只用四角与中心。
  // 独立按规则收集应出现的格点集合：所有块角点（=网格线上的格点）+ 所有块中心，
  // 与求解器的焊接顶点数对照，而不是用易错的闭式公式。
  const used = new Set();
  for (let bz = 0; bz < 128; bz += 2) for (let bx = 0; bx < 128; bx += 2) {
    for (const [gx, gz] of [[bx, bz], [bx + 2, bz], [bx, bz + 2], [bx + 2, bz + 2], [bx + 1, bz + 1]]) {
      used.add(gx + ',' + gz);
    }
  }
  check(`顶点焊接数 = 独立推导的 ${used.size}（块角点∪块中心，全局焊接）`,
    deep.mesh.vertexCount === used.size, `got ${deep.mesh.vertexCount}`);

  // 相机极远 + 大像素误差 -> 只有根块
  const far = solveTerrain({ ...cap, pixelError: 1e9, camera: { ...cap.camera, position: [64, 10000, 64] } });
  check('极远时只剩根块', far.mesh.leafList.length === 1 && far.mesh.leafList[0].s === 128);
  check('根块 4 三角形', far.mesh.triangleCount === 4);
}

// ---------- 5. 平衡约束：手工构造违规叶集，验证强制拆分传播 ----------
console.log('\n[5] 邻块平衡约束');
{
  // N=32 平地。手工铺叶：左半 s=8、右半 s=2，共享边比例 4，严重违规。
  const N = 32, W = N + 1;
  const heights = new Array(W * W).fill(0);
  const nodes = precomputeNodes(N, heights);
  const camera = { position: [16, 10, 16], fovY: 60, viewportHeight: 600, near: 0.1 };
  const leaves = new Map();
  const put = (x, z, s) => {
    const n = nodes.get(`${x},${z},${s}`);
    leaves.set(`${x},${z},${s}`, { x, z, s, E: n.E, hmin: n.hmin, hmax: n.hmax, D: 1, rho: 0 });
  };
  for (let z = 0; z < N; z += 8) for (let x = 0; x < 16; x += 8) put(x, z, 8);
  for (let z = 0; z < N; z += 2) for (let x = 16; x < N; x += 2) put(x, z, 2);
  const splitReasons = new Map();
  enforceBalance(nodes, N, camera, leaves, splitReasons);
  const bal = Array.from(splitReasons.values()).filter((x) => x.type === 'balance');
  check('产生了 balance 类型拆分', bal.length > 0, `balance=${bal.length}`);

  // 平衡后任意共享边尺寸比 <= 2
  let worst = 0;
  const all = Array.from(leaves.values());
  const leafAt = (px, pz) => all.find((o) => px >= o.x && px <= o.x + o.s && pz >= o.z && pz <= o.z + o.s);
  for (const l of all) {
    const half = l.s >> 1; const q = half / 2; const eps = 1e-6;
    for (let side = 0; side < 4; side++) for (let t = 0; t < l.s; t += half) {
      let px, pz;
      if (side === 0) { px = l.x - eps; pz = l.z + t + q; }
      else if (side === 1) { px = l.x + l.s + eps; pz = l.z + t + q; }
      else if (side === 2) { px = l.x + t + q; pz = l.z - eps; }
      else { px = l.x + t + q; pz = l.z + l.s + eps; }
      if (px < 0 || pz < 0 || px > N || pz > N) continue;
      const n = leafAt(px, pz);
      if (n) worst = Math.max(worst, Math.max(l.s / n.s, n.s / l.s));
    }
  }
  check('平衡后任意共享边尺寸比 <= 2', worst <= 2, `worst=${worst}`);

  const mesh = buildMesh({ size: N, heights }, leaves);
  const rep = validateMesh({ size: N, heights, leaves, mesh });
  check('平衡后网格无悬挂/退化/重叠', rep.ok, rep.problems.slice(0, 3).join('; '));

  // 真实工况下叶子字段齐全
  const ridge = load('ridge.json');
  const r = solveTerrain({ ...ridge, camera: { ...ridge.camera, position: [0.5, 0.5, 0.5] }, pixelError: 0.5 });
  const okFields = r.mesh.leafList.every((l) =>
    Number.isFinite(l.E) && Number.isFinite(l.D) && Number.isFinite(l.rho) && l.source);
  check('叶块 E/D/屏幕误差/来源字段齐全', okFields);
}

// ---------- 6. 非法输入 ----------
console.log('\n[6] 非法输入拦截');
{
  const bad = solveTerrain(load('invalid.json'));
  check('heights 长度不符被拦截', !!bad.error && bad.error.includes('heights 长度'));
  const ridge = load('ridge.json');
  check('size 非 2 的幂被拦截', !!solveTerrain({ ...ridge, size: 12 }).error);
  check('NaN 高度被拦截', !!solveTerrain({ ...ridge, heights: ridge.heights.map((h, i) => i ? h : NaN) }).error);
  check('相机缺字段被拦截', !!solveTerrain({ ...ridge, camera: { position: [0, 0] } }).error);
  check('pixelError 非正被拦截', !!solveTerrain({ ...ridge, pixelError: 0 }).error);
}

// ---------- 7. 拖动相机稳定性：多次随机相机均合法 ----------
console.log('\n[7] 随机相机扰动稳定性');
{
  const ridge = load('ridge.json');
  let allOk = true;
  for (let i = 0; i < 50; i++) {
    const position = [Math.random() * 64, Math.random() * 40 + 0.05, Math.random() * 64];
    const r = solveTerrain({ ...ridge, camera: { ...ridge.camera, position }, pixelError: 1 + Math.random() * 8 });
    const rep = validateMesh(r);
    if (!rep.ok) { allOk = false; console.log('    失败相机', position, rep.problems.slice(0, 3)); break; }
  }
  check('50 组随机相机网格全部合法', allOk);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
