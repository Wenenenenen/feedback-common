/*
 * validate.js — 场景 JSON 结构与语义校验
 * 规则全部来自样例包《格式说明.md》：
 *   单父、无环、深度 ≤ 16、叶 ≤ 64；
 *   叶参数均正；matrix 为行主序可逆仿射 4×4；
 *   射线方向须为有限向量且可归一化，t 域固定 [0,20]。
 * 所有问题都带具体节点 id / 射线 id 汇总返回，不做“首错即停”。
 */
(function (global, factory) {
  const deps = (typeof module === 'object' && module.exports)
    ? require('./mat4.js')
    : global.Mat4;
  const mod = factory(deps);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else global.SdfValidate = mod;
})(typeof self !== 'undefined' ? self : globalThis, function (Mat4) {
  'use strict';

  const LEAF_KINDS = new Set(['sphere', 'box', 'torus']);
  const INTERNAL_KINDS = new Set(['union', 'intersection', 'difference']);
  const MAX_DEPTH = 16;          // 根深度为 1 时的最大深度
  const MAX_LEAVES = 64;

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function validateScene(data) {
    const errors = [];
    const warnings = [];
    const push = (node, message) => errors.push({ node: node || null, message });

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, errors: [{ node: null, message: '顶层必须是对象，包含 nodes、root、rays' }], warnings };
    }

    const nodes = data.nodes;
    const root = data.root;
    const rays = data.rays;

    if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) {
      push(null, 'nodes 必须是节点字典（对象）');
    }
    if (typeof root !== 'string') {
      push(null, 'root 必须是节点 id 字符串');
    } else if (nodes && !Object.prototype.hasOwnProperty.call(nodes, root)) {
      push(null, `root 引用了不存在的节点 "${root}"`);
    }
    if (!Array.isArray(rays)) {
      push(null, 'rays 必须是数组');
    }

    const nodeIds = nodes ? Object.keys(nodes) : [];
    const matrices = {};   // id -> 已确认形状合法的 matrix（可逆性另行记录）
    const parents = {};    // id -> 父 id（单父检查）

    for (const id of nodeIds) {
      const n = nodes[id];
      if (n === null || typeof n !== 'object' || Array.isArray(n)) {
        push(id, '节点必须是对象');
        continue;
      }
      const kind = n.kind;
      if (LEAF_KINDS.has(kind)) {
        if (kind === 'sphere') {
          if (!isFiniteNumber(n.radius)) push(id, 'sphere 缺少数值型 radius');
          else if (!(n.radius > 0)) push(id, `radius 必须为正数，当前为 ${n.radius}`);
        } else if (kind === 'box') {
          const h = n.half_size;
          if (!Array.isArray(h) || h.length !== 3) {
            push(id, 'box 的 half_size 必须是长度 3 的数组');
          } else {
            h.forEach((v, axis) => {
              if (!isFiniteNumber(v)) push(id, `half_size[${axis}] 必须是有限数值`);
              else if (!(v > 0)) push(id, `half_size[${axis}] 必须为正数，当前为 ${v}`);
            });
          }
        } else if (kind === 'torus') {
          for (const key of ['major', 'minor']) {
            if (!isFiniteNumber(n[key])) push(id, `torus 缺少数值型 ${key}`);
            else if (!(n[key] > 0)) push(id, `${key} 必须为正数，当前为 ${n[key]}`);
          }
        }
        if (n.left !== undefined || n.right !== undefined) {
          warnings.push({ node: id, message: '叶节点上的 left/right 字段会被忽略' });
        }
      } else if (INTERNAL_KINDS.has(kind)) {
        for (const side of ['left', 'right']) {
          const ref = n[side];
          if (typeof ref !== 'string') {
            push(id, `${kind} 缺少字符串类型的 ${side} 引用`);
          } else if (nodes && !Object.prototype.hasOwnProperty.call(nodes, ref)) {
            push(id, `${kind} 的 ${side} 引用了不存在的节点 "${ref}"`);
          } else if (nodes) {
            if (parents[ref] !== undefined && parents[ref] !== id) {
              push(ref, `节点同时被 "${parents[ref]}" 和 "${id}" 引用，树只允许单父`);
            }
            parents[ref] = id;
          }
        }
      } else {
        push(id, `未知 kind "${String(kind)}"，允许值：sphere/box/torus/union/intersection/difference`);
      }

      // matrix：可选；缺省单位
      if (n.matrix !== undefined) {
        const mm = n.matrix;
        if (!Array.isArray(mm) || mm.length !== 16 || mm.some((v) => !isFiniteNumber(v))) {
          push(id, 'matrix 必须是 16 个有限数值（行主序 4×4）');
        } else {
          const lastRow = [mm[12], mm[13], mm[14], mm[15]];
          const isAffine = Math.abs(mm[12]) < 1e-12 && Math.abs(mm[13]) < 1e-12 &&
            Math.abs(mm[14]) < 1e-12 && Math.abs(mm[15] - 1) < 1e-12;
          if (!isAffine) {
            push(id, `matrix 末行必须为 [0,0,0,1]，当前为 [${lastRow.map((v) => round(v)).join(', ')}]`);
          }
          const inv = Mat4.inverse(mm);
          if (inv === null) {
            push(id, 'matrix 是奇异矩阵（线性部分不可逆），无法把世界点变换回局部坐标系');
          } else {
            const sig = Mat4.minSingularValue(mm);
            if (sig < 1e-9) {
              push(id, `matrix 线性部分最小奇异值仅 ${sig.toExponential(2)}，视为奇异/近奇异变换`);
            }
            matrices[id] = mm;
          }
        }
      }
    }

    // 树结构：从 root 做迭代三色 DFS，检测自引用 / 环 / 深度 / 叶数
    // 状态 0=未访问，1=在当前祖先链上，2=整棵子树已完成
    let leafCount = 0;
    let maxDepthSeen = 0;
    if (nodes && typeof root === 'string' && Object.prototype.hasOwnProperty.call(nodes, root)) {
      const state = new Map();
      const stack = [{ id: root, depth: 1 }];
      let acyclic = true;
      while (stack.length && acyclic) {
        const { id, depth, done } = stack.pop();
        if (done) { state.set(id.slice(8), 2); continue; }
        const node = nodes[id];
        if (node === undefined) { acyclic = false; break; } // 引用错误已在前面登记
        const st = state.get(id) || 0;
        if (st === 1) {
          push(id, '引用形成环，该节点在自身祖先链上被再次访问');
          acyclic = false;
          break;
        }
        if (st === 2) continue;
        state.set(id, 1);
        maxDepthSeen = Math.max(maxDepthSeen, depth);
        if (depth > MAX_DEPTH) {
          push(id, `节点位于深度 ${depth}，超过最大深度 ${MAX_DEPTH}`);
        }
        if (LEAF_KINDS.has(node.kind)) {
          leafCount++;
          state.set(id, 2);
        } else if (INTERNAL_KINDS.has(node.kind)) {
          const refs = [node.left, node.right].filter((r) => typeof r === 'string' && r in nodes);
          // 收尾帧：子树全部处理完后把本节点标记为完成
          stack.push({ id: `__done:${id}`, depth, done: true });
          for (const r of refs) stack.push({ id: r, depth: depth + 1 });
        } else {
          state.set(id, 2); // 未知 kind，已登记
        }
      }
      if (acyclic) {
        if (leafCount > MAX_LEAVES) {
          push(null, `树中叶节点数为 ${leafCount}，超过上限 ${MAX_LEAVES}`);
        }
        for (const id of nodeIds) {
          if ((state.get(id) || 0) === 0) {
            warnings.push({ node: id, message: '节点未被 root 可达，不会参与求值' });
          }
        }
      }
    }

    // 射线
    if (Array.isArray(rays)) {
      const seenIds = new Set();
      rays.forEach((ray, i) => {
        const rid = ray && typeof ray.id === 'string' ? ray.id : `#${i}`;
        if (ray === null || typeof ray !== 'object') {
          push(null, `射线 ${rid} 必须是对象`);
          return;
        }
        if (typeof ray.id !== 'string' || ray.id.length === 0) {
          push(null, `第 ${i} 条射线缺少字符串 id`);
        } else if (seenIds.has(ray.id)) {
          push(null, `射线 id "${ray.id}" 重复`);
        } else {
          seenIds.add(ray.id);
        }
        const vec = (v, name) => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
        if (!vec(ray.origin)) push(null, `射线 "${rid}" 的 origin 必须是 3 个有限数`);
        if (!vec(ray.direction)) {
          push(null, `射线 "${rid}" 的 direction 必须是 3 个有限数`);
        } else {
          const len = Mat4.length3(ray.direction);
          if (len <= 1e-12) push(null, `射线 "${rid}" 的 direction 是零向量，无法归一化`);
        }
      });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      stats: { leafCount, maxDepth: maxDepthSeen },
      validMatrices: matrices,
    };
  }

  function round(v) {
    return Math.abs(v) >= 1e-4 || v === 0 ? Number(v.toFixed(4)) : Number(v).toExponential(2);
  }

  return { validateScene, LEAF_KINDS, INTERNAL_KINDS, MAX_DEPTH, MAX_LEAVES };
});
