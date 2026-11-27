/* 相位掩膜衍射打样 —— 数值核心
 *
 * 浏览器（普通脚本）与 Node（require）共用，无外部依赖。
 *
 * 约定（与 samples/phase-mask.json 的 spec 一致）：
 *  - 每种波长输入复场 U = amp * exp(i 2π cycles p)
 *  - 补零网格 M = 2W、N = 2H，原场左上角放在 (W/2, H/2)
 *  - 正向 DFT 指数为负，逆向除以 M*N
 *  - fx = m/(M dx)，m 取横坐标 m<W 的原值，否则 m-M；fy 同理
 *  - s = 1/λ² - fx² - fy²，s >= 0 乘 exp(i2πz√s)，否则乘 exp(-2πz√(-s))
 *  - z = 0 时 H_z 恒为 1
 *  - 逆变换后裁回放置矩形得 V，I = |V|²
 *  - E = 0.5 Σ weight (I - target)²
 *  - G = ∂E/∂p 为未投影、未清零锁点的真实损失梯度（伴随传播）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TWO_PI = 2 * Math.PI;

  /* ============================== FFT ============================== */

  function makePlan(n) {
    if (!(n >= 2) || (n & (n - 1)) !== 0) throw new Error('FFT 长度必须为 2 的幂');
    const log = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, v = i;
      for (let b = 0; b < log; b++) { r = (r << 1) | (v & 1); v >>= 1; }
      rev[i] = r;
    }
    const stages = [];
    const twR = [], twI = [];
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, st = n / len, off = twR.length;
      for (let k = 0; k < half; k++) {
        const a = -TWO_PI * k / len;
        twR.push(Math.cos(a)); twI.push(Math.sin(a));
      }
      stages.push({ len, half, st, off });
    }
    return { n, rev, twR: Float64Array.from(twR), twI: Float64Array.from(twI), stages };
  }

  function fft1d(re, im, off, p, inv) {
    const n = p.n, rev = p.rev, twR = p.twR, twI = p.twI, stages = p.stages;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        const a = off + i, b = off + r;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    const sg = inv ? -1 : 1;
    for (let si = 0; si < stages.length; si++) {
      const len = stages[si].len, half = len >> 1, step = stages[si].st, twOff = stages[si].off;
      for (let s = 0; s < n; s += len) {
        let m = twOff;
        for (let k = 0; k < half; k++, m++) {
          const wr = twR[m], wi = sg * twI[m];
          const a = off + s + k, b = a + half;
          const xr = re[b], xi = im[b];
          const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function makeFFT2(M, N) {
    const pm = makePlan(M), pn = makePlan(N);
    const tRe = new Float64Array(M * N), tIm = new Float64Array(M * N);

    // 分块转置：把 (rows × cols) 转到 (cols × rows)
    function transpose(srcRe, srcIm, rows, cols, dstRe, dstIm) {
      const B = 24;
      for (let i0 = 0; i0 < rows; i0 += B) {
        const i1 = Math.min(i0 + B, rows);
        for (let j0 = 0; j0 < cols; j0 += B) {
          const j1 = Math.min(j0 + B, cols);
          for (let i = i0; i < i1; i++) {
            const sBase = i * cols;
            for (let j = j0; j < j1; j++) {
              const si = sBase + j, di = j * rows + i;
              dstRe[di] = srcRe[si]; dstIm[di] = srcIm[si];
            }
          }
        }
      }
    }

    function fwd(re, im) {
      for (let y = 0; y < N; y++) fft1d(re, im, y * M, pm, false);
      transpose(re, im, N, M, tRe, tIm);
      for (let x = 0; x < M; x++) fft1d(tRe, tIm, x * N, pn, false);
      transpose(tRe, tIm, M, N, re, im);
    }

    function inv(re, im) {
      for (let y = 0; y < N; y++) fft1d(re, im, y * M, pm, true);
      transpose(re, im, N, M, tRe, tIm);
      for (let x = 0; x < M; x++) fft1d(tRe, tIm, x * N, pn, true);
      transpose(tRe, tIm, M, N, re, im);
      const sc = 1 / (M * N);
      for (let i = 0; i < re.length; i++) { re[i] *= sc; im[i] *= sc; }
    }

    return { M, N, fwd, inv };
  }

  /* ============================ 输入校验 ============================ */

  const isPow2Size = (v) => Number.isInteger(v) && v >= 4 && v <= 256 && (v & (v - 1)) === 0;
  const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isIntNum = (v) => typeof v === 'number' && Number.isInteger(v);

  function validateProject(obj) {
    const errors = [];
    const err = (path, message) => errors.push({ path, message });

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: [{ path: '(root)', message: '项目必须是一个 JSON 对象' }] };
    }

    const W = obj.W, H = obj.H;
    const dimOk = isPow2Size(W) && isPow2Size(H);
    if (!isPow2Size(W)) err('W', '必须为 4 到 256 之间的二次幂整数');
    if (!isPow2Size(H)) err('H', '必须为 4 到 256 之间的二次幂整数');

    for (const key of ['dx', 'dy']) {
      if (!isFiniteNum(obj[key])) err(key, '必须为有限实数');
      else if (obj[key] < 0.1 || obj[key] > 100) err(key, '必须在 0.1 到 100 微米之间');
    }

    const waves = obj.waves;
    let nWaves = 0;
    if (!Array.isArray(waves) || waves.length < 1 || waves.length > 2) {
      err('waves', '必须为 1 或 2 项的数组');
    } else {
      nWaves = waves.length;
      for (let i = 0; i < waves.length; i++) {
        const w = waves[i], p = `waves[${i}]`;
        if (w === null || typeof w !== 'object' || Array.isArray(w)) { err(p, '必须是对象'); continue; }
        if (!isFiniteNum(w.lambda)) err(`${p}.lambda`, '必须为有限实数');
        else if (w.lambda < 0.1 || w.lambda > 100) err(`${p}.lambda`, '必须在 0.1 到 100 微米之间');
        if (!isFiniteNum(w.cycles)) err(`${p}.cycles`, '必须为有限实数');
        else if (!(w.cycles > 0 && w.cycles <= 4)) err(`${p}.cycles`, '必须在 (0, 4] 区间内');
      }
    }

    for (const key of ['amp', 'p0']) {
      const arr = obj[key];
      if (!Array.isArray(arr)) { err(key, '必须为数组'); continue; }
      if (dimOk && arr.length !== W * H) {
        err(key, `长度必须为 W*H=${W * H}，实际为 ${arr.length}`);
        continue;
      }
      if (!dimOk) continue;
      for (let i = 0; i < arr.length; i++) {
        if (!isFiniteNum(arr[i])) { err(`${key}[${i}]`, '必须为有限实数'); break; }
        if (arr[i] < 0 || arr[i] > 1) { err(`${key}[${i}]`, '必须在 [0, 1] 内'); break; }
      }
    }

    const locks = obj.locks;
    if (!Array.isArray(locks)) err('locks', '必须为数组');
    else {
      const seen = new Set();
      for (let i = 0; i < locks.length; i++) {
        const L = locks[i], p = `locks[${i}]`;
        if (!Array.isArray(L) || L.length !== 3) { err(p, '必须为 [x, y, q] 数组'); continue; }
        const x = L[0], y = L[1], q = L[2];
        if (!isIntNum(x) || (dimOk ? !(x >= 0 && x < W) : false)) err(`${p}[0]`, 'x 必须为 [0, W) 内的整数');
        if (!isIntNum(y) || (dimOk ? !(y >= 0 && y < H) : false)) err(`${p}[1]`, 'y 必须为 [0, H) 内的整数');
        if (!isIntNum(q) || q < 0 || q > 255) err(`${p}[2]`, 'q 必须为 0 到 255 的整数');
        if (dimOk && isIntNum(x) && isIntNum(y)) {
          const k = x + ',' + y;
          if (seen.has(k)) err(p, `坐标 (${x}, ${y}) 重复`);
          seen.add(k);
        }
      }
    }

    const planes = obj.planes;
    if (!Array.isArray(planes) || planes.length < 1 || planes.length > 6) {
      err('planes', '必须为 1 到 6 项的数组');
    } else {
      for (let i = 0; i < planes.length; i++) {
        const pl = planes[i], p = `planes[${i}]`;
        if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) { err(p, '必须是对象'); continue; }
        if (!isIntNum(pl.wave) || pl.wave < 0 || (nWaves > 0 ? pl.wave >= nWaves : false)) {
          err(`${p}.wave`, '必须为 waves 的零基索引');
        }
        if (!isFiniteNum(pl.z)) err(`${p}.z`, '必须为有限实数');
        else if (pl.z < 0 || pl.z > 10000) err(`${p}.z`, '必须在 0 到 10000 微米之间');
        for (const [key, lo, hi, label] of [['target', 0, 16, '目标强度'], ['weight', 0, 1, '权重']]) {
          const arr = pl[key];
          if (!Array.isArray(arr)) { err(`${p}.${key}`, '必须为数组'); continue; }
          if (dimOk && arr.length !== W * H) {
            err(`${p}.${key}`, `长度必须为 W*H=${W * H}，实际为 ${arr.length}`);
            continue;
          }
          if (!dimOk) continue;
          for (let k = 0; k < arr.length; k++) {
            if (!isFiniteNum(arr[k])) { err(`${p}.${key}[${k}]`, '必须为有限实数'); break; }
            if (arr[k] < lo || arr[k] > hi) { err(`${p}.${key}[${k}]`, `${label}必须在 [${lo}, ${hi}] 内`); break; }
          }
        }
      }
    }

    if (!isFiniteNum(obj.eta)) err('eta', '必须为有限实数');
    else if (!(obj.eta > 0 && obj.eta <= 1)) err('eta', '必须在 (0, 1] 区间内');
    if (!isIntNum(obj.steps)) err('steps', '必须为整数');
    else if (obj.steps < 1 || obj.steps > 120) err('steps', '必须为 1 到 120 的整数');
    if (obj.spec !== undefined && typeof obj.spec !== 'string') err('spec', '若提供必须为字符串');

    return { ok: errors.length === 0, errors };
  }

  // 校验通过后转成运行时结构（TypedArray）
  function prepareProject(obj) {
    const v = validateProject(obj);
    if (!v.ok) throw new Error('项目未通过校验：' + v.errors.map((e) => e.path).join(', '));
    return {
      W: obj.W, H: obj.H, dx: obj.dx, dy: obj.dy,
      waves: obj.waves.map((w) => ({ lambda: w.lambda, cycles: w.cycles })),
      amp: Float64Array.from(obj.amp),
      p0: Float64Array.from(obj.p0),
      locks: obj.locks.map(([x, y, q]) => ({ x, y, q })),
      planes: obj.planes.map((pl) => ({
        wave: pl.wave, z: pl.z,
        target: Float64Array.from(pl.target),
        weight: Float64Array.from(pl.weight),
      })),
      eta: obj.eta, steps: obj.steps,
      spec: obj.spec,
    };
  }

  /* ============================== 引擎 ============================== */

  function createEngine(proj) {
    const W = proj.W, H = proj.H, M = 2 * W, N = 2 * H;
    const offX = W / 2, offY = H / 2;
    const P = proj.planes.length;
    const fft2 = makeFFT2(M, N);

    const waves = proj.waves.map((w) => ({ lambda: w.lambda, cycles: w.cycles }));
    const amp = Float64Array.from(proj.amp);
    const locks = proj.locks.map((L) => ({
      x: L.x, y: L.y, q: L.q,
      v: L.q / 255,
    }));

    const fx = new Float64Array(M), fy = new Float64Array(N);
    for (let m = 0; m < M; m++) fx[m] = (m < W ? m : m - M) / (M * proj.dx);
    for (let n = 0; n < N; n++) fy[n] = (n < H ? n : n - N) / (N * proj.dy);

    const planes = proj.planes.map((pl) => ({
      wave: pl.wave, z: pl.z,
      target: Float64Array.from(pl.target),
      weight: Float64Array.from(pl.weight),
      hRe: new Float64Array(M * N), hIm: new Float64Array(M * N),
    }));

    // 批量标记：某面权重是否全 0（梯度可跳过）
    function planeAllZeroWeight(j) {
      const w = planes[j].weight;
      for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
      return true;
    }

    function computeH(j) {
      const pl = planes[j];
      const lam = waves[pl.wave].lambda;
      const z = pl.z;
      if (z === 0) {
        pl.hRe.fill(1); pl.hIm.fill(0);
        return;
      }
      const invLam2 = 1 / (lam * lam);
      for (let n = 0; n < N; n++) {
        const fy2 = fy[n] * fy[n];
        const base = n * M;
        for (let m = 0; m < M; m++) {
          const s = invLam2 - fx[m] * fx[m] - fy2;
          let re, im;
          if (s >= 0) {
            const a = TWO_PI * z * Math.sqrt(s);
            re = Math.cos(a); im = Math.sin(a);
          } else {
            re = Math.exp(-TWO_PI * z * Math.sqrt(-s)); im = 0;
          }
          pl.hRe[base + m] = re; pl.hIm[base + m] = im;
        }
      }
      pl.zeroWeight = planeAllZeroWeight(j);
    }
    for (let j = 0; j < P; j++) computeH(j);

    /* 引擎级暂存（每次评估内部使用，不跨调用保存结果） */
    const padRe = new Float64Array(M * N), padIm = new Float64Array(M * N);
    const vRe = new Float64Array(M * N), vIm = new Float64Array(M * N);
    const aRe = new Float64Array(M * N), aIm = new Float64Array(M * N);
    const waveSpec = waves.map(() => [new Float64Array(M * N), new Float64Array(M * N)]);

    function createSlot() {
      return {
        p: new Float64Array(W * H),
        U: waves.map(() => [new Float64Array(W * H), new Float64Array(W * H)]),
        vCrop: planes.map(() => [new Float64Array(W * H), new Float64Array(W * H)]),
        intensity: planes.map(() => new Float64Array(W * H)),
        planeLoss: new Float64Array(P),
        loss: 0,
        grad: null,
      };
    }

    function evaluateInto(p, slot, wantGrad) {
      const n = W * H;
      slot.p.set(p);

      // 1. 每种波长的入射场与正向频谱
      const waveUsed = new Set();
      for (let j = 0; j < P; j++) waveUsed.add(planes[j].wave);
      for (const wi of waveUsed) {
        const w = waves[wi];
        const Ure = slot.U[wi][0], Uim = slot.U[wi][1];
        const c = w.cycles;
        for (let i = 0; i < n; i++) {
          const a = TWO_PI * c * p[i];
          const s = Math.sin(a), cos = Math.cos(a);
          Ure[i] = amp[i] * cos;
          Uim[i] = amp[i] * s;
        }
        padRe.fill(0); padIm.fill(0);
        for (let y = 0; y < H; y++) {
          const src = y * W, dst = (y + offY) * M + offX;
          padRe.set(Ure.subarray(src, src + W), dst);
          padIm.set(Uim.subarray(src, src + W), dst);
        }
        fft2.fwd(padRe, padIm);
        const sp = waveSpec[wi];
        sp[0].set(padRe); sp[1].set(padIm);
      }

      // 2. 每个面：乘 H_z → 逆变换 → 裁回
      let loss = 0;
      for (let j = 0; j < P; j++) {
        const pl = planes[j];
        const sp = waveSpec[pl.wave];
        for (let i = 0; i < M * N; i++) {
          const ar = sp[0][i], ai = sp[1][i], hr = pl.hRe[i], hi = pl.hIm[i];
          vRe[i] = ar * hr - ai * hi;
          vIm[i] = ar * hi + ai * hr;
        }
        fft2.inv(vRe, vIm);
        const vr = slot.vCrop[j][0], vi = slot.vCrop[j][1];
        const Ij = slot.intensity[j], Tj = pl.target, wj = pl.weight;
        let pl0 = 0;
        for (let y = 0; y < H; y++) {
          const src = (y + offY) * M + offX, row = y * W;
          for (let x = 0; x < W; x++) {
            const vr0 = vRe[src + x], vi0 = vIm[src + x];
            const ii = vr0 * vr0 + vi0 * vi0;
            const idx = row + x;
            vr[idx] = vr0; vi[idx] = vi0;
            Ij[idx] = ii;
            const d = ii - Tj[idx];
            pl0 += 0.5 * wj[idx] * d * d;
          }
        }
        slot.planeLoss[j] = pl0;
        loss += pl0;
      }
      slot.loss = loss;

      slot.grad = null;
      if (wantGrad) computeGrad(slot);
      return slot;
    }

    // 由 slot 中的 V 裁回场与 U 计算真实梯度（未投影、未清零锁点）
    function computeGrad(slot) {
      const n = W * H;
      let G = slot.grad;
      if (!G) G = new Float64Array(n);
      G.fill(0);
      for (let j = 0; j < P; j++) {
        const pl = planes[j];
        const w = waves[pl.wave];
        const Ij = slot.intensity[j], Tj = pl.target, wj = pl.weight;
        const vjRe = slot.vCrop[j][0], vjIm = slot.vCrop[j][1];
        const Ure = slot.U[pl.wave][0], Uim = slot.U[pl.wave][1];
        // a = weight*(I-target)*V；全零权重面不贡献
        aRe.fill(0); aIm.fill(0);
        let any = false;
        for (let idx = 0; idx < n; idx++) {
          const k = wj[idx];
          if (k === 0) continue;
          const g = k * (Ij[idx] - Tj[idx]);
          const y = (idx - (idx % W)) / W, x = idx % W;
          const dst = (y + offY) * M + offX + x;
          aRe[dst] = g * vjRe[idx];
          aIm[dst] = g * vjIm[idx];
          any = true;
        }
        if (!any) continue;
        fft2.fwd(aRe, aIm);
        const hr = pl.hRe, hi = pl.hIm;
        for (let i = 0; i < M * N; i++) {
          const ar = aRe[i], ai = aIm[i];
          // 乘共轭 H_z
          aRe[i] = ar * hr[i] + ai * hi[i];
          aIm[i] = ai * hr[i] - ar * hi[i];
        }
        fft2.inv(aRe, aIm);
        const k = 4 * Math.PI * w.cycles;
        for (let idx = 0; idx < n; idx++) {
          const y = (idx - (idx % W)) / W, x = idx % W;
          const src = (y + offY) * M + offX + x;
          const fr = aRe[src], fi = aIm[src];
          // Im(conj(U) f) = Im(conj(Ure+iUim)(fr+i fi))
          //   = Uim*fr - Ure*fi? 计算  conj(U)*f = (Ure - i Uim)(fr + i fi)
          //   = (Ure*fr + Uim*fi) + i (Ure*fi - Uim*fr)
          // 虚部 = Ure*fi - Uim*fr
          G[idx] += k * (Ure[idx] * fi - Uim[idx] * fr);
        }
      }
      slot.grad = G;
      return G;
    }

    function applyLocksTo(p) {
      const q = Float64Array.from(p);
      for (const L of locks) q[L.y * W + L.x] = L.q / 255;
      return q;
    }

    function quantize(p) {
      const out = new Uint8Array(W * H);
      for (let i = 0; i < p.length; i++) {
        let q = Math.floor(255 * p[i] + 0.5);
        if (q < 0) q = 0; else if (q > 255) q = 255;
        out[i] = q;
      }
      return out;
    }

    function dequantize(q) {
      const out = new Float64Array(W * H);
      for (let i = 0; i < q.length; i++) out[i] = q[i] / 255;
      return out;
    }

    // 用 8 位量化码重新传播（导出误差 JSON）
    function evaluateQuantized(p) {
      const q = typeof p === 'string' ? p : quantize(p);
      const pq = dequantize(q);
      const slot = createSlot();
      evaluateInto(pq, slot, false);
      return {
        bytes: q,
        p: pq,
        loss: slot.loss,
        planeLoss: Array.from(slot.planeLoss),
        intensity: slot.intensity.map((a) => Float64Array.from(a)),
      };
    }

    function setPlaneZ(j, z) {
      planes[j].z = z;
      computeH(j);
    }

    return {
      W, H, M, N, offX, offY, planes, waves, amp, locks, fft2,
      p0: Float64Array.from(proj.p0),
      eta: proj.eta, steps: proj.steps,
      evaluateInto, computeGrad, createSlot, applyLocksTo, quantize, dequantize,
      evaluateQuantized, setPlaneZ,
    };
  }

  /* ============================== 会话 ============================== */

  const MAX_BACKTRACK = 8;
  const ARMIJO_C1 = 0.0001;
  const ARMIJO_FLOOR = 1e-12;

  function createSession(engine, opts) {
    const settings = { eta: engine.eta, steps: engine.steps, p0: engine.p0 };
    if (opts) {
      if (opts.eta !== undefined) settings.eta = opts.eta;
      if (opts.steps !== undefined) settings.steps = opts.steps;
      if (opts.p0) settings.p0 = opts.p0;
    }

    const W = engine.W, H = engine.H, n = W * H;
    let slotA = engine.createSlot(); // 已提交状态（含梯度）
    let slotB = engine.createSlot(); // 试步暂存
    let pCur = null;
    let pInitial = null;
    let state = 'idle';
    let round = 0;
    let lastStep = null;
    const history = [];

    function init(p0) {
      const base = p0 || settings.p0;
      pInitial = engine.applyLocksTo(base);
      pCur = Float64Array.from(pInitial);
      round = 0;
      lastStep = null;
      history.length = 0;
      engine.evaluateInto(pCur, slotA, true);
      history.push({ round: 0, loss: slotA.loss, planeLoss: Array.from(slotA.planeLoss), stepSize: null });
      state = 'ready';
      return this;
    }

    function trialFrom(p, G, t, out) {
      for (let i = 0; i < n; i++) {
        let v = p[i] - t * G[i];
        if (v < 0) v = 0; else if (v > 1) v = 1;
        out[i] = v;
      }
      for (const L of engine.locks) out[L.y * W + L.x] = L.q / 255;
      return out;
    }

    function oneStep() {
      if (state === 'idle') init();
      if (round >= settings.steps) { state = 'done'; return summary(true); }
      if (!slotA.grad) engine.computeGrad(slotA);
      const G = slotA.grad, p = pCur, E0 = slotA.loss;

      let accepted = false, acceptedT = 0;
      for (let j = 0; j < MAX_BACKTRACK; j++) {
        const t = settings.eta / Math.pow(2, j);
        trialFrom(p, G, t, slotB.p);
        let differs = false;
        for (let i = 0; i < n; i++) if (slotB.p[i] !== p[i]) { differs = true; break; }
        if (!differs) continue;
        engine.evaluateInto(slotB.p, slotB, false);
        const Et = slotB.loss;
        let dot = 0;
        for (let i = 0; i < n; i++) dot += G[i] * (slotB.p[i] - p[i]);
        const rhs = E0 + ARMIJO_C1 * dot + ARMIJO_FLOOR * Math.max(1, E0);
        if (Et <= rhs) { accepted = true; acceptedT = t; break; }
      }

      if (accepted) {
        const tmp = slotA; slotA = slotB; slotB = tmp;
        pCur = Float64Array.from(slotA.p);
        engine.computeGrad(slotA); // 已提交状态的梯度，供显示与下一轮
      }
      lastStep = accepted ? acceptedT : 0;
      round += 1;
      history.push({
        round, loss: slotA.loss, planeLoss: Array.from(slotA.planeLoss), stepSize: lastStep,
      });
      state = round >= settings.steps ? 'done' : 'ready';
      return summary(state === 'done');
    }

    function summary(done) {
      return {
        round, loss: slotA.loss, planeLoss: Array.from(slotA.planeLoss),
        stepSize: lastStep, done,
      };
    }

    const api = {
      get round() { return round; },
      get eta() { return settings.eta; },
      get steps() { return settings.steps; },
      get loss() { return slotA.loss; },
      get planeLoss() { return Array.from(slotA.planeLoss); },
      get lastStep() { return lastStep; },
      get state() { return state; },
      get done() { return state === 'done'; },
      get p() { return pCur; },
      get grad() { if (!slotA.grad) engine.computeGrad(slotA); return slotA.grad; },
      get slot() { return slotA; },
      get initial() { return pInitial; },
      get history() { return history.map((h) => ({ ...h, planeLoss: h.planeLoss.slice() })); },
      init, step: oneStep,
      setSteps(v) {
        if (!Number.isInteger(v) || v < 1 || v > 120) throw new Error('steps 必须为 1 到 120 的整数');
        settings.steps = v;
        if (round >= settings.steps) state = 'done';
        else if (state === 'done') state = 'ready';
        return round;
      },
      intensity(j) { return slotA.intensity[j]; },
      // 按当前驱动（尚未量化）导出的 8 位码
      quantize() { return engine.quantize(pCur); },
      // 误差 JSON：step 是已完成轮数；loss / planeLoss 用 q/255 重新传播
      exportError() {
        const q = engine.evaluateQuantized(pCur);
        return {
          W: engine.W, H: engine.H, step: round, loss: q.loss,
          planeLoss: q.planeLoss, bytes: q.bytes, pQuant: q.p,
        };
      },
    };
    return api;
  }

  /* ====================================================================
   * 说明：以下为对外的便捷函数（页面、Worker、Node 测试都直接调用）
   * ==================================================================== */

  function createProject(obj) {
    const v = validateProject(obj);
    if (!v.ok) return { ok: false, errors: v.errors };
    const engine = createEngine(prepareProject(obj));
    return { ok: true, engine, project: obj };
  }

  return {
    makePlan, makeFFT2, validateProject, prepareProject, createEngine, createSession, createProject,
  };
});
