// OBJ / JSON 导出。数据全部来自 sweep.js 的 buildSweep，预览与导出同源。
import { v3 } from './sweep.js';

const f3 = (x) => {
  // 足够精度，去掉无意义的 -0
  const s = Math.abs(x) < 1e-15 ? 0 : x;
  return s.toFixed(9);
};

// 返回 OBJ 文本。法线与顶点一一对应（侧面平滑法线 + 端盖平面法线）。
export function toOBJ(r, name = 'parallel-transport-sweep') {
  const lines = [];
  lines.push(`# ${name}`);
  lines.push(`# rings=${r.n} profileVertices=${r.m} closed=${r.closed} caps=${r.caps}`);
  lines.push(`# side vertices: ${r.sideVerts.length}, cap vertices: ${r.capVerts.length}`);

  // 顶点：先侧面后端盖
  for (const p of r.sideVerts) lines.push(`v ${f3(p[0])} ${f3(p[1])} ${f3(p[2])}`);
  for (const p of r.capVerts) lines.push(`v ${f3(p[0])} ${f3(p[1])} ${f3(p[2])}`);

  // 法线：侧面平滑法线 + 端盖恒定法线（OBJ 法线索引与顶点索引平行排列）
  for (const nn of r.sideNormals) lines.push(`vn ${f3(nn[0])} ${f3(nn[1])} ${f3(nn[2])}`);
  for (const nn of r.capNormals) lines.push(`vn ${f3(nn[0])} ${f3(nn[1])} ${f3(nn[2])}`);

  // OBJ 索引从 1 开始；侧面三角形直接用 1-based 索引，法线索引与顶点相同
  lines.push('g side');
  for (const tri of r.sideTris) {
    const a = tri[0] + 1, b = tri[1] + 1, c = tri[2] + 1;
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }

  if (r.capTris.length) {
    const base = r.sideVerts.length; // 端盖全局偏移
    lines.push('g caps');
    for (const tri of r.capTris) {
      const a = base + tri[0] + 1;
      const b = base + tri[1] + 1;
      const c = base + tri[2] + 1;
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  }
  return lines.join('\n') + '\n';
}

// 记录标架、环及索引的 JSON
export function toJSON(r, input) {
  const capOffset = r.sideVerts.length;
  return {
    format: 'parallel-transport-sweep/1',
    input: {
      points: input.points,
      radii: input.radii,
      profile: input.profile,
      closed: r.closed,
      twist: input.twist,
      caps: r.caps,
    },
    arcLength: r.arcLength,
    seamTwist: r.seamTwist,
    frames: r.tangents.map((t, i) => ({
      index: i,
      arcLength: r.s[i],
      point: r.rings[i][0] && input.points[i],
      tangent: t,
      normal: r.ringNormals[i],
      binormal: r.ringBinormals[i],
      twistAngle: r.ringTwistAngles[i],
    })),
    rings: r.rings,
    side: {
      vertexCount: r.sideVerts.length,
      vertices: r.sideVerts,
      normals: r.sideNormals,
      // 环 i 的第 j 个截面点对应顶点索引 i*m + j（闭合时 i 取模）
      ringStride: r.m,
      triangles: r.sideTris,
    },
    caps: r.capTris.length ? {
      vertexCount: r.capVerts.length,
      indexOffset: capOffset,
      vertices: r.capVerts,
      normals: r.capNormals,
      triangles: r.capTris.map((tri) => tri.map((k) => k + capOffset)),
    } : null,
    diagnostics: {
      frameJumps: r.diagnostics.frameJumps,
      zeroSegments: r.diagnostics.zeroSegments,
      degenerateFaces: r.diagnostics.degenerateFaces,
      selfIntersectingFaces: r.diagnostics.selfIntersectingFaces,
      seamTwistDeg: r.diagnostics.seamTwistDeg,
    },
  };
}

// 浏览器下载（沙箱外可用；artifact 查看器里 download 可能被拦截，UI 另有提示）
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
