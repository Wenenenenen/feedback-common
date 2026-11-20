// 独立解析导出的 OBJ 与叶块 JSON，验证模型可用性（流形、绕序、字段、邻接一致）
// 用法: node tests/check-export.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveTerrain } from '../web/js/terrain.js';
import { exportOBJ, exportLeavesJSON } from '../web/js/exporter.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, '..', 'samples', 'extracted', 'ridge.json'), 'utf8'));
const result = solveTerrain(sample);
const objText = exportOBJ(result);
const json = exportLeavesJSON(result);

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, d); } };

// ---- 解析 OBJ ----
const verts = [];
const faces = [];
for (const line of objText.split('\n')) {
  if (line.startsWith('v ')) verts.push(line.slice(2).trim().split(/\s+/).map(Number));
  else if (line.startsWith('f ')) faces.push(line.slice(2).trim().split(/\s+/).map((t) => Number(t) - 1));
}
check('OBJ 顶点数与求解器一致', verts.length === result.mesh.vertexCount, `${verts.length} vs ${result.mesh.vertexCount}`);
check('OBJ 面数与求解器一致', faces.length === result.mesh.triangleCount);
check('OBJ 全部为三角形', faces.every((f) => f.length === 3));
check('OBJ 索引在合法范围', faces.every((f) => f.every((i) => i >= 0 && i < verts.length)));

// 边流形：每条边 1 或 2 个面；无退化；法线朝上（允许水平 ny≈0）
const edgeUse = new Map();
let degenerate = 0, downward = 0;
for (const [a, b, c] of faces) {
  const A = verts[a], B = verts[b], C = verts[c];
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  if (area2 < 1e-12) degenerate++;
  if (uz * vx - ux * vz < -1e-9) downward++;
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const k = p < q ? p + '|' + q : q + '|' + p;
    edgeUse.set(k, (edgeUse.get(k) || 0) + 1);
  }
}
check('OBJ 无退化面', degenerate === 0, `degenerate=${degenerate}`);
check('OBJ 绕序统一朝上', downward === 0, `downward=${downward}`);
const badEdges = [...edgeUse.values()].filter((n) => n !== 1 && n !== 2).length;
check('OBJ 每条边仅 1（边界）或 2（内部）个面', badEdges === 0, `bad=${badEdges}`);
// 边界边必须落在高度场外轮廓
const N = result.size;
let boundaryOffBorder = 0;
for (const [k, n] of edgeUse) {
  if (n !== 1) continue;
  const [i, j] = k.split('|').map(Number);
  for (const id of [i, j]) {
    const [x, , z] = verts[id];
    if (!(Math.abs(x) < 1e-9 || Math.abs(z) < 1e-9 || Math.abs(x - N) < 1e-9 || Math.abs(z - N) < 1e-9)) {
      boundaryOffBorder++; break;
    }
  }
}
check('OBJ 单边（边界）均位于高度场外轮廓', boundaryOffBorder === 0);

// ---- 解析叶块 JSON ----
check('JSON leafCount 一致', json.leafCount === result.mesh.leafList.length);
const required = ['x', 'z', 'size', 'E', 'D', 'screenError', 'source', 'splitReason', 'neighbors'];
check('JSON 每块含必需字段', json.leaves.every((l) => required.every((k) => k in l)));
check('JSON 叶块完整铺满且无重叠', (() => {
  const cells = new Set();
  for (const l of json.leaves) for (let z = l.z; z < l.z + l.size; z++) for (let x = l.x; x < l.x + l.size; x++) {
    const k = x + ',' + z; if (cells.has(k)) return false; cells.add(k);
  }
  return cells.size === N * N;
})());
// 邻接对称：A 视 B 为邻居，则 B 也视 A 为邻居
let asym = 0;
const byKey = new Map(json.leaves.map((l) => [`${l.x},${l.z},${l.size}`, l]));
for (const l of json.leaves) {
  for (const side of [0, 1, 2, 3]) {
    for (const nb of (l.neighbors[side] || [])) {
      const other = byKey.get(`${nb.x},${nb.z},${nb.s}`);
      if (!other) { asym++; continue; }
      const back = [0, 1, 2, 3].some((bs) => (other.neighbors[bs] || []).some((o) => o.x === l.x && o.z === l.z && o.s === l.size));
      if (!back) asym++;
    }
  }
}
check('JSON 邻接关系双向对称', asym === 0, `asymmetric=${asym}`);
// 层级差
let ratioBad = 0;
for (const l of json.leaves) for (const side of [0, 1, 2, 3]) for (const nb of (l.neighbors[side] || [])) {
  if (Math.max(l.size, nb.s) / Math.min(l.size, nb.s) > 2) ratioBad++;
}
check('JSON 相邻块尺寸比 ≤ 2', ratioBad === 0);

writeFileSync('/tmp/export-check.obj', objText);
writeFileSync('/tmp/export-check-leaves.json', JSON.stringify(json));
console.log(`\n导出校验: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
