/*
 * instance-ray-bvh 核心库
 * 自实现两层 BVH（BLAS=共享网格级，TLAS=实例级）与射线求交。
 * 不依赖任何现成 Raycaster / BVH 库。浏览器挂 window.IRB，Node 可 require。
 *
 * 规则（来自样例包 说明.txt）：
 *  - 实例矩阵行主序，作用于列向量，末行必须为 [0,0,0,1]。
 *  - 射线在世界坐标，direction 非零，归一化后求交，t>=0 为世界米制距离。
 *  - 三角形双面可拾取；重心坐标按原 faces 顶点顺序。
 *  - 世界法线由变换后三个顶点叉积得到并单位化，不向射线翻转。
 *  - 先取所有命中的最小 t，在 [tmin, tmin+1e-7] 内按实例 id 字典序、原面号升序裁定唯一结果。
 *  - 未命中输出 null；奇异/非法实例排除但不使整个场景失败。
 *  - BLAS 按共享 mesh 只构建一次；仅改实例矩阵时只重建 TLAS。
 */
(function (global) {
  'use strict';

  const TIE_EPS = 1e-7;          // 等距裁定窗口
  const DET_EPS = 1e-12;         // 实例矩阵奇异阈值
  const TRI_DET_EPS = 1e-15;     // 射线与三角形平行阈值
  const LAST_ROW_EPS = 1e-9;     // 仿射末行容差
  const MAX_INSTANCES = 2000;
  const MAX_FACES_PER_MESH = 20000;
  const BLAS_LEAF_SIZE = 4;
  const TLAS_LEAF_SIZE = 2;

  // ---------------- 向量 ----------------
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vcross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vnormalize(a) {
    const l = vlen(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
  }

  // ---------------- 仿射矩阵（行主序 4x4） ----------------
  function isAffineLastRow(m) {
    return Math.abs(m[12]) <= LAST_ROW_EPS && Math.abs(m[13]) <= LAST_ROW_EPS &&
           Math.abs(m[14]) <= LAST_ROW_EPS && Math.abs(m[15] - 1) <= LAST_ROW_EPS;
  }

  // 求仿射矩阵逆；奇异/非有限返回 null
  function invertAffine(m) {
    const a = m[0], b = m[1], c = m[2],
          d = m[4], e = m[5], f = m[6],
          g = m[8], h = m[9], i = m[10];
    const c00 = e * i - f * h, c01 = -(d * i - f * g), c02 = d * h - e * g;
    const det = a * c00 + b * c01 + c * c02;
    if (!isFinite(det) || Math.abs(det) < DET_EPS) return null;
    const id = 1 / det;
    const c10 = -(b * i - c * h), c11 = a * i - c * g, c12 = -(a * h - b * g);
    const c20 = b * f - c * e, c21 = -(a * f - c * d), c22 = a * e - b * d;
    // inv3 = 伴随转置 / det
    const i00 = c00 * id, i01 = c10 * id, i02 = c20 * id;
    const i10 = c01 * id, i11 = c11 * id, i12 = c21 * id;
    const i20 = c02 * id, i21 = c12 * id, i22 = c22 * id;
    const tx = m[3], ty = m[7], tz = m[11];
    return {
      det,
      inv: [
        i00, i01, i02, -(i00 * tx + i01 * ty + i02 * tz),
        i10, i11, i12, -(i10 * tx + i11 * ty + i12 * tz),
        i20, i21, i22, -(i20 * tx + i21 * ty + i22 * tz),
        0, 0, 0, 1,
      ],
    };
  }

  function transformPoint(m, p) {
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ];
  }
  function transformDir(m, p) {
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2],
    ];
  }

  // ---------------- AABB ----------------
  function aabbEmpty() { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; }
  function aabbAddPoint(b, p) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < b.min[k]) b.min[k] = p[k];
      if (p[k] > b.max[k]) b.max[k] = p[k];
    }
  }
  function aabbAddBox(b, o) {
    aabbAddPoint(b, o.min); aabbAddPoint(b, o.max);
  }
  // 仿射变换后的世界 AABB（8 角点）
  function aabbTransform(m, b) {
    const out = aabbEmpty();
    for (let n = 0; n < 8; n++) {
      aabbAddPoint(out, transformPoint(m, [
        (n & 1) ? b.max[0] : b.min[0],
        (n & 2) ? b.max[1] : b.min[1],
        (n & 4) ? b.max[2] : b.min[2],
      ]));
    }
    return out;
  }

  // 射线-AABB（slab，对 0 方向分量安全），返回进入 t 或 null
  function rayAABB(o, d, min, max, tMax) {
    let t0 = 0, t1 = tMax;
    for (let k = 0; k < 3; k++) {
      if (d[k] === 0) {
        if (o[k] < min[k] || o[k] > max[k]) return null;
      } else {
        const inv = 1 / d[k];
        let ta = (min[k] - o[k]) * inv, tb = (max[k] - o[k]) * inv;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return null;
      }
    }
    return t0;
  }

  // ---------------- 三角形求交（Möller–Trumbore，双面） ----------------
  // 返回 {t,u,v}，u/v 为 v1/v2 权重；未命中返回 null
  function rayTriangle(o, d, v0, v1, v2) {
    const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
    const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < TRI_DET_EPS) return null; // 平行或退化三角形
    const inv = 1 / det;
    const tx = o[0] - v0[0], ty = o[1] - v0[1], tz = o[2] - v0[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 0) return null;
    return { t, u, v };
  }

  // ---------------- 通用 BVH 构建 ----------------
  // items: [{min:[3],max:[3]}]，返回 {nodes, order}
  // node: {min,max, left,right} 内部节点；叶子 {start,count, left:-1}
  function buildBVH(items, leafSize) {
    const n = items.length;
    const centroids = new Array(n);
    for (let i = 0; i < n; i++) {
      centroids[i] = [
        (items[i].min[0] + items[i].max[0]) / 2,
        (items[i].min[1] + items[i].max[1]) / 2,
        (items[i].min[2] + items[i].max[2]) / 2,
      ];
    }
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const nodes = [];

    function recurse(start, end) {
      const box = aabbEmpty();
      for (let i = start; i < end; i++) aabbAddBox(box, items[order[i]]);
      const nodeIndex = nodes.length;
      const count = end - start;
      if (count <= leafSize) {
        nodes.push({ min: box.min, max: box.max, left: -1, right: -1, start, count });
        return nodeIndex;
      }
      // 形心包围盒最长轴，中位划分
      const cbox = aabbEmpty();
      for (let i = start; i < end; i++) aabbAddPoint(cbox, centroids[order[i]]);
      const ext = [cbox.max[0] - cbox.min[0], cbox.max[1] - cbox.min[1], cbox.max[2] - cbox.min[2]];
      let axis = 0;
      if (ext[1] > ext[axis]) axis = 1;
      if (ext[2] > ext[axis]) axis = 2;
      if (ext[axis] === 0) {
        // 所有形心重合，无法划分，直接成叶
        nodes.push({ min: box.min, max: box.max, left: -1, right: -1, start, count });
        return nodeIndex;
      }
      const sub = order.slice(start, end).sort((a, b) => centroids[a][axis] - centroids[b][axis]);
      for (let i = 0; i < sub.length; i++) order[start + i] = sub[i];
      const mid = start + (count >> 1);
      nodes.push({ min: box.min, max: box.max, left: 0, right: 0, start: -1, count: 0 });
      const left = recurse(start, mid);
      const right = recurse(mid, end);
      nodes[nodeIndex].left = left;
      nodes[nodeIndex].right = right;
      return nodeIndex;
    }

    if (n > 0) recurse(0, n);
    return { nodes, order };
  }

  // ---------------- 场景 ----------------
  function createScene() {
    return {
      meshes: new Map(),   // name -> {name, vertices, faces, aabb, blas, blasBuilds}
      instances: [],       // {id, mesh, matrix, inv, valid, invalidReason, aabb}
      tlas: null,
      tlasItems: [],
      tlasBuilds: 0,
      revision: 0,         // 任何场景变更 +1（用于报告失效判定）
      errors: [],
    };
  }

  function validateMesh(name, def) {
    if (!def || !Array.isArray(def.vertices) || !Array.isArray(def.faces)) {
      return '网格 ' + name + ' 缺少 vertices/faces';
    }
    if (def.faces.length > MAX_FACES_PER_MESH) {
      return '网格 ' + name + ' 面数 ' + def.faces.length + ' 超过上限 ' + MAX_FACES_PER_MESH;
    }
    for (const f of def.faces) {
      if (!Array.isArray(f) || f.length !== 3) return '网格 ' + name + ' 存在非三角形面';
      for (const idx of f) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= def.vertices.length) {
          return '网格 ' + name + ' 面索引越界';
        }
      }
    }
    return null;
  }

  function buildMeshEntry(name, def) {
    const vertices = def.vertices;
    const faces = def.faces;
    const aabb = aabbEmpty();
    for (const v of vertices) aabbAddPoint(aabb, v);
    const items = faces.map((f) => {
      const b = aabbEmpty();
      aabbAddPoint(b, vertices[f[0]]); aabbAddPoint(b, vertices[f[1]]); aabbAddPoint(b, vertices[f[2]]);
      return b;
    });
    const blas = buildBVH(items, BLAS_LEAF_SIZE);
    return { name, vertices, faces, aabb, blas, blasBuilds: 1 };
  }

  // 校验并登记一个实例；返回错误信息或 null
  function validateInstance(inst) {
    if (!inst || typeof inst.id !== 'string' || inst.id.length === 0) return '实例缺少 id';
    if (!Array.isArray(inst.matrix) || inst.matrix.length !== 16) return '矩阵不是 16 元素数组';
    for (const x of inst.matrix) if (typeof x !== 'number' || !isFinite(x)) return '矩阵含非有限数值';
    if (!isAffineLastRow(inst.matrix)) return '矩阵末行不是 [0,0,0,1]（非仿射矩阵）';
    const r = invertAffine(inst.matrix);
    if (!r) return '矩阵奇异（行列式为 0），不可逆';
    return null;
  }

  function registerInstance(scene, inst) {
    const err = validateInstance(inst);
    const mesh = scene.meshes.get(inst.mesh);
    const entry = {
      id: inst.id,
      mesh: inst.mesh,
      matrix: inst.matrix.slice(),
      inv: null,
      valid: true,
      invalidReason: null,
      aabb: null,
    };
    if (err) {
      entry.valid = false;
      entry.invalidReason = err;
    } else if (!mesh) {
      entry.valid = false;
      entry.invalidReason = '引用了不存在的网格 ' + inst.mesh;
    } else {
      entry.inv = invertAffine(inst.matrix).inv;
      entry.aabb = aabbTransform(inst.matrix, mesh.aabb);
    }
    scene.instances.push(entry);
    return entry;
  }

  function rebuildTLAS(scene) {
    const items = [];
    const refs = [];
    for (const inst of scene.instances) {
      if (!inst.valid) continue;
      items.push(inst.aabb);
      refs.push(inst);
    }
    scene.tlas = buildBVH(items, TLAS_LEAF_SIZE);
    scene.tlasItems = refs; // tlas.order 索引到 refs
    scene.tlasBuilds++;
  }

  // 整体装载场景数据 {meshes, instances}
  function loadSceneData(scene, data) {
    scene.meshes.clear();
    scene.instances = [];
    scene.tlas = null;
    scene.tlasItems = [];
    scene.errors = [];
    const meshes = data.meshes || {};
    for (const name of Object.keys(meshes)) {
      const err = validateMesh(name, meshes[name]);
      if (err) { scene.errors.push(err); continue; }
      scene.meshes.set(name, buildMeshEntry(name, meshes[name]));
    }
    const list = data.instances || [];
    if (list.length > MAX_INSTANCES) {
      scene.errors.push('实例数 ' + list.length + ' 超过上限 ' + MAX_INSTANCES + '，已截断');
    }
    for (const inst of list.slice(0, MAX_INSTANCES)) registerInstance(scene, inst);
    rebuildTLAS(scene);
    scene.revision++;
    return scene;
  }

  // 仅更新一个实例的矩阵：只重建 TLAS，共享网格的 BLAS 不动
  function updateInstanceMatrix(scene, id, matrix) {
    const inst = scene.instances.find((x) => x.id === id);
    if (!inst) return '未找到实例 ' + id;
    const candidate = { id: inst.id, mesh: inst.mesh, matrix };
    const err = validateInstance(candidate);
    inst.matrix = matrix.slice();
    if (err) {
      inst.valid = false;
      inst.invalidReason = err;
      inst.inv = null;
      inst.aabb = null;
    } else {
      inst.valid = true;
      inst.invalidReason = null;
      inst.inv = invertAffine(matrix).inv;
      inst.aabb = aabbTransform(matrix, scene.meshes.get(inst.mesh).aabb);
    }
    rebuildTLAS(scene);
    scene.revision++;
    return null;
  }

  function sceneStats(scene) {
    const invalid = scene.instances.filter((i) => !i.valid);
    let blasBuilds = 0;
    for (const m of scene.meshes.values()) blasBuilds += m.blasBuilds;
    return {
      meshCount: scene.meshes.size,
      instanceCount: scene.instances.length,
      validInstances: scene.instances.length - invalid.length,
      invalidInstances: invalid.map((i) => ({ id: i.id, reason: i.invalidReason })),
      uniqueBlas: scene.meshes.size,
      blasBuilds,
      tlasBuilds: scene.tlasBuilds,
      revision: scene.revision,
    };
  }

  // 场景指纹：报告防冒用
  function sceneHash(scene) {
    const parts = [];
    for (const name of [...scene.meshes.keys()].sort()) {
      const m = scene.meshes.get(name);
      parts.push(name + ':' + m.vertices.length + '/' + m.faces.length);
    }
    for (const inst of scene.instances) {
      parts.push(inst.id + '=' + inst.matrix.join(','));
    }
    const s = parts.join('|');
    // FNV-1a 64bit（用两个 32 位累加模拟）
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c >> 8), 0x85ebca6b) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  // ---------------- 命中收集（BVH 与穷举共用同一套判定，保证结果一致） ----------------
  function makeCollector() {
    return { tMin: Infinity, candidates: [] };
  }
  function collectHit(col, instId, face, t, u, v) {
    if (t < col.tMin) {
      col.tMin = t;
      col.candidates.length = 0;
      col.candidates.push({ instance: instId, face, t, u, v });
    } else if (t <= col.tMin + TIE_EPS) {
      col.candidates.push({ instance: instId, face, t, u, v });
    }
  }
  // 裁定：t 窗口内按实例 id 字典序、面号升序
  function resolveHit(scene, col, o, d) {
    if (!col.candidates.length) return null;
    const tMin = col.tMin;
    const tied = col.candidates.filter((c) => c.t <= tMin + TIE_EPS);
    tied.sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : a.face - b.face));
    const best = tied[0];
    const inst = scene.instances.find((x) => x.id === best.instance);
    const mesh = scene.meshes.get(inst.mesh);
    const f = mesh.faces[best.face];
    const w0 = transformPoint(inst.matrix, mesh.vertices[f[0]]);
    const w1 = transformPoint(inst.matrix, mesh.vertices[f[1]]);
    const w2 = transformPoint(inst.matrix, mesh.vertices[f[2]]);
    const normal = vnormalize(vcross(vsub(w1, w0), vsub(w2, w0))) || [0, 0, 0];
    return {
      instance: best.instance,
      face: best.face,
      t: best.t,
      barycentric: [1 - best.u - best.v, best.u, best.v],
      position: [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t],
      normal,
    };
  }

  function normalizeRay(origin, direction) {
    if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(direction) || direction.length !== 3) {
      return { error: '射线格式错误' };
    }
    const d = vnormalize(direction);
    if (!d) return { error: '射线方向为零向量' };
    return { o: origin.slice(), d };
  }

  // ---------------- BVH 查询 ----------------
  // options.recordVisited=true 时记录访问过的包围盒（用于可视化）
  function queryBVH(scene, origin, direction, options) {
    const record = !!(options && options.recordVisited);
    const nr = normalizeRay(origin, direction);
    if (nr.error) return { hit: null, error: nr.error, stats: null };
    const { o, d } = nr;
    const stats = { tlasAabbTests: 0, blasAabbTests: 0, triTests: 0, visited: record ? [] : null };
    const col = makeCollector();
    if (!scene.tlas || !scene.tlas.nodes.length) {
      return { hit: null, stats, error: null };
    }
    const stack = [0];
    while (stack.length) {
      const ni = stack.pop();
      const node = scene.tlas.nodes[ni];
      stats.tlasAabbTests++;
      const tEnter = rayAABB(o, d, node.min, node.max, col.tMin + TIE_EPS);
      if (tEnter === null) continue;
      if (record) stats.visited.push({ level: 'tlas', min: node.min.slice(), max: node.max.slice() });
      if (node.left >= 0) {
        stack.push(node.left, node.right);
      } else {
        for (let k = 0; k < node.count; k++) {
          const inst = scene.tlasItems[scene.tlas.order[node.start + k]];
          queryInstance(scene, inst, o, d, col, stats, record);
        }
      }
    }
    return { hit: resolveHit(scene, col, o, d), stats, error: null };
  }

  function queryInstance(scene, inst, o, d, col, stats, record) {
    const mesh = scene.meshes.get(inst.mesh);
    const lo = transformPoint(inst.inv, o);
    const ld = transformDir(inst.inv, d);
    const blas = mesh.blas;
    const stack = [0];
    while (stack.length) {
      const ni = stack.pop();
      const node = blas.nodes[ni];
      stats.blasAabbTests++;
      const tEnter = rayAABB(lo, ld, node.min, node.max, col.tMin + TIE_EPS);
      if (tEnter === null) continue;
      if (record) stats.visited.push({ level: 'blas', instance: inst.id, min: node.min.slice(), max: node.max.slice() });
      if (node.left >= 0) {
        stack.push(node.left, node.right);
      } else {
        for (let k = 0; k < node.count; k++) {
          const fi = blas.order[node.start + k];
          const f = mesh.faces[fi];
          stats.triTests++;
          const r = rayTriangle(lo, ld, mesh.vertices[f[0]], mesh.vertices[f[1]], mesh.vertices[f[2]]);
          if (r) collectHit(col, inst.id, fi, r.t, r.u, r.v);
        }
      }
    }
  }

  // ---------------- 逐三角穷举对照 ----------------
  function queryBruteForce(scene, origin, direction) {
    const nr = normalizeRay(origin, direction);
    if (nr.error) return { hit: null, error: nr.error, stats: null };
    const { o, d } = nr;
    const stats = { instanceTests: 0, triTests: 0 };
    const col = makeCollector();
    for (const inst of scene.instances) {
      if (!inst.valid) continue;
      stats.instanceTests++;
      const mesh = scene.meshes.get(inst.mesh);
      const lo = transformPoint(inst.inv, o);
      const ld = transformDir(inst.inv, d);
      for (let fi = 0; fi < mesh.faces.length; fi++) {
        const f = mesh.faces[fi];
        stats.triTests++;
        const r = rayTriangle(lo, ld, mesh.vertices[f[0]], mesh.vertices[f[1]], mesh.vertices[f[2]]);
        if (r) collectHit(col, inst.id, fi, r.t, r.u, r.v);
      }
    }
    return { hit: resolveHit(scene, col, o, d), stats, error: null };
  }

  // ---------------- 命中结果比较 ----------------
  const CMP_TOL = 1e-9;
  function hitsEqual(a, b, tol) {
    const t = tol === undefined ? CMP_TOL : tol;
    if (a === null || b === null) return a === b;
    if (a.instance !== b.instance || a.face !== b.face) return false;
    if (Math.abs(a.t - b.t) > t) return false;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(a.barycentric[k] - b.barycentric[k]) > t) return false;
      if (Math.abs(a.position[k] - b.position[k]) > t) return false;
      if (Math.abs(a.normal[k] - b.normal[k]) > t) return false;
    }
    return true;
  }

  // 与 expected.json 的条目比较（只检查出现的字段）
  function hitMatchesExpected(hit, exp, tol) {
    const t = tol === undefined ? 1e-6 : tol;
    if (exp === null || exp === undefined) return hit === null;
    if (hit === null) return false;
    if (exp.instance !== undefined && hit.instance !== exp.instance) return false;
    if (exp.face !== undefined && hit.face !== exp.face) return false;
    if (exp.t !== undefined && Math.abs(hit.t - exp.t) > t) return false;
    const vec = (key) => {
      if (exp[key] === undefined) return true;
      for (let k = 0; k < 3; k++) if (Math.abs(hit[key][k] - exp[key][k]) > t) return false;
      return true;
    };
    return vec('position') && vec('barycentric') && vec('normal');
  }

  const IRB = {
    TIE_EPS, MAX_INSTANCES, MAX_FACES_PER_MESH,
    vsub, vcross, vdot, vlen, vnormalize,
    invertAffine, transformPoint, transformDir,
    aabbTransform, rayAABB, rayTriangle, buildBVH,
    createScene, loadSceneData, updateInstanceMatrix, sceneStats, sceneHash,
    queryBVH, queryBruteForce, hitsEqual, hitMatchesExpected, normalizeRay,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = IRB;
  else global.IRB = IRB;
})(typeof window !== 'undefined' ? window : globalThis);
