// 导出 OBJ（全局焊接顶点）与叶块/邻接 JSON
import { buildAdjacency } from './terrain.js';

/** 生成 OBJ 文本：v 顶点（焊接后天然去重）、f 1-based 索引 */
export function exportOBJ(result) {
  const { mesh } = result;
  const { positions, indices } = mesh;
  const lines = [
    '# Balanced terrain stitcher export',
    `# leaves=${mesh.leafList.length} vertices=${mesh.vertexCount} triangles=${mesh.triangleCount}`,
  ];
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(`v ${fmt(positions[i])} ${fmt(positions[i + 1])} ${fmt(positions[i + 2])}`);
  }
  for (let i = 0; i < indices.length; i += 3) {
    // 保持逆时针朝上绕序，OBJ 为 1-based
    lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
  }
  return lines.join('\n') + '\n';
}

function fmt(v) {
  const r = Math.round(v * 1e7) / 1e7;
  return Object.is(r, -0) ? '0' : String(r);
}

/** 叶块与邻接 JSON（含 x、z、size、E、D、屏幕误差、拆分来源） */
export function exportLeavesJSON(result) {
  const { mesh, splitReasons, size, pixelError, camera } = result;
  const adjacency = buildAdjacency(new Map(mesh.leafList.map((l) => [`${l.x},${l.z},${l.s}`, l])), size);
  const adjMap = new Map(adjacency.map((a) => [`${a.x},${a.z},${a.s}`, a.neighbors]));

  const leaves = mesh.leafList.map((l) => {
    const reason = splitReasons.get(`${l.x},${l.z},${l.s}`);
    return {
      x: l.x,
      z: l.z,
      size: l.s,
      E: l.E,
      D: l.D,
      screenError: l.rho,
      source: l.source, // root | kept | error | balance
      splitReason: reason || null,
      neighbors: adjMap.get(`${l.x},${l.z},${l.s}`),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    heightfield: { size },
    camera,
    pixelError,
    leafCount: leaves.length,
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
    // side 编号: 0=左(-x) 1=右(+x) 2=上(-z) 3=下(+z)；null=域外
    sideLegend: { 0: '-x', 1: '+x', 2: '-z', 3: '+z' },
    leaves,
  };
}

/** 浏览器端触发下载 */
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
