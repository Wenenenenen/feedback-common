/* 级联阴影（CSM）纯计算：分段、包围范围、稳定化、过渡带、解析阴影。
 * UMD：浏览器挂 window.CSM，Node 测试可 require。不依赖 WebGL。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CSM = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CASCADE_COUNT = 3;

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

  /* 分段：di = (1-λ)(near+(far-near)i/N) + λ·near·(far/near)^(i/N)，i=0..N */
  function computeSplits(near, far, lambda, count = CASCADE_COUNT) {
    const d = [];
    for (let i = 0; i <= count; i++) {
      const lin = near + (far - near) * (i / count);
      const log = near * Math.pow(far / near, i / count);
      d.push((1 - lambda) * lin + lambda * log);
    }
    return d;
  }

  /* 过渡带：以分界 di 为中心，总宽 = transition × min(相邻两级跨度) */
  function computeBands(splits, transition) {
    const w = [];
    for (let i = 1; i < splits.length - 1; i++) {
      const spanPrev = splits[i] - splits[i - 1];
      const spanNext = splits[i + 1] - splits[i];
      w.push(transition * Math.min(spanPrev, spanNext));
    }
    return w;
  }

  function cameraBasis(cam) {
    const f = norm(sub(cam.target, cam.position));
    const r = norm(cross(f, cam.up));
    const u = cross(r, f);
    return { f, r, u };
  }

  /* 视锥切片 [d0,d1]（相机空间正深度）的 8 个世界角点：近平面 4 个 + 远平面 4 个 */
  function frustumSliceCorners(cam, d0, d1) {
    const { f, r, u } = cameraBasis(cam);
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const pts = [];
    for (const d of [d0, d1]) {
      const hh = d * tan;
      const hw = hh * cam.aspect;
      const c = add(cam.position, scale(f, d));
      pts.push(
        add(add(c, scale(r, -hw)), scale(u, -hh)),
        add(add(c, scale(r, hw)), scale(u, -hh)),
        add(add(c, scale(r, hw)), scale(u, hh)),
        add(add(c, scale(r, -hw)), scale(u, hh))
      );
    }
    return pts;
  }

  /* 固定光空间基（只依赖光方向与世界 up，与相机无关）。
   * z = 光传播方向（背离光源），x/y 与之正交，右手系。 */
  function lightBasis(toLight) {
    const L = norm(toLight); // 表面 -> 光源
    const z = scale(L, -1); // 光传播方向
    let x = cross(z, [0, 1, 0]);
    if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = cross(z, [0, 0, 1]);
    x = norm(x);
    const y = cross(z, x);
    return { x, y, z };
  }

  function toLightSpace(basis, p) {
    return [dot(basis.x, p), dot(basis.y, p), dot(basis.z, p)];
  }

  function aabbCorners(min, max) {
    const c = [];
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) c.push([x, y, z]);
    return c;
  }

  /* 全部遮挡物 AABB 在光空间中的最小 z（用于向光源方向扩展深度范围，
   * 使视锥外但能投影到接收范围的遮挡物仍被深度图覆盖）。 */
  function occluderZMin(basis, casters) {
    let zMin = Infinity;
    for (const bb of casters) {
      for (const c of aabbCorners(bb.min, bb.max)) {
        const s = toLightSpace(basis, c);
        if (s[2] < zMin) zMin = s[2];
      }
    }
    return zMin;
  }

  /* 计算一套（3 级）级联。
   * opts: { cam:{position,target,up,fov,aspect,near,far}, splits, toLight,
   *         casters:[{min,max}], resolution, stabilize }
   * 返回 { basis, cascades:[{index,d0,d1,bounds,texel,center}] }。
   * bounds 为光空间正交窗口 {minX,maxX,minY,maxY,minZ,maxZ}；
   * texel 为世界纹素尺寸 [tx,ty]；center 为窗口中心（稳定化时为取整后的值）。 */
  function computeCascadeSet(opts) {
    const { cam, splits, toLight, casters, resolution, stabilize } = opts;
    const basis = lightBasis(toLight);
    const occZ = occluderZMin(basis, casters);
    const cascades = [];
    for (let i = 0; i < splits.length - 1; i++) {
      const d0 = splits[i];
      const d1 = splits[i + 1];
      const corners = frustumSliceCorners(cam, d0, d1).map((p) => toLightSpace(basis, p));
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const c of corners) {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
        if (c[2] < minZ) minZ = c[2];
        if (c[2] > maxZ) maxZ = c[2];
      }
      // 深度范围向光源侧扩展，包住可能投影进接收范围的视锥外遮挡物
      minZ = Math.min(minZ, occZ);
      const zPad = 0.02 * (maxZ - minZ) + 1e-3;
      minZ -= zPad;
      maxZ += zPad;

      const width = maxX - minX;
      const height = maxY - minY;
      let cx = (minX + maxX) / 2;
      let cy = (minY + maxY) / 2;
      const texelX = width / resolution;
      const texelY = height / resolution;
      if (stabilize) {
        // 在固定光空间基中，将 xy 中心按世界纹素尺寸取最近整数（原点对齐纹素网格）
        cx = Math.round(cx / texelX) * texelX;
        cy = Math.round(cy / texelY) * texelY;
      }
      cascades.push({
        index: i,
        d0,
        d1,
        bounds: {
          minX: cx - width / 2, maxX: cx + width / 2,
          minY: cy - height / 2, maxY: cy + height / 2,
          minZ, maxZ,
        },
        texel: [texelX, texelY],
        center: [cx, cy],
      });
    }
    return { basis, cascades };
  }

  /* 按视图深度选择级联；落在过渡带内时返回两级及混合因子 t。 */
  function selectCascade(depth, splits, bands) {
    const n = splits.length - 1;
    for (let i = 1; i < n; i++) {
      const w = bands[i - 1];
      const d = splits[i];
      if (w <= 0) {
        if (depth < d) return { from: i - 1, to: i - 1, t: 0 };
        continue;
      }
      if (depth < d - w / 2) return { from: i - 1, to: i - 1, t: 0 };
      if (depth < d + w / 2) return { from: i - 1, to: i, t: (depth - (d - w / 2)) / w };
    }
    return { from: n - 1, to: n - 1, t: 0 };
  }

  /* 射线与 AABB 求交，返回进入距离 t（不相交返回 null） */
  function rayAABB(origin, dir, min, max) {
    let t0 = 0, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      const inv = 1 / dir[i];
      let a = (min[i] - origin[i]) * inv;
      let b = (max[i] - origin[i]) * inv;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
    return t0;
  }

  /* 解析阴影：从点沿 toLight 方向是否与任一遮挡盒相交。0=阴影，1=受光。 */
  function analyticShadow(point, toLight, boxAABBs) {
    const L = norm(toLight);
    for (const b of boxAABBs) {
      const t = rayAABB(point, L, b.min, b.max);
      if (t !== null && t > 1e-4) return 0;
    }
    return 1;
  }

  return {
    CASCADE_COUNT,
    computeSplits, computeBands, cameraBasis, frustumSliceCorners,
    lightBasis, toLightSpace, aabbCorners, occluderZMin,
    computeCascadeSet, selectCascade, rayAABB, analyticShadow,
    vec: { sub, add, scale, dot, cross, norm },
  };
});
