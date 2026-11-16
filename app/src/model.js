/* 模型解析与校验：结构检查、接缝 1e-8 重合校验、控制点联动、平面检测 */
(function (global) {
  'use strict';

  const { v3 } = global.Math3D;
  const { edgeControlPoints, EDGES } = global.Bezier;

  const SEAM_TOL = 1e-8;
  const MAX_PATCHES = 16;

  function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  /* 仅做结构解析；接缝重合性在 validateSeams 中单独处理，便于定位边 */
  function validateStructure(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { errors: ['根节点必须是 JSON 对象'] };
    }
    if (!Array.isArray(data.patches)) {
      return { errors: ['缺少 patches 数组'] };
    }
    if (data.patches.length === 0) errors.push('patches 不能为空');
    if (data.patches.length > MAX_PATCHES) {
      errors.push(`曲面片数量 ${data.patches.length} 超过上限 ${MAX_PATCHES}`);
    }

    const ids = new Set();
    const normalized = [];
    data.patches.forEach((patch, pi) => {
      const label = patch && patch.id != null ? String(patch.id) : `#${pi}`;
      if (!patch || typeof patch !== 'object') {
        errors.push(`片 ${label} 不是对象`);
        return;
      }
      if (patch.id == null || String(patch.id) === '') {
        errors.push(`第 ${pi} 片缺少 id`);
      } else if (ids.has(String(patch.id))) {
        errors.push(`片 id 重复: ${label}`);
      } else {
        ids.add(String(patch.id));
      }
      const pts = patch.points;
      if (!Array.isArray(pts) || pts.length !== 4) {
        errors.push(`片 ${label} 的 points 必须是 4 行`);
      } else {
        const points = [];
        for (let j = 0; j < 4; j++) {
          if (!Array.isArray(pts[j]) || pts[j].length !== 4) {
            errors.push(`片 ${label} 的 points[${j}] 必须含 4 个控制点`);
            continue;
          }
          const row = [];
          for (let i = 0; i < 4; i++) {
            const c = pts[j][i];
            if (!Array.isArray(c) || c.length !== 3 || !c.every(isNum)) {
              errors.push(`片 ${label} 的 points[${j}][${i}] 必须是 3 个有限数 [x,y,z]`);
              row.push([0, 0, 0]);
            } else {
              row.push([c[0], c[1], c[2]]);
            }
          }
          points.push(row);
        }
        normalized.push({ id: String(patch.id), points });
      }
    });

    // 接缝结构
    const seams = [];
    if (data.seams != null && !Array.isArray(data.seams)) {
      errors.push('seams 必须是数组');
    } else if (Array.isArray(data.seams)) {
      data.seams.forEach((s, si) => {
        if (!s || !Array.isArray(s.a) || !Array.isArray(s.b) ||
            s.a.length !== 2 || s.b.length !== 2) {
          errors.push(`seams[${si}] 必须含 a、b 两个 [片id, 边名] 引用`);
          return;
        }
        const a = [String(s.a[0]), String(s.a[1])];
        const b = [String(s.b[0]), String(s.b[1])];
        if (!EDGES.includes(a[1])) errors.push(`seams[${si}] 的边名非法: ${a[1]}`);
        if (!EDGES.includes(b[1])) errors.push(`seams[${si}] 的边名非法: ${b[1]}`);
        seams.push({ a, b, reversed: !!s.reversed });
      });
    }

    // 相机
    let camera = null;
    const cam = data.camera;
    if (cam && typeof cam === 'object') {
      const vec = (name, dflt) =>
        Array.isArray(cam[name]) && cam[name].length === 3 && cam[name].every(isNum)
          ? [cam[name][0], cam[name][1], cam[name][2]] : dflt;
      camera = {
        position: vec('position', [3, 3, 4]),
        target: vec('target', [0, 0, 0]),
        up: vec('up', [0, 1, 0]),
        width: isNum(cam.width) ? cam.width : 800,
        height: isNum(cam.height) ? cam.height : 600,
        vertical_span: isNum(cam.vertical_span) ? cam.vertical_span : 3,
      };
    }

    return { errors, normalized, seams, ids, camera };
  }

  /* 校验引用与边占用，并逐项检查接缝控制点 1e-8 重合；返回带定位的全部问题 */
  function validateSeams(normalized, ids, seams) {
    const errors = [];
    const byId = new Map(normalized.map((p) => [p.id, p]));
    const edgeOwner = new Map();
    const result = [];

    seams.forEach((s, si) => {
      const [pa, ea] = s.a;
      const [pb, eb] = s.b;
      const loc = `seams[${si}] (${pa}.${ea} ↔ ${pb}.${eb}${s.reversed ? ', reversed' : ''})`;
      if (!ids.has(pa)) { errors.push(`${loc}: 片 ${pa} 不存在`); return; }
      if (!ids.has(pb)) { errors.push(`${loc}: 片 ${pb} 不存在`); return; }
      for (const [pid, edge] of [[pa, ea], [pb, eb]]) {
        const key = `${pid}.${edge}`;
        if (edgeOwner.has(key)) {
          errors.push(`${loc}: 边 ${key} 已被 seams[${edgeOwner.get(key)}] 占用，一条边只能属于一条接缝`);
        } else {
          edgeOwner.set(key, si);
        }
      }

      const cpA = edgeControlPoints(byId.get(pa).points, ea);
      const cpB = edgeControlPoints(byId.get(pb).points, eb);
      const worst = { index: -1, dist: -1 };
      for (let k = 0; k < 4; k++) {
        const kb = s.reversed ? 3 - k : k;
        const d = v3.dist(cpA[k], cpB[kb]);
        if (d > SEAM_TOL) {
          if (d > worst.dist) worst.dist = d, worst.index = k;
        }
      }
      if (worst.index >= 0) {
        const kb = s.reversed ? 3 - worst.index : worst.index;
        errors.push(
          `${loc}: 接缝不重合 — 第 ${worst.index} 对控制点距离 ${worst.dist.toExponential(3)} ` +
          `超过容差 1e-8（${pa}.${ea}[${worst.index}]=[${cpA[worst.index].map((n) => n.toFixed(6)).join(', ')}] ` +
          `vs ${pb}.${eb}[${kb}]=[${cpB[kb].map((n) => n.toFixed(6)).join(', ')}]）`
        );
      } else {
        result.push(s);
      }
    });

    return { errors, seams: result, edgeOwner };
  }

  function validateModel(data) {
    const structural = validateStructure(data);
    if (structural.errors.length || !structural.normalized || structural.normalized.length === 0) {
      return { ok: false, errors: structural.errors };
    }
    const seamCheck = validateSeams(structural.normalized, structural.ids, structural.seams);
    const errors = structural.errors.concat(seamCheck.errors);
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      model: {
        patches: structural.normalized,
        seams: seamCheck.seams,
        edgeOwner: seamCheck.edgeOwner,
        camera: structural.camera,
      },
    };
  }

  /* 平面检测：所有控制点共面（含退化情形） */
  function isPlanar(points) {
    const p0 = points[0][0];
    let normal = null;
    for (let j = 0; j < 4 && !normal; j++) {
      for (let i = 0; i < 4 && !normal; i++) {
        for (const [j2, i2] of [[j, i + 1], [j + 1, i]]) {
          if (j2 > 3 || i2 > 3) continue;
          const n = v3.cross(v3.sub(points[j][i], p0), v3.sub(points[j2][i2], p0));
          if (v3.len(n) > 1e-9) { normal = v3.norm(n); }
        }
      }
    }
    if (!normal) return true; // 全部共线/重合，视为平面
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        if (Math.abs(v3.dot(v3.sub(points[j][i], p0), normal)) > 1e-7) return false;
      }
    }
    return true;
  }

  /* 构造 (片id, 边, 控制点序号) 的联动组：接缝两边逐项配对（含 reversed） */
  function buildLinkGroups(model) {
    const groups = [];
    const memberToGroup = new Map();
    model.seams.forEach((s) => {
      const pair = [];
      for (let k = 0; k < 4; k++) {
        const kb = s.reversed ? 3 - k : k;
        pair.push([
          { patch: s.a[0], edge: s.a[1], index: k },
          { patch: s.b[0], edge: s.b[1], index: kb },
        ]);
      }
      pair.forEach((members, k) => {
        const gi = groups.length;
        groups.push(members);
        members.forEach((m) => memberToGroup.set(`${m.patch}.${m.edge}.${m.index}`, gi));
      });
    });
    return { groups, memberToGroup };
  }

  /* 边上控制点序号 -> 控制点网格 (j,i) */
  function edgeIndexToGrid(edge, k) {
    switch (edge) {
      case 'u0': return [k, 0];
      case 'u1': return [k, 3];
      case 'v0': return [0, k];
      case 'v1': return [3, k];
      default: throw new Error('未知边名: ' + edge);
    }
  }

  /* 编辑一个控制点后，联动同一接缝组的其它控制点 */
  function applyLinkedEdit(model, linkGroups, patchId, j, i, newXYZ) {
    const patch = model.patches.find((p) => p.id === patchId);
    patch.points[j][i] = [newXYZ[0], newXYZ[1], newXYZ[2]];
    // 找到该网格点所属的边成员（角点可能属于两条边，各自成组，都要联动）
    for (const edge of EDGES) {
      const cp = edgeControlPoints(patch.points, edge);
      for (let k = 0; k < 4; k++) {
        if (cp[k] === patch.points[j][i] || sameGrid(edge, k, j, i)) {
          const gi = linkGroups.memberToGroup.get(`${patchId}.${edge}.${k}`);
          if (gi == null) continue;
          for (const m of linkGroups.groups[gi]) {
            if (m.patch === patchId && m.edge === edge && m.index === k) continue;
            const target = model.patches.find((p) => p.id === m.patch);
            const [tj, ti] = edgeIndexToGrid(m.edge, m.index);
            target.points[tj][ti] = [newXYZ[0], newXYZ[1], newXYZ[2]];
          }
        }
      }
    }
  }

  function sameGrid(edge, k, j, i) {
    const [gj, gi] = edgeIndexToGrid(edge, k);
    return gj === j && gi === i;
  }

  function cloneModel(model) {
    return {
      patches: model.patches.map((p) => ({
        id: p.id,
        points: p.points.map((row) => row.map((c) => [c[0], c[1], c[2]])),
      })),
      seams: model.seams.map((s) => ({ a: [...s.a], b: [...s.b], reversed: s.reversed })),
      edgeOwner: new Map(model.edgeOwner),
      camera: model.camera ? JSON.parse(JSON.stringify(model.camera)) : null,
    };
  }

  const api = {
    SEAM_TOL,
    MAX_PATCHES,
    validateModel,
    validateStructure,
    validateSeams,
    isPlanar,
    buildLinkGroups,
    edgeIndexToGrid,
    applyLinkedEdit,
    cloneModel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PatchModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
