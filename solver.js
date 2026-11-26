/*
 * solver.js — 磁带导频整圈展开 / 全段最小折变 DP / 无解读数诊断
 *
 * 纯逻辑、无 DOM 依赖：浏览器挂到 window.PilotSolver，Node 可 require。
 *
 * 数学约定（见 samples 包内 约定.txt）：
 *   mark = [x, p, k_lo, k_hi]
 *   z = 256 k + p,  k ∈ [k_lo, k_hi]（边界均含，候选 ≤ 16）
 *   dx_i = x_{i+1} - x_i, dz_i = z_{i+1} - z_i
 *   rate_min = [a,b], rate_max = [c,d]（正 u32 分数）
 *     a/b ≤ dz_i/dx_i ≤ c/d   ⇔   a·dx_i ≤ b·dz_i 且 d·dz_i ≤ c·dx_i
 *   折变代价 Σ_i |dz_i·dx_{i+1} - dz_{i+1}·dx_i|（纯整数）
 *   同价取整条展开相位序列字典序最小。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PilotSolver = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MAX_CANDIDATES = 16;
  var MAX_K = 9999999;
  var PHASE_MOD = 256;
  // z = 256 * 9999999 + 255 = 2,559,999,999
  var Z_MAX = PHASE_MOD * MAX_K + 255;
  var DZ_HARD_MAX = Z_MAX;

  /* ---------------- 基础构造与校验 ---------------- */

  function candidateZs(mark) {
    var p = mark[1] | 0;
    var lo = mark[2] | 0;
    var hi = mark[3] | 0;
    var out = new Array(Math.max(0, hi - lo + 1));
    for (var k = lo, j = 0; k <= hi; k++, j++) out[j] = PHASE_MOD * k + p;
    return out;
  }

  function isPosU32(v) {
    return Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
  }

  // 只做问题级校验；返回 { errors:[...], warnings:[...] }
  function validateProject(proj) {
    var errors = [];
    var warnings = [];
    if (!proj || typeof proj !== 'object') {
      errors.push('project.json 不是对象');
      return { errors: errors, warnings: warnings };
    }
    if (!Array.isArray(proj.marks) || proj.marks.length < 2) {
      errors.push('marks 至少需要首尾 2 个读数');
      return { errors: errors, warnings: warnings };
    }
    var m = proj.marks.length;
    if (m > 20000) errors.push('读数数量 ' + m + ' 超过上限 20000');

    var rm = proj.rate_min, rx = proj.rate_max;
    if (!Array.isArray(rm) || !isPosU32(rm[0]) || !isPosU32(rm[1]))
      errors.push('rate_min 必须是两个正 u32 组成的分数 [分子, 分母]');
    if (!Array.isArray(rx) || !isPosU32(rx[0]) || !isPosU32(rx[1]))
      errors.push('rate_max 必须是两个正 u32 组成的分数 [分子, 分母]');

    var lastX = -1;
    for (var i = 0; i < m; i++) {
      var row = proj.marks[i];
      if (!Array.isArray(row) || row.length < 4) {
        errors.push('marks[' + i + '] 不是 [x,p,k_lo,k_hi]');
        continue;
      }
      var x = row[0], p = row[1], lo = row[2], hi = row[3];
      if (!Number.isInteger(x) || x < 0) errors.push('marks[' + i + '].x 非法');
      if (i > 0 && Number.isInteger(x) && x <= lastX)
        errors.push('x 必须严格升序：marks[' + i + '].x=' + x + ' 未大于前一 x=' + lastX);
      lastX = x;
      if (!Number.isInteger(p) || p < 0 || p > 255)
        errors.push('marks[' + i + '].p=' + p + ' 不在 0..255');
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > MAX_K || lo > hi)
        errors.push('marks[' + i + '] 的整圈候选下界/上界非法（需 0≤lo≤hi≤9999999）');
      else if (hi - lo + 1 > MAX_CANDIDATES)
        errors.push('marks[' + i + '] 候选数 ' + (hi - lo + 1) + ' 超过 ' + MAX_CANDIDATES);
    }
    if (Number.isInteger(proj.marks[0] && proj.marks[0][0]) && proj.marks[0][0] !== 0)
      errors.push('首个读数的 x 必须为 0');

    if (proj.anchors != null) {
      if (typeof proj.anchors !== 'object') errors.push('anchors 必须是 {读数编号: 展开相位}');
      else {
        Object.keys(proj.anchors).forEach(function (key) {
          var idx = Number(key);
          var z = proj.anchors[key];
          if (!Number.isInteger(idx) || idx < 0 || idx >= m)
            errors.push('anchors 键 "' + key + '" 不是有效读数编号 0..' + (m - 1));
          if (!Number.isInteger(z) || z < 0 || z > Z_MAX)
            errors.push('anchors[' + key + ']=' + z + ' 不是合法展开相位');
        });
      }
    }
    return { errors: errors, warnings: warnings };
  }

  /* ---------------- 预处理：候选 / dx / 可行邻接位掩码 ---------------- */

  function prepare(proj) {
    var v = validateProject(proj);
    if (v.errors.length) {
      var e = new Error(v.errors[0]);
      e.allErrors = v.errors;
      throw e;
    }
    var marks = proj.marks;
    var n = marks.length;
    var Z = new Array(n);
    var klen = new Array(n);
    for (var i = 0; i < n; i++) {
      Z[i] = candidateZs(marks[i]);
      klen[i] = Z[i].length;
    }
    var xs = marks.map(function (m) { return m[0]; });
    var dx = new Array(n - 1);
    for (i = 0; i < n - 1; i++) dx[i] = xs[i + 1] - xs[i];

    var a = proj.rate_min[0], b = proj.rate_min[1];
    var c = proj.rate_max[0], d = proj.rate_max[1];

    // succ[e][p] = 位掩码：读数 e 的候选 p 可按速度区间连到读数 e+1 的哪些候选 q
    // pred[e][q] = 位掩码：读数 e+1 的候选 q 可由读数 e 的哪些候选 p 连入
    var succ = new Array(n - 1);
    var pred = new Array(n - 1);
    var edgeDzMax = new Array(n - 1);
    var anyEdge = new Array(n - 1);

    for (var e = 0; e < n - 1; e++) {
      var dxe = dx[e];
      // 精确求 dz 的整数闭区间（用 BigInt 处理 u32*dx 的溢出），再饱和到 Number
      var loBI = (BigInt(a) * BigInt(dxe) + BigInt(b) - 1n) / BigInt(b); // ceil(a*dx/b)
      var hiBI = (BigInt(c) * BigInt(dxe)) / BigInt(d);                 // floor(c*dx/d)
      var dzMin, dzMax;
      if (loBI > BigInt(DZ_HARD_MAX)) dzMin = DZ_HARD_MAX + 1;
      else dzMin = Number(loBI);
      if (hiBI >= BigInt(DZ_HARD_MAX)) dzMax = DZ_HARD_MAX;
      else if (hiBI < -BigInt(DZ_HARD_MAX)) dzMax = -DZ_HARD_MAX - 1;
      else dzMax = Number(hiBI);

      var kp = klen[e], kq = klen[e + 1];
      succ[e] = new Uint16Array(kp);
      pred[e] = new Uint16Array(kq);
      var dzMaxAbs = 0;
      var any = false;
      for (var p = 0; p < kp; p++) {
        var zp = Z[e][p];
        var mask = 0;
        for (var q = 0; q < kq; q++) {
          var dz = Z[e + 1][q] - zp;
          if (dz >= dzMin && dz <= dzMax) {
            mask |= 1 << q;
            pred[e][q] |= 1 << p;
            var ad = dz < 0 ? -dz : dz;
            if (ad > dzMaxAbs) dzMaxAbs = ad;
            any = true;
          }
        }
        succ[e][p] = mask;
      }
      edgeDzMax[e] = dzMaxAbs;
      anyEdge[e] = any;
    }

    // 判断整条 DP 是否可全程使用安全 Number 整数：
    // 第 i 个代价项上界 B_i = max|dz_i|*dx_{i+1} + max|dz_{i+1}|*dx_i
    // Σ B_i ≤ MAX_SAFE_INTEGER 时，所有 DP 累加值与逐项整数运算都精确。
    var sumBound = 0;
    var numberSafe = true;
    for (var ti = 0; ti < n - 2; ti++) {
      var Bi = edgeDzMax[ti] * dx[ti + 1] + edgeDzMax[ti + 1] * dx[ti];
      if (!Number.isFinite(Bi)) { numberSafe = false; break; }
      sumBound += Bi;
      if (sumBound > Number.MAX_SAFE_INTEGER || Bi > Number.MAX_SAFE_INTEGER) {
        numberSafe = false;
        break;
      }
    }
    if (n <= 2) numberSafe = true;

    return {
      n: n,
      Z: Z,
      klen: klen,
      xs: xs,
      dx: dx,
      sampleFrames: xs[n - 1],
      rateMin: [a, b],
      rateMax: [c, d],
      succ: succ,
      pred: pred,
      edgeDzMax: edgeDzMax,
      anyEdge: anyEdge,
      numberSafe: numberSafe,
      costBound: sumBound
    };
  }

  /* ---------------- 锚点解析 ---------------- */

  // anchorsInput: Map<number,number> 或 { "3": 6400 } 或 [[idx,z],...]
  // 返回 { anchorIdx: Int8Array(n) (-1=无), errors: [] }
  function resolveAnchors(prep, anchorsInput) {
    var n = prep.n;
    var anchorIdx = new Int8Array(n).fill(-1);
    var errors = [];
    var entries = [];
    if (anchorsInput instanceof Map) {
      anchorsInput.forEach(function (z, idx) { entries.push([Number(idx), z]); });
    } else if (Array.isArray(anchorsInput)) {
      entries = anchorsInput.map(function (pair) { return [Number(pair[0]), pair[1]]; });
    } else if (anchorsInput && typeof anchorsInput === 'object') {
      Object.keys(anchorsInput).forEach(function (k) {
        entries.push([Number(k), anchorsInput[k]]);
      });
    }
    entries.forEach(function (pair) {
      var idx = pair[0], z = pair[1];
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
        errors.push('锚点编号 ' + idx + ' 超出读数范围 0..' + (n - 1));
        return;
      }
      var qi = prep.Z[idx].indexOf(z);
      if (qi < 0) {
        errors.push('读数 #' + idx + ' 的锚点相位 z=' + z +
          ' 不在其整圈候选展开值 ' + JSON.stringify(prep.Z[idx]) + ' 中');
        return;
      }
      if (anchorIdx[idx] >= 0 && anchorIdx[idx] !== qi) {
        errors.push('读数 #' + idx + ' 存在互相冲突的锚点');
        return;
      }
      anchorIdx[idx] = qi;
    });
    return { anchorIdx: anchorIdx, errors: errors };
  }

  function allowedMask(prep, anchorIdx, i) {
    if (anchorIdx[i] >= 0) return 1 << anchorIdx[i];
    return prep.klen[i] >= 16 ? 0xffff : (1 << prep.klen[i]) - 1;
  }

  /* ---------------- 第一处无法延续的读数 ---------------- */

  // 从读数 0 前向做候选可达性；返回第一个 reachable 为空的读数编号；全部可行返回 -1。
  function firstBadReading(prep, anchorIdx) {
    var n = prep.n;
    var mask0 = allowedMask(prep, anchorIdx, 0);
    if (mask0 === 0) return 0;
    var reach = mask0;
    for (var i = 1; i < n; i++) {
      var allowed = allowedMask(prep, anchorIdx, i);
      var next = 0;
      // q 候选是否存在可达前驱 p
      var qbits = allowed;
      while (qbits) {
        var q = ctz(qbits);
        qbits &= qbits - 1;
        if (prep.pred[i - 1][q] & reach) next |= 1 << q;
      }
      if (next === 0) return i;
      reach = next;
    }
    return -1;
  }

  function ctz(x) {
    // Uint16 位掩码，最低置位位号
    var n = 0;
    if ((x & 0x00ff) === 0) { n += 8; x >>= 8; }
    if ((x & 0x000f) === 0) { n += 4; x >>= 4; }
    if ((x & 0x0003) === 0) { n += 2; x >>= 2; }
    if ((x & 0x0001) === 0) { n += 1; }
    return n;
  }

  /* ---------------- 二阶 DP 全局最优 ---------------- */

  // anchorIdx 可省略（表示无额外锚点，通常首/尾仍应由调用方放入）。
  // 返回 { ok, z, zIndices, cost(number|bigint), costText, numberSafe, elapsedMs, firstBad }
  function solvePrepared(prep, anchorIdx) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : nowMs();
    if (!anchorIdx) anchorIdx = new Int8Array(prep.n).fill(-1);
    var bad = firstBadReading(prep, anchorIdx);
    if (bad >= 0) {
      return {
        ok: false,
        feasible: false,
        firstBad: bad,
        elapsedMs: nowMs() - t0
      };
    }

    var n = prep.n;
    var Z = prep.Z, dx = prep.dx, succ = prep.succ;
    var numberSafe = prep.numberSafe;

    // 单读数退化情况
    if (n === 1) {
      var qi0 = anchorIdx[0] >= 0 ? anchorIdx[0] : 0;
      return finish([Z[0][qi0]], [qi0], 0, true, t0);
    }

    // dec[i*256 + p*16 + q] = 层 i 状态 (p=读数 i-1, q=读数 i) 选中的后继 r
    var dec = new Uint8Array(n * 256);
    for (var di = 0; di < dec.length; di++) dec[di] = 255;

    var nextT, curT;
    var INF = Infinity;

    if (numberSafe) {
      nextT = new Float64Array(256);
      for (var b = 0; b < 256; b++) nextT[b] = INF;
      // 基表 T_{n-1}：所有合法的 (p,q) 边状态代价 0
      var lastAllowed = allowedMask(prep, anchorIdx, n - 1);
      for (var pp = 0; pp < prep.klen[n - 2]; pp++) {
        var qm = succ[n - 2][pp] & lastAllowed;
        while (qm) {
          var qq = ctz(qm); qm &= qm - 1;
          nextT[pp * 16 + qq] = 0;
        }
      }

      for (var i = n - 2; i >= 1; i--) {
        curT = new Float64Array(256);
        for (var z0i = 0; z0i < 256; z0i++) curT[z0i] = INF;
        var allowI = allowedMask(prep, anchorIdx, i);
        var allowNext = allowedMask(prep, anchorIdx, i + 1);
        var dxCur = dx[i - 1];
        var dxNext = dx[i];
        for (var p = 0; p < prep.klen[i - 1]; p++) {
          var qmask = succ[i - 1][p] & allowI;
          while (qmask) {
            var q = ctz(qmask); qmask &= qmask - 1;
            var state = p * 16 + q;
            var zq = Z[i][q];
            var dz1 = zq - Z[i - 1][p];
            var rmask = succ[i][q] & allowNext;
            var best = INF;
            var bestR = 255;
            while (rmask) {
              var r = ctz(rmask); rmask &= rmask - 1; // r 升序，平局保留最小 r
              var base = q * 16 + r;
              var nv = nextT[base];
              if (nv === INF) continue;
              var dz2 = Z[i + 1][r] - zq;
              var term = Math.abs(dz1 * dxNext - dz2 * dxCur);
              var cand = nv + term;
              if (cand < best) { best = cand; bestR = r; }
            }
            if (bestR !== 255) {
              curT[state] = best;
              dec[i * 256 + state] = bestR;
            }
          }
        }
        nextT = curT;
      }

      // 选起点 (z0,z1)：代价最小，平局按 p、q 升序（= z 升序）
      var allow0 = allowedMask(prep, anchorIdx, 0);
      var bestTotal = INF, bestP = 255, bestQ = 255;
      var pbits = allow0;
      while (pbits) {
        var p0 = ctz(pbits); pbits &= pbits - 1;
        for (var q1 = 0; q1 < prep.klen[1]; q1++) {
          var val = nextT[p0 * 16 + q1]; // T_1 表（n=2 时即基表，合法边为 0）
          if (val < bestTotal) { bestTotal = val; bestP = p0; bestQ = q1; }
        }
      }
      if (bestP === 255) {
        return { ok: false, feasible: false, firstBad: firstBadReading(prep, anchorIdx), elapsedMs: nowMs() - t0 };
      }

      var idxPath = reconstruct(prep, dec, bestP, bestQ);
      var zPath = idxPath.map(function (qi, ii) { return Z[ii][qi]; });
      return finish(zPath, idxPath, bestTotal, true, t0);
    }

    /* -------- BigInt 精确模式（代价总额可能超过 2^53） -------- */
    var NINF = -1n;
    nextT = new Array(256);
    for (var x = 0; x < 256; x++) nextT[x] = NINF;
    var lastAllowedBI = allowedMask(prep, anchorIdx, n - 1);
    for (var p2 = 0; p2 < prep.klen[n - 2]; p2++) {
      var qmBI = succ[n - 2][p2] & lastAllowedBI;
      while (qmBI) {
        var ql = ctz(qmBI); qmBI &= qmBI - 1;
        nextT[p2 * 16 + ql] = 0n;
      }
    }

    for (var ib = n - 2; ib >= 1; ib--) {
      curT = new Array(256);
      for (var xi = 0; xi < 256; xi++) curT[xi] = NINF;
      var allowIb = allowedMask(prep, anchorIdx, ib);
      var allowNextIb = allowedMask(prep, anchorIdx, ib + 1);
      var dxCurB = BigInt(dx[ib - 1]);
      var dxNextB = BigInt(dx[ib]);
      // 该层代价项是否可用安全 Number 计算
      var boundI = prep.edgeDzMax[ib - 1] * dx[ib] + prep.edgeDzMax[ib] * dx[ib - 1];
      var termNumberSafe = boundI <= Number.MAX_SAFE_INTEGER;
      for (var pb = 0; pb < prep.klen[ib - 1]; pb++) {
        var qmaskB = succ[ib - 1][pb] & allowIb;
        while (qmaskB) {
          var qb = ctz(qmaskB); qmaskB &= qmaskB - 1;
          var stateB = pb * 16 + qb;
          var zqb = Z[ib][qb];
          var dz1b = zqb - Z[ib - 1][pb];
          var dz1Big = termNumberSafe ? null : BigInt(dz1b);
          var rmaskB = succ[ib][qb] & allowNextIb;
          var bestB = NINF;
          var bestRb = 255;
          while (rmaskB) {
            var rb = ctz(rmaskB); rmaskB &= rmaskB - 1;
            var nvB = nextT[qb * 16 + rb];
            if (nvB === NINF) continue;
            var dz2b = Z[ib + 1][rb] - zqb;
            var termB;
            if (termNumberSafe) {
              termB = BigInt(Math.abs(dz1b * dx[ib] - dz2b * dx[ib - 1]));
            } else {
              var cross = dz1Big * dxNextB - BigInt(dz2b) * dxCurB;
              termB = cross < 0n ? -cross : cross;
            }
            var candB = nvB + termB;
            if (bestB === NINF || candB < bestB) { bestB = candB; bestRb = rb; }
          }
          if (bestRb !== 255) {
            curT[stateB] = bestB;
            dec[ib * 256 + stateB] = bestRb;
          }
        }
      }
      nextT = curT;
    }

    var allow0B = allowedMask(prep, anchorIdx, 0);
    var bestTotalB = NINF, bestPb = 255, bestQb = 255;
    var pbitsB = allow0B;
    while (pbitsB) {
      var p0b = ctz(pbitsB); pbitsB &= pbitsB - 1;
      for (var q1b = 0; q1b < prep.klen[1]; q1b++) {
        var valB = nextT[p0b * 16 + q1b];
        if (valB !== NINF && (bestTotalB === NINF || valB < bestTotalB)) {
          bestTotalB = valB; bestPb = p0b; bestQb = q1b;
        }
      }
    }
    if (bestPb === 255) {
      return { ok: false, feasible: false, firstBad: firstBadReading(prep, anchorIdx), elapsedMs: nowMs() - t0 };
    }
    var idxPathB = reconstruct(prep, dec, bestPb, bestQb);
    var zPathB = idxPathB.map(function (qi, ii) { return Z[ii][qi]; });
    return finish(zPathB, idxPathB, bestTotalB, false, t0);
  }

  function reconstruct(prep, dec, p0, q1) {
    var n = prep.n;
    var idx = new Array(n);
    idx[0] = p0;
    idx[1] = q1;
    var p = p0, q = q1;
    for (var i = 1; i <= n - 2; i++) {
      var r = dec[i * 256 + p * 16 + q];
      if (r === 255) throw new Error('DP 重建失败：层 ' + i + ' 状态 ' + p + ',' + q + ' 无决策');
      idx[i + 1] = r;
      p = q;
      q = r;
    }
    return idx;
  }

  function finish(zPath, idxPath, cost, numberSafe, t0) {
    var costText = typeof cost === 'bigint' ? cost.toString() : String(cost);
    return {
      ok: true,
      feasible: true,
      z: zPath,
      zIndices: idxPath,
      cost: cost,
      costText: costText,
      numberSafe: numberSafe,
      elapsedMs: nowMs() - t0
    };
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Number(process.hrtime.bigint() / 1000000n);
  }

  /* ---------------- 输出时间 y 与帧数 ---------------- */

  // y_i = 3 (z_i - z_0) / 16，返回精确分数 {num, den:16}
  function yNumerators(zPath) {
    var z0 = zPath[0];
    return zPath.map(function (z) { return 3 * (z - z0); }); // y = num/16
  }

  // 0 ≤ 整数输出帧 < y_last 的帧数 = ceil(y_last) = ceil(numLast/16)
  function outputFrameCount(zPath) {
    var numLast = 3 * (zPath[zPath.length - 1] - zPath[0]);
    return Math.floor((numLast + 15) / 16);
  }

  // 便捷一站式
  function solveProject(project, anchorsInput) {
    var prep = prepare(project);
    var anchors = anchorsInput === undefined ? project.anchors : anchorsInput;
    var r = resolveAnchors(prep, anchors || {});
    if (r.errors.length) {
      var err = new Error(r.errors[0]);
      err.anchorErrors = r.errors;
      throw err;
    }
    var res = solvePrepared(prep, r.anchorIdx);
    res.anchorIdx = r.anchorIdx;
    return res;
  }

  return {
    MAX_CANDIDATES: MAX_CANDIDATES,
    MAX_K: MAX_K,
    Z_MAX: Z_MAX,
    candidateZs: candidateZs,
    validateProject: validateProject,
    prepare: prepare,
    resolveAnchors: resolveAnchors,
    firstBadReading: firstBadReading,
    solvePrepared: solvePrepared,
    solveProject: solveProject,
    yNumerators: yNumerators,
    outputFrameCount: outputFrameCount,
    ctz: ctz
  };
});
