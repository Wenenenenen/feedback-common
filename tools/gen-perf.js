/* 满额测试场景生成器：N×N×N 规则栅格切成 5 个四面体/立方体，最多 2048 单元、12000 面。 */
'use strict';

function generateFull(nx, ny, nz, facesPerCellHint) {
  const rest = [];
  const index = new Map();
  const vid = (i, j, k) => {
    const key = i + ',' + j + ',' + k;
    if (!index.has(key)) {
      index.set(key, rest.length);
      rest.push([i * 4, j * 4, k * 4]);
    }
    return index.get(key);
  };
  // 立方体 8 角点
  const corners = (i, j, k) => [
    vid(i, j, k), vid(i + 1, j, k), vid(i + 1, j + 1, k), vid(i, j + 1, k),
    vid(i, j, k + 1), vid(i + 1, j, k + 1), vid(i + 1, j + 1, k + 1), vid(i, j + 1, k + 1),
  ];
  // 6 个四面体绕体对角线 (角点0→角点6) 剖分立方体，彼此共享含该对角线的三角面
  const TETS6 = [
    [0, 6, 1, 2],
    [0, 6, 2, 3],
    [0, 6, 3, 7],
    [0, 6, 7, 4],
    [0, 6, 4, 5],
    [0, 6, 5, 1],
  ];
  const cells = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const c = corners(i, j, k);
        for (const t of TETS6) cells.push(t.map(q => c[q]));
      }

  // 随机但确定性的三角形：在栅格内部取整数点，保证落在笼内
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (m) => Math.floor(rand() * m);
  const spanX = nx * 4, spanY = ny * 4, spanZ = nz * 4;
  const faces = [];
  const target = facesPerCellHint || 12000;
  let guard = 0;
  while (faces.length < target && guard++ < target * 10) {
    const cx = ri(spanX - 2) + 1, cy = ri(spanY - 2) + 1, cz = ri(Math.max(1, spanZ - 2)) + 1;
    const p = [
      [cx, cy, cz],
      [cx + 1, cy, cz],
      [cx, cy + 1, cz],
    ];
    if (cx + 1 >= spanX || cy + 1 >= spanY) continue;
    faces.push({
      p,
      n: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
    });
  }
  return { rules: 'perf', rest, pose: rest.map(q => [...q]), cells, faces };
}

function main() {
  const fs = require('fs');
  const path = require('path');
  // 完整网格：7×6×8 = 336 立方体 × 6 tet = 2016 单元（接近 2048 上限，拓扑完整合法）
  const data = generateFull(7, 6, 8, 12000);
  const out = path.join(__dirname, '..', 'samples', 'perf-full.json');
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`写出 ${out}: 顶点 ${data.rest.length}, 单元 ${data.cells.length}, 面 ${data.faces.length}`);
}

if (require.main === module) main();
module.exports = { generateFull };
