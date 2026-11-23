/*
 * Array inverse-FIR design core.
 *
 *   E(F) = sum_m w_m * sum_n | sum_p (H[m,p] * F[p,q])[n] - T[m,q][n-delay] |^2
 *          + lambda * sum_{p,k} F[p,q,k]^2
 *
 * solved per program channel with every tap box-constrained to [-G[p], G[p]],
 * using an FFT-based block-Toeplitz operator plus a primal active-set method.
 * The callback-free module works both in the browser (global AICore) and in
 * Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAMPLE_RATE = 48000;
  const MAX_MEAS = 8;
  const MAX_SPK = 8;
  const MAX_PROGRAMS = 2;
  const MAX_LEN = 4096;
  const MAX_DELAY = 4095;
  const W_MIN = 0.25, W_MAX = 4;
  const G_MIN = 0.001, G_MAX = 2;
  const LAMBDA_MIN = 0.05, LAMBDA_MAX = 4;
  const ENERGY_LIMIT = 16;
  const PG_LIMIT = 1e-7;

  /* ------------------------------- FFT ---------------------------------- */

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  class FFT {
    constructor(n) {
      this.n = n;
      let levels = 0;
      while ((1 << levels) < n) levels++;
      this.levels = levels;
      const rev = new Uint32Array(n);
      for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
      this.rev = rev;
      const half = n >> 1;
      const cos = new Float64Array(half), sin = new Float64Array(half);
      for (let k = 0; k < half; k++) {
        const a = 2 * Math.PI * k / n;
        cos[k] = Math.cos(a);
        sin[k] = Math.sin(a);
      }
      this.cos = cos;
      this.sin = sin;
    }
    fwd(re, im) {
      const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          let k = 0;
          for (let j = 0; j < half; j++, k += step) {
            const c = cos[k], s = sin[k];
            const a = start + j, b = a + half;
            const vr = re[b], vi = im[b];
            const tr = c * vr + s * vi, ti = c * vi - s * vr;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    }
    inv(re, im) {
      const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          let k = 0;
          for (let j = 0; j < half; j++, k += step) {
            const c = cos[k], s = sin[k];
            const a = start + j, b = a + half;
            const vr = re[b], vi = im[b];
            const tr = c * vr - s * vi, ti = c * vi + s * vr;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      const invn = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= invn; im[i] *= invn; }
    }
  }

  /* ---------------------------- validation ------------------------------- */

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  function matrixOfInts(value, path, errors, opts) {
    const { minRows, maxRows, minCols, maxCols, minVal, maxVal, label } = opts;
    if (!Array.isArray(value)) {
      errors.push({ path, message: `${label} 必须是二维数组（矩阵）` });
      return null;
    }
    const rows = value.length;
    if (rows < minRows || rows > maxRows) {
      errors.push({ path, message: `${label} 行数 ${rows} 不在 ${minRows}–${maxRows} 范围内` });
      return null;
    }
    let nCols = -1, ok = true;
    for (let r = 0; r < rows; r++) {
      if (!Array.isArray(value[r])) {
        errors.push({ path: `${path}[${r}]`, message: `${label} 第 ${r} 行必须是数组` });
        ok = false; continue;
      }
      if (nCols < 0) {
        nCols = value[r].length;
        if (nCols < minCols || nCols > maxCols) {
          errors.push({ path: `${path}[${r}]`, message: `${label} 列数 ${nCols} 不在 ${minCols}–${maxCols} 范围内` });
          ok = false;
        }
      } else if (value[r].length !== nCols) {
        errors.push({ path: `${path}[${r}]`, message: `${label} 第 ${r} 行长度 ${value[r].length} 与首行 ${nCols} 不一致` });
        ok = false;
      }
      for (let c = 0; c < value[r].length; c++) {
        const v = value[r][c];
        if (!isInt(v)) {
          errors.push({ path: `${path}[${r}][${c}]`, message: `${label} 路径长度必须是整数，当前为 ${JSON.stringify(v)}` });
          ok = false;
        } else if (v < minVal || v > maxVal) {
          errors.push({ path: `${path}[${r}][${c}]`, message: `${label} 路径长度 ${v} 不在 ${minVal}–${maxVal} 范围内` });
          ok = false;
        }
      }
    }
    return ok ? { rows, cols: nCols, data: value } : null;
  }

  // Structural validation of project.json only; signal checks happen in parseSignals.
  function validateProjectObject(project) {
    const errors = [];
    if (project === null || typeof project !== 'object' || Array.isArray(project)) {
      return { errors: [{ path: 'project.json', message: '根节点必须是 JSON 对象' }], config: null };
    }
    const hInfo = matrixOfInts(project.h_lengths, 'project.json: h_lengths', errors, {
      minRows: 2, maxRows: MAX_MEAS, minCols: 2, maxCols: MAX_SPK,
      minVal: 1, maxVal: MAX_LEN, label: 'h_lengths',
    });
    const tInfo = matrixOfInts(project.t_lengths, 'project.json: t_lengths', errors, {
      minRows: 2, maxRows: MAX_MEAS, minCols: 1, maxCols: MAX_PROGRAMS,
      minVal: 1, maxVal: MAX_LEN, label: 't_lengths',
    });
    if (hInfo && tInfo && hInfo.rows !== tInfo.rows) {
      errors.push({
        path: 'project.json: t_lengths',
        message: `测点数不一致：h_lengths 为 ${hInfo.rows} 行，t_lengths 为 ${tInfo.rows} 行`,
      });
    }
    const weights = project.weights;
    if (!Array.isArray(weights)) {
      errors.push({ path: 'project.json: weights', message: 'weights 必须是数组' });
    } else {
      if (hInfo && weights.length !== hInfo.rows) {
        errors.push({ path: 'project.json: weights', message: `weights 长度 ${weights.length} 与测点数 ${hInfo.rows} 不一致` });
      }
      for (let i = 0; i < weights.length; i++) {
        const v = weights[i];
        if (!isNum(v)) errors.push({ path: `project.json: weights[${i}]`, message: '权重必须是有限数值' });
        else if (v < W_MIN || v > W_MAX) errors.push({ path: `project.json: weights[${i}]`, message: `测点权重 ${v} 不在 ${W_MIN}–${W_MAX} 范围内` });
      }
    }
    const limits = project.limits;
    if (!Array.isArray(limits)) {
      errors.push({ path: 'project.json: limits', message: 'limits 必须是数组' });
    } else {
      if (hInfo && limits.length !== hInfo.cols) {
        errors.push({ path: 'project.json: limits', message: `limits 长度 ${limits.length} 与扬声器数 ${hInfo.cols} 不一致` });
      }
      for (let i = 0; i < limits.length; i++) {
        const v = limits[i];
        if (!isNum(v)) errors.push({ path: `project.json: limits[${i}]`, message: '抽头上限必须是有限数值' });
        else if (v < G_MIN || v > G_MAX) errors.push({ path: `project.json: limits[${i}]`, message: `扬声器限值 ${v} 不在 ${G_MIN}–${G_MAX} 范围内` });
      }
    }
    const { lambda, delay, taps } = project;
    if (!isNum(lambda)) errors.push({ path: 'project.json: lambda', message: 'lambda 必须是有限数值' });
    else if (lambda < LAMBDA_MIN || lambda > LAMBDA_MAX) errors.push({ path: 'project.json: lambda', message: `lambda ${lambda} 不在 ${LAMBDA_MIN}–${LAMBDA_MAX} 范围内` });
    if (!isInt(delay)) errors.push({ path: 'project.json: delay', message: `delay 必须是 0–${MAX_DELAY} 的整数` });
    else if (delay < 0 || delay > MAX_DELAY) errors.push({ path: 'project.json: delay', message: `delay ${delay} 不在 0–${MAX_DELAY} 范围内` });
    if (!isInt(taps)) errors.push({ path: 'project.json: taps', message: `taps 必须是 1–${MAX_LEN} 的整数` });
    else if (taps < 1 || taps > MAX_LEN) errors.push({ path: 'project.json: taps', message: `taps ${taps} 不在 1–${MAX_LEN} 范围内` });
    if (errors.length) return { errors, config: null };
    // duplicate h_lengths/t_lengths shape checks for filters
    if (hInfo.cols < 2 || hInfo.cols > MAX_SPK) return { errors, config: null };
    return {
      errors: [],
      config: {
        M: hInfo.rows, P: hInfo.cols, Q: tInfo.cols,
        h_lengths: hInfo.data, t_lengths: tInfo.data,
        weights: weights.slice(), limits: limits.slice(),
        lambda, delay, taps,
      },
    };
  }

  function signalSampleCount(cfg) {
    let n = 0;
    for (const row of cfg.h_lengths) for (const L of row) n += L;
    for (const row of cfg.t_lengths) for (const L of row) n += L;
    return n;
  }

  // Decode float32 samples; every sample must be finite and |x| <= 1.
  function parseSignals(buffer, cfg) {
    const errors = [];
    const expected = signalSampleCount(cfg) * 4;
    if (!(buffer instanceof ArrayBuffer)) {
      return { errors: [{ path: 'signals.f32', message: '缺少二进制信号数据' }], H: null, T: null };
    }
    if (buffer.byteLength !== expected) {
      errors.push({
        path: 'signals.f32',
        message: `二进制尺寸 ${buffer.byteLength} 字节，与 project.json 路径长度合计期望 ${expected} 字节（${expected / 4} 个样本）不符`,
      });
      return { errors, H: null, T: null };
    }
    const dv = new DataView(buffer);
    let off = 0;
    const H = [], T = [];
    const { M, P, Q } = cfg;
    let minAbs = Infinity, maxAbs = 0;
    const check = (v, idx, path) => {
      if (!Number.isFinite(v)) {
        if (errors.length < 40) errors.push({ path, message: `第 ${idx} 个样本非有限值（NaN 或 Inf）` });
        return;
      }
      if (Math.abs(v) > 1) {
        if (errors.length < 40) errors.push({ path, message: `第 ${idx} 个样本绝对值 ${Math.abs(v)} 超过 1` });
      }
      const a = Math.abs(v);
      if (a < minAbs) minAbs = a;
      if (a > maxAbs) maxAbs = a;
    };
    for (let m = 0; m < M; m++) {
      H.push([]);
      for (let p = 0; p < P; p++) {
        const L = cfg.h_lengths[m][p];
        const arr = new Float64Array(L);
        for (let i = 0; i < L; i++) {
          const v = dv.getFloat32(off, true);
          check(v, off / 4, `signals.f32 → h[m=${m + 1}][p=${p + 1}][n=${i}]`);
          arr[i] = v;
          off += 4;
        }
        H[m].push(arr);
      }
    }
    for (let m = 0; m < M; m++) {
      T.push([]);
      for (let q = 0; q < Q; q++) {
        const L = cfg.t_lengths[m][q];
        const arr = new Float64Array(L);
        for (let i = 0; i < L; i++) {
          const v = dv.getFloat32(off, true);
          check(v, off / 4, `signals.f32 → t[m=${m + 1}][q=${q + 1}][n=${i}]`);
          arr[i] = v;
          off += 4;
        }
        T[m].push(arr);
      }
    }
    if (errors.length) return { errors, H: null, T: null };
    return { errors: [], H, T, stats: { samples: expected / 4, minAbs, maxAbs } };
  }

  // sum_m w_m * sum_p (sum_n |h_m,p,n|)^2 ; must stay <= 16
  function energyTerms(H, weights) {
    const M = H.length;
    const perMeasurement = [];
    let total = 0;
    for (let m = 0; m < M; m++) {
      const pathL1 = [];
      let sumSq = 0;
      for (const h of H[m]) {
        let l1 = 0;
        for (let i = 0; i < h.length; i++) l1 += Math.abs(h[i]);
        pathL1.push(l1);
        sumSq += l1 * l1;
      }
      const val = (weights[m] || 0) * sumSq;
      perMeasurement.push({ pathL1, sumSq, val });
      total += val;
    }
    return { perMeasurement, total };
  }

  // Validate editable parameters against the loaded measurements.
  function validateParams(cfg) {
    const errors = [];
    const w = cfg.weights, G = cfg.limits;
    if (!Array.isArray(w) || w.length !== cfg.M) errors.push({ path: 'weights', message: `需要 ${cfg.M} 个测点权重` });
    else for (let i = 0; i < w.length; i++) {
      if (!isNum(w[i])) errors.push({ path: `weights[${i}]`, message: '必须是有限数值' });
      else if (w[i] < W_MIN || w[i] > W_MAX) errors.push({ path: `weights[${i}]`, message: `${w[i]} 不在 ${W_MIN}–${W_MAX} 范围内` });
    }
    if (!Array.isArray(G) || G.length !== cfg.P) errors.push({ path: 'limits', message: `需要 ${cfg.P} 个扬声器限值` });
    else for (let i = 0; i < G.length; i++) {
      if (!isNum(G[i])) errors.push({ path: `limits[${i}]`, message: '必须是有限数值' });
      else if (G[i] < G_MIN || G[i] > G_MAX) errors.push({ path: `limits[${i}]`, message: `${G[i]} 不在 ${G_MIN}–${G_MAX} 范围内` });
    }
    if (!isNum(cfg.lambda) || cfg.lambda < LAMBDA_MIN || cfg.lambda > LAMBDA_MAX) {
      errors.push({ path: 'lambda', message: `lambda 必须在 ${LAMBDA_MIN}–${LAMBDA_MAX} 内` });
    }
    if (!isInt(cfg.delay) || cfg.delay < 0 || cfg.delay > MAX_DELAY) {
      errors.push({ path: 'delay', message: `delay 必须是 0–${MAX_DELAY} 的整数` });
    }
    if (!isInt(cfg.taps) || cfg.taps < 1 || cfg.taps > MAX_LEN) {
      errors.push({ path: 'taps', message: `taps 必须是 1–${MAX_LEN} 的整数` });
    }
    let energy = null;
    if (cfg.H && !errors.some((e) => e.path.startsWith('weights'))) {
      energy = energyTerms(cfg.H, cfg.weights);
      if (energy.total > ENERGY_LIMIT) {
        errors.push({
          path: 'weights',
          message: `加权能量 sum_m w[m]·sum_p(Σ|h|)² = ${energy.total.toFixed(4)} 超过上限 ${ENERGY_LIMIT}，请降低权重`,
        });
      }
    }
    return { errors, energy };
  }

  /* ---------------------------- geometry --------------------------------- */

  function geometry(cfg) {
    const { h_lengths, t_lengths, taps, delay } = cfg;
    let maxH = 0, maxConv = 0, maxT = 0;
    for (const row of h_lengths) for (const len of row) {
      if (len > maxH) maxH = len;
      if (len + taps - 1 > maxConv) maxConv = len + taps - 1;
    }
    for (const row of t_lengths) for (const len of row) if (len > maxT) maxT = len;
    const N = Math.max(maxConv, delay + maxT);
    // Circular-convolution clearance. Every spectrum is read only on taps
    // 0..taps-1 of an inverse transform whose nonzero support spans
    // [-(maxH-1), maxConv-1 | delay+maxT-1]. Choosing L >= N keeps the wrapped
    // copy (indices L-maxH+1 .. L-1) clear of that read window, since
    // L-maxH+1 > taps-1 is exactly L >= maxConv. So the truncated Toeplitz
    // operator and the correlation both come out alias-free at L.
    const need = Math.max(N, 1);
    const L = nextPow2(need);
    return { maxH, maxConv, maxT, N, L, need };
  }

  /* --------------------------- spectra ----------------------------------- */

  function buildSpectra(cfg) {
    const { M, P, Q, H, T, delay } = cfg;
    const geo = geometry(cfg);
    const { L } = geo;
    const fft = new FFT(L);
    const HhatRe = new Float64Array(M * P * L), HhatIm = new Float64Array(M * P * L);
    for (let m = 0; m < M; m++) {
      for (let p = 0; p < P; p++) {
        const re = new Float64Array(L), im = new Float64Array(L);
        const h = H[m][p];
        for (let n = 0; n < h.length; n++) re[n] = h[n];
        fft.fwd(re, im);
        const off = (m * P + p) * L;
        HhatRe.set(re, off); HhatIm.set(im, off);
      }
    }
    const ThatRe = [], ThatIm = [];
    for (let m = 0; m < M; m++) {
      for (let q = 0; q < Q; q++) {
        const tr = new Float64Array(L), ti = new Float64Array(L);
        const t = T[m][q];
        for (let n = 0; n < t.length; n++) {
          const idx = n + delay;
          if (idx < L) tr[idx] = t[n];
        }
        fft.fwd(tr, ti);
        ThatRe.push(tr); ThatIm.push(ti);
      }
    }
    return { geo, fft, HhatRe, HhatIm, ThatRe, ThatIm };
  }

  class Engine {
    constructor(o) { Object.assign(this, o); this._alloc(); }
    _alloc() {
      const { P, L } = this;
      this._tmpR = new Float64Array(L);
      this._tmpI = new Float64Array(L);
      this._XR = new Float64Array(L * P);
      this._XI = new Float64Array(L * P);
      this._YR = new Float64Array(L * P);
      this._YI = new Float64Array(L * P);
      this._tr = new Float64Array(P); this._ti = new Float64Array(P);
      this._sr = new Float64Array(P); this._si = new Float64Array(P);
      this._dr = new Float64Array(P); this._di = new Float64Array(P);
    }
    // Packed real FFT: two real channels share one complex transform.
    _forward(x, mask) {
      const { P, L, taps, fft } = this;
      const { _XR, _XI, _tmpR, _tmpI } = this;
      const halfP = P >> 1;
      for (let j = 0; j < halfP; j++) {
        const p0 = 2 * j, p1 = p0 + 1;
        _tmpR.fill(0); _tmpI.fill(0);
        const b0 = p0 * taps, b1 = p1 * taps;
        if (mask) {
          for (let k = 0; k < taps; k++) { _tmpR[k] = mask[b0 + k] * x[b0 + k]; _tmpI[k] = mask[b1 + k] * x[b1 + k]; }
        } else {
          for (let k = 0; k < taps; k++) { _tmpR[k] = x[b0 + k]; _tmpI[k] = x[b1 + k]; }
        }
        fft.fwd(_tmpR, _tmpI);
        for (let f = 0; f < L; f++) {
          const g = (L - f) % L;
          const ar = _tmpR[f], ai = _tmpI[f];
          const cr = _tmpR[g], ci = -_tmpI[g];
          const o = f * P;
          _XR[o + p0] = 0.5 * (ar + cr); _XI[o + p0] = 0.5 * (ai + ci);
          _XR[o + p1] = 0.5 * (ai - ci); _XI[o + p1] = -0.5 * (ar - cr);
        }
      }
      if (P & 1) {
        const p = P - 1;
        _tmpR.fill(0); _tmpI.fill(0);
        const b = p * taps;
        if (mask) for (let k = 0; k < taps; k++) _tmpR[k] = mask[b + k] * x[b + k];
        else for (let k = 0; k < taps; k++) _tmpR[k] = x[b + k];
        fft.fwd(_tmpR, _tmpI);
        for (let f = 0; f < L; f++) { _XR[f * P + p] = _tmpR[f]; _XI[f * P + p] = _tmpI[f]; }
      }
    }
    _inverse(out, mask) {
      const { P, L, taps, fft } = this;
      const { _YR, _YI, _tmpR, _tmpI } = this;
      const halfP = P >> 1;
      for (let j = 0; j < halfP; j++) {
        const p0 = 2 * j, p1 = p0 + 1;
        for (let f = 0; f < L; f++) {
          const o = f * P;
          const yr = _YR[o + p0], yi = _YI[o + p0];
          const y2r = _YR[o + p1], y2i = _YI[o + p1];
          _tmpR[f] = yr - y2i; _tmpI[f] = yi + y2r;
        }
        fft.inv(_tmpR, _tmpI);
        const b0 = p0 * taps, b1 = p1 * taps;
        if (mask) {
          for (let k = 0; k < taps; k++) { out[b0 + k] = mask[b0 + k] * _tmpR[k]; out[b1 + k] = mask[b1 + k] * _tmpI[k]; }
        } else {
          for (let k = 0; k < taps; k++) { out[b0 + k] = _tmpR[k]; out[b1 + k] = _tmpI[k]; }
        }
      }
      if (P & 1) {
        const p = P - 1;
        for (let f = 0; f < L; f++) { _tmpR[f] = _YR[f * P + p]; _tmpI[f] = _YI[f * P + p]; }
        fft.inv(_tmpR, _tmpI);
        const b = p * taps;
        if (mask) for (let k = 0; k < taps; k++) out[b + k] = mask[b + k] * _tmpR[k];
        else for (let k = 0; k < taps; k++) out[b + k] = _tmpR[k];
      }
    }
    // y = mask .* B (mask .* x), B = sum_m w_m H_m^T H_m + lambda I
    matvec(x, out, mask) {
      const { P, L, br, bi } = this;
      const { _XR, _XI, _YR, _YI } = this;
      this._forward(x, mask);
      for (let f = 0; f < L; f++) {
        const off = f * P * P, bo = f * P;
        for (let p = 0; p < P; p++) {
          let sr = 0, si = 0;
          for (let q = 0; q < P; q++) {
            const a = br[off + p * P + q], b = bi[off + p * P + q];
            const xr = _XR[bo + q], xi = _XI[bo + q];
            sr += a * xr - b * xi;
            si += a * xi + b * xr;
          }
          _YR[bo + p] = sr; _YI[bo + p] = si;
        }
      }
      this._inverse(out, mask);
      return out;
    }
    // y = mask .* B^{-1} (mask .* x): circulant preconditioner (Cholesky per bin)
    binv(x, out, mask) {
      const { P, L, lr, li } = this;
      const { _XR, _XI, _YR, _YI, _tr, _ti, _sr, _si, _dr, _di } = this;
      this._forward(x, mask);
      for (let f = 0; f < L; f++) {
        const o0 = f * P * P, bo = f * P;
        for (let p = 0; p < P; p++) { _tr[p] = _XR[bo + p]; _ti[p] = _XI[bo + p]; }
        for (let i = 0; i < P; i++) {
          let rr = _tr[i], ii = _ti[i];
          for (let k = 0; k < i; k++) {
            const o = o0 + i * P + k;
            const a = lr[o], b = li[o];
            rr -= a * _sr[k] - b * _si[k];
            ii -= a * _si[k] + b * _sr[k];
          }
          const d = lr[o0 + i * P + i];
          const id = d > 0 ? 1 / d : 0;
          _sr[i] = rr * id; _si[i] = ii * id;
        }
        for (let i = P - 1; i >= 0; i--) {
          let rr = _sr[i], ii = _si[i];
          for (let k = i + 1; k < P; k++) {
            const o = o0 + k * P + i;
            const a = lr[o], b = -li[o];
            rr -= a * _dr[k] - b * _di[k];
            ii -= a * _di[k] + b * _dr[k];
          }
          const d = lr[o0 + i * P + i];
          const id = d > 0 ? 1 / d : 0;
          _dr[i] = rr * id; _di[i] = ii * id;
        }
        for (let p = 0; p < P; p++) { _YR[bo + p] = _dr[p]; _YI[bo + p] = _di[p]; }
      }
      this._inverse(out, mask);
      return out;
    }
  }

  function buildEngine(cfg, spec) {
    const { M, P, lambda } = cfg;
    const L = spec.geo.L, taps = cfg.taps;
    const { fft, HhatRe, HhatIm } = spec;
    const w = cfg.weights;
    const br = new Float64Array(L * P * P), bi = new Float64Array(L * P * P);
    for (let p = 0; p < P; p++) {
      for (let q = p; q < P; q++) {
        for (let f = 0; f < L; f++) {
          let sr = 0, si = 0;
          for (let m = 0; m < M; m++) {
            const o = (m * P + p) * L + f, o2 = (m * P + q) * L + f;
            const ar = HhatRe[o], ai = HhatIm[o];
            const cr = HhatRe[o2], ci = HhatIm[o2];
            sr += w[m] * (ar * cr + ai * ci);
            si += w[m] * (ar * ci - ai * cr);
          }
          if (p === q) sr += lambda;
          const i1 = f * P * P + p * P + q;
          br[i1] = sr; bi[i1] = si;
          if (q !== p) {
            const i2 = f * P * P + q * P + p;
            br[i2] = sr; bi[i2] = -si;
          }
        }
      }
    }
    const lr = new Float64Array(L * P * P), li = new Float64Array(L * P * P);
    for (let f = 0; f < L; f++) {
      const o0 = f * P * P;
      for (let i = 0; i < P; i++) {
        for (let j = 0; j <= i; j++) {
          let sr = br[o0 + i * P + j], si = bi[o0 + i * P + j];
          for (let k = 0; k < j; k++) {
            const a = lr[o0 + i * P + k], b = li[o0 + i * P + k];
            const c = lr[o0 + j * P + k], d = li[o0 + j * P + k];
            sr -= a * c + b * d;
            si -= b * c - a * d;
          }
          if (i === j) {
            lr[o0 + i * P + j] = Math.sqrt(sr > 0 ? sr : 0);
            li[o0 + i * P + j] = 0;
          } else {
            const d = lr[o0 + j * P + j];
            if (d > 0) { lr[o0 + i * P + j] = sr / d; li[o0 + i * P + j] = si / d; }
            else { lr[o0 + i * P + j] = 0; li[o0 + i * P + j] = 0; }
          }
        }
      }
    }
    const diagP = new Float64Array(P);
    for (let p = 0; p < P; p++) {
      let e = lambda;
      for (let m = 0; m < M; m++) {
        const h = cfg.H[m][p];
        let s = 0;
        for (let i = 0; i < h.length; i++) s += h[i] * h[i];
        e += w[m] * s;
      }
      diagP[p] = e;
    }
    return new Engine({ M, P, L, taps, fft, HhatRe, HhatIm, br, bi, lr, li, n: P * taps, diagP, lambda });
  }

  /* --------------------- right-hand side & prediction -------------------- */

  function computeC(cfg, spec, q) {
    const { M, P, Q, weights } = cfg;
    const L = spec.geo.L, taps = cfg.taps;
    const { fft, HhatRe, HhatIm, ThatRe, ThatIm } = spec;
    const out = new Float64Array(P * taps);
    const gre = new Float64Array(L), gim = new Float64Array(L);
    const fre = new Float64Array(L), fim = new Float64Array(L);
    for (let p = 0; p < P; p++) {
      gre.fill(0); gim.fill(0);
      for (let m = 0; m < M; m++) {
        const off = (m * P + p) * L, wm = weights[m];
        const tre = ThatRe[m * Q + q], tim = ThatIm[m * Q + q];
        for (let f = 0; f < L; f++) {
          const ar = HhatRe[off + f], ai = -HhatIm[off + f];
          const tr = tre[f], ti = tim[f];
          gre[f] += wm * (ar * tr - ai * ti);
          gim[f] += wm * (ar * ti + ai * tr);
        }
      }
      fre.set(gre); fim.set(gim);
      fft.inv(fre, fim);
      for (let k = 0; k < taps; k++) out[p * taps + k] = fre[k];
    }
    return out;
  }

  function computePrediction(cfg, spec, filters, q) {
    const { M, P } = cfg;
    const L = spec.geo.L, taps = cfg.taps, N = spec.geo.N;
    const { fft, HhatRe, HhatIm } = spec;
    const out = [];
    const Xre = [], Xim = [];
    for (let p = 0; p < P; p++) {
      const re = new Float64Array(L), im = new Float64Array(L);
      for (let k = 0; k < taps; k++) re[k] = filters[p * taps + k];
      fft.fwd(re, im);
      Xre.push(re); Xim.push(im);
    }
    for (let m = 0; m < M; m++) {
      const yre = new Float64Array(L), yim = new Float64Array(L);
      for (let p = 0; p < P; p++) {
        const off = (m * P + p) * L;
        const xp = Xre[p], xq = Xim[p];
        for (let f = 0; f < L; f++) {
          const ar = HhatRe[off + f], ai = HhatIm[off + f];
          const brr = xp[f], bii = xq[f];
          yre[f] += ar * brr - ai * bii;
          yim[f] += ar * bii + ai * brr;
        }
      }
      fft.inv(yre, yim);
      const arr = new Float64Array(N);
      const lim = Math.min(N, L);
      for (let n = 0; n < lim; n++) arr[n] = yre[n];
      out.push(arr);
    }
    return out;
  }

  // Gradient (÷2) at arbitrary filter values, recomputed from spectra.
  function computeGradient(cfg, spec, engine, filters, q) {
    const c = computeC(cfg, spec, q);
    const Bf = new Float64Array(engine.n);
    engine.matvec(filters, Bf, null);
    const g = new Float64Array(engine.n);
    for (let i = 0; i < engine.n; i++) g[i] = Bf[i] - c[i];
    return g;
  }

  function shiftedTarget(cfg, m, q) {
    const { delay } = cfg;
    const N = geometry(cfg).N;
    const t = cfg.T[m][q];
    const arr = new Float64Array(N);
    for (let n = 0; n < t.length; n++) {
      const idx = n + delay;
      if (idx < N) arr[idx] = t[n];
    }
    return arr;
  }

  /* ----------------------------- solver ---------------------------------- */

  function projectedResidual(f, g, G) {
    let m = 0;
    for (let i = 0; i < f.length; i++) {
      const lo = -G[i], hi = G[i];
      let t = f[i] - g[i];
      if (t < lo) t = lo; else if (t > hi) t = hi;
      const e = Math.abs(f[i] - t);
      if (e > m) m = e;
    }
    return m;
  }

  function dotFree(a, b, mask) {
    let s = 0;
    for (let i = 0; i < a.length; i++) if (mask[i]) s += a[i] * b[i];
    return s;
  }
  function maxAbsFree(a, mask) {
    let s = 0;
    for (let i = 0; i < a.length; i++) if (mask[i]) { const v = Math.abs(a[i]); if (v > s) s = v; }
    return s;
  }

  function pcg(engine, rhs, mask, opts) {
    const n = engine.n;
    const d = new Float64Array(n);
    const r = new Float64Array(n);
    const z = new Float64Array(n);
    const p = new Float64Array(n);
    const Ap = new Float64Array(n);
    const bnorm = Math.sqrt(dotFree(rhs, rhs, mask));
    if (bnorm === 0) return { d, iters: 0, rmax: 0, converged: true };
    engine.matvec(d, Ap, mask);
    for (let i = 0; i < n; i++) r[i] = mask[i] ? rhs[i] - Ap[i] : 0;
    const rmax0 = maxAbsFree(r, mask);
    let rmax = rmax0;
    const absTol = opts.absTol, relTol = opts.relTol, maxIter = opts.maxIter;
    const diagP = engine.diagP, taps = engine.taps;
    const precond = (src, dst) => {
      if (opts.useChol) engine.binv(src, dst, mask);
      else {
        for (let i = 0; i < n; i++) {
          if (!mask[i]) { dst[i] = 0; continue; }
          const pi = (i / taps) | 0;
          dst[i] = src[i] / (diagP[pi] > 0 ? diagP[pi] : 1);
        }
        for (let i = 0; i < n; i++) if (!mask[i]) dst[i] = 0;
      }
    };
    precond(r, z);
    for (let i = 0; i < n; i++) p[i] = z[i];
    let rz = dotFree(r, z, mask);
    let it = 0;
    for (; it < maxIter; it++) {
      if (opts.shouldAbort && opts.shouldAbort()) return { d, iters: it, rmax, converged: false, aborted: true };
      engine.matvec(p, Ap, mask);
      const pAp = dotFree(p, Ap, mask);
      if (!(pAp > 0)) break;
      const alpha = rz / pAp;
      for (let i = 0; i < n; i++) { d[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
      for (let i = 0; i < n; i++) if (!mask[i]) r[i] = 0;
      const target = absTol + relTol * rmax0;
      if ((it & 3) === 3 || it === maxIter - 1) {
        rmax = maxAbsFree(r, mask);
        if (rmax <= target) { it++; break; }
      }
      precond(r, z);
      const rz2 = dotFree(r, z, mask);
      if (!(rz2 > 0)) { it++; break; }
      const beta = rz2 / rz;
      rz = rz2;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    rmax = maxAbsFree(r, mask);
    return { d, iters: it, rmax, converged: rmax <= absTol + relTol * rmax0 };
  }

  /**
   * Box-constrained minimisation of 0.5 f'Bf - c'f for one program channel.
   *
   * Primal active set: solve the free block with CG, clip anything that left
   * the box, then check the KKT multipliers of the clipped taps and release
   * those whose gradient points back into the interior. Intermediate CG solves
   * run at a loose tolerance (they only have to reveal the next active set);
   * the final pass tightens down to the certificate target so the exported
   * projected-gradient residual is far inside the 1e-7 requirement.
   */
  async function solveChannel(cfg, spec, engine, c, opts = {}) {
    const shouldAbort = opts.shouldAbort || (() => false);
    const yieldFn = opts.yieldFn || (async () => {});
    const onIteration = opts.onIteration || (() => {});
    const { P, taps, limits } = cfg;
    const n = engine.n;
    const G = new Float64Array(n);
    for (let p = 0; p < P; p++) for (let k = 0; k < taps; k++) G[p * taps + k] = limits[p];
    const f = new Float64Array(n);
    const free = new Uint8Array(n).fill(1);
    const mask = new Uint8Array(n).fill(1);
    const Bf = new Float64Array(n);
    const r = new Float64Array(n);
    const g = new Float64Array(n);

    let cMax = 0;
    for (let i = 0; i < n; i++) { const v = Math.abs(c[i]); if (v > cMax) cMax = v; }
    const scale = Math.max(1, cMax);
    const pgTarget = opts.pgTarget ?? 2e-9;
    const pgAccept = opts.pgAccept ?? 5e-8;
    const maxIter = opts.cgMaxIter ?? 4000;
    const maxOuter = opts.maxOuter ?? 200;
    const useChol = opts.useChol !== false;
    // Intermediate CG passes only need to locate the next active set. A
    // relative target against c keeps ill-scaled problems from grinding: the
    // final polish is always run at the tight certificate tolerance.
    const looseTol = Math.max(opts.cgLooseTol ?? 1e-5 * scale, 1e-11);
    const tightTol = Math.max(pgTarget * 0.2, 1e-13 * scale);
    let totalIters = 0;
    let outer = 0;
    let polished = false;

    const gradFrom = () => {
      engine.matvec(f, Bf, null);
      for (let i = 0; i < n; i++) g[i] = Bf[i] - c[i];
    };
    const solveFree = (tol) => {
      engine.matvec(f, Bf, null);
      let rmax = 0;
      for (let i = 0; i < n; i++) {
        if (!free[i]) { r[i] = 0; continue; }
        const v = c[i] - Bf[i];
        r[i] = v;
        const av = v < 0 ? -v : v;
        if (av > rmax) rmax = av;
      }
      if (rmax <= tol) return { iters: 0, rmax, aborted: false };
      const res = pcg(engine, r, mask, { absTol: tol, relTol: 0, maxIter, useChol, shouldAbort });
      if (res.aborted) return { iters: res.iters, rmax, aborted: true };
      for (let i = 0; i < n; i++) if (free[i]) f[i] += res.d[i];
      return { iters: res.iters, rmax, aborted: false };
    };

    for (; outer < maxOuter; outer++) {
      if (shouldAbort()) return { aborted: true, f, iterations: totalIters, outer };
      await yieldFn();
      onIteration({ outer, iterations: totalIters });

      const pass = solveFree(polished ? tightTol : looseTol);
      totalIters += pass.iters;
      if (pass.aborted) return { aborted: true, f, iterations: totalIters, outer };

      let activated = 0;
      for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        if (f[i] > G[i]) { f[i] = G[i]; free[i] = 0; mask[i] = 0; activated++; }
        else if (f[i] < -G[i]) { f[i] = -G[i]; free[i] = 0; mask[i] = 0; activated++; }
      }
      if (activated > 0) { polished = false; continue; }

      gradFrom();
      // A pinned tap with a barely-positive multiplier contributes that
      // multiplier directly to the projected-gradient certificate, so any
      // threshold well under pgTarget is safe. Keeping such taps pinned
      // avoids the clip/release flapping that near-zero multipliers cause on
      // degenerate problems.
      const violTol = Math.max(opts.kktTol ?? 0.05 * pgTarget, 1e-14 * scale);
      let released = 0;
      for (let i = 0; i < n; i++) {
        if (free[i]) continue;
        if (f[i] > 0 && g[i] > violTol) { free[i] = 1; mask[i] = 1; released++; }
        else if (f[i] < 0 && g[i] < -violTol) { free[i] = 1; mask[i] = 1; released++; }
      }
      if (released > 0) { polished = false; continue; }

      const pr = projectedResidual(f, g, G);
      if (pr <= pgAccept) break;
      if (!polished) { polished = true; continue; } // one tight polish pass
      break;
    }

    gradFrom();
    const pr = projectedResidual(f, g, G);
    return {
      f, g, G,
      iterations: totalIters,
      outer,
      projectedResidual: pr,
      status: pr <= PG_LIMIT ? 'converged' : 'iteration-limit',
      done: pr <= PG_LIMIT,
    };
  }

  /* -------------------------- orchestration ------------------------------ */

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function makeYield() {
    if (typeof setTimeout !== 'function') return async () => {};
    return () => new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Solve all program channels and compute curves/objective.
   * opts: { onEvent, shouldAbort, yieldFn, channelOpts }
   * Returns { aborted: true } without a result if aborted.
   */
  async function solveAll(cfg, opts = {}) {
    const onEvent = opts.onEvent || (() => {});
    const shouldAbort = opts.shouldAbort || (() => false);
    const yieldFn = opts.yieldFn || makeYield();
    const t0 = now();
    const spec = buildSpectra(cfg);
    onEvent({ type: 'stage', stage: 'spectra', elapsed: now() - t0 });
    if (shouldAbort()) return { aborted: true };
    await yieldFn();
    const engine = buildEngine(cfg, spec);
    onEvent({ type: 'stage', stage: 'operator', elapsed: now() - t0 });
    if (shouldAbort()) return { aborted: true };
    await yieldFn();

    const { M, P, Q, taps } = cfg;
    const N = spec.geo.N;
    const filters = [], predictions = [], residuals = [], targets = [];
    let objectiveResidual = 0, tapSum = 0;
    let projected = 0, iterations = 0, outer = 0;
    const perChannel = [];

    for (let q = 0; q < Q; q++) {
      if (shouldAbort()) return { aborted: true };
      await yieldFn();
      const c = computeC(cfg, spec, q);
      onEvent({ type: 'stage', stage: 'rhs', q, elapsed: now() - t0 });
      if (shouldAbort()) return { aborted: true };
      await yieldFn();

      const sol = await solveChannel(cfg, spec, engine, c, {
        ...(opts.channelOpts || {}), shouldAbort, yieldFn,
        onIteration: (it) => onEvent({ type: 'stage', stage: 'iterate', q, ...it, elapsed: now() - t0 }),
      });
      if (sol.aborted) return { aborted: true };
      onEvent({ type: 'stage', stage: 'solve', q, projected: sol.projectedResidual, elapsed: now() - t0 });
      if (shouldAbort()) return { aborted: true };
      await yieldFn();

      const f = sol.f;
      filters.push(f);
      iterations += sol.iterations;
      outer += sol.outer;
      projected = Math.max(projected, sol.projectedResidual);

      const pred = computePrediction(cfg, spec, f, q);
      predictions.push(pred);
      const tgt = [], res = [];
      let resSum = 0;
      for (let m = 0; m < M; m++) {
        const tm = shiftedTarget(cfg, m, q);
        tgt.push(tm);
        const rr = new Float64Array(N);
        let s = 0;
        for (let n = 0; n < N; n++) {
          const e = pred[m][n] - tm[n];
          rr[n] = e; s += e * e;
        }
        res.push(rr);
        resSum += cfg.weights[m] * s;
      }
      residuals.push(res);
      targets.push(tgt);
      let ts = 0;
      for (let i = 0; i < f.length; i++) ts += f[i] * f[i];
      tapSum += ts;
      objectiveResidual += resSum;
      perChannel.push({
        q,
        iterations: sol.iterations,
        outer: sol.outer,
        projectedResidual: sol.projectedResidual,
        status: sol.status,
        residualSum: resSum,
        tapSum: ts,
        objective: resSum + cfg.lambda * ts,
      });
      if (shouldAbort()) return { aborted: true };
      await yieldFn();
    }
    const objective = objectiveResidual + cfg.lambda * tapSum;
    return {
      aborted: false,
      spec, engine,
      filters, predictions, residuals, targets,
      objective, objectiveResidual, tapSum,
      projectedResidual: projected,
      iterations, outer,
      perChannel,
      elapsed: now() - t0,
      geometry: spec.geo,
    };
  }

  function makeExport(cfg, result) {
    const filters = [];
    for (let p = 0; p < cfg.P; p++) {
      const perProgram = [];
      for (let q = 0; q < cfg.Q; q++) {
        const f = result.filters[q];
        const row = new Array(cfg.taps);
        for (let k = 0; k < cfg.taps; k++) row[k] = f[p * cfg.taps + k];
        perProgram.push(row);
      }
      filters.push(perProgram);
    }
    return {
      sample_rate: SAMPLE_RATE,
      taps: cfg.taps,
      delay: cfg.delay,
      lambda: cfg.lambda,
      objective: result.objective,
      projected_residual: result.projectedResidual,
      filters,
    };
  }

  /**
   * Re-certify a JSON export from scratch: rebuilds the operator from cfg and
   * the filter taps parsed from the JSON, then evaluates the projected
   * gradient exactly as the spec defines it. Also verifies every tap is in box.
   */
  function certifyExport(cfg, exportObj) {
    const errors = [];
    if (!exportObj || typeof exportObj !== 'object') return { ok: false, errors: ['导出不是对象'] };
    if (exportObj.taps !== cfg.taps) errors.push(`导出 taps=${exportObj.taps} 与当前 ${cfg.taps} 不一致`);
    const F = exportObj.filters;
    if (!Array.isArray(F) || F.length !== cfg.P) errors.push(`filters 顶层长度应为 ${cfg.P}（扬声器）`);
    const filters = [];
    let maxOverrun = 0;
    for (let q = 0; q < cfg.Q; q++) {
      const fq = new Float64Array(cfg.P * cfg.taps);
      for (let p = 0; p < cfg.P; p++) {
        const rowQ = F && F[p] && F[p][q];
        for (let k = 0; k < cfg.taps; k++) {
          const v = rowQ && rowQ[k];
          if (!isNum(v)) { errors.push(`filters[${p}][${q}][${k}] 非有限数值`); continue; }
          if (Math.abs(v) > cfg.limits[p]) maxOverrun = Math.max(maxOverrun, Math.abs(v) - cfg.limits[p]);
          fq[p * cfg.taps + k] = v;
        }
      }
      filters.push(fq);
    }
    if (errors.length) return { ok: false, errors, maxOverrun };
    const spec = buildSpectra(cfg);
    const engine = buildEngine(cfg, spec);
    let pg = 0;
    const perChannelPg = [];
    for (let q = 0; q < cfg.Q; q++) {
      const g = computeGradient(cfg, spec, engine, filters[q], q);
      const G = new Float64Array(engine.n);
      for (let p = 0; p < cfg.P; p++) for (let k = 0; k < cfg.taps; k++) G[p * cfg.taps + k] = cfg.limits[p];
      const v = projectedResidual(filters[q], g, G);
      perChannelPg.push(v);
      pg = Math.max(pg, v);
    }
    return {
      ok: errors.length === 0,
      errors,
      projectedResidual: pg,
      perChannelPg,
      maxOverrun,
      withinTolerance: pg <= PG_LIMIT && maxOverrun <= 1e-12,
    };
  }

  return {
    SAMPLE_RATE, MAX_MEAS, MAX_SPK, MAX_PROGRAMS, MAX_LEN, MAX_DELAY,
    W_MIN, W_MAX, G_MIN, G_MAX, LAMBDA_MIN, LAMBDA_MAX, ENERGY_LIMIT, PG_LIMIT,
    nextPow2, FFT,
    validateProjectObject, validateParams, parseSignals, signalSampleCount,
    energyTerms, geometry, buildSpectra, buildEngine, computeC, computePrediction,
    computeGradient, shiftedTarget, solveChannel, solveAll, projectedResidual,
    makeExport, certifyExport, now,
  };
});
