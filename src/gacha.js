/*
 * gacha.js — 抽卡保底概率核算引擎
 *
 * 精确解：按规则逐抽做有限状态马尔可夫链转移（动态规划），不使用模拟。
 * 状态 (p, s, j)：
 *   p — 距上次五星已垫抽数（下一抽为第 p+1 抽）
 *   s — 已连续歪（常驻五星）次数
 *   j — 已拿到的限定五星数
 *
 * 同一份代码在浏览器（window.Gacha）与 Node（module.exports）下运行。
 */
(function (global) {
  'use strict';

  const EPS = 1e-12;

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isInteger(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  /* ---------------- 合法性校验：返回全部错误，逐项指出字段 ---------------- */
  function validateRule(r) {
    const errors = [];
    const push = (field, message) => errors.push({ field, message });

    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, errors: [{ field: '(根对象)', message: '规则必须是一个 JSON 对象' }] };
    }

    // base：0 < base <= 1
    if (!isFiniteNumber(r.base)) push('base', '基础概率必须是有限数字');
    else if (!(r.base > 0)) push('base', '基础概率 base 必须大于 0，当前为 ' + r.base);
    else if (r.base > 1) push('base', '基础概率 base 不能大于 1，当前为 ' + r.base);

    // softStep >= 0
    if (!isFiniteNumber(r.softStep)) push('softStep', '软保底每抽增量必须是有限数字');
    else if (r.softStep < 0) push('softStep', '软保底增量 softStep 不能为负数，当前为 ' + r.softStep);

    // hard >= 1（先校验 hard，后面 softStart / carry.pity 依赖它）
    if (!isInteger(r.hard)) push('hard', '硬保底抽数 hard 必须是整数');
    else if (!(r.hard >= 1)) push('hard', '硬保底抽数 hard 必须不小于 1，当前为 ' + r.hard);

    // 1 <= softStart <= hard
    if (!isInteger(r.softStart)) push('softStart', '软保底起点 softStart 必须是整数');
    else if (isInteger(r.hard) && r.hard >= 1) {
      if (!(r.softStart >= 1)) push('softStart', '软保底起点 softStart 必须不小于 1，当前为 ' + r.softStart);
      if (r.softStart > r.hard) push('softStart', '软保底起点 softStart(' + r.softStart + ') 不能大于硬保底 hard(' + r.hard + ')');
    } else if (!(r.softStart >= 1)) {
      push('softStart', '软保底起点 softStart 必须不小于 1，当前为 ' + r.softStart);
    }

    // 0 <= limitedRate <= 1
    if (!isFiniteNumber(r.limitedRate)) push('limitedRate', '限定五星比例必须是有限数字');
    else if (r.limitedRate < 0 || r.limitedRate > 1) {
      push('limitedRate', '限定五星比例 limitedRate 必须在 [0,1] 区间，当前为 ' + r.limitedRate);
    }

    // guaranteeAfter：不小于 1 的整数
    if (!isInteger(r.guaranteeAfter)) push('guaranteeAfter', '大保底阈值 guaranteeAfter 必须是整数');
    else if (r.guaranteeAfter < 1) push('guaranteeAfter', '大保底阈值 guaranteeAfter 必须不小于 1，当前为 ' + r.guaranteeAfter);

    // carry
    if (r.carry === null || typeof r.carry !== 'object' || Array.isArray(r.carry)) {
      push('carry', '继承状态 carry 必须是对象 {pity, misses}');
    } else {
      if (!isInteger(r.carry.pity)) push('carry.pity', '继承垫抽 carry.pity 必须是整数');
      else if (isInteger(r.hard) && r.hard >= 1) {
        if (r.carry.pity < 0) push('carry.pity', '继承垫抽 carry.pity 不能为负数，当前为 ' + r.carry.pity);
        if (r.carry.pity >= r.hard) push('carry.pity', '继承垫抽 carry.pity(' + r.carry.pity + ') 必须小于硬保底 hard(' + r.hard + ')');
      } else if (r.carry.pity < 0) {
        push('carry.pity', '继承垫抽 carry.pity 不能为负数，当前为 ' + r.carry.pity);
      }

      if (!isInteger(r.carry.misses)) push('carry.misses', '继承歪次数 carry.misses 必须是整数');
      else if (isInteger(r.guaranteeAfter) && r.guaranteeAfter >= 1) {
        if (r.carry.misses < 0) push('carry.misses', '继承歪次数 carry.misses 不能为负数，当前为 ' + r.carry.misses);
        if (r.carry.misses > r.guaranteeAfter) {
          push('carry.misses', '继承歪次数 carry.misses(' + r.carry.misses + ') 不能大于 guaranteeAfter(' + r.guaranteeAfter + ')');
        }
      } else if (r.carry.misses < 0) {
        push('carry.misses', '继承歪次数 carry.misses 不能为负数，当前为 ' + r.carry.misses);
      }
    }

    // targets：非空正整数数组
    if (!Array.isArray(r.targets) || r.targets.length === 0) {
      push('targets', 'targets 必须是非空数组，元素为正整数');
    } else {
      r.targets.forEach((t, i) => {
        if (!isInteger(t) || t < 1) push('targets[' + i + ']', '目标限定五星数必须是正整数，当前为 ' + JSON.stringify(t));
      });
    }

    return { ok: errors.length === 0, errors };
  }

  /* 第 k 抽出五星的条件概率（k 从 1 开始） */
  function fiveStarProb(r, k) {
    if (k >= r.hard) return 1; // k === hard 必出；k>hard 在合法规则下不会发生
    if (k < r.softStart) return r.base;
    const p = r.base + (k - r.softStart + 1) * r.softStep;
    return p >= 1 ? 1 : p;
  }

  /*
   * 实际保底抽数：软保底段内概率首次达到 1 的抽数；
   * 若 hard 之前到不了 1，则就是 hard。
   */
  function effectiveHard(r) {
    if (r.softStep <= 0) return r.hard;
    // base + (k - softStart + 1) * softStep >= 1
    const need = (1 - r.base) / r.softStep;
    const kAtOne = r.softStart - 1 + Math.ceil(need - 1e-15);
    if (kAtOne >= r.softStart && kAtOne < r.hard) return kAtOne;
    return r.hard;
  }

  function pmfSum(pmf) {
    let s = 0;
    for (let i = 0; i < pmf.length; i++) s += pmf[i];
    return s;
  }

  function pmfExpected(pmf) {
    let e = 0;
    for (let i = 1; i < pmf.length; i++) e += i * pmf[i];
    return e;
  }

  function pmfSecondMoment(pmf) {
    let e = 0;
    for (let i = 1; i < pmf.length; i++) e += i * i * pmf[i];
    return e;
  }

  /* 分位数：累计概率首次不小于 q 的抽数 */
  function pmfQuantile(pmf, q) {
    let cum = 0;
    for (let i = 1; i < pmf.length; i++) {
      cum += pmf[i];
      if (cum + EPS >= q) return i;
    }
    return pmf.length - 1;
  }

  function summarize(pmf, quantiles) {
    const sum = pmfSum(pmf);
    const expected = pmfExpected(pmf);
    const second = pmfSecondMoment(pmf);
    const variance = Math.max(0, second - expected * expected);
    const out = {
      pmf,
      sum,
      expected,
      std: Math.sqrt(variance),
      quantiles: {}
    };
    (quantiles || [0.5, 0.9, 0.99]).forEach((q) => {
      out.quantiles[q] = pmfQuantile(pmf, q);
    });
    return out;
  }

  /* ---------------- 第一个五星的出现抽数分布（一维生存递推） ---------------- */
  function firstFive(r) {
    const start = r.carry.pity + 1;
    const end = r.hard; // 第 hard 抽必出
    const pmf = new Float64Array(r.hard + 1); // 完整 1-based 数组（前导零保留）
    let survival = 1; // 到达第 n 抽之前仍未出五星的概率
    for (let k = start; k <= end; k++) {
      const q = fiveStarProb(r, k);
      pmf[k] = survival * q;
      survival *= 1 - q;
    }
    const summary = summarize(pmf);
    summary.support = [start, end];
    // 裁掉 carry 垫抽产生的前导零：视图下标 0 对应第 start 抽
    summary.pmfView = pmf.slice(start);
    summary.viewStart = start;
    // 剩余抽数期望（不含已继承的 carry.pity 垫抽），与公告口径对齐
    summary.expectedRemaining = summary.expected - r.carry.pity;
    return summary;
  }

  /*
   * 拿到 m 个限定五星所需总抽数的分布。
   * 一次 DP 跑到最大目标 M，记录每个 j=1..M 的吸收分布。
   */
  function limitedDists(r, quantileList) {
    const M = Math.max.apply(null, r.targets);
    const g = r.guaranteeAfter;
    const h = effectiveHard(r);
    const pity0 = r.carry.pity;
    const misses0 = r.carry.misses;

    // 最坏情形抽数上界（用于定长数组；DP 会自然在此之前吸收完毕）
    // 首个五星周期最多 h-pity0 抽；
    // 首个限定最坏需要 g+1-misses0 个五星周期，之后每个限定最坏 g+1 个周期。
    const maxPulls = (h - pity0) + ((M - 1) * (g + 1) + (g - misses0)) * h;

    // 每个目标 m 自己的紧致上界
    const tightMax = (m) => (h - pity0) + ((m - 1) * (g + 1) + (g - misses0)) * h;

    const nP = h;           // p 取值 0..h-1
    const nS = g + 1;       // s 取值 0..g
    const nJ = M + 1;       // j 取值 0..M
    const size = nP * nS * nJ;
    const idx = (p, s, j) => (p * nS + s) * nJ + j;

    const pmfs = [];
    for (let j = 0; j <= M; j++) pmfs.push(new Float64Array(maxPulls + 1));

    let cur = new Float64Array(size);
    cur[idx(pity0, misses0, 0)] = 1;

    let activeMass = 1;
    for (let t = 1; t <= maxPulls && activeMass > EPS * EPS; t++) {
      const nxt = new Float64Array(size);
      let remaining = 0;

      for (let p = 0; p < nP; p++) {
        const k = p + 1;
        const q = fiveStarProb(r, k);
        const missQ = 1 - q;
        const baseP = p * nS * nJ;
        const nextP = (p + 1) * nS * nJ;

        for (let s = 0; s < nS; s++) {
          const rowBase = baseP + s * nJ;
          for (let j = 0; j < M; j++) {
            const mass = cur[rowBase + j];
            if (mass === 0) continue;

            // 本抽未出五星（q===1 时 missQ 为 0，硬保底/提前到 1 不会产生非法转移）
            if (missQ > 0) {
              const v = mass * missQ;
              nxt[nextP + s * nJ + j] += v;
              remaining += v;
            }

            // 本抽出五星
            const hit = mass * q;
            if (s === g) {
              // 大保底：必为限定
              pmfs[j + 1][t] += hit;
              if (j + 1 < M) {
                nxt[idx(0, 0, j + 1)] += hit;
                remaining += hit;
              }
            } else {
              const lim = hit * r.limitedRate;
              const off = hit - lim;
              // 常驻（歪）：misses +1，垫抽清零
              nxt[idx(0, s + 1, j)] += off;
              remaining += off;
              // 限定：misses 归 0
              pmfs[j + 1][t] += lim;
              if (j + 1 < M) {
                nxt[idx(0, 0, j + 1)] += lim;
                remaining += lim;
              }
            }
          }
        }
      }
      cur = nxt;
      activeMass = remaining;
    }

    const result = {};
    r.targets.forEach((m) => {
      result[m] = summarize(pmfs[m], quantileList);
      result[m].maxPulls = tightMax(m);
    });
    result._maxPulls = maxPulls;
    result._effectiveHard = h;
    return result;
  }

  /* ---------------- 固定种子随机数（mulberry32） ---------------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
   * 蒙特卡洛模拟（固定种子）。
   * 返回首个五星与各目标限定数的抽数直方图，结构与精确解对齐。
   * 可传入共享的 rand（同一 PRNG 流跨批次连续消费，保证分块执行与整段执行逐次一致）。
   */
  function simulate(r, N, seed, onProgress, rand) {
    const M = Math.max.apply(null, r.targets);
    const g = r.guaranteeAfter;
    const firstHist = new Float64Array(r.hard + 1);
    const limHists = [];
    for (let j = 0; j <= M; j++) limHists.push(new Float64Array(r.hard * (M * (g + 1) + 1) + 1));

    if (!rand) rand = mulberry32(seed);
    const reportEvery = Math.max(1000, Math.floor(N / 50));

    for (let run = 0; run < N; run++) {
      let p = r.carry.pity;
      let s = r.carry.misses;
      let got = 0;
      let pulls = 0;
      let firstRecorded = false;

      while (got < M) {
        pulls++;
        const q = fiveStarProb(r, p + 1);
        if (rand() < q) {
          if (!firstRecorded) {
            firstHist[pulls]++;
            firstRecorded = true;
          }
          if (s === g || rand() < r.limitedRate) {
            got++;
            limHists[got][pulls]++;
            p = 0;
            s = 0;
          } else {
            s++;
            p = 0;
          }
        } else {
          p++;
        }
      }

      if (onProgress && (run + 1) % reportEvery === 0) onProgress(run + 1, N);
    }
    if (onProgress) onProgress(N, N);

    return { N, seed, firstHist, limHists };
  }

  /* 精确分布 vs 模拟直方图的逐抽对比，超过 3 倍标准误标红 */
  function comparePmf(exactPmf, simHist, N) {
    const rows = [];
    let flagged = 0;
    for (let n = 1; n < exactPmf.length; n++) {
      const p = exactPmf[n];
      const count = n < simHist.length ? simHist[n] : 0;
      const pHat = count / N;
      if (p === 0 && count === 0) continue;
      const se = Math.sqrt(p * (1 - p) / N);
      const diff = pHat - p;
      const z = se > 0 ? diff / se : (diff !== 0 ? Infinity : 0);
      const flag = Math.abs(z) > 3;
      if (flag) flagged++;
      rows.push({ n, exact: p, sim: pHat, count, se, z, flag });
    }
    return { rows, flagged };
  }

  /* 期望的模拟值与三倍标准误对比（标准误用精确分布的标准差） */
  function compareExpectation(exactSummary, simHist, N) {
    let sum = 0;
    let count = 0;
    for (let n = 1; n < simHist.length; n++) {
      sum += n * simHist[n];
      count += simHist[n];
    }
    const simMean = count > 0 ? sum / count : NaN;
    const seMean = exactSummary.std / Math.sqrt(N);
    const z = seMean > 0 ? (simMean - exactSummary.expected) / seMean : 0;
    return {
      simMean,
      exactMean: exactSummary.expected,
      seMean,
      z,
      flag: Math.abs(z) > 3
    };
  }

  /* 模拟分布的分位数 */
  function simQuantile(simHist, N, q) {
    let cum = 0;
    const target = q * N;
    for (let i = 1; i < simHist.length; i++) {
      cum += simHist[i];
      if (cum >= target) return i;
    }
    return simHist.length - 1;
  }

  const API = {
    EPS,
    validateRule,
    fiveStarProb,
    effectiveHard,
    firstFive,
    limitedDists,
    summarize,
    pmfQuantile,
    mulberry32,
    simulate,
    comparePmf,
    compareExpectation,
    simQuantile
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  } else {
    global.Gacha = API;
  }
})(typeof window !== 'undefined' ? window : globalThis);
