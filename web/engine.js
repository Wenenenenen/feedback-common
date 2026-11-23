/*
 * deep-interval-compositor 核心引擎（无依赖，Float64 全精度）。
 *
 * 同一份代码可在三处运行：
 *   - Node 单元测试（module.exports / require）
 *   - 浏览器主线程 <script>（挂到 window.DicEngine）
 *   - Blob 内联 Worker（由 app.js 把本文件源码拼进 Worker 工厂）
 *
 * 物理模型（视线沿 +z 方向，由近及远）：
 *   体积段 [z0,z1) 内活跃介质集合恒定，总消光 σ = Σσᵢ，
 *   段源颜色 C = Σσᵢ·rgbᵢ / σ（σ=0 时该段无贡献），
 *   段透射 T_out = T_in·exp(−σ·Δz)，
 *   体积吸收份额 = T_in·(1 − exp(−σ·Δz))，
 *   预乘颜色贡献 = T_in·(1 − exp(−σ·Δz))·C。
 *   表面吸收份额 = T_in·a，预乘贡献 = T_in·a·rgb。
 *   遮挡样本（holdout）把透射率切断为 0，自身不进入 A 与 RGB。
 *
 * 同深度事件次序：体积结束 → holdout → 按编号排列的表面 → 体积开始。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DicEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 层类型编码
  const T_VOLUME = 0;
  const T_SURFACE = 1;
  const T_HOLDOUT = 2;

  // 事件 kind（独立于层类型编号）
  const K_END = 0;      // 体积结束
  const K_HOLDOUT = 1;  // 遮挡样本
  const K_SURFACE = 2;  // 表面
  const K_START = 3;    // 体积开始

  // 每层层记录占用的定长槽位
  const I_TYPE = 0;   // Int32 槽 0：类型
  const I_ID = 1;     // Int32 槽 1：记录 id
  const I_STRIDE = 2;
  const F_Z0 = 0;     // Float64 槽 0：volume z0 / surface、holdout 的 z
  const F_Z1 = 1;     // Float64 槽 1：volume z1（其余类型为空槽）
  const F_SIGMA = 2;  // Float64 槽 2：sigma / surface 的 a
  const F_R = 3;      // Float64 槽 3..5：线性直色 rgb
  // F_G = 4, F_B = 5
  const F_STRIDE = 6;

  class ValidationError extends Error {
    constructor(message, path) {
      super(path ? `${message}（位置：${path}）` : message);
      this.name = 'ValidationError';
      this.path = path || null;
    }
  }

  const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isNonNegFinite = (v) => isFiniteNum(v) && v >= 0;
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  function fail(msg, path) {
    throw new ValidationError(msg, path);
  }

  // 带位置的 JSON 解析：把 JSON.parse 的行列号翻译成记录位置描述。
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      if (!m) throw new ValidationError('JSON 解析失败：' + e.message, '$');
      const pos = Number(m[1]);
      let line = 1, col = 1;
      for (let i = 0; i < pos && i < text.length; i++) {
        if (text[i] === '\n') { line++; col = 1; } else col++;
      }
      throw new ValidationError(
        'JSON 语法错误', `第 ${line} 行第 ${col} 列（字符偏移 ${pos}）`);
    }
  }

  /* ------------------------------------------------------------------
   * 解析 + 校验 + 定长打包。
   * 返回 {
   *   width, height,
   *   offsets: Int32Array(W*H+1)  像素 p 的层位于 [offsets[p], offsets[p+1])
   *   itypes:  Int32Array(n*2)
   *   fvals:   Float64Array(n*6)
   *   layerCount
   * }
   * ------------------------------------------------------------------ */
  function parseAndPack(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      fail('根节点必须是 JSON 对象', '$');
    }
    if (!isInt(data.width) || data.width <= 0) {
      fail('width 必须是正整数', '$.width');
    }
    if (!isInt(data.height) || data.height <= 0) {
      fail('height 必须是正整数', '$.height');
    }
    const W = data.width, H = data.height;
    const N = W * H;
    if (!Array.isArray(data.pixels)) {
      fail('pixels 必须是数组', '$.pixels');
    }

    // 第一遍：统计每个像素的层数，顺便做结构校验
    const counts = new Int32Array(N);
    let totalLayers = 0;
    const seen = new Set();
    const seenPixel = new Set();

    for (let pi = 0; pi < data.pixels.length; pi++) {
      const pp = `$.pixels[${pi}]`;
      const px = data.pixels[pi];
      if (px === null || typeof px !== 'object' || Array.isArray(px)) {
        fail('像素记录必须是对象', pp);
      }
      if (!isInt(px.x) || px.x < 0 || px.x >= W) {
        fail(`x 必须是 [0, ${W - 1}] 内的整数`, `${pp}.x`);
      }
      if (!isInt(px.y) || px.y < 0 || px.y >= H) {
        fail(`y 必须是 [0, ${H - 1}] 内的整数`, `${pp}.y`);
      }
      const pidx = px.y * W + px.x;
      if (seenPixel.has(pidx)) {
        fail(`像素坐标重复：(${px.x},${px.y}) 出现了多次`, pp);
      }
      seenPixel.add(pidx);
      if (!Array.isArray(px.layers)) {
        fail('layers 必须是数组', `${pp}.layers`);
      }
      seen.clear();
      for (let li = 0; li < px.layers.length; li++) {
        const lp = `${pp}.layers[${li}]`;
        const L = px.layers[li];
        if (L === null || typeof L !== 'object' || Array.isArray(L)) {
          fail('层记录必须是对象', lp);
        }
        if (!isInt(L.id) || L.id < 0) {
          fail('id 必须是非负整数', `${lp}.id`);
        }
        if (seen.has(L.id)) {
          fail(`像素内 id 重复：${L.id}`, `${lp}.id`);
        }
        seen.add(L.id);

        if (L.type === 'volume') {
          if (!isInt(L.z0) || !isInt(L.z1)) {
            fail('volume 的 z0、z1 必须是整数', lp);
          }
          if (!(L.z0 < L.z1)) {
            fail('volume 要求 z0 < z1', lp);
          }
          if (!isNonNegFinite(L.sigma)) {
            fail('sigma 必须是有限非负数', `${lp}.sigma`);
          }
          checkRgb(L, lp);
        } else if (L.type === 'surface') {
          if (!isInt(L.z)) {
            fail('surface 的 z 必须是整数', `${lp}.z`);
          }
          if (!(isFiniteNum(L.a) && L.a >= 0 && L.a <= 1)) {
            fail('a 必须是 0 到 1 之间的有限数', `${lp}.a`);
          }
          checkRgb(L, lp);
        } else if (L.type === 'holdout') {
          if (!isInt(L.z)) {
            fail('holdout 的 z 必须是整数', `${lp}.z`);
          }
        } else {
          fail(`未知层类型：${String(L.type)}`, `${lp}.type`);
        }
        totalLayers++;
      }
      counts[pidx] += px.layers.length;
    }

    // 前缀和 → 偏移
    const offsets = new Int32Array(N + 1);
    for (let p = 0; p < N; p++) offsets[p + 1] = offsets[p] + counts[p];

    const itypes = new Int32Array(totalLayers * I_STRIDE);
    const fvals = new Float64Array(totalLayers * F_STRIDE);
    const cursor = new Int32Array(offsets); // 每个像素当前填充位置

    for (let pi = 0; pi < data.pixels.length; pi++) {
      const px = data.pixels[pi];
      const pidx = px.y * W + px.x;
      for (let li = 0; li < px.layers.length; li++) {
        const L = px.layers[li];
        const slot = cursor[pidx]++;
        const ib = slot * I_STRIDE;
        const fb = slot * F_STRIDE;
        if (L.type === 'volume') {
          itypes[ib + I_TYPE] = T_VOLUME;
          itypes[ib + I_ID] = L.id;
          fvals[fb + F_Z0] = L.z0;
          fvals[fb + F_Z1] = L.z1;
          fvals[fb + F_SIGMA] = L.sigma;
          fvals[fb + F_R] = L.rgb[0];
          fvals[fb + F_R + 1] = L.rgb[1];
          fvals[fb + F_R + 2] = L.rgb[2];
        } else if (L.type === 'surface') {
          itypes[ib + I_TYPE] = T_SURFACE;
          itypes[ib + I_ID] = L.id;
          fvals[fb + F_Z0] = L.z;
          fvals[fb + F_SIGMA] = L.a;
          fvals[fb + F_R] = L.rgb[0];
          fvals[fb + F_R + 1] = L.rgb[1];
          fvals[fb + F_R + 2] = L.rgb[2];
        } else {
          itypes[ib + I_TYPE] = T_HOLDOUT;
          itypes[ib + I_ID] = L.id;
          fvals[fb + F_Z0] = L.z;
        }
      }
    }

    return {
      width: W,
      height: H,
      offsets,
      itypes,
      fvals,
      layerCount: totalLayers,
    };
  }

  function checkRgb(L, lp) {
    if (!Array.isArray(L.rgb) || L.rgb.length !== 3) {
      fail('rgb 必须是长度 3 的数组', `${lp}.rgb`);
    }
    for (let c = 0; c < 3; c++) {
      if (!isNonNegFinite(L.rgb[c])) {
        fail('rgb 分量必须是有限非负数', `${lp}.rgb[${c}]`);
      }
    }
  }

  /* ------------------------------------------------------------------
   * 事件键：同深度次序
   *   体积结束(kind 0) → holdout(kind 1) → surface(kind 2，按 id) → 体积开始(kind 3)
   * 主排序键 = z*4 + kind（z 为整数，双精度内精确）；
   * 同深度同 kind 时用 id 作为次排序键（仅 surface 次序有意义）。
   * 事件载荷 = slot*4 + kind（slot 为打包层序号，4 进制无歧义）。
   * ------------------------------------------------------------------ */
  function eventKey(z, kind) {
    return z * 4 + kind;
  }

  /* ------------------------------------------------------------------
   * 单像素合成。返回 { r, g, b, A, T }，全部 Float64。
   * active/events/order 为可复用的临时数组（减少 GC）。
   * ------------------------------------------------------------------ */
  function compositePixel(pack, p, scratch) {
    const { offsets, itypes, fvals } = pack;
    const lo = offsets[p], hi = offsets[p + 1];
    const active = scratch.active;
    const keys = scratch.keys;
    const idKeys = scratch.idKeys;
    const payloads = scratch.payloads;
    const order = scratch.order;

    let ne = 0;
    for (let s = lo; s < hi; s++) {
      const ib = s * I_STRIDE;
      const fb = s * F_STRIDE;
      const t = itypes[ib + I_TYPE];
      const id = itypes[ib + I_ID];
      if (t === T_VOLUME) {
        keys[ne] = eventKey(fvals[fb + F_Z0], K_START);
        idKeys[ne] = id; payloads[ne] = s * 4 + K_START; ne++;
        keys[ne] = eventKey(fvals[fb + F_Z1], K_END);
        idKeys[ne] = id; payloads[ne] = s * 4 + K_END; ne++;
      } else if (t === T_SURFACE) {
        keys[ne] = eventKey(fvals[fb + F_Z0], K_SURFACE);
        idKeys[ne] = id; payloads[ne] = s * 4 + K_SURFACE; ne++;
      } else {
        keys[ne] = eventKey(fvals[fb + F_Z0], K_HOLDOUT);
        idKeys[ne] = id; payloads[ne] = s * 4 + K_HOLDOUT; ne++;
      }
    }
    order.length = ne;
    for (let i = 0; i < ne; i++) order[i] = i;
    order.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1
      : idKeys[a] - idKeys[b]));

    let T = 1;
    let r = 0, g = 0, b = 0, A = 0;
    active.length = 0;
    let prevZ = null;

    const integrate = (z0, z1) => {
      const dt = z1 - z0;
      if (dt <= 0 || active.length === 0 || T === 0) return;
      let sigma = 0;
      let sr = 0, sg = 0, sb = 0;
      for (const slot of active) {
        const f2 = slot * F_STRIDE;
        const sig = fvals[f2 + F_SIGMA];
        sigma += sig;
        sr += sig * fvals[f2 + F_R];
        sg += sig * fvals[f2 + F_R + 1];
        sb += sig * fvals[f2 + F_R + 2];
      }
      if (sigma <= 0) return;
      const trans = Math.exp(-sigma * dt);
      const absorb = T * (1 - trans);           // 本体积段吸收份额
      r += absorb * (sr / sigma);
      g += absorb * (sg / sigma);
      b += absorb * (sb / sigma);
      A += absorb;
      T *= trans;
    };

    for (let oi = 0; oi < ne; oi++) {
      const code = payloads[order[oi]];
      const slot = (code - (code % 4)) / 4;
      const kind = code % 4;
      const ib = slot * I_STRIDE;
      const fb = slot * F_STRIDE;
      const t = itypes[ib + I_TYPE];
      const z = (t === T_VOLUME && kind === K_START) ? fvals[fb + F_Z0]
        : (t === T_VOLUME ? fvals[fb + F_Z1] : fvals[fb + F_Z0]);

      if (prevZ !== null && z > prevZ) integrate(prevZ, z);

      if (kind === K_END) { // 体积结束
        for (let k = active.length - 1; k >= 0; k--) {
          if (active[k] === slot) { active.splice(k, 1); break; }
        }
      } else if (kind === K_SURFACE) { // surface
        if (T > 0) {
          const a = fvals[fb + F_SIGMA];
          const share = T * a;
          r += share * fvals[fb + F_R];
          g += share * fvals[fb + F_R + 1];
          b += share * fvals[fb + F_R + 2];
          A += share;
          T *= 1 - a;
        }
      } else if (kind === K_HOLDOUT) { // holdout：切断后方透射，不进 A/RGB
        T = 0;
      } else { // kind === K_START：体积开始
        active.push(slot);
      }
      prevZ = z;
    }

    return { r, g, b, A, T };
  }

  /* ------------------------------------------------------------------
   * 全帧合成。frame 为可选复用缓冲（Float64Array(4N)）。
   * 返回 { rgba: Float64Array(4N) 线性预乘, A: Float64Array(N), T: Float64Array(N) }
   * ------------------------------------------------------------------ */
  function compositeFrame(pack, frame) {
    const N = pack.width * pack.height;
    const rgba = frame && frame.rgba ? frame.rgba : new Float64Array(N * 4);
    const A = frame && frame.A ? frame.A : new Float64Array(N);
    const T = frame && frame.T ? frame.T : new Float64Array(N);
    const maxLayers = maxPixelLayers(pack);
    const scratch = {
      active: [],
      keys: new Float64Array(maxLayers * 2),
      idKeys: new Int32Array(maxLayers * 2),
      payloads: new Int32Array(maxLayers * 2),
      order: new Array(maxLayers * 2),
    };
    for (let p = 0; p < N; p++) {
      const res = compositePixel(pack, p, scratch);
      const o4 = p * 4;
      rgba[o4] = res.r;
      rgba[o4 + 1] = res.g;
      rgba[o4 + 2] = res.b;
      rgba[o4 + 3] = res.A;
      A[p] = res.A;
      T[p] = res.T;
    }
    return { rgba, A, T };
  }

  function maxPixelLayers(pack) {
    let m = 0;
    const off = pack.offsets;
    for (let p = 0; p < off.length - 1; p++) {
      const c = off[p + 1] - off[p];
      if (c > m) m = c;
    }
    return m;
  }

  /* ------------------------------------------------------------------
   * 像素检查：重新扫描单像素，产出每段入射/出射透射率与预乘贡献，
   * 以及表面/遮挡事件明细。
   * ------------------------------------------------------------------ */
  function inspectPixel(pack, x, y) {
    const W = pack.width, H = pack.height;
    if (x < 0 || y < 0 || x >= W || y >= H) {
      fail('像素坐标越界', `(${x},${y})`);
    }
    const p = y * W + x;
    const { offsets, itypes, fvals } = pack;
    const lo = offsets[p], hi = offsets[p + 1];

    const raw = [];
    for (let s = lo; s < hi; s++) {
      const ib = s * I_STRIDE;
      const fb = s * F_STRIDE;
      const t = itypes[ib + I_TYPE];
      const id = itypes[ib + I_ID];
      if (t === T_VOLUME) {
        raw.push({ z: fvals[fb + F_Z0], kind: K_START, slot: s });
        raw.push({ z: fvals[fb + F_Z1], kind: K_END, slot: s });
      } else if (t === T_SURFACE) {
        raw.push({ z: fvals[fb + F_Z0], kind: K_SURFACE, slot: s });
      } else {
        raw.push({ z: fvals[fb + F_Z0], kind: K_HOLDOUT, slot: s });
      }
    }
    raw.sort((e1, e2) => {
      if (e1.z !== e2.z) return e1.z - e2.z;
      if (e1.kind !== e2.kind) return e1.kind - e2.kind;
      // 同为 surface 时按 id 排列；其余同深度同类事件次序无影响
      if (e1.kind === K_SURFACE) {
        return itypes[e1.slot * I_STRIDE + I_ID] - itypes[e2.slot * I_STRIDE + I_ID];
      }
      return 0;
    });

    let T = 1;
    let r = 0, g = 0, b = 0, A = 0;
    const active = [];
    const segments = [];
    const eventsOut = [];
    let prevZ = null;

    const integrate = (z0, z1) => {
      if (active.length === 0) return;
      const dt = z1 - z0;
      let sigma = 0;
      let sr = 0, sg = 0, sb = 0;
      const ids = [];
      for (const slot of active) {
        const f2 = slot * F_STRIDE;
        const sig = fvals[f2 + F_SIGMA];
        sigma += sig;
        sr += sig * fvals[f2 + F_R];
        sg += sig * fvals[f2 + F_R + 1];
        sb += sig * fvals[f2 + F_R + 2];
        ids.push(itypes[slot * I_STRIDE + I_ID]);
      }
      ids.sort((a, c) => a - c);
      const tIn = T;
      if (dt <= 0 || sigma <= 0 || T === 0) {
        // 零长度/零消光/透射已被 holdout 切断：透射与贡献均不变，
        // 但 T=0 的段不再列出（后方一切不可见，避免幽灵段）。
        if (T === 0) return;
        segments.push({
          type: 'volume-segment', z0, z1, activeIds: ids,
          sigma, tIn, tOut: tIn, absorbShare: 0,
          contribution: [0, 0, 0],
        });
        return;
      }
      const trans = Math.exp(-sigma * dt);
      const absorb = T * (1 - trans);
      const cr = absorb * (sr / sigma);
      const cg = absorb * (sg / sigma);
      const cb = absorb * (sb / sigma);
      r += cr; g += cg; b += cb; A += absorb; T *= trans;
      segments.push({
        type: 'volume-segment', z0, z1, activeIds: ids,
        sigma, tIn, tOut: T, absorbShare: absorb,
        contribution: [cr, cg, cb],
      });
    };

    for (const ev of raw) {
      const { z, kind, slot } = ev;
      const ib = slot * I_STRIDE;
      const fb = slot * F_STRIDE;
      const t = itypes[ib + I_TYPE];
      const id = itypes[ib + I_ID];

      if (prevZ !== null && z > prevZ) integrate(prevZ, z);

      const tBefore = T;
      if (kind === K_END) { // 体积结束
        for (let k = active.length - 1; k >= 0; k--) {
          if (active[k] === slot) { active.splice(k, 1); break; }
        }
        eventsOut.push({ type: 'volume-end', id, z, tIn: tBefore, tOut: T });
      } else if (kind === K_SURFACE) { // surface
        const a = fvals[fb + F_SIGMA];
        const share = T * a;
        const cr = share * fvals[fb + F_R];
        const cg = share * fvals[fb + F_R + 1];
        const cb = share * fvals[fb + F_R + 2];
        r += cr; g += cg; b += cb; A += share; T *= 1 - a;
        eventsOut.push({
          type: 'surface', id, z, a,
          rgb: [fvals[fb + F_R], fvals[fb + F_R + 1], fvals[fb + F_R + 2]],
          tIn: tBefore, tOut: T, absorbShare: share, contribution: [cr, cg, cb],
        });
      } else if (kind === K_HOLDOUT) { // holdout
        T = 0;
        eventsOut.push({ type: 'holdout', id, z, tIn: tBefore, tOut: 0 });
      } else { // K_START：体积开始
        active.push(slot);
        eventsOut.push({ type: 'volume-start', id, z, tIn: tBefore, tOut: T });
      }
      prevZ = z;
    }

    return {
      x, y,
      layerCount: hi - lo,
      segments,
      events: eventsOut,
      result: { r, g, b, A, T },
    };
  }

  return {
    T_VOLUME, T_SURFACE, T_HOLDOUT,
    I_STRIDE, F_STRIDE,
    ValidationError,
    parseJson,
    parseAndPack,
    compositePixel,
    compositeFrame,
    inspectPixel,
  };
});
