/*
 * raymarch.js — 球步进（sphere tracing）求交
 *
 * 约定（格式说明）：
 *   方向输入后归一化；t 为世界长度，域 [0, 20]；
 *   每步推进 |d|（保守下界，含内部负场的 |d|）；
 *   |d| <= 1e-4 记 hit；t 超过 20 记 miss；步数耗尽记 iteration_limit，
 *   两者必须区分。起点在实体内部或差集空腔内同样适用。
 */
(function (global, factory) {
  const deps = (typeof module === 'object' && module.exports)
    ? { Mat4: require('./mat4.js'), Sdf: require('./sdf.js') }
    : { Mat4: global.Mat4, Sdf: global.Sdf };
  const mod = factory(deps.Mat4, deps.Sdf);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else global.RayMarch = mod;
})(typeof self !== 'undefined' ? self : globalThis, function (Mat4, Sdf) {
  'use strict';

  const T_MAX = 20;
  const HIT_EPSILON = 1e-4;
  const DEFAULT_MAX_STEPS = 512;
  const MIN_STEPS = 1;
  const MAX_STEPS_LIMIT = 4096;

  function normalizeMaxSteps(v) {
    let n = Number(v);
    if (!Number.isFinite(n) || n < MIN_STEPS) n = DEFAULT_MAX_STEPS;
    return Math.min(Math.max(Math.round(n), MIN_STEPS), MAX_STEPS_LIMIT);
  }

  /*
   * 完整步进，保留每步采样与命中元数据（拾取 / 批量交付用）。
   * ray: { id?, origin:[x,y,z], direction:[x,y,z]（会被归一化） }
   * 返回：
   *   hit:  { status:'hit', t, point, leaf, negated, distance, normal, steps, samples }
   *   miss: { status:'miss', t, steps, samples }
   *   耗尽: { status:'iteration_limit', t, steps, lastDistance, samples }
   */
  function trace(tree, ray, options) {
    const maxSteps = normalizeMaxSteps(options && options.maxSteps);
    const hitEps = options && Number.isFinite(options.hitEpsilon) ? options.hitEpsilon : HIT_EPSILON;
    const tMax = options && Number.isFinite(options.tMax) ? options.tMax : T_MAX;

    const dir = Mat4.normalize3(ray.direction);
    let t = 0;
    const samples = [];
    let lastField = null;

    for (let step = 1; step <= maxSteps; step++) {
      const x = ray.origin[0] + dir[0] * t;
      const y = ray.origin[1] + dir[1] * t;
      const z = ray.origin[2] + dir[2] * t;
      const f = Sdf.evalField(tree, tree.root, x, y, z);
      lastField = f;
      const d = f.d;
      samples.push({ step, t, d, leaf: f.leaf, negated: f.negated });

      if (Math.abs(d) <= hitEps) {
        const point = [x, y, z];
        const normal = Sdf.gradient(tree, x, y, z) || [0, 0, 0];
        return {
          status: 'hit',
          t,
          point,
          leaf: f.leaf,
          negated: f.negated,
          distance: d,
          normal,
          steps: step,
          samples,
        };
      }

      t += Math.abs(d);
      if (t > tMax) {
        return { status: 'miss', t: tMax, steps: step, lastDistance: d, samples };
      }
    }

    return {
      status: 'iteration_limit',
      t,
      steps: maxSteps,
      lastDistance: lastField ? lastField.d : null,
      lastLeaf: lastField ? lastField.leaf : null,
      samples,
    };
  }

  /*
   * 渲染热路径：只返回状态与颜色着色所需的最小信息。
   * 命中时顺带返回叶 id 与 negated，供按节点着色。
   */
  function traceShade(tree, origin, dirNorm, maxSteps) {
    const maxS = normalizeMaxSteps(maxSteps);
    let t = 0;
    for (let step = 0; step < maxS; step++) {
      const x = origin[0] + dirNorm[0] * t;
      const y = origin[1] + dirNorm[1] * t;
      const z = origin[2] + dirNorm[2] * t;
      const f = Sdf.evalField(tree, tree.root, x, y, z);
      const d = f.d;
      if (Math.abs(d) <= HIT_EPSILON) {
        const normal = Sdf.gradient(tree, x, y, z) || [0, 0, 0];
        return { status: 'hit', t, point: [x, y, z], normal, leaf: f.leaf, negated: f.negated };
      }
      t += Math.abs(d);
      if (t > T_MAX) return { status: 'miss', t: T_MAX };
    }
    return { status: 'iteration_limit', t };
  }

  return {
    trace, traceShade,
    T_MAX, HIT_EPSILON, DEFAULT_MAX_STEPS, MIN_STEPS, MAX_STEPS_LIMIT,
    normalizeMaxSteps,
  };
});
