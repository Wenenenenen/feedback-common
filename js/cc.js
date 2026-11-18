/*
 * cc.js — 带折痕的 Catmull-Clark 细分核心库。
 * 环境无关：浏览器里挂到 window.CC，Node 里通过 module.exports 导出。
 * 不依赖任何几何库。
 *
 * 网格约定（见 samples/格式说明.md）：
 *   {"vertices":[[x,y,z],...],"faces":[[i,j,k,...],...],"creases":[{"edge":[i,j],"sharpness":s},...]}
 */
(function (global) {
  'use strict';

  const MAX_FACES = 2000;

  function edgeKey(a, b) { return a < b ? a + ',' + b : b + ',' + a; }

  // ---------------------------------------------------------------- 导入校验

  /**
   * 校验并解析网格 JSON。
   * 返回 { errors:[], warnings:[], mesh|null }
   * mesh = { positions:[[x,y,z]...], faces:[[i..]...], edgeSharp:Map(key->s) }
   */
  function validateMesh(data) {
    const errors = [];
    const warnings = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { errors: ['文件内容不是 JSON 对象'], warnings, mesh: null };
    }

    // 顶点
    const rawVerts = data.vertices;
    if (!Array.isArray(rawVerts) || rawVerts.length === 0) {
      errors.push('vertices 缺失或为空');
    }
    const positions = [];
    if (Array.isArray(rawVerts)) {
      rawVerts.forEach((v, i) => {
        if (!Array.isArray(v) || v.length !== 3 || v.some(c => typeof c !== 'number' || !isFinite(c))) {
          errors.push(`顶点 ${i} 不是 [x,y,z] 数值数组`);
        } else {
          positions.push([v[0], v[1], v[2]]);
        }
      });
    }
    const nv = positions.length;

    // 面
    const rawFaces = data.faces;
    if (!Array.isArray(rawFaces) || rawFaces.length === 0) {
      errors.push('faces 缺失或为空');
    }
    const faces = [];
    if (Array.isArray(rawFaces)) {
      if (rawFaces.length > MAX_FACES) {
        errors.push(`面数 ${rawFaces.length} 超过上限 ${MAX_FACES}`);
      }
      rawFaces.forEach((f, fi) => {
        if (!Array.isArray(f)) { errors.push(`面 ${fi} 不是数组`); return; }
        if (f.length < 3) { errors.push(`面 ${fi} 顶点数 ${f.length} 少于 3`); return; }
        let ok = true;
        const seen = new Set();
        f.forEach(idx => {
          if (!Number.isInteger(idx) || idx < 0 || idx >= nv) {
            errors.push(`面 ${fi} 含越界索引 ${idx}（顶点数 ${nv}）`);
            ok = false;
          } else if (seen.has(idx)) {
            errors.push(`面 ${fi} 含重复顶点索引 ${idx}`);
            ok = false;
          } else {
            seen.add(idx);
          }
        });
        if (ok) faces.push(f.slice());
      });
    }

    // 折痕
    const edgeSharp = new Map();
    const rawCreases = data.creases;
    if (rawCreases !== undefined) {
      if (!Array.isArray(rawCreases)) {
        errors.push('creases 不是数组');
      } else {
        rawCreases.forEach((c, ci) => {
          if (!c || !Array.isArray(c.edge) || c.edge.length !== 2) {
            errors.push(`折痕 ${ci} 缺少 edge:[i,j]`);
            return;
          }
          const [a, b] = c.edge;
          const s = c.sharpness;
          if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= nv || b >= nv) {
            errors.push(`折痕 ${ci} 的边 [${a},${b}] 索引越界`);
            return;
          }
          if (a === b) { errors.push(`折痕 ${ci} 的边两端相同（${a}）`); return; }
          if (typeof s !== 'number' || !isFinite(s) || s < 0) {
            errors.push(`折痕 ${ci} 的锐度 ${s} 非法（需为 ≥0 的数）`);
            return;
          }
          edgeSharp.set(edgeKey(a, b), s);
        });
      }
    }

    if (errors.length > 0) return { errors, warnings, mesh: null };

    // 结构检查（警告级别）
    const edges = buildEdges(faces);
    edges.forEach(e => {
      if (e.faces.length > 2) {
        warnings.push(`非流形边 [${e.a}, ${e.b}]：被 ${e.faces.length} 个面共用`);
      }
    });
    // 折痕边必须真实存在
    edgeSharp.forEach((s, key) => {
      if (!edges.has(key)) {
        warnings.push(`折痕边 [${key.replace(',', ', ')}] 在网格中不存在，已忽略`);
        edgeSharp.delete(key);
      }
    });
    // 孤立顶点
    const used = new Set();
    faces.forEach(f => f.forEach(i => used.add(i)));
    for (let i = 0; i < nv; i++) {
      if (!used.has(i)) warnings.push(`顶点 ${i} 不属于任何面（孤立顶点，细分时保持不动）`);
    }

    return { errors, warnings, mesh: { positions, faces, edgeSharp } };
  }

  // ---------------------------------------------------------------- 拓扑

  /** 由面列表建立边表：Map(key -> {a,b,faces:[],sharp:0}) */
  function buildEdges(faces) {
    const edges = new Map();
    faces.forEach((f, fi) => {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        if (a === b) continue;
        const key = edgeKey(a, b);
        let e = edges.get(key);
        if (!e) {
          e = { a: Math.min(a, b), b: Math.max(a, b), faces: [], sharp: 0 };
          edges.set(key, e);
        }
        if (e.faces[e.faces.length - 1] !== fi && !e.faces.includes(fi)) e.faces.push(fi);
      }
    });
    return edges;
  }

  /** 顶点邻接：vFaces[i]=相邻面列表，vEdges[i]=相连边列表 */
  function vertexAdjacency(numVerts, faces, edges) {
    const vFaces = Array.from({ length: numVerts }, () => []);
    faces.forEach((f, fi) => f.forEach(v => { if (!vFaces[v].includes(fi)) vFaces[v].push(fi); }));
    const vEdges = Array.from({ length: numVerts }, () => []);
    edges.forEach(e => { vEdges[e.a].push(e); vEdges[e.b].push(e); });
    return { vFaces, vEdges };
  }

  /** 带锐度的完整拓扑：level 网格对象 {positions, faces, edges, provenance?} */
  function buildLevel(positions, faces, edgeSharp) {
    const edges = buildEdges(faces);
    if (edgeSharp) {
      edgeSharp.forEach((s, key) => {
        const e = edges.get(key);
        if (e && s > 0) e.sharp = s;
      });
    }
    return { positions, faces, edges };
  }

  // ---------------------------------------------------------------- 细分

  /**
   * 细分一级。输入/输出均为 level 网格对象。
   * 输出带 provenance：与 positions 等长的数组，每项
   *   { type:'face'|'edge'|'vertex', rule:'smooth'|'crease'|'corner'|'boundary'|'blend', ...来源细节 }
   */
  function subdivideLevel(mesh) {
    const P = mesh.positions, faces = mesh.faces, edges = mesh.edges;
    const nv = P.length;
    const { vFaces, vEdges } = vertexAdjacency(nv, faces, edges);

    // 1. 面点：面上各顶点的平均
    const facePts = faces.map(f => {
      const acc = [0, 0, 0];
      f.forEach(i => { acc[0] += P[i][0]; acc[1] += P[i][1]; acc[2] += P[i][2]; });
      return [acc[0] / f.length, acc[1] / f.length, acc[2] / f.length];
    });

    // 2. 边点
    const edgeList = Array.from(edges.values());
    const edgeIndex = new Map();
    edgeList.forEach((e, i) => edgeIndex.set(edgeKey(e.a, e.b), i));
    const edgePts = new Array(edgeList.length);
    const edgeProv = new Array(edgeList.length);
    edgeList.forEach((e, i) => {
      const a = P[e.a], b = P[e.b];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const src = { edge: [e.a, e.b], sharpness: e.sharp, faceCount: e.faces.length };
      if (e.faces.length !== 2) {
        // 开放边界边（1 个面）或非流形边（>2 个面）：取中点，保证共享唯一边点、不产生裂缝
        edgePts[i] = mid;
        edgeProv[i] = {
          type: 'edge', rule: 'boundary', source: src,
          note: e.faces.length > 2 ? '非流形边，按中点处理' : '开放边界边，取中点'
        };
      } else if (e.sharp >= 1) {
        edgePts[i] = mid;
        edgeProv[i] = { type: 'edge', rule: 'crease', source: src, note: `锐度 ${e.sharp} ≥ 1，取中点` };
      } else {
        const f1 = facePts[e.faces[0]], f2 = facePts[e.faces[1]];
        const smooth = [
          (a[0] + b[0] + f1[0] + f2[0]) / 4,
          (a[1] + b[1] + f1[1] + f2[1]) / 4,
          (a[2] + b[2] + f1[2] + f2[2]) / 4
        ];
        if (e.sharp > 0) {
          edgePts[i] = lerp3(smooth, mid, e.sharp);
          edgeProv[i] = {
            type: 'edge', rule: 'blend', source: src,
            note: `锐度 ${e.sharp}：光滑结果与中点按 (${(1 - e.sharp).toFixed(3)}, ${e.sharp}) 混合`
          };
        } else {
          edgePts[i] = smooth;
          edgeProv[i] = { type: 'edge', rule: 'smooth', source: src, note: '两端点与两侧面点的平均' };
        }
      }
    });

    // 3. 顶点
    const vertPts = new Array(nv);
    const vertProv = new Array(nv);
    for (let i = 0; i < nv; i++) {
      const p = P[i];
      const myEdges = vEdges[i];
      if (myEdges.length === 0) {
        vertPts[i] = p.slice();
        vertProv[i] = { type: 'vertex', rule: 'smooth', source: { vertex: i }, note: '孤立顶点，保持不动' };
        continue;
      }
      // 边界/非流形边（锐度视为无穷大）
      const bnd = myEdges.filter(e => e.faces.length !== 2);
      if (bnd.length > 0) {
        if (vFaces[i].length <= 1) {
          vertPts[i] = p.slice();
          vertProv[i] = { type: 'vertex', rule: 'boundary', source: { vertex: i }, note: '只属于一个面的边界顶点，保持原位置' };
        } else if (bnd.length === 2) {
          const A = P[bnd[0].a === i ? bnd[0].b : bnd[0].a];
          const B = P[bnd[1].a === i ? bnd[1].b : bnd[1].a];
          vertPts[i] = [
            (6 * p[0] + A[0] + B[0]) / 8,
            (6 * p[1] + A[1] + B[1]) / 8,
            (6 * p[2] + A[2] + B[2]) / 8
          ];
          vertProv[i] = {
            type: 'vertex', rule: 'boundary',
            source: { vertex: i, boundaryNeighbors: [bnd[0].a === i ? bnd[0].b : bnd[0].a, bnd[1].a === i ? bnd[1].b : bnd[1].a] },
            note: '开放边界顶点，按两条边界边做折痕规则 (6P+A+B)/8'
          };
        } else {
          vertPts[i] = p.slice();
          vertProv[i] = { type: 'vertex', rule: 'corner', source: { vertex: i }, note: `${bnd.length} 条边界/非流形边交汇，按角点保持原位置` };
        }
        continue;
      }
      // 内部顶点
      const creases = myEdges.filter(e => e.sharp > 0);
      const c = creases.length;
      const n = myEdges.length;
      // 光滑规则：(F + 2R + (n-3)P) / n
      const F = [0, 0, 0];
      vFaces[i].forEach(fi => { const fp = facePts[fi]; F[0] += fp[0]; F[1] += fp[1]; F[2] += fp[2]; });
      F[0] /= vFaces[i].length; F[1] /= vFaces[i].length; F[2] /= vFaces[i].length;
      const R = [0, 0, 0];
      myEdges.forEach(e => {
        const q = P[e.a === i ? e.b : e.a];
        R[0] += (p[0] + q[0]) / 2; R[1] += (p[1] + q[1]) / 2; R[2] += (p[2] + q[2]) / 2;
      });
      R[0] /= n; R[1] /= n; R[2] /= n;
      const smooth = [
        (F[0] + 2 * R[0] + (n - 3) * p[0]) / n,
        (F[1] + 2 * R[1] + (n - 3) * p[1]) / n,
        (F[2] + 2 * R[2] + (n - 3) * p[2]) / n
      ];
      if (c <= 1) {
        vertPts[i] = smooth;
        vertProv[i] = { type: 'vertex', rule: 'smooth', source: { vertex: i, valence: n }, note: `内部光滑顶点，n=${n}` };
      } else {
        const sigma = creases.reduce((s, e) => s + e.sharp, 0) / c;
        let target, baseRule, targetNote;
        if (c === 2) {
          const A = P[creases[0].a === i ? creases[0].b : creases[0].a];
          const B = P[creases[1].a === i ? creases[1].b : creases[1].a];
          target = [
            (6 * p[0] + A[0] + B[0]) / 8,
            (6 * p[1] + A[1] + B[1]) / 8,
            (6 * p[2] + A[2] + B[2]) / 8
          ];
          baseRule = 'crease';
          targetNote = '折痕规则 (6P+A+B)/8';
        } else {
          target = p.slice();
          baseRule = 'corner';
          targetNote = `角点（${c} 条折痕边交汇），保持原位置`;
        }
        const src = { vertex: i, valence: n, creaseCount: c, sharpness: sigma };
        if (sigma >= 1) {
          vertPts[i] = target;
          vertProv[i] = { type: 'vertex', rule: baseRule, source: src, note: `顶点锐度 ${sigma} ≥ 1，完全按${targetNote}` };
        } else {
          vertPts[i] = lerp3(smooth, target, sigma);
          vertProv[i] = {
            type: 'vertex', rule: 'blend', source: src,
            note: `顶点锐度 ${sigma.toFixed(4)}：光滑规则与${targetNote}按 (${(1 - sigma).toFixed(3)}, ${sigma.toFixed(3)}) 混合`
          };
        }
      }
    }

    // 4. 组装新网格：顶点顺序 = [原顶点的新位置 | 边点 | 面点]
    const E0 = nv, F0 = nv + edgeList.length;
    const newPositions = vertPts.concat(edgePts, facePts);
    const provenance = vertProv.concat(edgeProv, faces.map((f, fi) => ({
      type: 'face', rule: 'smooth', source: { face: fi, arity: f.length }, note: `${f.length} 边形面点：各顶点平均`
    })));

    const newFaces = [];
    faces.forEach((f, fi) => {
      const m = f.length;
      for (let i = 0; i < m; i++) {
        const vi = f[i];
        const vNext = f[(i + 1) % m], vPrev = f[(i - 1 + m) % m];
        const eNext = E0 + edgeIndex.get(edgeKey(vi, vNext));
        const ePrev = E0 + edgeIndex.get(edgeKey(vi, vPrev));
        newFaces.push([vi, eNext, F0 + fi, ePrev]);
      }
    });

    // 5. 子边锐度：折痕边分出的两条子边锐度 max(0, s-1)，其余新边为 0
    const newEdges = buildEdges(newFaces);
    edgeList.forEach((e, ei) => {
      if (e.sharp > 0) {
        const child = Math.max(0, e.sharp - 1);
        const eIdx = E0 + ei;
        const k1 = edgeKey(e.a, eIdx), k2 = edgeKey(eIdx, e.b);
        const c1 = newEdges.get(k1), c2 = newEdges.get(k2);
        if (c1) c1.sharp = child;
        if (c2) c2.sharp = child;
      }
    });

    return { positions: newPositions, faces: newFaces, edges: newEdges, provenance };
  }

  function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /**
   * 由输入网格细分到 level 级，返回每一级（含第 0 级）的 level 网格对象数组。
   */
  function subdivideTo(mesh, level) {
    const levels = [buildLevel(mesh.positions, mesh.faces, mesh.edgeSharp)];
    for (let l = 1; l <= level; l++) {
      levels.push(subdivideLevel(levels[l - 1]));
    }
    return levels;
  }

  // ---------------------------------------------------------------- 统计

  function levelStats(level) {
    let boundary = 0;
    const nonManifold = [];
    level.edges.forEach(e => {
      if (e.faces.length === 1) boundary++;
      else if (e.faces.length > 2) nonManifold.push({ edge: [e.a, e.b], faceCount: e.faces.length });
    });
    let crease = 0;
    level.edges.forEach(e => { if (e.sharp > 0) crease++; });
    return {
      vertices: level.positions.length,
      faces: level.faces.length,
      edges: level.edges.size,
      boundaryEdges: boundary,
      creaseEdges: crease,
      nonManifoldEdges: nonManifold,
      euler: level.positions.length - level.edges.size + level.faces.length
    };
  }

  // ---------------------------------------------------------------- 导出

  /** OBJ 导出：顶点与面，面索引从 1 开始 */
  function exportOBJ(level, name) {
    const lines = [`# Catmull-Clark subdivision export`, `o ${name || 'subdivided'}`];
    level.positions.forEach(p => lines.push(`v ${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`));
    level.faces.forEach(f => lines.push('f ' + f.map(i => i + 1).join(' ')));
    return lines.join('\n') + '\n';
  }

  /** 顶点来源 JSON 导出 */
  function exportProvenance(level, levelIndex, meshName) {
    const stats = levelStats(level);
    const vertices = level.positions.map((p, i) => {
      const prov = level.provenance ? level.provenance[i] : { type: 'vertex', rule: 'original', source: { vertex: i }, note: '控制网格原始顶点' };
      return {
        index: i,
        position: p,
        type: prov.type,
        rule: prov.rule,
        source: prov.source,
        note: prov.note || ''
      };
    });
    return JSON.stringify({
      mesh: meshName || 'mesh',
      level: levelIndex,
      counts: { vertices: stats.vertices, faces: stats.faces, edges: stats.edges },
      nonManifoldEdges: stats.nonManifoldEdges,
      vertices,
      faces: level.faces
    }, null, 2);
  }

  function fmt(x) {
    // 紧凑且无损的数字格式
    return Number(x.toPrecision(12)).toString();
  }

  const CC = {
    MAX_FACES,
    edgeKey,
    validateMesh,
    buildEdges,
    buildLevel,
    subdivideLevel,
    subdivideTo,
    levelStats,
    exportOBJ,
    exportProvenance
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CC;
  else global.CC = CC;
})(typeof window !== 'undefined' ? window : globalThis);
