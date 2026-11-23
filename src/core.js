/*
 * PQ 曝光校片台 — 纯计算核心（无 DOM 依赖）
 *
 * 约定来源：samples/pq-exposure-cases.zip 内的《约定.txt》
 *   - frames.rgb10：逐帧、逐行、逐像素 RGB 交错小端 u16，码值 0..1023，高 6 位为 0
 *   - 输入为全范围 PQ / BT.2020
 *   - 曝光格 e ∈ [-96, 96]，每格 1/16 档
 *
 * 浏览器：globalThis.PQCore；Node：module.exports
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PQCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ================= 常量 ================= */

  const E_MIN = -96;
  const E_MAX = 96;
  const NE = E_MAX - E_MIN + 1; // 193
  const ND = 25;                // 相邻差 d ∈ [-12, 12]
  const VMAX = 12;              // 相邻曝光格最大差
  const AMAX = 2;               // 相邻差之最大变化
  const LOCK_NONE = 32767;
  const INF = Infinity;

  // PQ（严格照约定）
  const M1 = 2610 / 16384;
  const M2 = 2523 / 32;
  const C1 = 3424 / 4096;
  const C2 = 2413 / 128;
  const C3 = 2392 / 128;

  // BT.2020 -> BT.709，行优先
  const M_2020_709 = [
    1.660491, -0.587641, -0.072850,
    -0.124550, 1.132900, -0.008349,
    -0.018151, -0.100579, 1.118730,
  ];

  const Y_R = 0.2627;
  const Y_G = 0.6780;
  const Y_B = 0.0593;

  const MAX_FRAMES = 1800;
  const MAX_PIXELS = 25000000;

  // PQ 码值 -> 线性尼特
  const PQ_LUT = new Float64Array(1024);
  for (let c = 0; c < 1024; c++) {
    const v = c / 1023;
    const P = Math.pow(v, 1 / M2);
    const num = Math.max(P - C1, 0);
    const den = C2 - C3 * P;
    PQ_LUT[c] = 10000 * Math.pow(num / den, 1 / M1);
  }

  function pqToNits(code) {
    if (!Number.isInteger(code) || code < 0 || code > 1023) {
      throw new RangeError('PQ 码值越界: ' + code);
    }
    return PQ_LUT[code];
  }

  /** P95（毫尼特）-> 建议曝光格 */
  function suggestFromP95(p95) {
    const raw = Math.floor(16 * Math.log2(100000 / Math.max(p95, 1)) + 0.5);
    return raw < E_MIN ? E_MIN : raw > E_MAX ? E_MAX : raw;
  }

  function isSafeInt(x) {
    return typeof x === 'number' && Number.isSafeInteger(x);
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  /* ================= 时间线校验 ================= */

  /**
   * 校验 timeline.json（不含像素）。
   * @returns {{ok:true, meta:object}|{ok:false, errors:string[]}}
   */
  function validateTimeline(tl) {
    const errors = [];
    if (!tl || typeof tl !== 'object' || Array.isArray(tl)) {
      return { ok: false, errors: ['timeline.json 必须是对象'] };
    }
    const { width, height, pts_us, end_us, cuts, weights, locks } = tl;

    if (!isSafeInt(width) || width < 1 || width > 640) errors.push('width 必须是 1..640 的整数');
    if (!isSafeInt(height) || height < 1 || height > 360) errors.push('height 必须是 1..360 的整数');

    if (!Array.isArray(pts_us) || pts_us.length === 0) {
      errors.push('pts_us 必须是非空数组');
    } else {
      if (pts_us.length > MAX_FRAMES) errors.push('帧数 ' + pts_us.length + ' 超过 ' + MAX_FRAMES + ' 帧上限');
      for (let i = 0; i < pts_us.length; i++) {
        const p = pts_us[i];
        if (!isSafeInt(p) || p < 0) { errors.push('pts_us[' + i + '] 必须是非负安全整数'); break; }
        if (i > 0 && p <= pts_us[i - 1]) { errors.push('pts_us 必须严格递增（第 ' + i + ' 帧）'); break; }
      }
      if (isSafeInt(width) && isSafeInt(height)) {
        const budget = width * height * pts_us.length;
        if (budget > MAX_PIXELS) {
          errors.push('像素总量 ' + budget + ' 超过 ' + MAX_PIXELS + ' 上限（' +
            width + '×' + height + '×' + pts_us.length + '）');
        }
      }
      if (!isSafeInt(end_us)) errors.push('end_us 必须是安全整数');
      else if (isSafeInt(pts_us[pts_us.length - 1]) && end_us <= pts_us[pts_us.length - 1]) {
        errors.push('end_us 必须大于末帧 PTS');
      }
    }

    if (!Array.isArray(cuts) || cuts.length === 0) {
      errors.push('cuts 必须是非空数组');
    } else {
      if (cuts[0] !== 0) errors.push('cuts 必须包含 0');
      for (let i = 0; i < cuts.length; i++) {
        if (!isSafeInt(cuts[i]) || cuts[i] < 0) { errors.push('cuts[' + i + '] 必须是非负整数'); break; }
        if (i > 0 && cuts[i] <= cuts[i - 1]) { errors.push('cuts 必须严格递增（第 ' + i + ' 项）'); break; }
        if (Array.isArray(pts_us) && cuts[i] >= pts_us.length) { errors.push('cuts[' + i + '] 超出帧范围'); break; }
      }
    }

    if (!Array.isArray(weights)) {
      errors.push('weights 必须是数组');
    } else if (Array.isArray(pts_us) && weights.length !== pts_us.length) {
      errors.push('weights 长度必须等于帧数（' + pts_us.length + '）');
    } else {
      for (let i = 0; i < weights.length; i++) {
        if (!isSafeInt(weights[i]) || weights[i] < 1 || weights[i] > 100) {
          errors.push('weights[' + i + '] 必须是 1..100 的整数'); break;
        }
      }
    }

    if (!Array.isArray(locks)) {
      errors.push('locks 必须是数组');
    } else {
      const seen = new Set();
      for (let i = 0; i < locks.length; i++) {
        const it = locks[i];
        if (!Array.isArray(it) || it.length !== 2) { errors.push('locks[' + i + '] 必须是 [帧, 曝光格]'); break; }
        const f = it[0], e = it[1];
        if (!isSafeInt(f) || f < 0 || (Array.isArray(pts_us) && f >= pts_us.length)) {
          errors.push('locks[' + i + '] 的帧号非法'); break;
        }
        if (!isSafeInt(e) || e < E_MIN || e > E_MAX) {
          errors.push('locks[' + i + '] 的曝光格必须是 -96..96 的整数'); break;
        }
        if (seen.has(f)) { errors.push('locks 中帧 ' + f + ' 重复'); break; }
        seen.add(f);
      }
    }

    if (errors.length) return { ok: false, errors };

    return {
      ok: true,
      meta: {
        width,
        height,
        pts_us: pts_us.slice(),
        end_us,
        cuts: cuts.slice(),
        weights: weights.slice(),
        locks: locks.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]),
      },
    };
  }

  /* ================= 帧统计：P95 与建议曝光 ================= */

  function swap(a, i, j) { const t = a[i]; a[i] = a[j]; a[j] = t; }

  /** 就地取第 k 小（k 从 1 起） */
  function kthSmallest(a, n, k) {
    let left = 0, right = n - 1;
    const target = k - 1;
    while (true) {
      if (left === right) return a[left];
      const mid = (left + right) >>> 1;
      if (a[mid] < a[left]) swap(a, mid, left);
      if (a[right] < a[left]) swap(a, right, left);
      if (a[right] < a[mid]) swap(a, right, mid);
      const pivot = a[mid];
      let i = left, j = right;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { swap(a, i, j); i++; j--; }
      }
      if (target <= j) right = j;
      else if (target >= i) left = i;
      else return a[target];
    }
  }

  /**
   * 从一段 10-bit RGB 像素计算逐帧 P95 与建议曝光格。
   * @param {Uint16Array} pixels 长度 = w*h*3*count
   * @param {(done:number,total:number)=>void} [onFrame]
   * @param {number} [frameOffset] 错误信息中的帧号偏移（分块计算时使用）
   * @returns {{p95:Int32Array, suggested:Int16Array}}
   */
  function computeStats(pixels, width, height, count, onFrame, frameOffset) {
    const npix = width * height;
    const k = Math.ceil((95 * npix) / 100);
    const scratch = new Uint32Array(npix);
    const p95 = new Int32Array(count);
    const suggested = new Int16Array(count);
    const stride = npix * 3;
    const lut = PQ_LUT;
    const fo = frameOffset || 0;
    for (let f = 0; f < count; f++) {
      const base = f * stride;
      for (let p = 0, o = base, s = 0; p < npix; p++, o += 3, s++) {
        const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
        if ((r | g | b) > 1023) {
          throw new Error('第 ' + (fo + f) + ' 帧第 ' + p + ' 像素码值 ' + (r | g | b) + ' 超过 1023');
        }
        const Y = Y_R * lut[r] + Y_G * lut[g] + Y_B * lut[b];
        scratch[s] = Math.floor(1000 * Y + 0.5);
      }
      const v = kthSmallest(scratch, npix, k);
      p95[f] = v;
      suggested[f] = suggestFromP95(v);
      if (onFrame) onFrame(f + 1);
    }
    return { p95, suggested };
  }

  /* ================= 求解器 ================= */

  const STATE_N = NE * ND;

  function shotList(cuts, n) {
    const shots = [];
    for (let i = 0; i < cuts.length; i++) {
      const a = cuts[i];
      const b = i + 1 < cuts.length ? cuts[i + 1] - 1 : n - 1;
      if (b >= a) shots.push([a, b]);
    }
    return shots;
  }

  function lockMap(locks) {
    const m = new Map();
    for (const [f, e] of locks) m.set(f, e);
    return m;
  }

  /** 可复用工作区，避免反复求解时的大块分配 */
  function makeWorkspace() {
    return { H: null, H0: null, costs: null, exp: null };
  }

  function ensureWorkspace(ws, L) {
    if (!ws) ws = makeWorkspace();
    if (!ws.H || ws.H.length < L * STATE_N) ws.H = new Float64Array(L * STATE_N);
    if (!ws.costs || ws.costs.length < L * NE) ws.costs = new Float64Array(L * NE);
    if (!ws.H0) ws.H0 = new Float64Array(NE);
    if (!ws.exp || ws.exp.length < L) ws.exp = new Int16Array(L);
    return ws;
  }

  /**
   * 单镜头求解：最小化 Σ w(e-q)^2，约束限速/限加速度/锁定；
   * 同成本取字典序最小。返回 {ok, exposure:Int16Array, cost, badLock}
   */
  function solveShot(weights, q, lockMapRef, a, b, ws) {
    const L = b - a + 1;
    ws = ensureWorkspace(ws, L);
    const H = ws.H;
    const H0 = ws.H0;
    const costs = ws.costs;
    const exposure = ws.exp;

    for (let k = 0; k < L; k++) {
      const frame = a + k;
      const off = k * NE;
      const w = weights[frame];
      const qq = q[frame];
      const lk = lockMapRef.has(frame) ? lockMapRef.get(frame) : LOCK_NONE;
      for (let ei = 0; ei < NE; ei++) {
        if (lk !== LOCK_NONE && E_MIN + ei !== lk) { costs[off + ei] = INF; continue; }
        const d = E_MIN + ei - qq;
        costs[off + ei] = w * d * d;
      }
    }

    // H_{L-1} ≡ 0；复用时清掉残留的末层
    H.fill(0, (L - 1) * STATE_N, L * STATE_N);

    for (let k = L - 2; k >= 1; k--) {
      const off = k * STATE_N;
      const nextOff = (k + 1) * STATE_N;
      const cOff = (k + 1) * NE;
      for (let ei = 0; ei < NE; ei++) {
        const e = E_MIN + ei;
        const base = off + ei * ND;
        for (let di = 0; di < ND; di++) {
          const d = di - 12;
          let best = INF;
          const lo = d - AMAX < -VMAX ? -VMAX : d - AMAX;
          const hi = d + AMAX > VMAX ? VMAX : d + AMAX;
          for (let d2 = lo; d2 <= hi; d2++) {
            const e2 = e + d2;
            if (e2 < E_MIN || e2 > E_MAX) continue;
            const c = costs[cOff + e2 - E_MIN];
            if (c === INF) continue;
            const v = c + H[nextOff + (e2 - E_MIN) * ND + (d2 + 12)];
            if (v < best) best = v;
          }
          H[base + di] = best;
        }
      }
    }

    if (L === 1) {
      H0.fill(0);
    } else {
      const cOff = NE;
      const nextOff = STATE_N;
      for (let ei = 0; ei < NE; ei++) {
        const e = E_MIN + ei;
        let best = INF;
        for (let d2 = -VMAX; d2 <= VMAX; d2++) {
          const e2 = e + d2;
          if (e2 < E_MIN || e2 > E_MAX) continue;
          const c = costs[cOff + e2 - E_MIN];
          if (c === INF) continue;
          const v = c + H[nextOff + (e2 - E_MIN) * ND + (d2 + 12)];
          if (v < best) best = v;
        }
        H0[ei] = best;
      }
    }

    let opt = INF;
    for (let ei = 0; ei < NE; ei++) {
      const c0 = costs[ei];
      if (c0 === INF) continue;
      const v = c0 + H0[ei];
      if (v < opt) opt = v;
    }
    if (!Number.isFinite(opt)) {
      return { ok: false, exposure: null, cost: INF, badLock: findBadLock(a, b, lockMapRef) };
    }

    // 字典序贪心回放。代价均为整数（w·(e-q)^2），双精度内精确；
    // 仍用极小相对容差兜底，避免浮点结合顺序差异误判为无解。
    const tol = Number.isFinite(opt) ? Math.max(1e-9, Math.abs(opt) * 1e-12) : 0;
    let prefix = 0;
    let prevD = 0;
    for (let k = 0; k < L; k++) {
      let found = false;
      const cOff = k * NE;
      for (let ei = 0; ei < NE; ei++) {
        const c = costs[cOff + ei];
        if (c === INF) continue;
        const e = E_MIN + ei;
        let d = 0;
        if (k > 0) {
          d = e - exposure[k - 1];
          if (d < -VMAX || d > VMAX) continue;
          if (k >= 2 && Math.abs(d - prevD) > AMAX) continue;
        }
        let rem;
        if (k === L - 1) rem = 0;
        else if (k === 0) rem = H0[ei];
        else rem = H[k * STATE_N + ei * ND + (d + 12)];
        if (rem === INF) continue;
        if (Math.abs(prefix + c + rem - opt) <= tol) {
          exposure[k] = e;
          prefix += c;
          prevD = d;
          found = true;
          break;
        }
      }
      if (!found) {
        return { ok: false, exposure: null, cost: INF, badLock: findBadLock(a, b, lockMapRef) };
      }
    }
    return { ok: true, exposure: exposure.slice(0, L), cost: opt, badLock: null };
  }

  /** 前向可达性扫描，定位首个不可达帧（无则 null） */
  function findBadLock(a, b, lockMapRef) {
    let cur = new Uint8Array(NE);
    let curED = null;
    const lk0 = lockMapRef.has(a) ? lockMapRef.get(a) : LOCK_NONE;
    for (let e = E_MIN; e <= E_MAX; e++) {
      if (lk0 === LOCK_NONE || e === lk0) cur[e - E_MIN] = 1;
    }
    for (let k = 1; k <= b - a; k++) {
      const frame = a + k;
      const lk = lockMapRef.has(frame) ? lockMapRef.get(frame) : LOCK_NONE;
      const next = new Uint8Array(STATE_N);
      let count = 0;
      if (k === 1) {
        for (let ei = 0; ei < NE; ei++) {
          if (!cur[ei]) continue;
          const e = E_MIN + ei;
          for (let d = -VMAX; d <= VMAX; d++) {
            const e2 = e + d;
            if (e2 < E_MIN || e2 > E_MAX) continue;
            if (lk !== LOCK_NONE && e2 !== lk) continue;
            const idx = (e2 - E_MIN) * ND + (d + 12);
            if (!next[idx]) { next[idx] = 1; count++; }
          }
        }
      } else {
        for (let si = 0; si < STATE_N; si++) {
          if (!curED[si]) continue;
          const ei = (si / ND) | 0;
          const dPrev = (si % ND) - 12;
          const e = E_MIN + ei;
          const lo = dPrev - AMAX < -VMAX ? -VMAX : dPrev - AMAX;
          const hi = dPrev + AMAX > VMAX ? VMAX : dPrev + AMAX;
          for (let d = lo; d <= hi; d++) {
            const e2 = e + d;
            if (e2 < E_MIN || e2 > E_MAX) continue;
            if (lk !== LOCK_NONE && e2 !== lk) continue;
            const idx = (e2 - E_MIN) * ND + (d + 12);
            if (!next[idx]) { next[idx] = 1; count++; }
          }
        }
      }
      if (count === 0) return frame;
      curED = next;
    }
    return null;
  }

  /**
   * 全片求解。镜头相互独立，结果按帧序拼接。
   * @returns {{ok:boolean, exposure:Int16Array|null, objective:number|null, conflicts:Array, perShot:Array}}
   */
  function solveAll(meta, suggested, ws) {
    const { cuts, weights, locks } = meta;
    const n = suggested.length;
    const shots = shotList(cuts, n);
    const lmap = lockMap(locks);
    const exposure = new Int16Array(n);
    const perShot = [];
    const conflicts = [];
    const perShotWs = ws || makeWorkspace();
    let objective = 0;
    let okAll = true;
    let maxL = 0;
    for (const [a, b] of shots) maxL = Math.max(maxL, b - a + 1);
    // 一次分配足够大，各镜头复用
    ensureWorkspace(perShotWs, maxL);

    for (let si = 0; si < shots.length; si++) {
      const [a, b] = shots[si];
      const res = solveShot(weights, suggested, lmap, a, b, perShotWs);
      perShot.push({ a, b, ok: res.ok, cost: res.cost });
      if (!res.ok) {
        okAll = false;
        conflicts.push({
          shot: si,
          a, b,
          frame: res.badLock,
          locks: locks.filter(([f]) => f >= a && f <= b).map(([f]) => f),
          message: '镜头 ' + (si + 1) + '（帧 ' + a + '–' + b + '）无可行曝光解' +
            (res.badLock != null ? '：帧 ' + res.badLock + ' 的锁定无法与前序约束同时满足' : ''),
        });
      } else {
        objective += res.cost;
        exposure.set(res.exposure, a);
      }
    }
    if (!okAll) return { ok: false, exposure: null, objective: null, conflicts, perShot };
    return { ok: true, exposure, objective, conflicts: [], perShot };
  }

  /* ================= SDR 渲染 ================= */

  function srgbEncode(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }

  /**
   * 将一帧 10-bit BT.2020 PQ 像素按曝光格 e 转为 8-bit sRGB RGBA。
   * @param {Uint16Array} px 长度 = npix*3
   * @param {Uint8ClampedArray} out 长度 = npix*4
   */
  function renderFrameRGBA(px, npix, e, out) {
    const g = Math.pow(2, e / 16) / 100;
    const lut = PQ_LUT;
    const m00 = M_2020_709[0], m01 = M_2020_709[1], m02 = M_2020_709[2];
    const m10 = M_2020_709[3], m11 = M_2020_709[4], m12 = M_2020_709[5];
    const m20 = M_2020_709[6], m21 = M_2020_709[7], m22 = M_2020_709[8];
    for (let p = 0, o = 0, q = 0; p < npix; p++, o += 3, q += 4) {
      const R = lut[px[o]], G = lut[px[o + 1]], B = lut[px[o + 2]];
      const Y = Y_R * R + Y_G * G + Y_B * B;
      const s = g / (1 + g * Y);
      let r = (m00 * R + m01 * G + m02 * B) * s;
      let gg = (m10 * R + m11 * G + m12 * B) * s;
      let b = (m20 * R + m21 * G + m22 * B) * s;
      if (r < 0) r = 0; else if (r > 1) r = 1;
      if (gg < 0) gg = 0; else if (gg > 1) gg = 1;
      if (b < 0) b = 0; else if (b > 1) b = 1;
      out[q] = Math.floor(255 * srgbEncode(r) + 0.5);
      out[q + 1] = Math.floor(255 * srgbEncode(gg) + 0.5);
      out[q + 2] = Math.floor(255 * srgbEncode(b) + 0.5);
      out[q + 3] = 255;
    }
  }

  /* ================= 曝光表 ================= */

  function buildTable(meta, stats, exposure) {
    const n = meta.pts_us.length;
    const frames = new Array(n);
    for (let i = 0; i < n; i++) {
      const dur = (i + 1 < n ? meta.pts_us[i + 1] : meta.end_us) - meta.pts_us[i];
      frames[i] = {
        pts_us: meta.pts_us[i],
        duration_us: dur,
        p95_millinit: stats.p95[i],
        suggested: stats.suggested[i],
        exposure: exposure[i],
      };
    }
    let objective = 0;
    for (let i = 0; i < n; i++) {
      const d = exposure[i] - stats.suggested[i];
      objective += meta.weights[i] * d * d;
    }
    return { objective, frames };
  }

  return {
    E_MIN, E_MAX, NE, ND, VMAX, AMAX, LOCK_NONE,
    MAX_FRAMES, MAX_PIXELS,
    PQ_LUT, M_2020_709,
    pqToNits, suggestFromP95, clamp,
    validateTimeline,
    kthSmallest,
    computeStats,
    shotList, makeWorkspace, solveShot, solveAll,
    renderFrameRGBA, srgbEncode,
    buildTable,
  };
});
