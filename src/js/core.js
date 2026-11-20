// 双目 Census + 八方向半全局聚合（SGM）参考实现。
// 纯计算，无 DOM、无第三方库；浏览器 Worker 与 Node 测试共用同一份代码。
//
// 规范（严格按样例包 README.txt）：
//   · 正视差 d：左图 (x,y) ↔ 右图 (x-d,y)，d ∈ [min_disparity, max_disparity]（0..63）。
//   · Census 5×5，行优先跳过中心，邻值严格小于中心置 1；仅完整窗口有效；
//     代价为 24 位汉明距离；窗口越界（本实现含左右图任一侧窗口不完整）代价恒为 1000000。
//   · 八方向单位向量：水平 ±、垂直 ±、两组对角线 ±。
//     每方向 L(p,d) = C(p,d) + min(L(prev,d), L(prev,d-1)+P1, L(prev,d+1)+P1,
//                                    min_k L(prev,k)+P2) - min_k L(prev,k)
//     路径起点 L = C。不存在的 d 候选项（越出视差区间的 d±1）不参与 min。
//   · S = Σ 八方向 L（不重复减 C）。最小 S 并列取小 d；只在“有效原始代价”中选最优。
//   · 唯一性：排除 |d-d0|<=1 后的次优 S2，要求 (S2-S0)/max(S0,1) >= ratio；无次优则通过。
//   · 亚像素：delta = (S(d-1) - S(d+1)) / (2*(S(d-1) - 2*S(d) + S(d+1)))，夹到 [-.5,.5]；
//     候选不全（d0 在区间端点上）或分母 <= 0 时 delta = 0。
//   · 反向以右图为基准，对应左图 x+d，视差仍为正；一致性在 floor(x - d_left + .5)
//     读取反向视差，两者差不超过阈值才有效。
//   · 导出：0 为无效，其余为 1 + floor(256*d + .5)。
//
// 关键约定：越界/窗口不完整的候选代价为 1000000 —— 它参与聚合（软惩罚，绝不补零），
// 但不属于“有效原始代价”，不参与 WTA、唯一性次优与最终选优。

export const INVALID_COST = 1000000;
export const MAX_WIDTH = 320;
export const MAX_HEIGHT = 240;
export const MAX_DISPARITY = 63;
export const CENSUS_RADIUS = 2;

/** 八个单位方向：水平、垂直、两组对角线。 */
export const DIRS = [
  { dx: 1, dy: 0, name: '→ 水平' },
  { dx: -1, dy: 0, name: '← 水平' },
  { dx: 0, dy: 1, name: '↓ 垂直' },
  { dx: 0, dy: -1, name: '↑ 垂直' },
  { dx: 1, dy: 1, name: '↘ 对角' },
  { dx: -1, dy: -1, name: '↖ 对角' },
  { dx: 1, dy: -1, name: '↗ 对角' },
  { dx: -1, dy: 1, name: '↙ 对角' },
];

export class InputError extends Error {}

const POP16 = new Uint8Array(1 << 16);
for (let i = 1; i < 1 << 16; i++) POP16[i] = POP16[i >> 1] + (i & 1);
function popcount24(v) {
  return POP16[v & 0xffff] + POP16[(v >>> 16) & 0xff];
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------
export function normalizeParams(raw = {}) {
  const num = (v, name, def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      if (def !== undefined) return def;
      throw new InputError(`参数 ${name} 不是有效数字`);
    }
    return n;
  };
  const dmin = Math.round(num(raw.minDisparity, '最小视差', 0));
  const dmax = Math.round(num(raw.maxDisparity, '最大视差', 12));
  const P1 = num(raw.P1, 'P1', 3);
  const P2 = num(raw.P2, 'P2', 24);
  const uniqueness = num(raw.uniqueness, '唯一性阈值', 0.05);
  const lrThreshold = num(raw.lrThreshold, '一致性阈值', 1);
  const subpixel = raw.subpixel !== false;
  const errors = [];
  if (!(dmin >= 0 && dmin <= MAX_DISPARITY)) errors.push(`最小视差须在 0..${MAX_DISPARITY}`);
  if (!(dmax >= 0 && dmax <= MAX_DISPARITY)) errors.push(`最大视差须在 0..${MAX_DISPARITY}`);
  if (dmin > dmax) errors.push('最小视差不能大于最大视差');
  if (!(P1 >= 0)) errors.push('P1 必须 ≥ 0');
  if (!(P2 > P1)) errors.push('必须满足 P2 > P1');
  if (!(uniqueness >= 0)) errors.push('唯一性阈值必须 ≥ 0');
  if (!(lrThreshold >= 0)) errors.push('一致性阈值必须 ≥ 0');
  if (errors.length) throw new InputError(errors.join('；'));
  return { minDisparity: dmin, maxDisparity: dmax, P1, P2, uniqueness, lrThreshold, subpixel };
}

export function validatePair(left, right) {
  if (!left || !right) throw new InputError('请同时提供左右两幅灰度图');
  const { width: lw, height: lh } = left;
  const { width: rw, height: rh } = right;
  if (lw !== rw || lh !== rh) {
    throw new InputError(`左右图尺寸必须相同（左 ${lw}×${lh}，右 ${rw}×${rh}）`);
  }
  if (lw > MAX_WIDTH || lh > MAX_HEIGHT) {
    throw new InputError(`图像最大 ${MAX_WIDTH}×${MAX_HEIGHT}（当前 ${lw}×${lh}）`);
  }
  if (!(lw > 0 && lh > 0)) throw new InputError('图像尺寸非法');
  if (left.bitDepth !== 8 || right.bitDepth !== 8) {
    throw new InputError(`左右图须为 8 位灰度（当前左 ${left.bitDepth} 位、右 ${right.bitDepth} 位）`);
  }
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------
/** 返回 { bits: Int32Array(W*H), valid: Uint8Array(W*H) }，仅完整 5×5 窗口 valid=1。 */
export function census(gray, W, H) {
  const bits = new Int32Array(W * H);
  const valid = new Uint8Array(W * H);
  const r = CENSUS_RADIUS;
  if (W < 2 * r + 1 || H < 2 * r + 1) return { bits, valid };
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      const c = gray[y * W + x];
      let b = 0;
      let k = 0;
      for (let dy = -r; dy <= r; dy++) {
        const row = (y + dy) * W + x;
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (gray[row + dx] < c) b |= 1 << k;
          k++;
        }
      }
      bits[y * W + x] = b;
      valid[y * W + x] = 1;
    }
  }
  return { bits, valid };
}

// ---------------------------------------------------------------------------
// 代价卷
// ---------------------------------------------------------------------------
/**
 * 代价卷 C(p,d)：Int32Array(W*H*D)，d 的索引 di = d - dmin。
 * 无效/越界候选恒为 INVALID_COST。正反向共用同一份：反向在 (x,d) 处的代价
 * 等于正向在 (x+d,d) 处的代价（汉明距离对称），见 reverseCost()。
 */
export function buildCostVolume(cenL, cenR, W, H, D, dmin) {
  const out = new Int32Array(W * H * D).fill(INVALID_COST);
  const bl = cenL.bits, br = cenR.bits;
  const vl = cenL.valid, vr = cenR.valid;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!vl[p]) continue;
      const base = p * D;
      const lb = bl[p];
      for (let di = 0; di < D; di++) {
        const xr = x - dmin - di;
        if (xr < 0 || xr >= W) continue;
        const pr = y * W + xr;
        if (!vr[pr]) continue;
        out[base + di] = popcount24(lb ^ br[pr]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 八方向聚合
// ---------------------------------------------------------------------------
/**
 * 聚合到 S（Float32Array(W*H*D)），reverse=false 以左图为基准，true 以右图为基准。
 * 使用滚动行缓冲，内存与 H 无关；每条方向路径独立，端点 L=C。
 * 无效候选（越界/窗口不完整）以 INVALID_COST 参与递推，不补零。
 */
export function aggregate(costVol, W, H, D, dmin, P1, P2, reverse, S = null) {
  if (!S) S = new Float32Array(W * H * D);
  const lineA = new Float32Array(W * D);
  const lineB = new Float32Array(W * D);
  const inv = INVALID_COST;

  for (let dIdx = 0; dIdx < DIRS.length; dIdx++) {
    const { dx, dy } = DIRS[dIdx];
    const yStart = dy > 0 ? 0 : H - 1;
    const yEnd = dy > 0 ? H : -1;
    const yStep = dy > 0 ? 1 : -1;
    const xStart = dx > 0 ? 0 : W - 1;
    const xEnd = dx > 0 ? W : -1;
    const xStep = dx > 0 ? 1 : -1;
    const sameRow = dy === 0;

    let cur = lineA;
    let prev = lineB;

    for (let y = yStart; y !== yEnd; y += yStep) {
      const rowBase = y * W;
      const prevRowBase = (y - dy) * W;
      const hasPrevRow = !sameRow && y - dy >= 0 && y - dy < H;
      for (let x = xStart; x !== xEnd; x += xStep) {
        const px = x - dx;
        const hasPrev = sameRow ? (px >= 0 && px < W) : (hasPrevRow && px >= 0 && px < W);
        const p = rowBase + x;
        const lOut = x * D;
        const outBase = p * D;

        if (!hasPrev) {
          // 路径起点：L = C
          if (reverse) {
            const cBase = (rowBase + x + dmin) * D;
            const stride = D + 1;
            let idx = cBase;
            for (let di = 0; di < D; di++) {
              const v = x + dmin + di < W ? costVol[idx] : inv;
              cur[lOut + di] = v;
              S[outBase + di] += v;
              idx += stride;
            }
          } else {
            for (let di = 0; di < D; di++) {
              const v = costVol[outBase + di];
              cur[lOut + di] = v;
              S[outBase + di] += v;
            }
          }
          continue;
        }

        const srcLine = sameRow ? cur : prev;
        const src = px * D;
        let m = srcLine[src];
        for (let di = 1; di < D; di++) {
          const v = srcLine[src + di];
          if (v < m) m = v;
        }
        const p2m = m + P2;

        const lastDi = D - 1;
        if (reverse) {
          const stride = D + 1;
          let idx = (rowBase + x + dmin) * D;
          const maxDi = Math.min(lastDi, W - 1 - (x + dmin));
          for (let di = 0; di <= maxDi; di++) {
            let best = srcLine[src + di];
            if (di > 0) { const v = srcLine[src + di - 1] + P1; if (v < best) best = v; }
            if (di < lastDi) { const v = srcLine[src + di + 1] + P1; if (v < best) best = v; }
            if (p2m < best) best = p2m;
            const lv = costVol[idx] + best - m;
            cur[lOut + di] = lv;
            S[outBase + di] += lv;
            idx += stride;
          }
          for (let di = maxDi + 1; di < D; di++) {
            let best = p2m;
            const v0 = srcLine[src + di];
            if (v0 < best) best = v0;
            if (di > 0) { const v = srcLine[src + di - 1] + P1; if (v < best) best = v; }
            if (di < lastDi) { const v = srcLine[src + di + 1] + P1; if (v < best) best = v; }
            const lv = inv + best - m;
            cur[lOut + di] = lv;
            S[outBase + di] += lv;
          }
        } else {
          // di = 0
          {
            let best = srcLine[src];
            { const v = srcLine[src + 1] + P1; if (v < best) best = v; }
            if (p2m < best) best = p2m;
            const lv = costVol[outBase] + best - m;
            cur[lOut] = lv;
            S[outBase] += lv;
          }
          for (let di = 1; di < lastDi; di++) {
            let best = srcLine[src + di];
            { const v = srcLine[src + di - 1] + P1; if (v < best) best = v; }
            { const v = srcLine[src + di + 1] + P1; if (v < best) best = v; }
            if (p2m < best) best = p2m;
            const lv = costVol[outBase + di] + best - m;
            cur[lOut + di] = lv;
            S[outBase + di] += lv;
          }
          if (lastDi > 0) {
            const di = lastDi;
            let best = srcLine[src + di];
            { const v = srcLine[src + di - 1] + P1; if (v < best) best = v; }
            if (p2m < best) best = p2m;
            const lv = costVol[outBase + di] + best - m;
            cur[lOut + di] = lv;
            S[outBase + di] += lv;
          }
        }
      }
      if (!sameRow) {
        const t = prev; prev = cur; cur = t;
      }
    }
  }
  return S;
}

// ---------------------------------------------------------------------------
// WTA + 唯一性 + 亚像素
// ---------------------------------------------------------------------------
/**
 * 逐像素选优。reverse 时有效候选需 x+d 在右图内。
 * 返回：
 *   d0i      Int16Array   最优候选索引（-1 表示无有效候选）
 *   S0       Float32Array 最优 S
 *   S2       Float32Array 次优 S（排除 |d-d0|<=1；NaN 表示无次优）
 *   uniqOk   Uint8Array
 *   delta    Float32Array 亚像素修正
 *   d        Float32Array 亚像素后视差；不合格为 NaN
 *   reason   Uint8Array   0 通过 / 1 无有效原始代价 / 2 未过唯一性
 */
export function winnerTakeAll(costVol, S, W, H, D, dmin, uniqueness, subpixel, reverse) {
  const d0i = new Int16Array(W * H).fill(-1);
  const S0 = new Float32Array(W * H).fill(NaN);
  const S2 = new Float32Array(W * H).fill(NaN);
  const uniqOk = new Uint8Array(W * H);
  const delta = new Float32Array(W * H);
  const d = new Float32Array(W * H).fill(NaN);
  const reason = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const p = rowBase + x;
      const base = p * D;
      let bestDi = -1;
      let bestS = Infinity;
      for (let di = 0; di < D; di++) {
        const ok = reverse
          ? (x + dmin + di < W && costVol[(rowBase + x + dmin + di) * D + di] !== INVALID_COST)
          : costVol[base + di] !== INVALID_COST;
        if (!ok) continue;
        const v = S[base + di];
        if (v < bestS || (v === bestS && di < bestDi)) { bestS = v; bestDi = di; }
      }
      if (bestDi < 0) { reason[p] = 1; continue; }
      d0i[p] = bestDi;
      S0[p] = bestS;

      let second = NaN;
      for (let di = 0; di < D; di++) {
        if (Math.abs(di - bestDi) <= 1) continue;
        const ok = reverse
          ? (x + dmin + di < W && costVol[(rowBase + x + dmin + di) * D + di] !== INVALID_COST)
          : costVol[base + di] !== INVALID_COST;
        if (!ok) continue;
        const v = S[base + di];
        if (Number.isNaN(second) || v < second) second = v;
      }
      S2[p] = second;
      const pass = Number.isNaN(second) || (second - bestS) / Math.max(bestS, 1) >= uniqueness;
      if (!pass) { reason[p] = 2; continue; }
      uniqOk[p] = 1;

      let dlt = 0;
      // 亚像素要求 d0-1、d0、d0+1 三个候选都真实存在（在区间内且原始代价有效）
      const neighOk = bestDi > 0 && bestDi < D - 1 && (reverse
        ? (x + dmin + bestDi - 1 < W && x + dmin + bestDi + 1 < W
           && costVol[(rowBase + x + dmin + bestDi - 1) * D + bestDi - 1] !== INVALID_COST
           && costVol[(rowBase + x + dmin + bestDi + 1) * D + bestDi + 1] !== INVALID_COST)
        : (costVol[base + bestDi - 1] !== INVALID_COST && costVol[base + bestDi + 1] !== INVALID_COST));
      if (subpixel && neighOk) {
        const a = S[base + bestDi - 1];
        const b = S[base + bestDi];
        const c = S[base + bestDi + 1];
        const den = 2 * (a - 2 * b + c);
        if (den > 0) {
          dlt = (a - c) / den;
          if (dlt > 0.5) dlt = 0.5;
          else if (dlt < -0.5) dlt = -0.5;
        }
      }
      delta[p] = dlt;
      d[p] = dmin + bestDi + dlt;
    }
  }
  return { d0i, S0, S2, uniqOk, delta, d, reason };
}

// ---------------------------------------------------------------------------
// 左右一致性
// ---------------------------------------------------------------------------
/**
 * 以左图为基准的视差 dL，在右图 xr = floor(x - dL + .5) 读取反向视差 dR，
 * |dL - dR| <= threshold 才有效。越界或反向无效一律判无效，绝不补零。
 * 返回 { final: Float32Array(NaN=无效), reason: Uint8Array,
 *        0 通过 / 1 无有效原始代价 / 2 唯一性 / 3 一致性, dRAt: Float32Array }
 */
export function leftRightCheck(dL, dR, reasonL, W, H, lrThreshold) {
  const final = new Float32Array(W * H).fill(NaN);
  const reason = new Uint8Array(W * H);
  const dRAt = new Float32Array(W * H).fill(NaN);
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const p = rowBase + x;
      reason[p] = reasonL[p];
      const dl = dL[p];
      if (Number.isNaN(dl)) continue;
      const xr = Math.floor(x - dl + 0.5);
      if (xr < 0 || xr >= W) { reason[p] = 3; continue; }
      const dr = dR[rowBase + xr];
      dRAt[p] = dr;
      if (Number.isNaN(dr) || Math.abs(dl - dr) > lrThreshold) { reason[p] = 3; continue; }
      final[p] = dl;
    }
  }
  return { final, reason, dRAt };
}

// ---------------------------------------------------------------------------
// 完整管线
// ---------------------------------------------------------------------------
/**
 * @param {Uint8Array} leftGray  W*H，8 位灰度
 * @param {Uint8Array} rightGray W*H
 * @param {{minDisparity,maxDisparity,P1,P2,uniqueness,lrThreshold,subpixel}} params
 */
export function compute(leftGray, rightGray, W, H, params) {
  const p = normalizeParams(params);
  const D = p.maxDisparity - p.minDisparity + 1;
  const t0 = now();
  const cenL = census(leftGray, W, H);
  const cenR = census(rightGray, W, H);
  const C = buildCostVolume(cenL, cenR, W, H, D, p.minDisparity);
  const tCost = now();

  const Sf = aggregate(C, W, H, D, p.minDisparity, p.P1, p.P2, false);
  const fwd = winnerTakeAll(C, Sf, W, H, D, p.minDisparity, p.uniqueness, p.subpixel, false);
  const tFwd = now();

  const Sr = aggregate(C, W, H, D, p.minDisparity, p.P1, p.P2, true);
  const rev = winnerTakeAll(C, Sr, W, H, D, p.minDisparity, p.uniqueness, p.subpixel, true);
  // 反向 S 曲线保留给检查台（仅当明确要求时；默认释放以省内存）
  const tRev = now();

  const lr = leftRightCheck(fwd.d, rev.d, fwd.reason, W, H, p.lrThreshold);
  const tEnd = now();

  return {
    params: p,
    width: W,
    height: H,
    D,
    cost: C,
    S: Sf,
    Sr,
    cenL,
    cenR,
    forward: fwd,
    reverse: rev,
    final: lr.final,
    reason: lr.reason,
    dRAt: lr.dRAt,
    timings: { cost: tCost - t0, forward: tFwd - tCost, reverse: tRev - tFwd, lr: tEnd - tRev, total: tEnd - t0 },
  };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// 统计与导出
// ---------------------------------------------------------------------------
/** 与真值图（16 位，0=无效，其余 d=(v-1)/256）比较。 */
export function evaluate(final, truthSamples, W, H) {
  let truthCount = 0, validCount = 0, badCount = 0, falseValid = 0;
  let sumAbs = 0;
  for (let i = 0; i < W * H; i++) {
    const t = truthSamples[i];
    const d = final[i];
    const dValid = !Number.isNaN(d);
    if (t === 0) {
      if (dValid) falseValid++;
      continue;
    }
    truthCount++;
    if (!dValid) continue;
    validCount++;
    const td = (t - 1) / 256;
    const abs = Math.abs(d - td);
    sumAbs += abs;
    if (abs > 1) badCount++;
  }
  return {
    truthCount,
    validCount,
    badCount,
    falseValid,
    coverage: truthCount ? validCount / truthCount : 0,
    errorRate: validCount ? badCount / validCount : 0,
    meanAbsError: validCount ? sumAbs / validCount : 0,
  };
}

/** 按包内约定编码：0 无效，其余 1 + floor(256*d + .5)。 */
export function encodeDisparity16(final, W, H) {
  const out = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = final[i];
    if (Number.isNaN(d)) { out[i] = 0; continue; }
    let v = 1 + Math.floor(256 * d + 0.5);
    if (v < 0) v = 0;
    if (v > 65535) v = 65535;
    out[i] = v;
  }
  return out;
}

/**
 * 逐像素回放八条路径，返回原始代价、各方向 L 贡献、汇总曲线与最后一步的
 * 转移来源（供检查台核对）。复杂度 O((W+H)·D)。
 * reverse=false 以左图为基准；true 以右图为基准（代价按右图坐标取）。
 */
export function explainPixel(result, x, y, reverse = false) {
  const { width: W, height: H, D, params, cost } = result;
  const S = reverse ? result.Sr : result.S;
  const P1 = params.P1, P2 = params.P2, dmin = params.minDisparity;
  const costAt = (px, py, di) => {
    if (reverse) {
      const lx = px + dmin + di;
      if (lx >= W) return INVALID_COST;
      return cost[(py * W + lx) * D + di];
    }
    return cost[(py * W + px) * D + di];
  };

  const dirs = [];
  for (const dir of DIRS) {
    let steps = 0;
    for (;;) {
      const nx = x - dir.dx * (steps + 1);
      const ny = y - dir.dy * (steps + 1);
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) break;
      steps++;
    }
    let prevL = null;
    let prevM = 0;
    let L = null;
    let winners = new Int8Array(D); // 0=同d -1=取d-1+P1 1=取d+1+P1 2=全局min+P2
    for (let s = steps; s >= 0; s--) {
      const px = x - dir.dx * s;
      const py = y - dir.dy * s;
      L = new Float32Array(D);
      const w = new Int8Array(D);
      if (prevL === null) {
        for (let di = 0; di < D; di++) L[di] = costAt(px, py, di);
      } else {
        const m = prevM;
        const p2m = m + P2;
        for (let di = 0; di < D; di++) {
          let best = prevL[di], win = 0;
          if (di > 0) {
            const v = prevL[di - 1] + P1;
            if (v < best) { best = v; win = -1; }
          }
          if (di < D - 1) {
            const v = prevL[di + 1] + P1;
            if (v < best) { best = v; win = 1; }
          }
          if (p2m < best) { best = p2m; win = 2; }
          L[di] = costAt(px, py, di) + best - m;
          w[di] = win;
        }
      }
      let m = L[0];
      for (let di = 1; di < D; di++) if (L[di] < m) m = L[di];
      prevL = L;
      prevM = m;
      winners = w;
    }
    dirs.push({ dir, L: prevL, winners });
  }

  const rawCost = new Float32Array(D);
  for (let di = 0; di < D; di++) rawCost[di] = costAt(x, y, di);

  const sum = new Float32Array(D);
  for (const c of dirs) for (let di = 0; di < D; di++) sum[di] += c.L[di];

  const storedS = new Float32Array(D);
  const base = (y * W + x) * D;
  for (let di = 0; di < D; di++) storedS[di] = S[base + di];

  return { dirs, rawCost, sum, storedS };
}
