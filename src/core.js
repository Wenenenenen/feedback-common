/*
 * boxed-hermite-extractor core
 * Box-constrained single-vertex dual-contouring style isosurface extraction.
 *
 * Works both in the browser (global `BHE`) and in Node (module.exports).
 * No DOM, no external dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BHE = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AXES = ['x', 'y', 'z'];
  const DEFAULT_LAMBDA = 1e-3;
  const LAMBDA_MIN = 1e-6;
  const LAMBDA_MAX = 1;

  // ---------------------------------------------------------------------------
  // Small numeric helpers
  // ---------------------------------------------------------------------------

  function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isIntArray3(a) {
    return Array.isArray(a) && a.length === 3 && a.every((v) => Number.isInteger(v));
  }

  function vec3(a) {
    return [a[0], a[1], a[2]];
  }

  function copyVec(a) {
    return [a[0], a[1], a[2]];
  }

  function norm3(a) {
    return Math.hypot(a[0], a[1], a[2]);
  }

  function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function sub3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function scale3(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
  }

  function normalize3(a) {
    const n = norm3(a);
    if (!(n > 0) || !Number.isFinite(n)) return null;
    return [a[0] / n, a[1] / n, a[2] / n];
  }

  function flatIndex(i, j, k, dims) {
    return i + dims[0] * (j + dims[1] * k);
  }

  function nodeInBounds(node, dims) {
    for (let a = 0; a < 3; a++) {
      if (!Number.isInteger(node[a]) || node[a] < 0 || node[a] > dims[a] - 1) return false;
    }
    return true;
  }

  function cellInBounds(cell, dims) {
    for (let a = 0; a < 3; a++) {
      if (!Number.isInteger(cell[a]) || cell[a] < 0 || cell[a] > dims[a] - 2) return false;
    }
    return true;
  }

  function axisIndex(axis) {
    return AXES.indexOf(axis);
  }

  function edgeKey(axis, node) {
    return axis + ':' + node[0] + ',' + node[1] + ',' + node[2];
  }

  /**
   * Solve a symmetric positive definite 3x3 system M x = v with partial
   * pivoting (Gaussian elimination). Returns null on a singular system.
   */
  function solve3(M, v) {
    const A = [
      [M[0][0], M[0][1], M[0][2], v[0]],
      [M[1][0], M[1][1], M[1][2], v[1]],
      [M[2][0], M[2][1], M[2][2], v[2]],
    ];
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) {
        if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      }
      if (!(Math.abs(A[p][c]) > 1e-300)) return null;
      if (p !== c) {
        const t = A[p];
        A[p] = A[c];
        A[c] = t;
      }
      const piv = A[c][c];
      for (let r = c + 1; r < 3; r++) {
        const f = A[r][c] / piv;
        if (f === 0) continue;
        for (let cc = c; cc < 4; cc++) A[r][cc] -= f * A[c][cc];
      }
    }
    const x = [0, 0, 0];
    for (let r = 2; r >= 0; r--) {
      let s = A[r][3];
      for (let c = r + 1; c < 3; c++) s -= A[r][c] * x[c];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  function makeError(code, field, message, extra) {
    return Object.assign({ code: code, field: field, message: message }, extra || {});
  }

  /**
   * Validate a raw case object. Returns
   *   { ok, errors, data }
   * `data` is the normalised case (only present when ok === true):
   *   { dims, origin, spacing, signs, edges, edgeMap }
   * where edges[i] = { index, axis, axisIndex, node, t, normal, normalized }
   */
  function validateInput(raw) {
    const errors = [];
    const push = (e) => errors.push(e);

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      push(makeError('invalid-root', '$', '输入必须是 JSON 对象'));
      return { ok: false, errors: errors, data: null };
    }

    // ---- dims -------------------------------------------------------------
    let dims = null;
    if (!Array.isArray(raw.dims) || raw.dims.length !== 3) {
      push(makeError('invalid-dims', 'dims', 'dims 必须是长度为 3 的整数数组'));
    } else {
      dims = raw.dims;
      for (let a = 0; a < 3; a++) {
        const v = dims[a];
        if (!Number.isInteger(v)) {
          push(makeError('invalid-dims', 'dims[' + a + ']', '节点数必须是整数，实际为 ' + JSON.stringify(v)));
        } else if (v < 2 || v > 33) {
          push(makeError('dims-out-of-range', 'dims[' + a + ']', '每轴节点数必须在 2 到 33 之间，实际为 ' + v));
        }
      }
    }

    // ---- origin -----------------------------------------------------------
    let origin = null;
    if (!Array.isArray(raw.origin) || raw.origin.length !== 3) {
      push(makeError('invalid-origin', 'origin', 'origin 必须是长度为 3 的数值数组'));
    } else {
      origin = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const v = raw.origin[a];
        if (!isFiniteNum(v)) {
          push(makeError('non-finite', 'origin[' + a + ']', 'origin 分量必须是有限数值'));
        } else if (Math.abs(v) > 10000) {
          push(makeError('origin-out-of-range', 'origin[' + a + ']', 'origin 绝对值不得超过 10000'));
        } else {
          origin[a] = v;
        }
      }
    }

    // ---- spacing ----------------------------------------------------------
    let spacing = null;
    if (!Array.isArray(raw.spacing) || raw.spacing.length !== 3) {
      push(makeError('invalid-spacing', 'spacing', 'spacing 必须是长度为 3 的正数值数组'));
    } else {
      spacing = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const v = raw.spacing[a];
        if (!isFiniteNum(v)) {
          push(makeError('non-finite', 'spacing[' + a + ']', 'spacing 分量必须是有限数值'));
        } else if (v <= 0) {
          push(makeError('invalid-spacing', 'spacing[' + a + ']', 'spacing 必须为正，实际为 ' + v));
        } else if (v < 1e-4 || v > 100) {
          push(makeError('spacing-out-of-range', 'spacing[' + a + ']', 'spacing 必须在 1e-4 到 100 之间，实际为 ' + v));
        } else {
          spacing[a] = v;
        }
      }
    }

    // ---- signs ------------------------------------------------------------
    let signs = null;
    let nNodes = null;
    if (dims && dims.every((v) => Number.isInteger(v) && v >= 2 && v <= 33)) {
      nNodes = dims[0] * dims[1] * dims[2];
    }
    if (!Array.isArray(raw.signs)) {
      push(makeError('invalid-signs', 'signs', 'signs 必须是扁平数组'));
    } else {
      if (nNodes != null && raw.signs.length !== nNodes) {
        push(makeError('signs-length', 'signs', 'signs 长度必须为 dims 乘积 ' + nNodes + '，实际为 ' + raw.signs.length));
      }
      signs = new Array(raw.signs.length);
      for (let idx = 0; idx < raw.signs.length; idx++) {
        const v = raw.signs[idx];
        if (v !== -1 && v !== 1) {
          let nodeTxt = '';
          if (dims && dims.length === 3) {
            const i = idx % dims[0];
            const j = Math.floor(idx / dims[0]) % dims[1];
            const k = Math.floor(idx / (dims[0] * dims[1]));
            nodeTxt = '（节点 [' + i + ',' + j + ',' + k + ']）';
          }
          push(makeError('invalid-sign', 'signs[' + idx + ']', '节点符号只能是 -1 或 1' + nodeTxt + '，实际为 ' + JSON.stringify(v)));
        }
        signs[idx] = v;
      }
    }

    // ---- edges ------------------------------------------------------------
    const edges = [];
    const edgeMap = new Map();
    const invalidKeys = new Set();
    if (!Array.isArray(raw.edges)) {
      push(makeError('invalid-edges', 'edges', 'edges 必须是数组'));
    } else {
      for (let e = 0; e < raw.edges.length; e++) {
        const baseField = 'edges[' + e + ']';
        const rec = raw.edges[e];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          push(makeError('invalid-edge', baseField, '边记录必须是对象'));
          continue;
        }
        let bad = false;
        const axis = rec.axis;
        const ai = axisIndex(axis);
        if (ai < 0) {
          push(makeError('invalid-axis', baseField + '.axis', 'axis 必须是 "x"、"y" 或 "z"，实际为 ' + JSON.stringify(axis)));
          bad = true;
        }
        let node = null;
        if (!isIntArray3(rec.node)) {
          push(makeError('invalid-node', baseField + '.node', 'node 必须是长度为 3 的整数数组'));
          bad = true;
        } else {
          node = rec.node;
          if (dims && dims.every((v) => Number.isInteger(v))) {
            if (!nodeInBounds(node, dims)) {
              push(makeError('node-out-of-range', baseField + '.node', 'node 越界，必须满足 0 <= node[a] <= dims[a]-1'));
              bad = true;
            } else if (ai >= 0 && node[ai] > dims[ai] - 2) {
              push(makeError('node-out-of-range', baseField + '.node', '边长边起点越界：axis ' + axis + ' 上 node[' + ai + '] 必须 <= dims[' + ai + ']-2'));
              bad = true;
            }
          }
        }
        let t = null;
        if (!isFiniteNum(rec.t)) {
          push(makeError('non-finite', baseField + '.t', 't 必须是有限数值'));
          bad = true;
        } else if (!(rec.t > 0 && rec.t < 1)) {
          push(makeError('t-out-of-range', baseField + '.t', 't 必须严格位于 0 与 1 之间，实际为 ' + rec.t));
          bad = true;
        } else {
          t = rec.t;
        }
        let normal = null;
        let normalized = null;
        if (!Array.isArray(rec.normal) || rec.normal.length !== 3) {
          push(makeError('invalid-normal', baseField + '.normal', 'normal 必须是长度为 3 的数值数组'));
          bad = true;
        } else {
          normal = [0, 0, 0];
          let finite = true;
          for (let a = 0; a < 3; a++) {
            if (!isFiniteNum(rec.normal[a])) {
              push(makeError('non-finite', baseField + '.normal[' + a + ']', 'normal 分量必须是有限数值'));
              finite = false;
              bad = true;
            } else {
              normal[a] = rec.normal[a];
            }
          }
          if (finite) {
            const nn = norm3(normal);
            if (!(nn > 1e-12)) {
              push(makeError('zero-normal', baseField + '.normal', 'normal 不得为零向量（无法归一化）'));
              bad = true;
            } else {
              normalized = scale3(normal, 1 / nn);
            }
          }
        }
        if (bad) {
          if (axisIndex(rec.axis) >= 0 && isIntArray3(rec.node)) invalidKeys.add(edgeKey(rec.axis, rec.node));
          continue;
        }

        const key = edgeKey(axis, node);
        if (edgeMap.has(key)) {
          const prev = edgeMap.get(key);
          push(makeError('duplicate-edge', baseField, '同一条网格边重复出现：' + key + '，首次出现在 edges[' + prev.index + ']', {
            edge: { axis: axis, node: vec3(node) },
            index: e,
            firstIndex: prev.index,
          }));
          invalidKeys.add(key);
          continue;
        }
        const item = {
          index: e,
          axis: axis,
          axisIndex: ai,
          node: vec3(node),
          t: t,
          normal: normal,
          normalized: normalized,
        };
        edges.push(item);
        edgeMap.set(key, item);
      }
    }

    const geometryOK = dims && dims.every((v) => Number.isInteger(v) && v >= 2 && v <= 33) &&
      origin && origin.every((v) => isFiniteNum(v)) &&
      spacing && spacing.every((v) => isFiniteNum(v) && v > 0) &&
      signs && signs.length === nNodes && signs.every((v) => v === -1 || v === 1);

    // Cross-check edges against sign crossings.
    if (geometryOK) {
      for (let ai = 0; ai < 3; ai++) {
        for (let k = 0; k < dims[2]; k++) {
          for (let j = 0; j < dims[1]; j++) {
            for (let i = 0; i < dims[0]; i++) {
              const node = [i, j, k];
              if (node[ai] > dims[ai] - 2) continue;
              const s0 = signs[flatIndex(i, j, k, dims)];
              const nb = vec3(node);
              nb[ai] += 1;
              const s1 = signs[flatIndex(nb[0], nb[1], nb[2], dims)];
              const key = edgeKey(AXES[ai], node);
              if (s0 === s1) {
                if (edgeMap.has(key)) {
                  const rec = edgeMap.get(key);
                  push(makeError('unexpected-edge', 'edges[' + rec.index + ']',
                    '同号边不得有交点记录：' + AXES[ai] + ' 方向 node=[' + node.join(',') + ']，两端符号均为 ' + s0, {
                      edge: { axis: AXES[ai], node: node },
                      index: rec.index,
                    }));
                }
              } else {
                if (!edgeMap.has(key) && !invalidKeys.has(key)) {
                  push(makeError('missing-edge', 'edges',
                    '异号边缺少交点记录：axis=' + AXES[ai] + ' node=[' + node.join(',') + ']', {
                      edge: { axis: AXES[ai], node: node },
                    }));
                }
              }
            }
          }
        }
        // Any edge record on a same-sign edge was already reported above; the
        // seen set is only used for the missing-edge pass.
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors: errors, data: null };
    }

    return {
      ok: true,
      errors: [],
      data: {
        dims: dims.slice(),
        origin: origin.slice(),
        spacing: spacing.slice(),
        signs: signs.slice(),
        edges: edges,
        edgeMap: edgeMap,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Box-constrained least squares (single vertex)
  // ---------------------------------------------------------------------------

  /**
   * Minimise F(x) = sum_e (n_e . (x - h_e))^2 + lambda ||x - c||^2
   * over the closed box [lo, hi].
   *
   * Solved exactly by enumerating the 27 possible active sets.  The normal
   * equations are always positive definite because lambda > 0, so every
   * reduced system has a unique solution.
   */
  function solveBoxedVertex(hits, normals, c, lambda, lo, hi) {
    const m = hits.length;
    // Normal equations: Q = sum n n^T + lambda I, b = sum n (n.h) + lambda c
    const Q = [
      [lambda, 0, 0],
      [0, lambda, 0],
      [0, 0, lambda],
    ];
    const b = [lambda * c[0], lambda * c[1], lambda * c[2]];
    for (let e = 0; e < m; e++) {
      const n = normals[e];
      const h = hits[e];
      const nh = dot3(n, h);
      for (let r = 0; r < 3; r++) {
        b[r] += n[r] * nh;
        for (let s = 0; s < 3; s++) Q[r][s] += n[r] * n[s];
      }
    }

    const unconstrained = solve3(Q, b) || copyVec(c);

    // Enumerate active sets.  state: 0 = free, -1 = lower, +1 = upper.
    let best = null;
    for (let mask = 0; mask < 27; mask++) {
      let mm = mask;
      const state = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const d = mm % 3;
        mm = Math.floor(mm / 3);
        state[a] = d === 0 ? 0 : d === 1 ? -1 : 1;
      }
      const x = [0, 0, 0];
      const free = [];
      for (let a = 0; a < 3; a++) {
        if (state[a] === -1) x[a] = lo[a];
        else if (state[a] === 1) x[a] = hi[a];
        else free.push(a);
      }
      if (free.length > 0) {
        // Reduced system on free coordinates.
        const Qf = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        const bf = [0, 0, 0];
        for (let r = 0; r < free.length; r++) {
          const ar = free[r];
          let rhs = b[ar];
          for (let a = 0; a < 3; a++) {
            if (state[a] !== 0) rhs -= Q[ar][a] * x[a];
          }
          bf[r] = rhs;
          for (let s = 0; s < free.length; s++) Qf[r][s] = Q[ar][free[s]];
        }
        let sol = null;
        if (free.length === 3) sol = solve3(Qf, bf);
        else if (free.length === 2) {
          const det = Qf[0][0] * Qf[1][1] - Qf[0][1] * Qf[1][0];
          if (Math.abs(det) > 1e-300) {
            sol = [
              (bf[0] * Qf[1][1] - Qf[0][1] * bf[1]) / det,
              (Qf[0][0] * bf[1] - bf[0] * Qf[1][0]) / det,
            ];
          }
        } else {
          if (Math.abs(Qf[0][0]) > 1e-300) sol = [bf[0] / Qf[0][0]];
        }
        if (!sol) continue;
        for (let r = 0; r < free.length; r++) x[free[r]] = sol[r];
      }

      // Feasibility for the free coordinates.
      let feasible = true;
      const scale = Math.max(1, Math.abs(hi[0] - lo[0]), Math.abs(hi[1] - lo[1]), Math.abs(hi[2] - lo[2]),
        Math.abs(lo[0]), Math.abs(lo[1]), Math.abs(lo[2]), Math.abs(hi[0]), Math.abs(hi[1]), Math.abs(hi[2]));
      const tol = 1e-11 * scale;
      for (let r = 0; r < free.length; r++) {
        const a = free[r];
        if (x[a] < lo[a] - tol || x[a] > hi[a] + tol) {
          feasible = false;
          break;
        }
      }
      if (!feasible) continue;

      // Clamp machine-level excursions onto the bounds.
      for (let a = 0; a < 3; a++) {
        if (x[a] < lo[a]) x[a] = lo[a];
        if (x[a] > hi[a]) x[a] = hi[a];
      }

      // Objective.
      let data = 0;
      for (let e = 0; e < m; e++) {
        const r = dot3(normals[e], sub3(x, hits[e]));
        data += r * r;
      }
      const dx = sub3(x, c);
      const obj = data + lambda * dot3(dx, dx);

      if (!best || obj < best.objective - 1e-15 * Math.max(1, Math.abs(best.objective))) {
        best = { x: x, objective: obj, dataError: data, state: state.slice() };
      }
    }

    if (!best) {
      // Should never happen for lambda > 0; clamp as a defensive fallback.
      const x = [0, 0, 0];
      for (let a = 0; a < 3; a++) x[a] = Math.min(hi[a], Math.max(lo[a], unconstrained[a]));
      let data = 0;
      for (let e = 0; e < m; e++) {
        const r = dot3(normals[e], sub3(x, hits[e]));
        data += r * r;
      }
      const dx = sub3(x, c);
      best = { x: x, objective: data + lambda * dot3(dx, dx), dataError: data, state: [null, null, null] };
    }

    // Naive per-axis clamp, reported only for comparison in the UI.
    const clamped = [0, 0, 0];
    for (let a = 0; a < 3; a++) clamped[a] = Math.min(hi[a], Math.max(lo[a], unconstrained[a]));
    let clampData = 0;
    for (let e = 0; e < m; e++) {
      const r = dot3(normals[e], sub3(clamped, hits[e]));
      clampData += r * r;
    }
    const clampDx = sub3(clamped, c);
    const clampObjective = clampData + lambda * dot3(clampDx, clampDx);

    // Active axes relative to the bounds.  The tolerance is tied to the box
    // extent so that tiny cells at large world offsets still classify cleanly.
    const activeAxes = [null, null, null];
    const boundTol = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const extent = Math.abs(hi[a] - lo[a]);
      const maxAbs = Math.max(Math.abs(lo[a]), Math.abs(hi[a]));
      boundTol[a] = 1e-8 * (1 + extent) + 1e-12 * maxAbs;
    }
    for (let a = 0; a < 3; a++) {
      if (Math.abs(best.x[a] - lo[a]) <= boundTol[a]) {
        activeAxes[a] = 'lower';
        best.x[a] = lo[a];
      } else if (Math.abs(best.x[a] - hi[a]) <= boundTol[a]) {
        activeAxes[a] = 'upper';
        best.x[a] = hi[a];
      } else {
        activeAxes[a] = 'free';
      }
    }

    return {
      position: vec3(best.x),
      unconstrained: vec3(unconstrained),
      naiveClamp: vec3(clamped),
      naiveClampObjective: clampObjective,
      activeAxes: activeAxes,
      dataError: best.dataError,
      objective: best.objective,
      Q: Q,
      b: b,
      c: vec3(c),
    };
  }

  // ---------------------------------------------------------------------------
  // Cell topology helpers
  // ---------------------------------------------------------------------------

  /** List the 12 edges of a cell as {axisIndex, node}. */
  function cellEdges(cell) {
    const out = [];
    for (let a = 0; a < 3; a++) {
      const o1 = (a + 1) % 3;
      const o2 = (a + 2) % 3;
      for (let u = 0; u < 2; u++) {
        for (let v = 0; v < 2; v++) {
          const node = vec3(cell);
          node[o1] += u;
          node[o2] += v;
          out.push({ axisIndex: a, node: node });
        }
      }
    }
    return out;
  }

  /** World position of node. */
  function nodeWorld(origin, spacing, node) {
    return [
      origin[0] + spacing[0] * node[0],
      origin[1] + spacing[1] * node[1],
      origin[2] + spacing[2] * node[2],
    ];
  }

  /** World position of a crossing-edge intersection. */
  function hitWorld(origin, spacing, axisIndex, node, t) {
    const p = nodeWorld(origin, spacing, node);
    p[axisIndex] += spacing[axisIndex] * t;
    return p;
  }

  function signAt(signs, dims, node) {
    return signs[flatIndex(node[0], node[1], node[2], dims)];
  }

  /** The four cells around an interior grid edge, in the documented order. */
  function quadCells(axisIndex, node) {
    const i = node[0];
    const j = node[1];
    const k = node[2];
    if (axisIndex === 0) {
      return [[i, j - 1, k - 1], [i, j, k - 1], [i, j, k], [i, j - 1, k]];
    }
    if (axisIndex === 1) {
      return [[i - 1, j, k - 1], [i - 1, j, k], [i, j, k], [i, j, k - 1]];
    }
    return [[i - 1, j - 1, k], [i, j - 1, k], [i, j, k], [i - 1, j, k]];
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------

  /**
   * Run the extraction.  `data` comes from validateInput().  Returns a model:
   *   { ok, lambda, vertices, triangles, counts, cells, cellIndex,
   *     boundaryCrossings, boundaryEdges, nonmanifoldEdges }
   * vertices are in cell-number order and carry all per-cell diagnostics.
   */
  function extract(data, lambda) {
    const lam = isFiniteNum(lambda) ? lambda : DEFAULT_LAMBDA;
    if (!(lam >= LAMBDA_MIN && lam <= LAMBDA_MAX)) {
      throw new Error('lambda must be within [' + LAMBDA_MIN + ', ' + LAMBDA_MAX + ']');
    }
    const dims = data.dims;
    const origin = data.origin;
    const spacing = data.spacing;
    const signs = data.signs;
    const edgeMap = data.edgeMap;

    const mixedCellSet = new Set();
    const mixedCells = [];
    // Cell numbering: smaller-corner z, then y, then x ascending.
    for (let k = 0; k < dims[2] - 1; k++) {
      for (let j = 0; j < dims[1] - 1; j++) {
        for (let i = 0; i < dims[0] - 1; i++) {
          const s0 = signAt(signs, dims, [i, j, k]);
          let mixed = false;
          for (let dz = 0; dz < 2 && !mixed; dz++) {
            for (let dy = 0; dy < 2 && !mixed; dy++) {
              for (let dx = 0; dx < 2 && !mixed; dx++) {
                if (signAt(signs, dims, [i + dx, j + dy, k + dz]) !== s0) mixed = true;
              }
            }
          }
          if (mixed) {
            mixedCells.push([i, j, k]);
          }
        }
      }
    }

    const vertices = [];
    const cellIndex = new Map();
    const edgeCellMap = new Map();

    for (let ci = 0; ci < mixedCells.length; ci++) {
      const cell = mixedCells[ci];
      mixedCellSet.add(cell[0] + ',' + cell[1] + ',' + cell[2]);
      const lo = nodeWorld(origin, spacing, cell);
      const hi = nodeWorld(origin, spacing, [cell[0] + 1, cell[1] + 1, cell[2] + 1]);

      const hits = [];
      const normals = [];
      const edgeInfo = [];
      for (const ce of cellEdges(cell)) {
        const key = edgeKey(AXES[ce.axisIndex], ce.node);
        const rec = edgeMap.get(key);
        if (!rec) continue; // same-sign edge inside this cell
        const h = hitWorld(origin, spacing, ce.axisIndex, ce.node, rec.t);
        hits.push(h);
        normals.push(rec.normalized);
        edgeInfo.push({
          axis: AXES[ce.axisIndex],
          node: vec3(ce.node),
          t: rec.t,
          normal: vec3(rec.normalized),
          hit: h,
          sourceIndex: rec.index,
        });
      }

      if (hits.length === 0) {
        // Cannot happen for a properly validated mixed cell; skip defensively.
        continue;
      }

      const c = [0, 0, 0];
      for (const h of hits) {
        c[0] += h[0];
        c[1] += h[1];
        c[2] += h[2];
      }
      c[0] /= hits.length;
      c[1] /= hits.length;
      c[2] /= hits.length;

      const sol = solveBoxedVertex(hits, normals, c, lam, lo, hi);

      const residuals = edgeInfo.map((ei, idx) => {
        const r = dot3(normals[idx], sub3(sol.position, hits[idx]));
        return {
          axis: ei.axis,
          node: vec3(ei.node),
          t: ei.t,
          normal: vec3(ei.normal),
          hit: vec3(hits[idx]),
          residual: r,
          squared: r * r,
        };
      });

      const dx = sub3(sol.position, c);
      const regularization = lam * dot3(dx, dx);

      cellIndex.set(cell[0] + ',' + cell[1] + ',' + cell[2], ci);
      vertices.push({
        index: ci,
        cell: vec3(cell),
        position: sol.position,
        unconstrained: sol.unconstrained,
        naiveClamp: sol.naiveClamp,
        centroid: c,
        activeAxes: sol.activeAxes,
        box: { lower: lo, upper: hi },
        dataError: sol.dataError,
        regularization: regularization,
        objective: sol.objective,
        clampObjective: sol.naiveClampObjective,
        residuals: residuals,
        edges: edgeInfo,
        quadCount: 0,
      });
      for (const ei of edgeInfo) {
        const key = edgeKey(ei.axis, ei.node);
        if (!edgeCellMap.has(key)) edgeCellMap.set(key, []);
        edgeCellMap.get(key).push(ci);
      }
    }

    // ---- faces, in the documented processing order -------------------------
    const triangles = [];
    const quadList = [];
    let boundaryCrossings = 0;

    for (let ai = 0; ai < 3; ai++) {
      const NX = dims[0], NY = dims[1], NZ = dims[2];
      for (let k = 0; k < NZ; k++) {
        for (let j = 0; j < NY; j++) {
          for (let i = 0; i < NX; i++) {
            const node = [i, j, k];
            if (node[ai] > dims[ai] - 2) continue;
            const nb = vec3(node);
            nb[ai] += 1;
            const s0 = signAt(signs, dims, node);
            const s1 = signAt(signs, dims, nb);
            if (s0 === s1) continue;

            const cells = quadCells(ai, node);
            let complete = true;
            const ids = [];
            for (const cc of cells) {
              if (!cellInBounds(cc, dims)) {
                complete = false;
                break;
              }
              const id = cellIndex.get(cc[0] + ',' + cc[1] + ',' + cc[2]);
              if (id === undefined) {
                complete = false;
                break;
              }
              ids.push(id);
            }
            if (!complete) {
              boundaryCrossings++;
              continue;
            }

            // Orientation: start negative & end positive -> listed order,
            // otherwise keep the first point and reverse the remaining three.
            let order = ids;
            if (!(s0 === -1 && s1 === 1)) {
              order = [ids[0], ids[3], ids[2], ids[1]];
            }
            const [A, B, C, D] = order;
            triangles.push([A, B, C]);
            triangles.push([A, C, D]);
            quadList.push({ axis: AXES[ai], node: vec3(node), cells: cells.map((cc) => vec3(cc)), order: order.slice(), startSign: s0, endSign: s1 });
            for (let q = 0; q < 4; q++) vertices[order[q]].quadCount++;
          }
        }
      }
    }

    // ---- edge statistics for the triangle mesh ----------------------------
    const undirected = new Map();
    function addUndirected(a, b, tri) {
      const key = a < b ? a + ',' + b : b + ',' + a;
      let rec = undirected.get(key);
      if (!rec) {
        rec = { a: Math.min(a, b), b: Math.max(a, b), count: 0, triangles: [] };
        undirected.set(key, rec);
      }
      rec.count++;
      rec.triangles.push(tri);
    }
    for (let t = 0; t < triangles.length; t++) {
      const [a, b, c] = triangles[t];
      addUndirected(a, b, t);
      addUndirected(b, c, t);
      addUndirected(c, a, t);
    }
    const boundaryEdges = [];
    const nonmanifoldEdges = [];
    for (const rec of undirected.values()) {
      if (rec.count === 1) boundaryEdges.push(rec);
      else if (rec.count > 2) nonmanifoldEdges.push(rec);
    }
    boundaryEdges.sort((p, q) => (p.a - q.a) || (p.b - q.b));
    nonmanifoldEdges.sort((p, q) => (p.a - q.a) || (p.b - q.b));

    return {
      ok: true,
      lambda: lam,
      dims: dims.slice(),
      origin: origin.slice(),
      spacing: spacing.slice(),
      vertices: vertices,
      triangles: triangles,
      quads: quadList,
      cells: mixedCells,
      cellIndex: cellIndex,
      edgeCellMap: edgeCellMap,
      mixedCellSet: mixedCellSet,
      boundaryCrossings: boundaryCrossings,
      boundaryEdges: boundaryEdges,
      nonmanifoldEdges: nonmanifoldEdges,
      counts: {
        vertices: vertices.length,
        triangles: triangles.length,
        boundary_crossings: boundaryCrossings,
        boundary_edges: boundaryEdges.length,
        nonmanifold_edges: nonmanifoldEdges.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  function roundNum(v, digits) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
  }

  function roundVec(a, digits) {
    return a.map((v) => roundNum(v, digits));
  }

  function toOBJ(model, options) {
    const opts = options || {};
    const digits = opts.digits == null ? 10 : opts.digits;
    const lines = [];
    lines.push('# Boxed Hermite isosurface');
    lines.push('# lambda = ' + model.lambda);
    lines.push('# vertices = ' + model.vertices.length + ', triangles = ' + model.triangles.length);
    lines.push('# boundary_crossings = ' + model.boundaryCrossings);
    lines.push('o isosurface');
    for (const v of model.vertices) {
      lines.push('v ' + roundVec(v.position, digits).join(' '));
    }
    for (const t of model.triangles) {
      lines.push('f ' + (t[0] + 1) + ' ' + (t[1] + 1) + ' ' + (t[2] + 1));
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Diagnostic JSON.  Includes per-cell solutions, active constraints,
   * residuals, and any validation errors with their field locations.
   */
  function toDiagnostics(model, data, errors, extra) {
    const errs = (errors || []).map((e) => ({
      code: e.code,
      field: e.field,
      message: e.message,
      index: e.index,
      edge: e.edge,
      firstIndex: e.firstIndex,
    }));
    const out = {
      format: 'boxed-hermite-diagnostics',
      version: 1,
      lambda: model ? model.lambda : (extra && extra.lambda != null ? extra.lambda : DEFAULT_LAMBDA),
      grid: data
        ? { dims: data.dims.slice(), origin: data.origin.slice(), spacing: data.spacing.slice() }
        : (extra && extra.grid ? extra.grid : null),
      counts: model ? Object.assign({}, model.counts) : {
        vertices: 0,
        triangles: 0,
        boundary_crossings: 0,
        boundary_edges: 0,
        nonmanifold_edges: 0,
      },
      vertices: model ? model.vertices.map((v) => roundVec(v.position, 12)) : [],
      triangles: model ? model.triangles.map((t) => t.slice()) : [],
      cells: model ? model.vertices.map((v) => ({
        cell: v.cell.slice(),
        position: roundVec(v.position, 12),
        unconstrained: roundVec(v.unconstrained, 12),
        active_axes: v.activeAxes.slice(),
        data_error: v.dataError,
        objective: v.objective,
        regularization: v.regularization,
        edge_keys: v.edges.map((e) => edgeKey(e.axis, e.node)),
        max_abs_residual: v.residuals.reduce((m, r) => Math.max(m, Math.abs(r.residual)), 0),
        residuals: v.residuals.map((r) => ({
          axis: r.axis,
          node: r.node.slice(),
          t: r.t,
          residual: r.residual,
          squared: r.squared,
          normal: roundVec(r.normal, 12),
          hit: roundVec(r.hit, 12),
        })),
      })) : [],
      errors: errs,
    };
    if (extra && extra.warnings) out.warnings = extra.warnings;
    return out;
  }

  function cloneRaw(raw) {
    return JSON.parse(JSON.stringify(raw));
  }

  /** Summary used by tests / UI status. */
  function expectedCounts(model) {
    return {
      vertices: model.vertices.length,
      triangles: model.triangles.length,
      boundary_crossings: model.boundaryCrossings,
      boundary_edges: model.boundaryEdges.length,
      nonmanifold_edges: model.nonmanifoldEdges.length,
    };
  }

  return {
    AXES: AXES,
    DEFAULT_LAMBDA: DEFAULT_LAMBDA,
    LAMBDA_MIN: LAMBDA_MIN,
    LAMBDA_MAX: LAMBDA_MAX,
    validateInput: validateInput,
    extract: extract,
    solveBoxedVertex: solveBoxedVertex,
    toOBJ: toOBJ,
    toDiagnostics: toDiagnostics,
    cloneRaw: cloneRaw,
    expectedCounts: expectedCounts,
    helpers: {
      edgeKey: edgeKey,
      hitWorld: hitWorld,
      nodeWorld: nodeWorld,
      cellEdges: cellEdges,
      quadCells: quadCells,
      flatIndex: flatIndex,
      dot3: dot3,
      sub3: sub3,
      norm3: norm3,
      normalize3: normalize3,
    },
  };
});
