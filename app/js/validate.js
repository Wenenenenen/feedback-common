/* validate.js — SPEC §2 合法性校验。返回 { ok, errors:[{field, message}] }。 */
'use strict';
window.VF = window.VF || {};

VF.validateInput = (data) => {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const isFin = (x) => typeof x === 'number' && Number.isFinite(x);
  const isInt = (x) => Number.isInteger(x);

  if (!data || typeof data !== 'object') {
    return { ok: false, errors: [{ field: '(root)', message: '输入不是有效的 JSON 对象' }] };
  }

  // ---- 网格参数 ----
  const g = data.grid;
  if (!g || typeof g !== 'object') {
    fail('grid', '缺少 grid 对象');
  } else {
    const { dims, spacing, origin } = g;
    if (!Array.isArray(dims) || dims.length !== 3) {
      fail('grid.dims', 'dims 必须是长度 3 的数组');
    } else if (!dims.every(isInt) || !dims.every((n) => n >= 1 && n <= 96)) {
      fail('grid.dims', `dims 三个整数必须都在 [1, 96] 内，实际 [${dims && dims.join(', ')}]`);
    }
    if (!Array.isArray(spacing) || spacing.length !== 3) {
      fail('grid.spacing', 'spacing 必须是长度 3 的数组');
    } else if (!spacing.every(isFin) || !spacing.every((s) => s > 0)) {
      fail('grid.spacing', `spacing 必须为严格大于 0 的有限浮点数，实际 [${spacing && spacing.join(', ')}]`);
    }
    if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(isFin)) {
      fail('grid.origin', 'origin 必须是三个有限浮点数');
    }
  }

  // ---- 模式参数 ----
  if (data.separatingMode !== '6-separating' && data.separatingMode !== '26-separating') {
    fail('separatingMode', `只能取 "6-separating" 或 "26-separating"，实际 ${JSON.stringify(data.separatingMode)}`);
  }
  if (data.floodConnectivity !== 6 && data.floodConnectivity !== 26) {
    fail('floodConnectivity', `只能取 6 或 26，实际 ${JSON.stringify(data.floodConnectivity)}`);
  }

  // ---- 顶点 ----
  const verts = data.vertices;
  if (!Array.isArray(verts)) {
    fail('vertices', 'vertices 必须是数组');
  } else {
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isFin)) {
        fail(`vertices[${i}]`, '顶点必须是三个有限浮点数');
      }
    }
  }

  // ---- 三角形 ----
  const tris = data.triangles;
  if (!Array.isArray(tris)) {
    fail('triangles', 'triangles 必须是数组');
  } else {
    if (tris.length > 10000) {
      fail('triangles', `三角形数量 ${tris.length} 超过上限 10000`);
    }
    const nv = Array.isArray(verts) ? verts.length : 0;
    const seenIds = new Set();
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      const label = `triangle${tri && tri.id !== undefined ? ' id=' + tri.id : ' [' + t + ']'}`;
      if (!tri || typeof tri !== 'object') { fail(label, '不是对象'); continue; }
      if (!isInt(tri.id)) fail(`${label}`, 'id 必须是整数');
      else if (seenIds.has(tri.id)) fail(`${label}`, `id=${tri.id} 重复`);
      else seenIds.add(tri.id);

      if (!Array.isArray(tri.indices) || tri.indices.length !== 3) {
        fail(`${label}`, 'indices 必须是长度 3 的数组');
      } else {
        for (const idx of tri.indices) {
          if (!isInt(idx) || idx < 0 || idx >= nv) {
            fail(`${label}`, `索引 ${idx} 越界（顶点数 ${nv}，合法范围 [0, ${nv - 1}]）`);
          }
        }
      }
      if (!isInt(tri.material) || tri.material < 1 || tri.material > 16) {
        fail(`${label}`, `material 必须是 [1, 16] 的整数，实际 ${tri.material}`);
      }
      if (typeof tri.group !== 'string' || tri.group.length === 0) {
        fail(`${label}`, 'group 必须是非空字符串');
      }
      if (typeof tri.enabled !== 'boolean') {
        fail(`${label}`, 'enabled 必须是布尔值');
      }
      // 零面积退化面（索引合法时才计算）
      if (Array.isArray(tri.indices) && tri.indices.length === 3 &&
          tri.indices.every((idx) => isInt(idx) && idx >= 0 && idx < nv)) {
        const [i0, i1, i2] = tri.indices;
        const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
        const e0 = VF.sub3(v1, v0);
        const e1 = VF.sub3(v2, v0);
        const cr = VF.cross3(e0, e1);
        const area = 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
        if (!(area > 1e-10)) {
          fail(`${label}`, `零面积退化面：物理空间面积 ${area.toExponential(2)} ≤ 1e-10`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
};
