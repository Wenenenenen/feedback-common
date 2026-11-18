/*
 * sdf.js — 保守距离场与 CSG（并/交/差）求值
 *
 * 公式（样例包《格式说明.md》）：
 *   世界点先乘 matrix 逆得到局部点；局部距离场乘该节点 matrix 线性部分
 *   最小奇异值 σ_min，得到该节点世界保守字段（距离下界）。
 *   球   d = |p| - radius
 *   盒   q = abs(p) - half_size
 *        d = |max(q,0)| + min(max(q.x,q.y,q.z), 0)
 *   环面（绕 Y 轴）d = |[ |p.xz| - major, p.y ]| - minor
 *   并 min，交 max，差 max(a, -b)；相等一律取左分支。
 *   差集右分支的叶编号保留，用 negated 标记梯度反向。
 */
(function (global, factory) {
  const deps = (typeof module === 'object' && module.exports)
    ? require('./mat4.js')
    : global.Mat4;
  const mod = factory(deps);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else global.Sdf = mod;
})(typeof self !== 'undefined' ? self : globalThis, function (Mat4) {
  'use strict';

  /*
   * 编译场景：为每个节点预算逆矩阵与 σ_min。
   * 输入应已通过 validate；此处不重复结构校验。
   */
  function compile(data) {
    const compiled = {};
    for (const [id, node] of Object.entries(data.nodes)) {
      let inv = null;
      let sig = 1;
      if (node.matrix) {
        inv = Mat4.inverse(node.matrix);
        sig = Mat4.minSingularValue(node.matrix);
      }
      compiled[id] = {
        id,
        raw: node,
        kind: node.kind,
        inv,
        sig,
        left: node.left || null,
        right: node.right || null,
      };
    }
    return { root: data.root, nodes: compiled };
  }

  // —— 局部距离场（返回数值，不带 CSG 信息） ——
  function localDistance(kind, node, p) {
    const [x, y, z] = p;
    if (kind === 'sphere') {
      return Math.hypot(x, y, z) - node.radius;
    }
    if (kind === 'box') {
      const h = node.half_size;
      const qx = Math.abs(x) - h[0];
      const qy = Math.abs(y) - h[1];
      const qz = Math.abs(z) - h[2];
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      const inside = Math.min(Math.max(qx, qy, qz), 0);
      return outside + inside;
    }
    if (kind === 'torus') {
      const radial = Math.hypot(x, z) - node.major;
      return Math.hypot(radial, y) - node.minor;
    }
    throw new Error(`未知叶节点类型 ${kind}`);
  }

  /*
   * 完整字段求值：返回 { d（世界保守距离）, leaf（命中叶 id）, negated }。
   * negated=true 表示当前字段来自差集右分支，叶编号保留但梯度反向。
   */
  function evalField(tree, nodeId, x, y, z) {
    const n = tree.nodes[nodeId];
    let lx = x, ly = y, lz = z;
    if (n.inv) {
      const lp = Mat4.transformPoint(n.inv, x, y, z);
      lx = lp[0]; ly = lp[1]; lz = lp[2];
    }

    if (n.left === null) {
      // 叶节点：局部场 × σ_min
      const d = localDistance(n.kind, n.raw, [lx, ly, lz]) * n.sig;
      return { d, leaf: nodeId, negated: false };
    }

    // 内部节点：先在本节点局部系递归子树，再按公式组合
    const a = evalField(tree, n.left, lx, ly, lz);
    const b = evalField(tree, n.right, lx, ly, lz);
    let picked;
    if (n.kind === 'union') {
      // 相等取左
      picked = (a.d <= b.d) ? a : b;
    } else if (n.kind === 'intersection') {
      picked = (a.d >= b.d) ? a : b;
    } else {
      // difference：max(a, -b)，相等取左
      const nb = -b.d;
      if (a.d >= nb) picked = a;
      else picked = { d: nb, leaf: b.leaf, negated: !b.negated };
    }

    // 本节点坐标系 → 世界：乘本节点线性部分 σ_min
    picked = { d: picked.d * n.sig, leaf: picked.leaf, negated: picked.negated };
    return picked;
  }

  // 只取距离（渲染热路径，少建对象）
  function evalDistance(tree, nodeId, x, y, z) {
    const n = tree.nodes[nodeId];
    let lx = x, ly = y, lz = z;
    if (n.inv) {
      const lp = Mat4.transformPoint(n.inv, x, y, z);
      lx = lp[0]; ly = lp[1]; lz = lp[2];
    }
    if (n.left === null) {
      return localDistance(n.kind, n.raw, [lx, ly, lz]) * n.sig;
    }
    const a = evalDistance(tree, n.left, lx, ly, lz);
    const b = evalDistance(tree, n.right, lx, ly, lz);
    let d;
    if (n.kind === 'union') d = Math.min(a, b);
    else if (n.kind === 'intersection') d = Math.max(a, b);
    else d = Math.max(a, -b);
    return d * n.sig;
  }

  /*
   * 世界字段中心差分梯度，步长 1e-5（格式说明规定）。
   * 距离带符号，差集内壁的负号已包含在字段里，梯度自动反向。
   * 全零梯度（数值退化）时返回 null，由上层决定兜底法线。
   */
  const GRAD_EPS = 1e-5;
  function gradient(tree, x, y, z) {
    const root = tree.root;
    const gx = evalDistance(tree, root, x + GRAD_EPS, y, z) -
               evalDistance(tree, root, x - GRAD_EPS, y, z);
    const gy = evalDistance(tree, root, x, y + GRAD_EPS, z) -
               evalDistance(tree, root, x, y - GRAD_EPS, z);
    const gz = evalDistance(tree, root, x, y, z + GRAD_EPS) -
               evalDistance(tree, root, x, y, z - GRAD_EPS);
    const n = Mat4.normalize3([gx, gy, gz]);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return null;
    return n;
  }

  // 收集全部叶 id（供着色与编辑器使用）
  function listLeaves(tree) {
    const out = [];
    for (const [id, n] of Object.entries(tree.nodes)) {
      if (n.left === null) out.push(id);
    }
    return out;
  }

  return { compile, evalField, evalDistance, gradient, localDistance, listLeaves, GRAD_EPS };
});
