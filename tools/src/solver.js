// Multi-backdrop straight-alpha recovery with exact integer interval math.
//
// 合成约定（整数域，无颜色空间转换）：
//   O = floor((A*F + (255-A)*B + 127) / 255)
// 容差 t 下，某观测通道允许 O-t <= predict <= O+t（码值夹到 0..255）。
// 对每个 A in 0..255，求每个未排除观测通道的可行 F 区间，再按通道取交。
// 交片解：可行 A 中取最小 A，F 逐通道取区间下界（即 R、G、B 依次最小）。

export const STATUS_UNMEASURED = 0;
export const STATUS_FEASIBLE = 1;
export const STATUS_NO_SOLUTION = 2;

export function composite(a, f, b) {
  return ((a * f + (255 - a) * b + 127) / 255) | 0;
}

function floorDiv(x, y) {
  // y > 0
  return x >= 0 ? ((x / y) | 0) : -((( -x + y - 1) / y) | 0);
}

function ceilDiv(x, y) {
  // y > 0
  return x >= 0 ? (((x + y - 1) / y) | 0) : -(((-x) / y) | 0);
}

// 单通道 F 区间：满足 |composite(a,F,b)-o| <= t 的全部整数 F in 0..255。
// 返回 [lo, hi] 或 null。
export function channelInterval(a, b, o, t) {
  const loBound = o - t > 0 ? o - t : 0;
  const hiBound = o + t < 255 ? o + t : 255;
  if (a === 0) {
    // 此时预测恒等于 floor(((255)*b + 127)/255)
    const p = composite(0, 0, b);
    return p >= loBound && p <= hiBound ? [0, 255] : null;
  }
  const k = (255 - a) * b;
  // 255*loBound - k - 127 <= a*F
  const numLo = 255 * loBound - k - 127;
  // a*F <= 255*(hiBound+1) - 1 - k - 127
  const numHi = 255 * (hiBound + 1) - 1 - k - 127;
  let lo = ceilDiv(numLo, a);
  let hi = floorDiv(numHi, a);
  if (lo < 0) lo = 0;
  if (hi > 255) hi = 255;
  return lo <= hi ? [lo, hi] : null;
}

// 解一个像素。
// active: 数组，每组为 {b:[r,g,b], o:[r,g,b]}，仅含未排除的组；空数组表示未测。
// 返回 {status, solution:[a,r,g,b]|null, feasible:[{a,lo:[...],hi:[...]}...]}
export function solvePixel(active, tol) {
  if (active.length === 0) {
    return { status: STATUS_UNMEASURED, solution: null, feasible: [] };
  }
  const feasible = [];
  let solution = null;
  for (let a = 0; a <= 255; a++) {
    const lo = [0, 0, 0];
    const hi = [255, 255, 255];
    let ok = true;
    for (let g = 0; g < active.length; g++) {
      const grp = active[g];
      for (let c = 0; c < 3; c++) {
        const iv = channelInterval(a, grp.b[c], grp.o[c], tol);
        if (iv === null) { ok = false; break; }
        if (iv[0] > lo[c]) lo[c] = iv[0];
        if (iv[1] < hi[c]) hi[c] = iv[1];
        if (lo[c] > hi[c]) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) {
      const entry = { a, lo: [lo[0], lo[1], lo[2]], hi: [hi[0], hi[1], hi[2]] };
      feasible.push(entry);
      if (solution === null) {
        // 最小 A（a 递增），F 取下界 => R、G、B 依次最小
        solution = [a, lo[0], lo[1], lo[2]];
      }
    }
  }
  if (solution === null) return { status: STATUS_NO_SOLUTION, solution: null, feasible: [] };
  return { status: STATUS_FEASIBLE, solution, feasible };
}

// 全图求解。groups: [{bg:Uint8Array(3n), obs:Uint8Array(3n), mask:Uint8Array(n)|null, enabled:boolean}]
// 返回 {status:Uint8Array(n), rgba:Uint8Array(4n), feasibleA:Uint8Array(n) 计数,
//        width,height,tol,counts}
// onProgress(rowFrac=>void) 可选。
export function solveImage(width, height, groups, tol, onProgress = null) {
  const n = width * height;
  const status = new Uint8Array(n);
  const rgba = new Uint8Array(4 * n); // 默认全 0 => 未测/无解都是透明黑
  const feasibleCount = new Uint16Array(n);
  const counts = { feasible: 0, noSolution: 0, unmeasured: 0 };
  const activeGroups = groups.filter((g) => g.enabled);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const active = [];
      for (let gi = 0; gi < activeGroups.length; gi++) {
        const g = activeGroups[gi];
        if (g.mask !== null && g.mask[p] === 0) continue;
      active.push({
          b: [g.bg[3 * p], g.bg[3 * p + 1], g.bg[3 * p + 2]],
          o: [g.obs[3 * p], g.obs[3 * p + 1], g.obs[3 * p + 2]],
        });
      }
      const res = solvePixel(active, tol);
      status[p] = res.status;
      if (res.status === STATUS_FEASIBLE) {
        const [a, r, gg, b] = res.solution;
        rgba[4 * p] = r;
        rgba[4 * p + 1] = gg;
        rgba[4 * p + 2] = b;
        rgba[4 * p + 3] = a;
        feasibleCount[p] = res.feasible.length;
        counts.feasible++;
      } else if (res.status === STATUS_NO_SOLUTION) {
        counts.noSolution++;
      } else {
        counts.unmeasured++;
      }
    }
    if (onProgress && (y & 15) === 15) onProgress((y + 1) / height);
  }
  if (onProgress) onProgress(1);
  return { width, height, tol, status, rgba, feasibleCount, counts };
}

// 检查器：某像素在某次求解下的完整信息（全部可行 A + 逐组预测误差）。
export function inspectPixel(width, groups, tol, x, y) {
  const p = y * width + x;
  const perGroup = groups.map((g) => {
    const excludedByMask = g.mask !== null && g.mask[p] === 0;
    const used = g.enabled && !excludedByMask;
    return {
      enabled: g.enabled,
      excludedByMask,
      used,
      b: [g.bg[3 * p], g.bg[3 * p + 1], g.bg[3 * p + 2]],
      o: [g.obs[3 * p], g.obs[3 * p + 1], g.obs[3 * p + 2]],
    };
  });
  const active = perGroup.filter((g) => g.used).map((g) => ({ b: g.b, o: g.o }));
  const res = solvePixel(active, tol);
  // 逐组、逐通道预测与误差（误差 = 预测 - 观测），基于交片解
  let predictions = null;
  if (res.status === STATUS_FEASIBLE) {
    const [a, r, gg, b] = res.solution;
    const f = [r, gg, b];
    predictions = perGroup.map((g) => {
      const pred = [0, 0, 0];
      const err = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        pred[c] = composite(a, f[c], g.b[c]);
        err[c] = pred[c] - g.o[c];
      }
      return { pred, err };
    });
  }
  return {
    x, y,
    status: res.status,
    solution: res.solution,
    feasible: res.feasible,
    perGroup,
    predictions,
  };
}
