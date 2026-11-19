/*
 * cluster-core.js — 分簇点光源校验核心算法（无外部依赖，无现成分簇光照组件）
 *
 * 规则来源：samples 内《格式说明.md》
 *  - 视空间 X 右 Y 上 Z 前；对数深度层 z_k = near*(far/near)^(k/slices)，far 归末层
 *  - 六面朝内平面，法线归一化时 d 同比例缩放
 *  - 保守球测试 n·center+d >= -radius-1e-9，全过即入列表，按 id 排序、不截断
 *  - 线性 RGB 光照公式，仅 d<r 求值，d<=1e-10 贡献 0，背景 0
 *
 * UMD 风格：Node 走 module.exports，浏览器挂到 globalThis.ClusterCore。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.ClusterCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPS_PLANE = 1e-9;
  const D2_FLOOR = 1e-4;
  const D_ZERO = 1e-10;
  const MAX_W = 256;
  const MAX_H = 192;
  const MAX_LIGHTS = 1024;

  // ---------- 基础向量工具 ----------
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len3(a) { return Math.hypot(a[0], a[1], a[2]); }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }

  // ---------- 输入校验 ----------
  function validateCase(raw) {
    const errors = [];
    const warnings = [];
    const need = (k) => {
      if (!(k in raw)) errors.push("缺少字段 " + k);
    };
    ["width", "height", "tile_size", "slices", "near", "far", "fov_y",
      "depth", "normals", "albedo", "lights"].forEach(need);
    if (errors.length) return { errors, warnings };

    const W = raw.width, H = raw.height;
    if (!Number.isInteger(W) || W <= 0) errors.push("width 必须为正整数");
    if (!Number.isInteger(H) || H <= 0) errors.push("height 必须为正整数");
    if (W > MAX_W) errors.push("width 超过上限 " + MAX_W);
    if (H > MAX_H) errors.push("height 超过上限 " + MAX_H);
    if (!Number.isInteger(raw.tile_size) || raw.tile_size < 1 || raw.tile_size > 64)
      errors.push("tile_size 必须为 1..64 的整数");
    if (!Number.isInteger(raw.slices) || raw.slices < 1 || raw.slices > 32)
      errors.push("slices 必须为 1..32 的整数");
    if (!(raw.near > 0)) errors.push("near 必须 >0");
    if (!(raw.far > raw.near)) errors.push("far 必须 >near");
    if (!(raw.fov_y > 0 && raw.fov_y < 180)) errors.push("fov_y 角度非法");
    if (errors.length) return { errors, warnings };

    const N = W * H;
    if (!Array.isArray(raw.depth) || raw.depth.length !== N)
      errors.push("depth 数组长度应为 " + N);
    if (!Array.isArray(raw.normals) || raw.normals.length !== N)
      errors.push("normals 数组长度应为 " + N);
    if (!Array.isArray(raw.albedo) || raw.albedo.length !== N)
      errors.push("albedo 数组长度应为 " + N);
    if (!Array.isArray(raw.lights)) errors.push("lights 必须为数组");
    if (errors.length) return { errors, warnings };

    raw.depth.forEach((z, i) => {
      if (z !== null && (typeof z !== "number" || z < raw.near || z > raw.far))
        errors.push("depth[" + i + "] 非 null 且超出 [near,far]");
    });
    raw.normals.forEach((n, i) => {
      if (!Array.isArray(n) || n.length !== 3) {
        errors.push("normals[" + i + "] 应为三元数组");
      } else {
        const l = Math.hypot(n[0], n[1], n[2]);
        if (!(l > 0)) errors.push("normals[" + i + "] 为零向量");
        else if (Math.abs(l - 1) > 1e-4)
          warnings.push("normals[" + i + "] 非单位向量(长度 " + l.toFixed(6) + ")，已归一化");
      }
    });
    raw.albedo.forEach((a, i) => {
      if (!Array.isArray(a) || a.length !== 3 || a.some((v) => typeof v !== "number" || v < 0))
        errors.push("albedo[" + i + "] 应为非负线性 RGB 三元数组");
    });
    if (!Array.isArray(raw.lights) || raw.lights.length > MAX_LIGHTS)
      errors.push("光源数量必须为 0.." + MAX_LIGHTS);

    const ids = new Set();
    (raw.lights || []).forEach((L, i) => {
      if (!Number.isInteger(L.id)) errors.push("lights[" + i + "].id 必须为唯一整数");
      else if (ids.has(L.id)) errors.push("光源 id 重复: " + L.id);
      ids.add(L.id);
      if (!Array.isArray(L.position) || L.position.length !== 3 ||
        L.position.some((v) => typeof v !== "number"))
        errors.push("lights[" + i + "].position 必须为三维数值数组");
      if (typeof L.radius !== "number" || !(L.radius > 0))
        warnings.push("lights[" + i + "](id=" + L.id + ") radius<=0，按无效光源剔除");
      if (!Array.isArray(L.intensity) || L.intensity.length !== 3 ||
        L.intensity.some((v) => typeof v !== "number" || v < 0))
        errors.push("lights[" + i + "].intensity 必须为非负 RGB 三元数组");
    });
    return { errors, warnings };
  }

  // ---------- 簇构建 + 分灯 + 着色 ----------
  function analyze(raw, opts) {
    opts = opts || {};
    const overrides = opts.overrides || new Map();
    const cap = opts.cap || 0; // 仅用于截断诊断；0 表示不截断（规范路径永不截断）

    const W = raw.width, H = raw.height;
    const ts = raw.tile_size, slices = raw.slices;
    const near = raw.near, far = raw.far;
    const tanHalf = Math.tan((raw.fov_y * Math.PI / 180) / 2);
    const aspect = W / H;
    const ntx = Math.ceil(W / ts);
    const nty = Math.ceil(H / ts);
    const N = W * H;

    const edges = [];
    for (let k = 0; k <= slices; k++)
      edges.push(near * Math.pow(far / near, k / slices));

    // 有效光源（radius>0），按 id 排序；位置/半径/强度可被编辑器覆盖
    // overrides: Map<id, {position?:[x,y,z], radius?:number, intensity?:[r,g,b]}>
    const invalidLightIds = [];
    let lights = raw.lights.map((L) => {
      const ov = overrides.get(L.id);
      const radius = ov && ov.radius !== undefined ? ov.radius : L.radius;
      if (!(typeof radius === "number" && radius > 0)) {
        invalidLightIds.push(L.id);
        return null;
      }
      const position = ov && ov.position ? ov.position.slice() : L.position.slice();
      const intensity = ov && ov.intensity ? ov.intensity.slice() : L.intensity.slice();
      return { id: L.id, position, radius, intensity };
    }).filter(Boolean);
    invalidLightIds.sort((a, b) => a - b);
    lights.sort((a, b) => a.id - b.id);
    const ordinalById = new Map(lights.map((L, i) => [L.id, i]));

    // 簇：index = (ty*ntx + tx)*slices + s
    const clusters = [];
    for (let ty = 0; ty < nty; ty++) {
      for (let tx = 0; tx < ntx; tx++) {
        const x0 = tx * ts;
        const x1 = Math.min((tx + 1) * ts, W);
        const y0 = ty * ts;
        const y1 = Math.min((ty + 1) * ts, H);
        const l = (2 * (x0 + 0.5) / W - 1) * tanHalf * aspect;
        const r = (2 * (x1 - 1 + 0.5) / W - 1) * tanHalf * aspect;
        const b = (1 - 2 * (y1 - 1 + 0.5) / H) * tanHalf;
        const t = (1 - 2 * (y0 + 0.5) / H) * tanHalf;
        for (let s = 0; s < slices; s++) {
          const z0 = edges[s], z1 = edges[s + 1];
          const rawPlanes = [
            [1, 0, -l, 0], [-1, 0, r, 0],
            [0, 1, -b, 0], [0, -1, t, 0],
            [0, 0, 1, -z0], [0, 0, -1, z1],
          ];
          // 前三分量归一化，d 一起缩放
          const planes = rawPlanes.map((p) => {
            const inv = 1 / Math.hypot(p[0], p[1], p[2]);
            return [p[0] * inv, p[1] * inv, p[2] * inv, p[3] * inv];
          });
          clusters.push({
            index: (ty * ntx + tx) * slices + s,
            tx, ty, s, x0, x1, y0, y1, z0, z1,
            slopes: { l, r, b, t }, planes,
            members: [], truncatedMembers: [], count: 0,
          });
        }
      }
    }

    // 保守球测试：每个光源对每簇六面
    for (const L of lights) {
      const cx = L.position[0], cy = L.position[1], cz = L.position[2];
      const rad = L.radius, limit = -rad - EPS_PLANE;
      for (const c of clusters) {
        let inside = true;
        for (const p of c.planes) {
          if (p[0] * cx + p[1] * cy + p[2] * cz + p[3] < limit) {
            inside = false;
            break;
          }
        }
        if (inside) c.members.push(L.id);
      }
    }
    for (const c of clusters) {
      c.members.sort((a, b) => a - b);
      c.truncatedMembers = cap > 0 ? c.members.slice(0, cap) : c.members.slice();
      c.count = c.members.length;
    }

    const depth = raw.depth, normalsSrc = raw.normals, albedoSrc = raw.albedo;
    const normals = new Array(N);
    for (let i = 0; i < N; i++) {
      const n = normalsSrc[i];
      const l = Math.hypot(n[0], n[1], n[2]);
      normals[i] = l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
    }

    const pixelCluster = new Int32Array(N).fill(-1);
    const viewX = new Float64Array(N), viewY = new Float64Array(N), viewZ = new Float64Array(N);
    const isBg = new Uint8Array(N);
    const clusterRGB = new Float64Array(N * 3);
    const exhRGB = new Float64Array(N * 3);
    const errRGB = new Float64Array(N * 3);
    const candTests = new Uint32Array(N);
    const actualEvals = new Uint32Array(N);
    const exhTests = new Uint32Array(N);
    const exhEvals = new Uint32Array(N);

    function sliceOf(z) {
      for (let k = 0; k < slices; k++) if (z < edges[k + 1]) return k;
      return slices - 1; // far 归末层
    }

    // 单像素着色；memberMask 为允许参与的光源序号集合
    function shadePixel(px, py, memberSet, outRGB, outTests, outEvals, i) {
      const z = depth[i];
      if (z === null || z === undefined) { isBg[i] = 1; return; }
      const x = (2 * (px + 0.5) / W - 1) * z * tanHalf * aspect;
      const y = (1 - 2 * (py + 0.5) / H) * z * tanHalf;
      viewX[i] = x; viewY[i] = y; viewZ[i] = z;
      const n = normals[i], alb = albedoSrc[i];
      let tests = 0, evals = 0;
      let ar = 0, ag = 0, ab = 0;
      for (let li = 0; li < lights.length; li++) {
        const L = lights[li];
        if (!memberSet.has(L.id)) continue;
        tests++;
        const dx = L.position[0] - x;
        const dy = L.position[1] - y;
        const dz = L.position[2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const r = L.radius;
        if (!(d2 < r * r)) continue; // 仅 d<r 时计算
        evals++;
        const dist = Math.sqrt(d2);
        if (dist <= D_ZERO) continue; // 贡献 0
        const nlRaw = n[0] * dx + n[1] * dy + n[2] * dz;
        const nl = nlRaw / dist;
        if (nl <= 0) continue;
        const falloff = (1 - dist / r) * (1 - dist / r) / Math.max(d2, D2_FLOOR);
        // 每通道：albedo/pi * intensity * N·L * falloff（线性 RGB）
        const base = nl * falloff / Math.PI;
        ar += alb[0] * L.intensity[0] * base;
        ag += alb[1] * L.intensity[1] * base;
        ab += alb[2] * L.intensity[2] * base;
      }
      outRGB[i * 3] = ar; outRGB[i * 3 + 1] = ag; outRGB[i * 3 + 2] = ab;
      if (outTests) outTests[i] = tests;
      if (outEvals) outEvals[i] = evals;
    }

    const allIds = new Set(lights.map((L) => L.id));
    let maxErr = 0, sumErr = 0;
    let totalCandTests = 0, totalActualEvals = 0;
    let totalExhTests = 0, totalExhEvals = 0;
    const clusterCounts = clusters.map((c) => c.count);

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const z = depth[i];
        if (z === null || z === undefined) { isBg[i] = 1; continue; }
        const tx = Math.min(Math.floor(px / ts), ntx - 1);
        const ty = Math.min(Math.floor(py / ts), nty - 1);
        const s = sliceOf(z);
        const cidx = (ty * ntx + tx) * slices + s;
        pixelCluster[i] = cidx;
        const memberSet = cap > 0
          ? new Set(clusters[cidx].truncatedMembers)
          : new Set(clusters[cidx].members);
        shadePixel(px, py, memberSet, clusterRGB, candTests, actualEvals, i);
        shadePixel(px, py, allIds, exhRGB, exhTests, exhEvals, i);
        const e0 = Math.abs(exhRGB[i * 3] - clusterRGB[i * 3]);
        const e1 = Math.abs(exhRGB[i * 3 + 1] - clusterRGB[i * 3 + 1]);
        const e2 = Math.abs(exhRGB[i * 3 + 2] - clusterRGB[i * 3 + 2]);
        errRGB[i * 3] = e0; errRGB[i * 3 + 1] = e1; errRGB[i * 3 + 2] = e2;
        const eMax = Math.max(e0, e1, e2);
        if (eMax > maxErr) maxErr = eMax;
        sumErr += e0 + e1 + e2;
        totalCandTests += candTests[i];
        totalActualEvals += actualEvals[i];
        totalExhTests += exhTests[i];
        totalExhEvals += exhEvals[i];
      }
    }

    return {
      meta: {
        W, H, ts, slices, near, far, fovY: raw.fov_y, tanHalf, aspect,
        ntx, nty, nClusters: clusters.length, edges, cap,
      },
      raw, lights, invalidLightIds, ordinalById, clusters, clusterCounts,
      depth, normals, isBg, pixelCluster, viewX, viewY, viewZ,
      clusterRGB, exhRGB, errRGB,
      candTests, actualEvals, exhTests, exhEvals,
      maxError: maxErr,
      meanError: sumErr / (N * 3),
      totals: {
        candidateTests: totalCandTests,
        actualEvaluations: totalActualEvals,
        exhaustiveTests: totalExhTests,
        exhaustiveEvaluations: totalExhEvals,
      },
    };
  }

  // 单像素逐灯明细（候选灯 + 每灯贡献 + 未入选原因）
  function pixelDetail(res, px, py) {
    const { W, H, tanHalf, aspect } = res.meta;
    const i = py * W + px;
    const z = res.depth[i];
    if (z === null || z === undefined) {
      return { px, py, background: true, clusterIndex: -1, rows: [] };
    }
    const x = res.viewX[i], y = res.viewY[i], zz = res.viewZ[i];
    const cidx = res.pixelCluster[i];
    const cluster = res.clusters[cidx];
    const memberSet = new Set(cluster.members);
    const n = res.normals[i], alb = res.raw.albedo[i];
    const rows = res.lights.map((L) => {
      const dx = L.position[0] - x, dy = L.position[1] - y, dz = L.position[2] - zz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(d2);
      const inList = memberSet.has(L.id);
      const within = d2 < L.radius * L.radius;
      let nl = 0, falloff = 0;
      const contribution = [0, 0, 0];
      let reason;
      if (!inList) reason = "未通过簇球测试";
      else if (!within) reason = "d>=r，不求值";
      else if (dist <= D_ZERO) reason = "d<=1e-10，贡献0";
      else {
        nl = (n[0] * dx + n[1] * dy + n[2] * dz) / dist;
        if (nl <= 0) reason = "背向(N·L<=0)";
        else {
          falloff = (1 - dist / L.radius) * (1 - dist / L.radius) /
            Math.max(d2, D2_FLOOR);
          reason = "有贡献";
          const base = nl * falloff / Math.PI;
          contribution[0] = alb[0] * L.intensity[0] * base;
          contribution[1] = alb[1] * L.intensity[1] * base;
          contribution[2] = alb[2] * L.intensity[2] * base;
        }
      }
      return {
        id: L.id, inList, within, distance: dist, d2,
        nl, falloff, contribution,
        contributionMag: contribution[0] + contribution[1] + contribution[2],
        reason,
      };
    });
    return {
      px, py, background: false, clusterIndex: cidx,
      viewPos: [x, y, zz], normal: n, albedo: alb,
      clusterRGB: [res.clusterRGB[i * 3], res.clusterRGB[i * 3 + 1], res.clusterRGB[i * 3 + 2]],
      exhRGB: [res.exhRGB[i * 3], res.exhRGB[i * 3 + 1], res.exhRGB[i * 3 + 2]],
      candidateTests: res.candTests[i],
      actualEvaluations: res.actualEvals[i],
      exhaustiveEvaluations: res.exhEvals[i],
      rows,
    };
  }

  // 簇视空间八顶点（z 两层，x/y 由射线斜率*z 得到）
  function clusterCorners(c) {
    const { l, r, b, t } = c.slopes;
    const z0 = c.z0, z1 = c.z1;
    const mk = (x, y, z) => [x, y, z];
    return [
      mk(l * z0, b * z0, z0), mk(r * z0, b * z0, z0),
      mk(r * z0, t * z0, z0), mk(l * z0, t * z0, z0),
      mk(l * z1, b * z1, z1), mk(r * z1, b * z1, z1),
      mk(r * z1, t * z1, z1), mk(l * z1, t * z1, z1),
    ];
  }

  // 光源投影到场景屏幕；z<=0 返回 null（相机内/相机后）
  function projectLight(res, L) {
    const { tanHalf, aspect, W, H } = res.meta;
    const z = L.position[2];
    if (!(z > 0)) return null;
    const ndcX = L.position[0] / (z * tanHalf * aspect);
    const ndcY = L.position[1] / (z * tanHalf);
    return {
      px: (ndcX + 1) / 2 * W,
      py: (1 - ndcY) / 2 * H,
      onScreen: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
      radiusPx: L.radius / (z * tanHalf) * H / 2,
      behind: false,
    };
  }

  // 屏幕像素 + 固定 z 反算视空间点（用于 2D 拖拽）
  function unprojectPixel(res, px, py, z) {
    const { tanHalf, aspect, W, H } = res.meta;
    return [
      (2 * (px + 0.5) / W - 1) * z * tanHalf * aspect,
      (1 - 2 * (py + 0.5) / H) * z * tanHalf,
      z,
    ];
  }

  // 显示用：线性 -> Reinhard tonemap -> sRGB（0..255）
  function linearToSRGB255(c) {
    const tm = c / (1 + c);
    const v = tm <= 0.0031308 ? 12.92 * tm : 1.055 * Math.pow(tm, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  return {
    EPS_PLANE, D2_FLOOR, D_ZERO, MAX_W, MAX_H, MAX_LIGHTS,
    vec: { sub, dot, len3, scale, cross, normalize },
    validateCase, analyze, pixelDetail,
    clusterCorners, projectLight, unprojectPixel, linearToSRGB255,
  };
});
