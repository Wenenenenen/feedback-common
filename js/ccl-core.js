/*
 * ccl-core.js — 循环环境音上限限幅器的精确核心
 *
 * 约定（与包内 约定.txt 逐条对应）：
 *  - 一圈 N 个 48kHz 基率帧，四倍周期插值后共 n = 4N 个 192kHz 帧，编号 0..n-1。
 *  - 第 i 基率帧与下一帧之间相位 s = j/4 (j=0..3)，取循环索引 i-1,i,i+1,i+2 的码值 a,b,c,d：
 *      I = (2b + (-a+c)s + (2a-5b+4c-d)s^2 + (-a+3b-3c+d)s^3) / 2
 *    令 B,C,D 为对应整系数，可写成精确整数分数 I = K/128，其中
 *      K = 128b + 16Bj + 4Cj^2 + Dj^3。
 *  - 每帧增益 g 是 0..65536 的整数，两声道共用：
 *      y = round_half_to_even(K*g / (128*65536)) = rhe(K*g / 2^23)
 *    先舍入，再检查绝对码值 <= ceiling，不另做削顶。
 *  - up/down 为相邻（192k）帧之间增益的最大增加/减少，首尾同规则（环）。
 *  - 锁 = 指定帧上的目标增益。把锁也当作上限求逐点最大曲线；
 *    曲线低于目标值的锁即“达不到的锁（冲突）”。
 *
 * 本文件为无依赖 UMD：浏览器挂到 globalThis.CCL，Node 可 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CCL = root.CCL || {};
    Object.assign(root.CCL, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GAIN_MAX = 65536;
  const CEILING_MIN = 0;
  const CEILING_MAX = 32767;
  const BASE_RATE = 48000;
  const OUT_RATE = 192000;
  const OVERSAMPLE = 4;
  // 128（插值分母）* 65536（增益分母）= 2^23
  const SCALE_SHIFT = 23;
  const SCALE_DEN = 1 << SCALE_SHIFT;
  const TIE_HALF = 1 << (SCALE_SHIFT - 1);

  /** 安全整数范围内的正整数 floor(num/den)，带乘法校正，杜绝浮点边界 off-by-one。 */
  function floorDivExact(num, den) {
    let q = Math.floor(num / den);
    // 这里的乘积在本应用内 <= ~5.5e11，仍是精确整数；循环至多一两次。
    while ((q + 1) * den <= num) q++;
    while (q * den > num) q--;
    return q;
  }

  /**
   * 周期四点三次插值的精确整数分子 K（I = K/128）。
   * a,b,c,d 为循环索引 i-1,i,i+1,i+2 上的 PCM16 码值；j ∈ {0,1,2,3}。
   */
  function interpK(a, b, c, d, j) {
    const B = -a + c;
    const C = 2 * a - 5 * b + 4 * c - d;
    const D = -a + 3 * b - 3 * c + d;
    const jj = j | 0;
    return 128 * b + 16 * B * jj + 4 * C * jj * jj + D * jj * jj * jj;
  }

  /**
   * 精确“四舍六入五成双”：返回 rhe(t / 2^23)，t 为整数 K*g（可为负）。
   * 因为分母是 2 的幂，Math.floor(x / 2^23) 本身精确（仅改指数），
   * 余数判定完全用整数完成。
   */
  function roundScaled(t) {
    let neg = false;
    let x = t;
    if (x < 0) { neg = true; x = -x; }
    const q = Math.floor(x / SCALE_DEN);
    const rem = x - q * SCALE_DEN;
    let y = q;
    if (rem > TIE_HALF || (rem === TIE_HALF && (q & 1) === 1)) y = q + 1;
    return neg ? -y : y;
  }

  /**
   * 单声道单点：满足 |rhe(K*g/2^23)| <= ceiling 的最大整数 g（上限 GAIN_MAX）。
   *
   * |rhe(z)| <= C 的充要条件：
   *   |z| < C+1/2，或 |z| = C+1/2 且 C 为偶数（中点舍入到偶数 C）。
   * 令 T = (2C+1)*2^22，则 A=|K| 时：
   *   C 偶：A*g <= T          -> floor(T/A)
   *   C 奇：A*g <  T          -> floor((T-1)/A)
   */
  function ceilingCapK(K, ceiling) {
    const A = Math.abs(K);
    if (A === 0) return GAIN_MAX;
    const C = ceiling | 0;
    const T = (2 * C + 1) * (1 << 22);
    let g = (C & 1) === 0 ? floorDivExact(T, A) : floorDivExact(T - 1, A);
    if (g > GAIN_MAX) g = GAIN_MAX;
    if (g < 0) g = 0;
    return g;
  }

  function cycIdx(i, N) {
    let r = i % N;
    if (r < 0) r += N;
    return r;
  }

  /**
   * 由 48k 双声道 PCM16 码值求每个 192k 帧的增益上限帽。
   * left/right：长度 N 的整数类数组（Int16Array 最佳）。
   * 返回 { caps:Int32Array(4N), maxAbsK_L, maxAbsK_R }；
   * 插值峰值 = maxAbsK/128（可能大于原始峰值，三次插值会过冲）。
   */
  function computeCaps(left, right, N, ceiling, capsOut) {
    const n = OVERSAMPLE * N;
    const caps = capsOut && capsOut.length === n ? capsOut : new Int32Array(n);
    let maxKL = 0, maxKR = 0;
    for (let i = 0; i < N; i++) {
      const im = cycIdx(i - 1, N);
      const i1 = cycIdx(i + 1, N);
      const i2 = cycIdx(i + 2, N);
      const aL = left[im], bL = left[i], cL = left[i1], dL = left[i2];
      const aR = right[im], bR = right[i], cR = right[i1], dR = right[i2];
      for (let j = 0; j < 4; j++) {
        const k = 4 * i + j;
        const KL = interpK(aL, bL, cL, dL, j);
        const KR = interpK(aR, bR, cR, dR, j);
        const al = Math.abs(KL), ar = Math.abs(KR);
        if (al > maxKL) maxKL = al;
        if (ar > maxKR) maxKR = ar;
        const capL = ceilingCapK(KL, ceiling);
        const capR = ceilingCapK(KR, ceiling);
        caps[k] = capL < capR ? capL : capR;
      }
    }
    return { caps, maxAbsK_L: maxKL, maxAbsK_R: maxKR };
  }

  /**
   * 环上逐点最大可行增益（只有上界 hi）。
   *
   * 边约束（k -> k+1，模 n）：
   *   g[k+1] <= g[k] + up
   *   g[k]   <= g[k+1] + down
   * 最大不动点  g[k] = min(hi[k], g[k-1]+up, g[k+1]+down)。
   *
   * 显式解：对每个源 j，沿环正向传播每帧 +up、反向传播每帧 +down，
   *   g*[k] = min_j min(hi[j] + up*((k-j) mod n),
   *                     hi[j] + down*((j-k) mod n))。
   * 用长度 2n 的复制数组各做一次前向/后向 min-plus 扫描即可 O(n) 得到。
   * 中间值只会从 hi（<=65536）向下放松，Int32 足够。
   */
  function propagateUpperBounds(hi, up, down) {
    const n = hi.length;
    if (n === 0) return new Int32Array(0);
    const m = 2 * n;
    const work = new Int32Array(m);
    const gains = new Int32Array(n);

    work.set(hi, 0);
    work.set(hi, n);
    for (let t = 1; t < m; t++) {
      const v = work[t - 1] + up;
      if (v < work[t]) work[t] = v;
    }
    for (let k = 0; k < n; k++) gains[k] = work[k + n];

    work.set(hi, 0);
    work.set(hi, n);
    for (let t = m - 2; t >= 0; t--) {
      const v = work[t + 1] + down;
      if (v < work[t]) work[t] = v;
    }
    for (let k = 0; k < n; k++) {
      if (work[k] < gains[k]) gains[k] = work[k];
    }
    return gains;
  }

  /**
   * 把多种锁输入归一化为 [{frame, gain}]，按帧号排序。
   * 支持 Map、[[f,g],...]、[{frame,gain}]、{f:g,...}。
   */
  function normalizeLocks(locks, n) {
    const out = [];
    if (!locks) return out;
    // 扁平数字数组 [f1,g1,f2,g2,...] 也按“成对”解释
    if (Array.isArray(locks) && locks.length && locks.every((x) => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x)))) {
      if (locks.length % 2 !== 0) return out;
      for (let i = 0; i < locks.length; i += 2) out.push({ frame: Number(locks[i]), gain: Number(locks[i + 1]) });
    } else if (locks instanceof Map) {
      for (const [f, g] of locks) out.push({ frame: Number(f), gain: Number(g) });
    } else if (Array.isArray(locks)) {
      for (const item of locks) {
        if (Array.isArray(item)) out.push({ frame: Number(item[0]), gain: Number(item[1]) });
        else if (item && typeof item === 'object') {
          const f = item.frame != null ? item.frame : item.index != null ? item.index : item.f;
          const g = item.gain != null ? item.gain : item.g != null ? item.g : item.value;
          out.push({ frame: Number(f), gain: Number(g) });
        }
      }
    } else if (typeof locks === 'object') {
      for (const k of Object.keys(locks)) out.push({ frame: Number(k), gain: Number(locks[k]) });
    }
    out.sort((a, b) => a.frame - b.frame);
    // 每帧至多一个锁：重复帧保留最后一个（Map/对象语义），并做范围规整。
    const dedup = [];
    for (const l of out) {
      if (!Number.isFinite(l.frame) || !Number.isFinite(l.gain)) continue;
      if (n > 0 && (l.frame < 0 || l.frame >= n || Math.floor(l.frame) !== l.frame)) continue;
      l.gain = Math.max(0, Math.min(GAIN_MAX, Math.round(l.gain)));
      if (dedup.length && dedup[dedup.length - 1].frame === l.frame) {
        dedup[dedup.length - 1].gain = l.gain;
      } else dedup.push(l);
    }
    return dedup;
  }

  /**
   * 按约定原文实现的“仅把锁当上限”传播（其它位置上界为 GAIN_MAX）。
   * 返回逐点最大曲线与低于目标值的锁（纯锁间步率冲突，不含 ceiling 帽）。
   */
  function findLockOnlyConflicts(n, up, down, locks) {
    const list = normalizeLocks(locks, n);
    const hi = new Int32Array(n).fill(GAIN_MAX);
    for (const l of list) hi[l.frame] = Math.min(hi[l.frame], l.gain);
    const curve = propagateUpperBounds(hi, up, down);
    const conflicts = [];
    for (const l of list) {
      if (curve[l.frame] < l.gain) {
        conflicts.push({ frame: l.frame, target: l.gain, achievable: curve[l.frame] });
      }
    }
    return { curve, conflicts };
  }

  /**
   * 完整求解：ceiling 帽 + 锁（锁也作为上限）一起传播。
   * 返回：
   *   ok=true  -> gains 即逐点最大且所有锁精确命中的可行增益
   *   ok=false -> conflicts 列出传播后达不到的锁；candidate 为该上界系统的最大曲线，
   *               调用方应保留上一次可行曲线。
   * 同时始终给出 lockOnlyConflicts（约定字面定义，仅供对照/展示）。
   */
  function solveGains(caps, up, down, locks) {
    const n = caps.length;
    const list = normalizeLocks(locks, n);
    const hi = caps.slice();
    for (const l of list) {
      if (l.gain < hi[l.frame]) hi[l.frame] = l.gain;
    }
    const gains = propagateUpperBounds(hi, up, down);
    const conflicts = [];
    for (const l of list) {
      if (gains[l.frame] < l.gain) {
        conflicts.push({ frame: l.frame, target: l.gain, achievable: gains[l.frame] });
      }
    }
    const lockOnly = findLockOnlyConflicts(n, up, down, list).conflicts;
    return {
      ok: conflicts.length === 0,
      gains,
      conflicts,
      lockOnlyConflicts: lockOnly,
      locks: list,
    };
  }

  /**
   * 整链处理：caps -> solve -> 逐码输出。
   * input = { left:Int16Array(N), right:Int16Array(N) }
   * opts  = { ceiling, up, down, locks }
   *
   * 成功时结果含 outL/outR（Int16Array(n)，已是最终 WAV 码值）与峰值。
   * 冲突时 ok:false，不含 out*，调用方不得用 candidate 替换上次可行结果。
   */
  function processCycle(input, opts) {
    const ceiling = clampInt(opts.ceiling, 0, CEILING_MAX, CEILING_MAX);
    const up = clampInt(opts.up, 0, GAIN_MAX, 0);
    const down = clampInt(opts.down, 0, GAIN_MAX, 0);
    const left = input.left, right = input.right;
    const N = input.length || left.length;
    const n = OVERSAMPLE * N;

    // 允许调用方传入按 ceiling 缓存的 capInfo（仅改 up/down/锁时可复用）。
    const capInfo = opts.capInfo && opts.capInfo.caps && opts.capInfo.caps.length === n
      ? opts.capInfo
      : computeCaps(left, right, N, ceiling);
    const solved = solveGains(capInfo.caps, up, down, opts.locks);
    const base = {
      ok: solved.ok,
      N, n,
      sampleRate: OUT_RATE,
      ceiling, up, down,
      caps: capInfo.caps,
      gains: solved.gains,
      locks: solved.locks,
      conflicts: solved.conflicts,
      lockOnlyConflicts: solved.lockOnlyConflicts,
      interpPeakL: capInfo.maxAbsK_L / 128,
      interpPeakR: capInfo.maxAbsK_R / 128,
    };
    if (!solved.ok) return base;

    const gains = solved.gains;
    const outL = new Int16Array(n);
    const outR = new Int16Array(n);
    let peakL = 0, peakR = 0;
    for (let i = 0; i < N; i++) {
      const im = cycIdx(i - 1, N);
      const i1 = cycIdx(i + 1, N);
      const i2 = cycIdx(i + 2, N);
      const aL = left[im], bL = left[i], cL = left[i1], dL = left[i2];
      const aR = right[im], bR = right[i], cR = right[i1], dR = right[i2];
      for (let j = 0; j < 4; j++) {
        const k = 4 * i + j;
        const g = gains[k];
        const yL = roundScaled(interpK(aL, bL, cL, dL, j) * g);
        const yR = roundScaled(interpK(aR, bR, cR, dR, j) * g);
        outL[k] = yL;
        outR[k] = yR;
        const al = yL < 0 ? -yL : yL;
        const ar = yR < 0 ? -yR : yR;
        if (al > peakL) peakL = al;
        if (ar > peakR) peakR = ar;
      }
    }
    // 硬保证（若数学/实现有误，这里立刻暴露而不是写出越限码）。
    if (peakL > ceiling || peakR > ceiling) {
      throw new Error('internal: ceiling violated after rounding');
    }
    base.outL = outL;
    base.outR = outR;
    base.outPeakL = peakL;
    base.outPeakR = peakR;
    return base;
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = dflt;
    n = Math.round(n);
    return Math.max(lo, Math.min(hi, n));
  }

  /** 原始 48k 码值峰值。 */
  function pcmPeaks(left, right) {
    let pL = 0, pR = 0;
    for (let i = 0; i < left.length; i++) {
      const a = Math.abs(left[i]);
      if (a > pL) pL = a;
    }
    if (right) for (let i = 0; i < right.length; i++) {
      const a = Math.abs(right[i]);
      if (a > pR) pR = a;
    }
    return { left: pL, right: pR };
  }

  return {
    GAIN_MAX, CEILING_MAX, CEILING_MIN, BASE_RATE, OUT_RATE, OVERSAMPLE,
    SCALE_DEN,
    floorDivExact,
    interpK,
    roundScaled,
    ceilingCapK,
    computeCaps,
    propagateUpperBounds,
    normalizeLocks,
    findLockOnlyConflicts,
    solveGains,
    processCycle,
    pcmPeaks,
    cycIdx,
  };
});
