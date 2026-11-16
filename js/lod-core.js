/*!
 * Constrained LOD Forge — 核心算法（无第三方依赖，浏览器 / Node 通用）
 *
 * 平面二次误差（QEM）逐边折叠：
 *  - 每面 p=(nx,ny,nz,d)，K=p p^T，顶点 Q = 邻接面 K 之和；边误差矩阵 = 两端 Q 之和
 *  - 最小解奇异时只比较两端点与中点；误差相同按原端点编号排序
 *  - 边界边（仅邻接一面）与材质交界边（两邻接面材质不同）两端顶点锁定
 *  - 接触锁定顶点的边不可折叠
 *  - 折叠合法性：链接条件（非流形）、零面积退化、与存活面原法线点积 <= 0（翻转）、重复面
 *  - 不删除任意面凑目标；约束阻止继续时诚实停止
 */
(function (global) {
  'use strict';

  // ---------- 小工具 ----------
  function isInt(x) { return typeof x === 'number' && Number.isInteger(x); }
  function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  function triKey(v) {
    var a = v[0], b = v[1], c = v[2];
    var t;
    if (a > b) { t = a; a = b; b = t; }
    if (b > c) { t = b; b = c; c = t; }
    if (a > b) { t = a; a = b; b = t; }
    return a + ',' + b + ',' + c;
  }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function normalize(a) {
    var l = Math.hypot(a[0], a[1], a[2]);
    if (l === 0) return [0, 0, 0];
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  function faceNormal(pos, v) {
    return normalize(cross(sub3(pos[v[1]], pos[v[0]]), sub3(pos[v[2]], pos[v[0]])));
  }

  // 4x4（行主序，Float64）相加
  function addMat(A, B) {
    var R = new Float64Array(16);
    for (var i = 0; i < 16; i++) R[i] = A[i] + B[i];
    return R;
  }
  // 齐次坐标 x=(x,y,z,1) 的二次误差 x^T Q x
  function quadricError(Q, x) {
    var h = [x[0], x[1], x[2], 1];
    var s = 0, i, j;
    for (i = 0; i < 4; i++)
      for (j = 0; j < 4; j++) s += Q[i * 4 + j] * h[i] * h[j];
    return s;
  }

  /*
   * 求 QEM 最优收缩点。
   * 返回 {point, singular}。奇异时 singular=true，由调用方在两端点/中点间比较。
   * 解左上角 3x3 方程 A x = b，b = -[Q03,Q13,Q23]，部分主元高斯消元。
   */
  function solveOptimal(Q) {
    var A = [
      [Q[0], Q[1], Q[2]],
      [Q[4], Q[5], Q[6]],
      [Q[8], Q[9], Q[10]]
    ];
    var b = [-Q[3], -Q[7], -Q[11]];
    var scale = 1e-12;
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    var eps = 1e-10 * scale;
    for (var col = 0; col < 3; col++) {
      var piv = col;
      for (var r = col + 1; r < 3; r++)
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < eps) return { singular: true };
      if (piv !== col) {
        var tr = A[col]; A[col] = A[piv]; A[piv] = tr;
        var tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      }
      for (var r2 = col + 1; r2 < 3; r2++) {
        var f = A[r2][col] / A[col][col];
        for (var k = col; k < 3; k++) A[r2][k] -= f * A[col][k];
        b[r2] -= f * b[col];
      }
    }
    var x = [0, 0, 0];
    for (var rr = 2; rr >= 0; rr--) {
      var sum = b[rr];
      for (var k2 = rr + 1; k2 < 3; k2++) sum -= A[rr][k2] * x[k2];
      x[rr] = sum / A[rr][rr];
    }
    if (!isFiniteNum(x[0]) || !isFiniteNum(x[1]) || !isFiniteNum(x[2])) return { singular: true };
    return { point: x, singular: false };
  }

  // ---------- 输入校验 ----------
  /*
   * 返回 { ok, errors:[{code, message, location}], warnings:[...] }
   * 非法数、坏索引、退化面、非流形边/顶点全部拒绝并给出位置。
   */
  function validateMesh(data) {
    var errors = [];
    var warnings = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, errors: [{ code: 'schema', message: '输入必须是包含 vertices / faces / materials 的 JSON 对象', location: '根对象' }], warnings: warnings };
    }
    var verts = data.vertices, faces = data.faces, mats = data.materials;
    if (!Array.isArray(verts)) errors.push({ code: 'schema', message: 'vertices 必须是数组', location: 'vertices' });
    if (!Array.isArray(faces)) errors.push({ code: 'schema', message: 'faces 必须是数组', location: 'faces' });
    if (!Array.isArray(mats)) errors.push({ code: 'schema', message: 'materials 必须是数组', location: 'materials' });
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    if (verts.length === 0) errors.push({ code: 'empty', message: 'vertices 为空，没有可简化的几何', location: 'vertices' });
    if (faces.length === 0) errors.push({ code: 'empty', message: 'faces 为空，没有可简化的三角形', location: 'faces' });

    var V = verts.length;
    for (var i = 0; i < V; i++) {
      var p = verts[i];
      if (!Array.isArray(p) || p.length !== 3) {
        errors.push({ code: 'bad-vertex', message: '顶点必须是长度为 3 的坐标数组', location: 'vertices[' + i + ']' });
        continue;
      }
      for (var k = 0; k < 3; k++) {
        if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) {
          errors.push({
            code: 'illegal-number',
            message: '坐标必须是有限数，实际为 ' + String(p[k]),
            location: 'vertices[' + i + '][' + k + ']'
          });
        }
      }
    }

    for (var fi = 0; fi < faces.length; fi++) {
      var f = faces[fi];
      if (!Array.isArray(f) || f.length !== 3) {
        errors.push({ code: 'bad-face', message: '面必须是长度为 3 的索引数组', location: 'faces[' + fi + ']' });
        continue;
      }
      for (k = 0; k < 3; k++) {
        var idx = f[k];
        if (typeof idx !== 'number' || !Number.isInteger(idx)) {
          errors.push({ code: 'bad-index', message: '索引必须是整数，实际为 ' + String(idx), location: 'faces[' + fi + '][' + k + ']' });
        } else if (idx < 0 || idx >= V) {
          errors.push({ code: 'bad-index', message: '索引 ' + idx + ' 越界（合法范围 0..' + (V - 1) + '）', location: 'faces[' + fi + '][' + k + ']' });
        }
      }
      if (f.length === 3 && isInt(f[0]) && isInt(f[1]) && isInt(f[2]) &&
          f[0] >= 0 && f[0] < V && f[1] >= 0 && f[1] < V && f[2] >= 0 && f[2] < V) {
        if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) {
          errors.push({ code: 'degenerate', message: '退化三角形：含重复顶点索引', location: 'faces[' + fi + ']' });
        }
      }
    }

    if (!Array.isArray(mats) || mats.length !== faces.length) {
      errors.push({
        code: 'schema',
        message: 'materials 长度 ' + (Array.isArray(mats) ? mats.length : String(mats)) +
          ' 与 faces 长度 ' + faces.length + ' 不一致，材质必须逐面对应',
        location: 'materials'
      });
    } else {
      for (var mi = 0; mi < mats.length; mi++) {
        if (typeof mats[mi] !== 'number' || !Number.isInteger(mats[mi])) {
          errors.push({ code: 'bad-material', message: '材质编号必须是整数，实际为 ' + String(mats[mi]), location: 'materials[' + mi + ']' });
        }
      }
    }

    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    // ---- 拓扑：非流形检查 ----
    var edgeFaces = new Map();   // edgeKey -> 面 id 列表
    var vertFaces = new Map();
    var referenced = new Uint8Array(V);
    for (fi = 0; fi < faces.length; fi++) {
      f = faces[fi];
      for (k = 0; k < 3; k++) {
        referenced[f[k]] = 1;
        if (!vertFaces.has(f[k])) vertFaces.set(f[k], []);
        vertFaces.get(f[k]).push(fi);
      }
      for (k = 0; k < 3; k++) {
        var ek = edgeKey(f[k], f[(k + 1) % 3]);
        if (!edgeFaces.has(ek)) edgeFaces.set(ek, []);
        edgeFaces.get(ek).push(fi);
      }
    }
    edgeFaces.forEach(function (flist, ek) {
      if (flist.length > 2) {
        errors.push({
          code: 'nonmanifold-edge',
          message: '非流形边：边 ' + ek.replace('_', ', ') + ' 邻接 ' + flist.length + ' 个面 ' + JSON.stringify(flist) + '，流形边至多邻接 2 个面',
          location: '边 (' + ek.replace('_', ', ') + ')'
        });
      }
    });

    // 顶点链接环检查：每个顶点的 link 必须是单个闭合环或单条开口路径
    for (var v = 0; v < V; v++) {
      var vfl = vertFaces.get(v);
      if (!vfl) continue;
      var linkDeg = new Map();   // 邻点 -> 在 link 图中的度数
      for (var x = 0; x < vfl.length; x++) {
        var ff = faces[vfl[x]];
        var others = ff.filter(function (q) { return q !== v; });
        linkDeg.set(others[0], (linkDeg.get(others[0]) || 0) + 1);
        linkDeg.set(others[1], (linkDeg.get(others[1]) || 0) + 1);
      }
      var deg1 = 0, badDeg = 0;
      linkDeg.forEach(function (d) {
        if (d === 1) deg1++;
        else if (d !== 2) badDeg++;
      });
      var okLink = (badDeg === 0) && (deg1 === 0 || deg1 === 2);
      // 连通性：从任一邻点 BFS，应覆盖全部 link 顶点
      if (okLink) {
        var adj = new Map();
        vfl.forEach(function (fid) {
          var o = faces[fid].filter(function (q) { return q !== v; });
          if (!adj.has(o[0])) adj.set(o[0], []);
          if (!adj.has(o[1])) adj.set(o[1], []);
          adj.get(o[0]).push(o[1]);
          adj.get(o[1]).push(o[0]);
        });
        var start = linkDeg.keys().next().value;
        var seen = new Set([start]);
        var queue = [start];
        while (queue.length) {
          var cur = queue.pop();
          (adj.get(cur) || []).forEach(function (nb) {
            if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
          });
        }
        if (seen.size !== linkDeg.size) okLink = false;
      }
      if (!okLink) {
        errors.push({
          code: 'nonmanifold-vertex',
          message: '非流形顶点：顶点 ' + v + ' 的邻接环不是单条环/路径（多个三角形扇形只在该点相接）',
          location: '顶点 ' + v
        });
      }
    }

    for (v = 0; v < V; v++) {
      if (!referenced[v]) warnings.push({ code: 'unused-vertex', message: '顶点 ' + v + ' 未被任何面引用，将原样保留并参与距离统计', location: 'vertices[' + v + ']' });
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  // ---------- 二叉最小堆（惰性版本号删除） ----------
  function MinHeap() { this.a = []; }
  MinHeap.prototype.push = function (e) {
    var a = this.a, i = a.length;
    a.push(e);
    while (i > 0) {
      var par = (i - 1) >> 1;
      if (cmpHeap(a[i], a[par]) >= 0) break;
      var t = a[i]; a[i] = a[par]; a[par] = t;
      i = par;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a;
    if (!a.length) return null;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, s = i;
        if (l < n && cmpHeap(a[l], a[s]) < 0) s = l;
        if (r < n && cmpHeap(a[r], a[s]) < 0) s = r;
        if (s === i) break;
        var t = a[i]; a[i] = a[s]; a[s] = t;
        i = s;
      }
    }
    return top;
  };
  // 误差升序；误差相同按原端点编号排序（边构造时 u < v）
  function cmpHeap(x, y) {
    if (x.err !== y.err) return x.err < y.err ? -1 : 1;
    if (x.u !== y.u) return x.u < y.u ? -1 : 1;
    if (x.v !== y.v) return x.v < y.v ? -1 : 1;
    return 0;
  }

  /*
   * 从【原始模型】构建一次全新简化。
   * @param input 已通过 validateMesh 的 {vertices, faces, materials}
   * @param targetFaces 目标面数（不超过即停止）
   * @param cb {shouldCancel(), onProgress(state)} 可选
   */
  function simplify(input, targetFaces, cb) {
    cb = cb || {};
    var V0 = input.vertices.length;
    var F0 = input.faces.length;

    // ---- 工作状态（每次调用全新构建，原始 input 不修改）----
    var pos = input.vertices.map(function (p) { return [p[0], p[1], p[2]]; });
    var aliveV = new Uint8Array(V0);
    for (var i0 = 0; i0 < V0; i0++) aliveV[i0] = 1;

    var faceById = [];           // {v:[a,b,c], mat, alive, normal, origIndex}
    var edgeFaces = new Map();   // edgeKey -> Set(fid)
    var edgeMap = new Map();     // edgeKey -> {u,v,ver}
    var neighbors = new Map();   // v -> Set
    var vertFaces = new Map();   // v -> Set(fid)
    var triples = new Set();

    function ensureVertex(v) {
      if (!neighbors.has(v)) neighbors.set(v, new Set());
      if (!vertFaces.has(v)) vertFaces.set(v, new Set());
    }

    for (var f0 = 0; f0 < F0; f0++) {
      var fv = input.faces[f0].slice();
      var nrm = faceNormal(pos, fv);
      var fid = faceById.length;
      faceById.push({ v: fv, mat: input.materials[f0], alive: true, normal: nrm, origIndex: f0 });
      triples.add(triKey(fv));
      for (var kk = 0; kk < 3; kk++) {
        var vx = fv[kk];
        ensureVertex(vx);
        vertFaces.get(vx).add(fid);
      }
      for (kk = 0; kk < 3; kk++) {
        var a = fv[kk], b = fv[(kk + 1) % 3], ek = edgeKey(a, b);
        if (!edgeFaces.has(ek)) edgeFaces.set(ek, new Set());
        edgeFaces.get(ek).add(fid);
        if (!edgeMap.has(ek)) {
          var eu = Math.min(a, b), ev = Math.max(a, b);
          edgeMap.set(ek, { u: eu, v: ev, ver: 0 });
        }
        ensureVertex(a); ensureVertex(b);
        neighbors.get(a).add(b);
        neighbors.get(b).add(a);
      }
    }

    // ---- 锁定顶点：边界边 + 材质交界边的两端 ----
    var locked = new Uint8Array(V0);
    var boundaryEdges = 0, junctionEdges = 0;
    edgeFaces.forEach(function (set, ek) {
      var isBoundary = set.size === 1;
      var isJunction = false;
      if (set.size === 2) {
        var ids = [];
        set.forEach(function (x) { ids.push(x); });
        isJunction = faceById[ids[0]].mat !== faceById[ids[1]].mat;
      }
      if (isBoundary) boundaryEdges++;
      if (isJunction) junctionEdges++;
      if (isBoundary || isJunction) {
        var parts = ek.split('_');
        locked[+parts[0]] = 1;
        locked[+parts[1]] = 1;
      }
    });
    var lockedCount = 0;
    for (var lc = 0; lc < V0; lc++) if (locked[lc]) lockedCount++;

    // ---- 每顶点 Q 矩阵 ----
    var Q = new Array(V0);
    for (var qv = 0; qv < V0; qv++) Q[qv] = new Float64Array(16);
    faceById.forEach(function (face) {
      var n = face.normal;
      var d = -(n[0] * pos[face.v[0]][0] + n[1] * pos[face.v[0]][1] + n[2] * pos[face.v[0]][2]);
      var pv = [n[0], n[1], n[2], d];
      var K = new Float64Array(16);
      for (var i = 0; i < 4; i++)
        for (var j = 0; j < 4; j++) K[i * 4 + j] = pv[i] * pv[j];
      for (var t = 0; t < 3; t++) Q[face.v[t]] = addMat(Q[face.v[t]], K);
    });

    // ---- 边误差与堆 ----
    function edgeError(u, v) {
      var Qs = addMat(Q[u], Q[v]);
      var sol = solveOptimal(Qs);
      var point, singular;
      if (!sol.singular) {
        point = sol.point;
        singular = false;
      } else {
        // 奇异：只比较两端点与中点；候选顺序保证误差相同时小编号端点优先
        var pu = pos[u], pv2 = pos[v];
        var mid = [(pu[0] + pv2[0]) / 2, (pu[1] + pv2[1]) / 2, (pu[2] + pv2[2]) / 2];
        var cands = [{ p: pu, tag: 0 }, { p: pv2, tag: 1 }, { p: mid, tag: 2 }];
        var best = cands[0], bestErr = quadricError(Qs, cands[0].p);
        for (var ci = 1; ci < 3; ci++) {
          var e = quadricError(Qs, cands[ci].p);
          if (e < bestErr) { bestErr = e; best = cands[ci]; }
        }
        point = best.p;
        singular = true;
      }
      return { point: point, err: quadricError(Qs, point), singular: singular };
    }

    var heap = new MinHeap();
    function pushEdge(ek) {
      var e = edgeMap.get(ek);
      if (!e || locked[e.u] || locked[e.v]) return;
      var r = edgeError(e.u, e.v);
      heap.push({ key: ek, u: e.u, v: e.v, err: r.err, point: r.point, singular: r.singular, ver: e.ver });
    }
    edgeMap.forEach(function (e, ek) { pushEdge(ek); });

    // ---- 合法性检查 ----
    var rejectCounts = { flip: 0, degenerate: 0, nonmanifold: 0, duplicate: 0 };
    var failedKeys = new Set();

    function faceContains(fid, v) {
      var vv = faceById[fid].v;
      return vv[0] === v || vv[1] === v || vv[2] === v;
    }

    function legalCollapse(u, v, point) {
      var vf = [];
      vertFaces.get(v).forEach(function (fid) { vf.push(fid); });
      var shared = [], kept = [];
      for (var x = 0; x < vf.length; x++) {
        if (faceContains(vf[x], u)) shared.push(vf[x]); else kept.push(vf[x]);
      }

      // 链接条件：link(u) ∩ link(v) 必须恰好等于共享面的对顶点集合
      var expected = new Set();
      shared.forEach(function (fid) {
        faceById[fid].v.forEach(function (w) { if (w !== u && w !== v) expected.add(w); });
      });
      var inter = 0;
      neighbors.get(v).forEach(function (w) {
        if (w !== u && neighbors.get(u).has(w)) {
          inter++;
          if (!expected.has(w)) return { ok: false, reason: 'nonmanifold' };
        }
      });
      if (inter !== expected.size) return { ok: false, reason: 'nonmanifold' };

      // 假设折叠后的面
      var hyps = [];
      var oldKeys = new Set(), newKeys = new Set();
      for (x = 0; x < kept.length; x++) {
        var fid = kept[x], face = faceById[fid];
        oldKeys.add(triKey(face.v));
        var nv = face.v.map(function (w) { return w === v ? u : w; });
        if (nv[0] === nv[1] || nv[1] === nv[2] || nv[0] === nv[2]) return { ok: false, reason: 'degenerate' };
        var nk = triKey(nv);
        if (newKeys.has(nk)) return { ok: false, reason: 'duplicate' };
        newKeys.add(nk);
        hyps.push({ fid: fid, v: nv, key: nk });
      }
      // 与未参与折叠的现存面重复
      var dup = false;
      newKeys.forEach(function (nk) {
        if (triples.has(nk) && !oldKeys.has(nk)) dup = true;
      });
      if (dup) return { ok: false, reason: 'duplicate' };

      // 几何：零面积 + 法线翻转（与该面折叠前法线点积必须为正）
      for (x = 0; x < hyps.length; x++) {
        var h = hyps[x];
        var nn = faceNormal(pos, h.v);
        if (nn[0] === 0 && nn[1] === 0 && nn[2] === 0) return { ok: false, reason: 'degenerate' };
        if (dot3(nn, faceById[h.fid].normal) <= 0) return { ok: false, reason: 'flip' };
      }

      // 边邻接数：折叠后任何仍存活的边邻接面不得超过 2
      // 注意：含 v 的旧边会随 v 一起删除，基数只统计当前仍存在且不含 v 的边
      var localCnt = new Map();
      hyps.forEach(function (h) {
        for (var t = 0; t < 3; t++) {
          var ek = edgeKey(h.v[t], h.v[(t + 1) % 3]);
          localCnt.set(ek, (localCnt.get(ek) || 0) + 1);
        }
      });
      var bad = false;
      localCnt.forEach(function (cnt, ek) {
        var base = 0;
        var cur = edgeFaces.get(ek);
        if (cur) cur.forEach(function (fid2) {
          var vv = faceById[fid2].v;
          if (!(vv[0] === v || vv[1] === v || vv[2] === v)) base++;
        });
        if (base + cnt > 2) bad = true;
      });
      if (bad) return { ok: false, reason: 'nonmanifold' };

      return { ok: true, hyps: hyps, shared: shared, kept: kept };
    }

    // ---- 主循环 ----
    var faceCount = F0;
    var collapsed = 0;
    var log = [];
    var status = 'target-reached';
    var stopReason = '';
    var iter = 0;

    if (!(targetFaces >= 0) || !Number.isFinite(targetFaces)) {
      return { ok: false, error: '目标面数非法：' + String(targetFaces) };
    }

    while (faceCount > targetFaces) {
      if (cb.shouldCancel && cb.shouldCancel()) {
        status = 'cancelled';
        stopReason = '用户取消';
        break;
      }
      var entry = null;
      while (heap.a.length) {
        var cand = heap.pop();
        var e = edgeMap.get(cand.key);
        if (!e || e.ver !== cand.ver) continue;
        if (!aliveV[cand.u] || !aliveV[cand.v]) continue;
        if (locked[cand.u] || locked[cand.v]) continue;
        entry = cand;
        break;
      }
      if (!entry) {
        // 堆空：判断是全锁定还是合法性检查挡住
        var liveEdges = 0, lockEdges = 0;
        edgeMap.forEach(function (ee) {
          if (!aliveV[ee.u] || !aliveV[ee.v]) return;
          liveEdges++;
          if (locked[ee.u] || locked[ee.v]) lockEdges++;
        });
        if (liveEdges === 0 || lockEdges === liveEdges) {
          status = 'constrained-stop';
          stopReason = '剩余边全部接触锁定顶点（边界/材质交界），无可折叠边';
        } else {
          status = 'constrained-stop';
          stopReason = '剩余边折叠均会触发非流形、面翻转或退化检查，无法在保持流形与朝向的前提下继续';
        }
        break;
      }

      var leg = legalCollapse(entry.u, entry.v, entry.point);
      if (!leg.ok) {
        rejectCounts[leg.reason]++;
        failedKeys.add(entry.key);
        continue;
      }
      failedKeys.delete(entry.key);

      var u = entry.u, v = entry.v;

      // 1) 删除共享面
      leg.shared.forEach(function (fid) {
        var face = faceById[fid];
        face.alive = false;
        triples.delete(triKey(face.v));
        for (var t = 0; t < 3; t++) {
          var ek = edgeKey(face.v[t], face.v[(t + 1) % 3]);
          var set = edgeFaces.get(ek);
          if (set) set.delete(fid);
          vertFaces.get(face.v[t]).delete(fid);
        }
      });

      // 2) 更新保留面（v -> u）
      leg.hyps.forEach(function (h) {
        var face = faceById[h.fid];
        triples.delete(triKey(face.v));
        for (var t = 0; t < 3; t++) {
          var ekOld = edgeKey(face.v[t], face.v[(t + 1) % 3]);
          edgeFaces.get(ekOld).delete(h.fid);
        }
        face.v = h.v;
        face.normal = faceNormal(pos, face.v);
        triples.add(h.key);
        for (t = 0; t < 3; t++) {
          var ekNew = edgeKey(face.v[t], face.v[(t + 1) % 3]);
          if (!edgeFaces.has(ekNew)) edgeFaces.set(ekNew, new Set());
          edgeFaces.get(ekNew).add(h.fid);
        }
        vertFaces.get(u).add(h.fid);
      });

      // 3) 位置与误差矩阵
      pos[u] = [entry.point[0], entry.point[1], entry.point[2]];
      Q[u] = addMat(Q[u], Q[v]);
      aliveV[v] = 0;
      vertFaces.get(v).clear();

      // 4) 邻接与边结构合并
      var vNeighbors = [];
      neighbors.get(v).forEach(function (w) { vNeighbors.push(w); });
      vNeighbors.forEach(function (w) {
        if (w === u) return;
        var ekDead = edgeKey(v, w);
        edgeMap.delete(ekDead);
        edgeFaces.delete(ekDead);
        neighbors.get(w).delete(v);
        if (!neighbors.get(u).has(w)) {
          var ekNew = edgeKey(u, w);
          edgeMap.set(ekNew, { u: Math.min(u, w), v: Math.max(u, w), ver: 0 });
          neighbors.get(u).add(w);
          neighbors.get(w).add(u);
        }
      });
      var ekUV = edgeKey(u, v);
      edgeMap.delete(ekUV);
      edgeFaces.delete(ekUV);
      neighbors.get(u).delete(v);
      neighbors.get(v).clear();

      // 5) u 的全部邻边误差重算入堆
      neighbors.get(u).forEach(function (w) {
        var ek = edgeKey(u, w);
        var ee = edgeMap.get(ek);
        if (ee) { ee.ver++; failedKeys.delete(ek); pushEdge(ek); }
      });

      faceCount -= leg.shared.length;
      collapsed++;
      log.push({
        collapse: collapsed,
        edge: [u, v],
        error: entry.err,
        singular: entry.singular,
        removedFaces: leg.shared.length,
        facesAfter: faceCount
      });
      iter++;
      if (cb.onProgress && (iter & 31) === 0) {
        cb.onProgress({ faces: faceCount, collapsed: collapsed, total: F0 });
      }
    }

    if (status === 'target-reached' && faceCount <= targetFaces) {
      stopReason = '已达到目标面数（不超过 ' + targetFaces + '）';
    }

    // ---- 组装输出（保留原顶点编号映射）----
    var vertexMap = [];
    var oldToNew = new Map();
    for (var v2 = 0; v2 < V0; v2++) {
      if (aliveV[v2]) {
        oldToNew.set(v2, vertexMap.length);
        vertexMap.push(v2);
      }
    }
    var outVerts = vertexMap.map(function (old) { return [pos[old][0], pos[old][1], pos[old][2]]; });
    var outFaces = [], outMats = [], faceOrigIndex = [];
    faceById.forEach(function (face) {
      if (!face.alive) return;
      outFaces.push(face.v.map(function (w) { return oldToNew.get(w); }));
      outMats.push(face.mat);
      faceOrigIndex.push(face.origIndex);
    });

    return {
      ok: true,
      status: status,
      stopReason: stopReason,
      mesh: {
        vertices: outVerts,
        faces: outFaces,
        materials: outMats,
        vertexMap: vertexMap,
        faceSourceIndex: faceOrigIndex
      },
      stats: {
        sourceVertices: V0,
        sourceFaces: F0,
        targetFaces: targetFaces,
        resultVertices: outVerts.length,
        resultFaces: outFaces.length,
        lockedVertices: lockedCount,
        boundaryEdges: boundaryEdges,
        materialJunctionEdges: junctionEdges,
        collapsedEdges: collapsed,
        removedFaces: F0 - outFaces.length,
        rejects: rejectCounts,
        finalHeapError: (log.length ? log[log.length - 1].error : 0)
      },
      lockedVertices: (function () {
        var arr = [];
        for (var z = 0; z < V0; z++) if (locked[z]) arr.push(z);
        return arr;
      })(),
      collapseLog: log
    };
  }

  // ---------- 点到三角形最近距离（Ericson Real-Time Collision Detection）----------
  function pointTriangleDist2(p, a, b, c) {
    var ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
    var d1 = dot3(ab, ap), d2 = dot3(ac, ap);
    if (d1 <= 0 && d2 <= 0) return dot3(ap, ap);
    var bp = sub3(p, b);
    var d3 = dot3(ab, bp), d4 = dot3(ac, bp);
    if (d3 >= 0 && d4 <= d3) return dot3(bp, bp);
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      var v = d1 / (d1 - d3);
      var tv = [ap[0] - v * ab[0], ap[1] - v * ab[1], ap[2] - v * ab[2]];
      return dot3(tv, tv);
    }
    var cp = sub3(p, c);
    var d5 = dot3(ab, cp), d6 = dot3(ac, cp);
    if (d6 >= 0 && d5 <= d6) return dot3(cp, cp);
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      var w = d2 / (d2 - d6);
      var tw = [ap[0] - w * ac[0], ap[1] - w * ac[1], ap[2] - w * ac[2]];
      return dot3(tw, tw);
    }
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      // b-c 边区域：Q = b + w2(c-b)
      var qx = b[0] + w2 * (c[0] - b[0]);
      var qy = b[1] + w2 * (c[1] - b[1]);
      var qz = b[2] + w2 * (c[2] - b[2]);
      return (p[0] - qx) * (p[0] - qx) + (p[1] - qy) * (p[1] - qy) + (p[2] - qz) * (p[2] - qz);
    }
    // 面内区域
    var denom = 1 / (va + vb + vc);
    var vv = vb * denom, ww = vc * denom;
    var tx = ap[0] - (ab[0] * vv + ac[0] * ww);
    var ty = ap[1] - (ab[1] * vv + ac[1] * ww);
    var tz = ap[2] - (ab[2] * vv + ac[2] * ww);
    return tx * tx + ty * ty + tz * tz;
  }

  /*
   * 所有原顶点到简化表面（全部三角形）的欧氏最近距离。
   * 返回 {distances:[...与原顶点对齐], max, rms}
   */
  function computeDistances(origVertices, simpVertices, simpFaces) {
    var n = origVertices.length;
    var distances = new Float64Array(n);
    var sumSq = 0, maxD = 0;
    for (var i = 0; i < n; i++) {
      var p = origVertices[i], best = Infinity;
      for (var f = 0; f < simpFaces.length; f++) {
        var fc = simpFaces[f];
        var d2 = pointTriangleDist2(p, simpVertices[fc[0]], simpVertices[fc[1]], simpVertices[fc[2]]);
        if (d2 < best) best = d2;
      }
      if (!Number.isFinite(best)) best = 0;
      var d = Math.sqrt(best);
      distances[i] = d;
      sumSq += best;
      if (d > maxD) maxD = d;
    }
    return { distances: Array.prototype.slice.call(distances), max: maxD, rms: Math.sqrt(sumSq / n) };
  }

  var api = {
    validateMesh: validateMesh,
    simplify: simplify,
    computeDistances: computeDistances,
    pointTriangleDist2: pointTriangleDist2,
    faceNormal: faceNormal
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.LODCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
