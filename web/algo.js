// 帧指纹对版核心算法（无外部依赖，ESM）
// A = 主版(master)，B = 交付版(delivery)
// 步类型：m=match 各消费一帧；x=missing 只消费主版一帧；y=extra 只消费交付版一帧
//
// DP 语义（正向/反向对称，均为“到达态”）：
//   f_s(i,j)：从 (0,0) 以到达态 s 进入 (i,j) 的最优标量前缀（原点视为 M 中性态）
//   g_s(i,j)：从 (i,j) 以到达态 s 出发，到 (N,M) 的最优标量后缀
//   标量 score = fee*K + 段数，K > 任意可能段数，故标量序 == (费用, 段数) 字典序

export const BAND = 64;
export const W = BAND * 2 + 1; // 129，列索引 col = j - i + 64
const INF = Number.POSITIVE_INFINITY;

// 16 位 popcount 表
const POP16 = new Int32Array(65536);
for (let x = 0; x < 65536; x++) {
  let v = x;
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  POP16[x] = (((v + (v >> 4)) & 0x0f0f) * 0x0101) >> 8;
}

const HEX16 = /^[0-9a-fA-F]{16}$/;

/** 解析一整侧指纹：返回 hi/lo 两个 Uint32Array，并做格式校验 */
export function parseFingerprints(arr, sideName) {
  if (!Array.isArray(arr) || arr.length < 1) {
    throw new Error(`${sideName}：至少需要 1 帧`);
  }
  if (arr.length > 120000) {
    throw new Error(`${sideName}：帧数超过 12 万上限（实际 ${arr.length}）`);
  }
  const hi = new Uint32Array(arr.length);
  const lo = new Uint32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (typeof s !== 'string' || !HEX16.test(s)) {
      throw new Error(`${sideName} 第 ${i} 帧：指纹必须是 16 个十六进制字符`);
    }
    hi[i] = parseInt(s.slice(0, 8), 16);
    lo[i] = parseInt(s.slice(8, 16), 16);
  }
  return { hi, lo, raw: arr.map((s) => s.toLowerCase()) };
}

export function validateSettings(s) {
  const cfg = s || {};
  const maxDistance = cfg.maxDistance ?? 4;
  const gapOpen = cfg.gapOpen ?? 9;
  const gapExtend = cfg.gapExtend ?? 2;
  if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > 64) {
    throw new Error('settings.maxDistance 必须是 0..64 的整数');
  }
  for (const [k, v] of [['gapOpen', gapOpen], ['gapExtend', gapExtend]]) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      throw new Error(`settings.${k} 必须是 1..65535 的整数`);
    }
  }
  return { maxDistance, gapOpen, gapExtend };
}

/** 两个 64 位指纹的汉明距离（0..64） */
export function hamming(ahi, alo, bhi, blo) {
  const xh = (ahi ^ bhi) >>> 0;
  const xl = (alo ^ blo) >>> 0;
  return (
    POP16[xh >>> 16] + POP16[xh & 0xffff] +
    POP16[xl >>> 16] + POP16[xl & 0xffff]
  );
}

function min3(a, b, c) {
  let m = a;
  if (b < m) m = b;
  if (c < m) m = c;
  return m;
}

const infeasible = (msg, at) => {
  const e = new Error(msg);
  e.code = 'INFEASIBLE';
  if (at) e.at = at;
  return e;
};

/**
 * 单段对齐（局部坐标，段起点为 (0,0)）。
 * N 个主版帧、M 个交付版帧；offA/offB 为全局帧号偏移。
 *
 * 三状态仿射间隔 DP，标量目标 score = fee*K + 段数（K > 任意可能段数，
 * 故标量序等价于“先费用、后段数”的字典序）。
 * 正向 f_s(i,j)：从原点以到达态 s 进入 (i,j) 的最优前缀（原点视为 M 中性态）。
 * 反向 g_s(i,j)：从 (i,j) 以到达态 s 出发到 (N,M) 的最优后缀。
 * 重建时按 m>x>y 贪心，用 prefix + 步费 + g_目的态(目的格) == S* 精确判定，
 * 得到三级判优下的唯一最优路径。
 */
function alignSegment(N, M, fpA, offA, fpB, offB, params, progressCb) {
  const { maxDistance, gapOpen, gapExtend } = params;
  const K = N + M + 1;
  const openK = gapOpen * K + 1; // 开段：费用 + 段数 +1
  const extK = gapExtend * K;
  if (N - M > BAND || N - M < -BAND) {
    throw infeasible('段终点超出带宽 |i-j|<=64，此区间无法对齐');
  }

  // ---- 退化段：单侧长度为 0，路径被同类 gap 步唯一确定 ----
  if (N === 0 || M === 0) {
    const len = N + M;
    if (len > BAND) throw infeasible('纯间隔段长度超出带宽 64');
    const t = N === 0 ? 'y' : 'x';
    const steps = [];
    let fee = 0;
    for (let k = 0; k < len; k++) {
      const cost = k === 0 ? gapOpen : gapExtend;
      fee += cost;
      steps.push(t === 'x'
        ? { t, ai: offA + k, bi: null, cost }
        : { t, ai: null, bi: offB + k, cost });
    }
    return { steps, totalFee: fee, gapSegments: len ? 1 : 0, scalar: fee * K + (len ? 1 : 0), K };
  }

  const jLoAt = (i) => {
    const v = i - BAND;
    return v > 0 ? v : 0;
  };
  const jHiAt = (i) => {
    const v = i + BAND;
    return v < M ? v : M;
  };
  // 反向扫描取 c±1 邻列，j 范围比正向带宽放宽一格
  const jLoRev = (i) => {
    const v = i - BAND - 1;
    return v > 0 ? v : 0;
  };
  const jHiRev = (i) => {
    const v = i + BAND + 1;
    return v < M ? v : M;
  };
  const col = (i, j) => j - i + BAND;

  const BLOCK = 2048;
  const numBlocks = Math.ceil(N / BLOCK);
  const boundaryG = new Array(numBlocks + 1);

  // ========== 第一趟：全局反向 DP（滚动行），只保留分块边界行 ==========
  let gM = new Float64Array(W).fill(INF);
  let gX = new Float64Array(W).fill(INF);
  let gY = new Float64Array(W).fill(INF);
  gM[col(N, M)] = 0;
  gX[col(N, M)] = 0;
  gY[col(N, M)] = 0;

  // 终点行 i=N：在已播种的 g 数组上原地沿 j 降序长 Y 链（M/X 因无下一行保持 INF）。
  // 从 (N,j) 只能走 Y 到终点：当前态 Y=延续 extK，当前态 M/X=新开 openK。
  {
    const lo = jLoRev(N);
    for (let j = M - 1; j >= lo; j--) {
      const c = col(N, j);
      const tailY = gY[c + 1]; // 目的格 (N,j+1) 到达态 Y 的后缀
      if (tailY === INF) continue;
      gY[c] = extK + tailY;
      gM[c] = openK + tailY;
      gX[c] = openK + tailY;
    }
    boundaryG[numBlocks] = {
      gM: Float64Array.from(gM), gX: Float64Array.from(gX), gY: Float64Array.from(gY),
    };
  }

  let pM = new Float64Array(W);
  let pX = new Float64Array(W);
  let pY = new Float64Array(W);

  for (let i = N - 1; i >= 0; i--) {
    pM.fill(INF); pX.fill(INF); pY.fill(INF);
    const lo = jLoRev(i);
    const hi = jHiRev(i);
    const ahiV = fpA.hi[offA + i];
    const aloV = fpA.lo[offA + i];
    // pass 1（j 降序）：M 步、X 步，仅依赖下一行 g*
    for (let j = hi; j >= lo; j--) {
      const c = col(i, j);
      const nc = c - 1; // (i+1,j) 的列
      let mTail = INF;
      if (j < M) {
        const d = hamming(ahiV, aloV, fpB.hi[offB + j], fpB.lo[offB + j]);
        if (d <= maxDistance && gM[c] !== INF) {
          // M 步目的格到达态固定为 M，后缀只能取 g_M
          mTail = d * K + gM[c];
        }
      }
      let xExt = INF;
      let xOpen = INF;
      if (nc >= 0 && gX[nc] !== INF) {
        xExt = extK + gX[nc]; // 当前态 X 延续
        xOpen = openK + gX[nc]; // 当前态 M/Y 新开
      }
      pM[c] = Math.min(mTail, xOpen);
      pX[c] = Math.min(mTail, xExt);
      pY[c] = mTail; // Y 当前态的 M 候选，X/Y 候选 pass2 补
    }
    // pass 2（j 降序）：Y 步（同行 j+1），并给 pY 补 X 新开
    for (let j = hi; j >= lo; j--) {
      const c = col(i, j);
      const nc = c - 1;
      if (nc >= 0 && gX[nc] !== INF) {
        const v = openK + gX[nc]; // Y 当前态走 X = 换方向新开
        if (v < pY[c]) pY[c] = v;
      }
      if (c + 1 < W && j < M && pY[c + 1] !== INF) {
        const yExt = extK + pY[c + 1];  // 当前态 Y 延续
        const yOpen = openK + pY[c + 1]; // 当前态 M/X 新开
        if (yOpen < pM[c]) pM[c] = yOpen;
        if (yOpen < pX[c]) pX[c] = yOpen;
        if (yExt < pY[c]) pY[c] = yExt;
      }
    }
    gM = pM; gX = pX; gY = pY;
    pM = new Float64Array(W);
    pX = new Float64Array(W);
    pY = new Float64Array(W);
    // 块底行：i 是 BLOCK 的整数倍（边界 1..numBlocks-1）
    if (i > 0 && i % BLOCK === 0) {
      boundaryG[i / BLOCK] = {
        gM: Float64Array.from(gM), gX: Float64Array.from(gX), gY: Float64Array.from(gY),
      };
    }
    if (progressCb && (i & 255) === 0) progressCb(0.34 * (1 - i / N));
  }
  const originCol = col(0, 0);
  const Sstar = gM[originCol]; // 原点中性态 == M
  if (Sstar === INF) throw infeasible('带宽/距离阈值内不存在可行对齐路径');

  // ========== 逐块：块内正向 f + 反向 g，再按词典序 m>x>y 行走 ==========
  const steps = [];
  let fM = new Float64Array(W).fill(INF);
  let fX = new Float64Array(W).fill(INF);
  let fY = new Float64Array(W).fill(INF);
  fM[originCol] = 0;

  let ci = 0;
  let cj = 0;
  let cs = 'M';
  let prefix = 0;
  let feeTotal = 0;
  let segTotal = 0;

  for (let b = 0; b < numBlocks; b++) {
    const r0 = b * BLOCK;
    const r1 = Math.min(N, r0 + BLOCK);
    const rows = r1 - r0;
    const size = (rows + 1) * W;
    const lastBlock = b === numBlocks - 1;

    const fbM = new Float64Array(size).fill(INF);
    const fbX = new Float64Array(size).fill(INF);
    const fbY = new Float64Array(size).fill(INF);
    fbM.set(fM, 0); fbX.set(fX, 0); fbY.set(fY, 0);

    // ---- 块内正向（到达态语义） ----
    let qM = fM, qX = fX, qY = fY;
    for (let i = r0 + 1; i <= r1; i++) {
      const nM = new Float64Array(W).fill(INF);
      const nX = new Float64Array(W).fill(INF);
      const nY = new Float64Array(W).fill(INF);
      const lo = jLoAt(i);
      const hi = jHiAt(i);
      const ai = offA + i - 1;
      const ahiV = fpA.hi[ai];
      const aloV = fpA.lo[ai];
      for (let j = lo; j <= hi; j++) {
        const c = col(i, j);
        if (j > 0) {
          const d = hamming(ahiV, aloV, fpB.hi[offB + j - 1], fpB.lo[offB + j - 1]);
          if (d <= maxDistance) {
            const pv = min3(qM[c], qX[c], qY[c]);
            if (pv !== INF) nM[c] = d * K + pv;
          }
        }
        if (c + 1 < W) {
          let best = INF;
          if (qX[c + 1] !== INF) best = Math.min(best, extK + qX[c + 1]);
          if (qM[c + 1] !== INF) best = Math.min(best, openK + qM[c + 1]);
          if (qY[c + 1] !== INF) best = Math.min(best, openK + qY[c + 1]);
          nX[c] = best;
        }
        if (c - 1 >= 0) {
          let best = INF;
          if (nY[c - 1] !== INF) best = Math.min(best, extK + nY[c - 1]);
          if (nM[c - 1] !== INF) best = Math.min(best, openK + nM[c - 1]);
          if (nX[c - 1] !== INF) best = Math.min(best, openK + nX[c - 1]);
          nY[c] = best;
        }
      }
      qM = nM; qX = nX; qY = nY;
      const base = (i - r0) * W;
      fbM.set(nM, base);
      fbX.set(nX, base);
      fbY.set(nY, base);
    }
    if (!lastBlock) {
      fM = Float64Array.from(qM);
      fX = Float64Array.from(qX);
      fY = Float64Array.from(qY);
    } else {
      fM = qM; fX = qX; fY = qY;
    }

    // ---- 块内反向（到达态语义），底行取全局边界 g ----
    const gbM = new Float64Array(size).fill(INF);
    const gbX = new Float64Array(size).fill(INF);
    const gbY = new Float64Array(size).fill(INF);
    const bot = boundaryG[b + 1];
    gbM.set(bot.gM, rows * W);
    gbX.set(bot.gX, rows * W);
    gbY.set(bot.gY, rows * W);

    let uM = bot.gM, uX = bot.gX, uY = bot.gY;
    for (let i = r1 - 1; i >= r0; i--) {
      const nM = new Float64Array(W).fill(INF);
      const nX = new Float64Array(W).fill(INF);
      const nY = new Float64Array(W).fill(INF);
      const lo = jLoRev(i);
      const hi = jHiRev(i);
      const ahiV = fpA.hi[offA + i];
      const aloV = fpA.lo[offA + i];
      // pass 1：M、X
      for (let j = hi; j >= lo; j--) {
        const c = col(i, j);
        const nc = c - 1;
        let mTail = INF;
        if (j < M) {
          const d = hamming(ahiV, aloV, fpB.hi[offB + j], fpB.lo[offB + j]);
          if (d <= maxDistance && uM[c] !== INF) {
            // M 步目的格到达态固定为 M，后缀只能取 g_M
            mTail = d * K + uM[c];
          }
        }
        let xExt = INF;
        let xOpen = INF;
        if (nc >= 0 && uX[nc] !== INF) {
          xExt = extK + uX[nc];
          xOpen = openK + uX[nc];
        }
        nM[c] = Math.min(mTail, xOpen);
        nX[c] = Math.min(mTail, xExt);
        nY[c] = mTail;
      }
      // pass 2：Y + 给 nY 补 X 新开
      for (let j = hi; j >= lo; j--) {
        const c = col(i, j);
        const nc = c - 1;
        if (nc >= 0 && uX[nc] !== INF) {
          const v = openK + uX[nc];
          if (v < nY[c]) nY[c] = v;
        }
        if (c + 1 < W && j < M && nY[c + 1] !== INF) {
          const yExt = extK + nY[c + 1];
          const yOpen = openK + nY[c + 1];
          if (yOpen < nM[c]) nM[c] = yOpen;
          if (yOpen < nX[c]) nX[c] = yOpen;
          if (yExt < nY[c]) nY[c] = yExt;
        }
      }
      uM = nM; uX = nX; uY = nY;
      const base = (i - r0) * W;
      gbM.set(nM, base);
      gbX.set(nX, base);
      gbY.set(nY, base);
    }

    if (progressCb) progressCb(0.34 + 0.66 * ((b + 1) / numBlocks));

    // ---- 块内词典序行走：m > x > y ----
    const gAt = (arr, i, j) => arr[(i - r0) * W + col(i, j)];
    while (true) {
      if (ci === N && cj === M) break;
      if (!lastBlock && ci >= r1) break; // 非末块走到底行，剩余 y 步留给下一块
      let moved = false;

      // 1) match：目的格 (ci+1,cj+1)，到达态 M
      if (ci < N && cj < M) {
        const d = hamming(
          fpA.hi[offA + ci], fpA.lo[offA + ci],
          fpB.hi[offB + cj], fpB.lo[offB + cj],
        );
        if (d <= maxDistance) {
          const ni = ci + 1;
          const nj = cj + 1;
          if (ni <= r1) {
            const gv = gAt(gbM, ni, nj);
            if (gv !== INF && prefix + d * K + gv === Sstar) {
              steps.push({ t: 'm', ai: offA + ci, bi: offB + cj, cost: d });
              feeTotal += d;
              prefix += d * K;
              ci = ni; cj = nj; cs = 'M';
              moved = true;
            }
          }
        }
      }
      // 2) missing：目的格 (ci+1,cj)，到达态 X
      if (!moved && ci < N) {
        const ni = ci + 1;
        if (ni <= r1) {
          const cc = col(ni, cj);
          if (cc >= 0 && cc < W) {
            const open = cs !== 'X';
            const stepFee = open ? gapOpen : gapExtend;
            const stepK = open ? openK : extK;
            const gv = gAt(gbX, ni, cj);
            if (gv !== INF && prefix + stepK + gv === Sstar) {
              steps.push({ t: 'x', ai: offA + ci, bi: null, cost: stepFee });
              feeTotal += stepFee;
              if (open) segTotal += 1;
              prefix += stepK;
              ci = ni; cs = 'X';
              moved = true;
            }
          }
        }
      }
      // 3) extra：目的格 (ci,cj+1)，到达态 Y
      if (!moved && cj < M) {
        const nj = cj + 1;
        const cc = col(ci, nj);
        if (cc >= 0 && cc < W) {
          const open = cs !== 'Y';
          const stepFee = open ? gapOpen : gapExtend;
          const stepK = open ? openK : extK;
          const gv = gAt(gbY, ci, nj);
          if (gv !== INF && prefix + stepK + gv === Sstar) {
            steps.push({ t: 'y', ai: null, bi: offB + cj, cost: stepFee });
            feeTotal += stepFee;
            if (open) segTotal += 1;
            prefix += stepK;
            cj = nj; cs = 'Y';
            moved = true;
          }
        }
      }
      if (!moved) {
        throw infeasible(
          `段内回溯失败于局部位置 (${ci},${cj})，请检查锁点与带宽约束`,
          { i: offA + ci, j: offB + cj },
        );
      }
    }
  }

  if (feeTotal * K + segTotal !== Sstar) {
    throw infeasible('内部校验失败：重建路径与最优标量不一致');
  }
  return { steps, totalFee: feeTotal, gapSegments: segTotal, scalar: Sstar, K };
}

/**
 * 带锁点的整版对齐。
 * locks: [{i,j}] 全局帧号，必须 match。
 * 失败时错误带 code 与 segment/at 定位，调用方负责保留上一次有效结果。
 */
export function align(master, delivery, paramsInput, locksInput, progressCb) {
  const params = validateSettings(paramsInput);
  const N = master.hi.length;
  const M = delivery.hi.length;
  const locks = validateLocks(locksInput || [], master, delivery, params);

  const anchors = [
    { i: 0, j: 0, lock: false },
    ...locks.map((l) => ({ i: l.i, j: l.j, lock: true })),
    { i: N, j: M, lock: false },
  ];
  const allSteps = [];
  let totalFee = 0;
  let gapSegments = 0;
  const segCount = anchors.length - 1;

  for (let s = 0; s < segCount; s++) {
    const a = anchors[s];
    const b = anchors[s + 1];
    const n = b.i - a.i;
    const m = b.j - a.j;
    try {
      const seg = alignSegment(
        n, m, master, a.i, delivery, a.j, params,
        progressCb ? (p) => progressCb((s + p) / segCount) : null,
      );
      for (const st of seg.steps) allSteps.push(st);
      totalFee += seg.totalFee;
      gapSegments += seg.gapSegments;
    } catch (err) {
      if (err.code === 'INFEASIBLE') {
        err.segment = {
          index: s,
          from: { i: a.i, j: a.j, locked: a.lock },
          to: { i: b.i, j: b.j, locked: b.lock },
        };
      }
      throw err;
    }
  }

  const intervals = buildIntervals(allSteps);
  return {
    steps: allSteps,
    totalFee,
    gapSegments,
    locks: locks.map((l) => ({ i: l.i, j: l.j })),
    intervals,
  };
}

/** 校验锁点：合法则返回按主版帧号排序的锁点，否则抛 LOCK_INVALID 并带定位 */
export function validateLocks(locks, master, delivery, params) {
  const seenI = new Map();
  const seenJ = new Map();
  for (const l of locks) {
    const { i, j } = l;
    if (!Number.isInteger(i) || !Number.isInteger(j) ||
      i < 0 || i >= master.hi.length || j < 0 || j >= delivery.hi.length) {
      const e = new Error(`锁点 (${i},${j}) 帧号越界`);
      e.code = 'LOCK_INVALID';
      e.at = { i, j };
      throw e;
    }
    if (Math.abs(i - j) > BAND) {
      const e = new Error(`锁点 (${i},${j}) 越带：|i-j|=${Math.abs(i - j)} > 64`);
      e.code = 'LOCK_INVALID';
      e.at = { i, j };
      throw e;
    }
    const d = hamming(master.hi[i], master.lo[i], delivery.hi[j], delivery.lo[j]);
    if (d > params.maxDistance) {
      const e = new Error(`锁点 (${i},${j}) 汉明距离 ${d} 超过阈值 ${params.maxDistance}，不能配对`);
      e.code = 'LOCK_INVALID';
      e.at = { i, j };
      e.distance = d;
      throw e;
    }
    if (seenI.has(i)) {
      const e = new Error(`主版第 ${i} 帧不能锁给多个交付帧（已锁 (${i},${seenI.get(i)})）`);
      e.code = 'LOCK_INVALID';
      e.at = { i, j };
      throw e;
    }
    if (seenJ.has(j)) {
      const e = new Error(`交付版第 ${j} 帧不能锁给多个主版帧（已锁 (${seenJ.get(j)},${j})）`);
      e.code = 'LOCK_INVALID';
      e.at = { i, j };
      throw e;
    }
    seenI.set(i, j);
    seenJ.set(j, i);
  }
  const sorted = locks.slice().sort((a, b) => a.i - b.i || a.j - b.j);
  for (let k = 1; k < sorted.length; k++) {
    if (!(sorted[k].i > sorted[k - 1].i && sorted[k].j > sorted[k - 1].j)) {
      const e = new Error(
        `锁点冲突：(${sorted[k - 1].i},${sorted[k - 1].j}) 与 (${sorted[k].i},${sorted[k].j}) 不能保持两侧严格递增`,
      );
      e.code = 'LOCK_INVALID';
      e.at = sorted[k];
      throw e;
    }
  }
  return sorted;
}

/** 把步序列合并成半开缺多区间，mi/dj 为两侧已消费帧数 */
export function buildIntervals(steps) {
  const intervals = [];
  let mi = 0;
  let dj = 0;
  let run = null;
  const flush = () => {
    if (run) {
      intervals.push(run);
      run = null;
    }
  };
  for (const st of steps) {
    if (st.t === 'm') {
      flush();
      mi++;
      dj++;
    } else if (st.t === 'x') {
      // missing：消费侧为主版，对侧已消费交付帧数 = dj（进入本段前的值）
      if (!run || run.type !== 'missing') {
        flush();
        run = { type: 'missing', start: mi, end: mi + 1, otherConsumed: dj };
      } else {
        run.end = mi + 1;
      }
      mi++;
    } else {
      // extra：消费侧为交付版，对侧已消费主版帧数 = mi（进入本段前的值）
      if (!run || run.type !== 'extra') {
        flush();
        run = { type: 'extra', start: dj, end: dj + 1, otherConsumed: mi };
      } else {
        run.end = dj + 1;
      }
      dj++;
    }
  }
  flush();
  return intervals;
}

/** 导出 JSON（format.txt 规定的结构） */
export function buildExport(result) {
  const typeName = { m: 'match', x: 'missing', y: 'extra' };
  return {
    totalFee: result.totalFee,
    gapSegments: result.gapSegments,
    steps: result.steps.map((s) => ({
      type: typeName[s.t],
      masterFrame: s.ai,
      deliveryFrame: s.bi,
      cost: s.cost,
    })),
    gapIntervals: result.intervals.map((iv) => ({
      type: iv.type,
      start: iv.start,
      end: iv.end,
      otherConsumed: iv.otherConsumed,
    })),
  };
}
