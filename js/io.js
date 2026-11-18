// 场景导入校验与导出。限制：≤10000 面，贴图 ≤512×512。
export const MAX_FACES = 10000;
export const MAX_TEX = 512;

function isFiniteVec(arr, n) {
  return Array.isArray(arr) && arr.length === n && arr.every((x) => Number.isFinite(x));
}

// 校验并规范化场景 JSON（样例包格式或本工具导出格式均可）
// 返回 { mesh, instance, normalMapName, pngDataUrl, expected }
export function parseScene(json) {
  if (json && json.format === 'tangent-frame-auditor/v1') {
    return {
      mesh: validateMesh(json),
      instance: validateInstance(json.instance),
      normalMapName: json.normalMap ? json.normalMap.name : null,
      pngDataUrl: json.normalMap ? json.normalMap.pngDataUrl : null,
      expected: json.corners || null,
      expectedInstanced: json.instanced || null,
    };
  }
  if (!json || !Array.isArray(json.positions) || !Array.isArray(json.faces)) {
    throw new Error('场景 JSON 需要 positions 与 faces 数组');
  }
  return {
    mesh: validateMesh(json),
    instance: json.instance ? validateInstance(json.instance) : null,
    normalMapName: typeof json.normal_map === 'string' ? json.normal_map : null,
    pngDataUrl: null,
    expected: null,
    expectedInstanced: null,
  };
}

function validateMesh(json) {
  const positions = json.positions;
  const faces = json.faces;
  if (faces.length > MAX_FACES) throw new Error(`面数 ${faces.length} 超过上限 ${MAX_FACES}`);
  positions.forEach((p, i) => {
    if (!isFiniteVec(p, 3)) throw new Error(`positions[${i}] 不是有限三维向量`);
  });
  faces.forEach((f, fi) => {
    if (!Array.isArray(f.v) || f.v.length !== 3 || !f.v.every((i) => Number.isInteger(i) && i >= 0 && i < positions.length)) {
      throw new Error(`面 ${fi}：v 必须是三个合法位置索引`);
    }
    if (!Array.isArray(f.uv) || f.uv.length !== 3 || !f.uv.every((uv) => isFiniteVec(uv, 2))) {
      throw new Error(`面 ${fi}：uv 必须是三个有限二维值`);
    }
    if (!Array.isArray(f.n) || f.n.length !== 3 || !f.n.every((n) => isFiniteVec(n, 3))) {
      throw new Error(`面 ${fi}：n 必须是三个有限三维向量`);
    }
    f.n.forEach((n, ci) => {
      if (Math.hypot(n[0], n[1], n[2]) <= 1e-12) {
        throw new Error(`面 ${fi} 角 ${ci}：法线为零向量，不符合"法线必须非零"的约定`);
      }
    });
  });
  return {
    positions: positions.map((p) => p.slice()),
    faces: faces.map((f) => ({ v: f.v.slice(), uv: f.uv.map((u) => u.slice()), n: f.n.map((n) => n.slice()) })),
  };
}

function validateInstance(m) {
  if (!Array.isArray(m) || m.length !== 16 || !m.every((x) => Number.isFinite(x))) {
    throw new Error('实例矩阵必须是 16 个有限数（行主序 4×4）');
  }
  return m.slice();
}

export function checkTextureSize(w, h) {
  if (w > MAX_TEX || h > MAX_TEX) throw new Error(`贴图 ${w}×${h} 超过上限 ${MAX_TEX}×${MAX_TEX}`);
}

// 组装导出 JSON（含 PNG 数据，重新导入可复现）
export function buildExport({ mesh, normalMap, instance, corners, instanced, diagnostics }) {
  return {
    format: 'tangent-frame-auditor/v1',
    positions: mesh.positions,
    faces: mesh.faces,
    normalMap: normalMap
      ? { name: normalMap.name, width: normalMap.width, height: normalMap.height, pngDataUrl: normalMap.pngDataUrl }
      : null,
    instance,
    corners: corners.map((c) => ({
      face: c.face,
      corner: c.corner,
      T: c.T,
      B: c.B,
      N: c.N,
      h: c.h,
      fallback: c.fallback,
      uvDet: c.uvDet,
    })),
    instanced: instanced.map((f) => ({ T: f.T, B: f.B, N: f.N, h: f.h })),
    diagnostics,
  };
}

// 复现校验：重新计算结果与导入文件中保存的结果对比
export function verifyReproduction(expected, actual, eps = 1e-6) {
  if (!expected || expected.length !== actual.length) {
    return { ok: false, detail: `角数量不一致（文件 ${expected ? expected.length : 0} vs 重算 ${actual.length}）` };
  }
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i], a = actual[i];
    if (e.h !== a.h) return { ok: false, detail: `面${a.face ?? i}角${a.corner ?? i}：手性 ${a.h} ≠ 文件中的 ${e.h}` };
    for (const k of ['T', 'B', 'N']) {
      for (let j = 0; j < 3; j++) {
        worst = Math.max(worst, Math.abs(e[k][j] - a[k][j]));
      }
    }
  }
  return worst <= eps
    ? { ok: true, detail: `复现校验通过（最大分量误差 ${worst.toExponential(2)}）` }
    : { ok: false, detail: `复现校验失败：最大分量误差 ${worst.toExponential(2)} > ${eps}` };
}
