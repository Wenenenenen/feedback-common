/*
 * mesh.js — 索引网格校验、拓扑构建与边分类
 *
 * 边严格按位置索引构建（不做坐标焊接）：
 *   关联 1 个面 -> 边界边 boundary
 *   关联 2 个面：正面状态不同 -> 轮廓边 silhouette；
 *               两面法线夹角 >= 折痕阈值 -> 折痕边 crease
 *   关联 >2 个面 -> 非流形边 nonmanifold（标记并保留）
 * 一条边可同时携带多种类型。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});
  const M = HLM.math;

  function edgeKey(a, b) {
    return a < b ? a * 0x100000 + b : b * 0x100000 + a;
  }

  /**
   * 解析并校验网格。
   * 返回 { positions, faces, edges, warnings, errors }
   * faces:  { id, verts:[i0,i1,i2], normal:[...], center:[...], front, degenerate }
   * edges:  { id, a, b, key, faceIds:[...], types:{boundary,crease,silhouette,nonmanifold} }
   */
  function buildMesh(data, camera, creaseDegrees) {
    const warnings = [];
    const errors = [];
    const positions = data.positions;

    if (!Array.isArray(positions) || positions.length < 3) {
      errors.push('positions 缺失或顶点数少于 3');
    }
    if (!Array.isArray(data.triangles) || data.triangles.length === 0) {
      errors.push('triangles 缺失或为空');
    }
    if (errors.length) return { positions: positions || [], faces: [], edges: [], warnings, errors };

    const nV = positions.length;
    for (const t of data.triangles) {
      if (!Array.isArray(t) || t.length !== 3 ||
          !Number.isInteger(t[0]) || !Number.isInteger(t[1]) || !Number.isInteger(t[2])) {
        errors.push(`非法三角形（必须为 3 个整数索引）: ${JSON.stringify(t)}`);
        continue;
      }
      if (t.some(i => i < 0 || i >= nV)) {
        errors.push(`顶点索引越界（合法范围 0..${nV - 1}）: ${JSON.stringify(t)}`);
      }
    }
    if (errors.length) return { positions, faces: [], edges: [], warnings, errors };

    const faces = [];
    const edgeMap = new Map();
    const edgeList = [];

    function getEdge(a, b, faceId) {
      const k = edgeKey(a, b);
      let e = edgeMap.get(k);
      if (!e) {
        e = {
          id: edgeList.length, key: k,
          a: Math.min(a, b), b: Math.max(a, b),
          faceIds: [],
          types: { boundary: false, crease: false, silhouette: false, nonmanifold: false },
        };
        edgeMap.set(k, e);
        edgeList.push(e);
      }
      e.faceIds.push(faceId);
      return e;
    }

    data.triangles.forEach((t, id) => {
      const [i0, i1, i2] = t;
      const p0 = positions[i0], p1 = positions[i1], p2 = positions[i2];
      const normal = M.faceNormal(p0, p1, p2);
      const degenerate = M.length(M.cross(M.sub(p1, p0), M.sub(p2, p0))) <= 1e-20;
      if (degenerate) warnings.push(`三角形 #${id} 退化（零面积），已跳过其拓扑与遮挡`);
      const center = M.scale(M.add(M.add(p0, p1), p2), 1 / 3);

      const front = isFront(camera, normal, center);
      const face = { id, verts: [i0, i1, i2], normal, center, front, degenerate };
      faces.push(face);

      if (!degenerate) {
        getEdge(i0, i1, id);
        getEdge(i1, i2, id);
        getEdge(i2, i0, id);
      }
    });

    const creaseCos = Math.cos(M.deg2rad(HLM.math.clamp(creaseDegrees, 0, 180)));
    for (const e of edgeList) classifyEdge(e, faces, creaseCos);

    return { positions, faces, edges: edgeList, warnings, errors };
  }

  /** 正面判定：正交看法线与 -forward；透视看法线与（相机-面心）方向 */
  function isFront(camera, normal, center) {
    if (camera.type === 'orthographic') {
      return M.dot(normal, M.scale(camera.forward, -1)) > 1e-10;
    }
    return M.dot(normal, M.sub(camera.origin, center)) > 1e-10;
  }

  function classifyEdge(e, faces, creaseCos) {
    const incident = e.faceIds.map(id => faces[id]);
    if (incident.length === 1) {
      e.types.boundary = true;
      return;
    }
    if (incident.length > 2) {
      e.types.nonmanifold = true;
      // 非流形边仍尽量给出轮廓/折痕信息，供显示参考
      for (let i = 0; i < incident.length; i++) {
        for (let j = i + 1; j < incident.length; j++) {
          const f = incident[i], g = incident[j];
          if (f.front !== g.front) e.types.silhouette = true;
          if (M.dot(f.normal, g.normal) <= creaseCos) e.types.crease = true;
        }
      }
      return;
    }
    const [f, g] = incident;
    if (f.front !== g.front) e.types.silhouette = true;
    // 法线夹角 >= 阈值  <=>  法线点积 <= cos(阈值)
    if (M.dot(f.normal, g.normal) <= creaseCos + 1e-12) e.types.crease = true;
  }

  function isFeatureEdge(e) {
    return e.types.boundary || e.types.crease ||
           e.types.silhouette || e.types.nonmanifold;
  }

  HLM.mesh = { buildMesh, isFeatureEdge, edgeKey };
})(typeof window !== 'undefined' ? window : globalThis);
