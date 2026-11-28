/*
 * 子像素点阵打样 —— 核心算法
 *
 * 模型
 *   测例 [a, b, c, w]：半平面 a·x + b·y ≤ c（边界算覆盖），窗口 [0,2]×[0,2]。
 *   点阵：8×8 子格中每行每列各取一点，即一个排列 π（行 r 取列 π[r]）。
 *         偶格（像素原点的 x+y 为偶数）用原点阵；
 *         奇格把局部坐标 (x,y) 变换为 (1−y, x)。
 *   采样：2×2 像素 × 每格 8 点 = 32 点，子格中心为 ((2c+1)/16, (2r+1)/16)。
 *
 * 所有几何量、比例、误差与评分均用 BigInt 有理数精确计算。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FoundryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 大整数有理数 {n, d}，d > 0，始终约分
   * ------------------------------------------------------------------ */

  function babs(x) { return x < 0n ? -x : x; }

  function bgcd(a, b) {
    a = babs(a); b = babs(b);
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  }

  function rat(n, d) {
    if (typeof n !== 'bigint') n = BigInt(n);
    if (d === undefined) d = 1n;
    if (typeof d !== 'bigint') d = BigInt(d);
    if (d === 0n) throw new Error('分母不能为 0');
    if (d < 0n) { n = -n; d = -d; }
    const g = bgcd(n, d);
    if (g > 1n) { n /= g; d /= g; }
    return { n, d };
  }

  const RZERO = rat(0, 1);
  const RONE = rat(1, 1);

  function rAdd(x, y) { return rat(x.n * y.d + y.n * x.d, x.d * y.d); }
  function rSub(x, y) { return rat(x.n * y.d - y.n * x.d, x.d * y.d); }
  function rMul(x, y) { return rat(x.n * y.n, x.d * y.d); }
  function rDiv(x, y) { return rat(x.n * y.d, x.d * y.n); }
  function rNeg(x) { return { n: -x.n, d: x.d }; }
  function rAbs(x) { return x.n < 0n ? { n: -x.n, d: x.d } : x; }
  function rIsZero(x) { return x.n === 0n; }
  function rCmp(x, y) {
    const l = x.n * y.d, r = y.n * x.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  function rNum(x) { return Number(x.n) / Number(x.d); }

  function rToFixed(x, digits) {
    if (digits === undefined) digits = 6;
    const neg = x.n < 0n;
    let n = babs(x.n), d = x.d;
    const scale = 10n ** BigInt(digits);
    let q = (n * scale) / d;
    const rem = (n * scale) % d;
    if (rem * 2n >= d) q += 1n;
    let s = q.toString().padStart(digits + 1, '0');
    if (digits > 0) s = s.slice(0, -digits) + '.' + s.slice(-digits);
    return (neg ? '−' : '') + s;
  }

  function rToString(x) {
    return x.d === 1n ? x.n.toString() : x.n.toString() + '/' + x.d.toString();
  }

  /* ------------------------------------------------------------------ *
   * 1. 精确几何
   * ------------------------------------------------------------------ */

  // 返回窗口 [0,2]² 与半平面 a·x+b·y ≤ c 的交多边形（有理顶点）。
  function clipPolygon(a, b, c) {
    const A = rat(a, 1), B = rat(b, 1), C = rat(c, 1);
    const val = (p) => rSub(rAdd(rMul(A, p.x), rMul(B, p.y)), C);
    const poly = [
      { x: rat(0, 1), y: rat(0, 1) },
      { x: rat(2, 1), y: rat(0, 1) },
      { x: rat(2, 1), y: rat(2, 1) },
      { x: rat(0, 1), y: rat(2, 1) },
    ];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const fp = val(P), fq = val(Q);
      const pin = fp.n <= 0n, qin = fq.n <= 0n;
      if (pin) out.push(P);
      if (pin !== qin) {
        const t = rDiv(fp, rSub(fp, fq));
        out.push({
          x: rAdd(P.x, rMul(t, rSub(Q.x, P.x))),
          y: rAdd(P.y, rMul(t, rSub(Q.y, P.y))),
        });
      }
    }
    return out;
  }

  function polygonArea(poly) {
    if (poly.length < 3) return RZERO;
    let s = RZERO;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      s = rAdd(s, rSub(rMul(p.x, q.y), rMul(q.x, p.y)));
    }
    s = rAbs(s);
    return rat(s.n, s.d * 2n);
  }

  function exactArea(a, b, c) { return polygonArea(clipPolygon(a, b, c)); }

  /* ------------------------------------------------------------------ *
   * 2. 采样点
   *
   * 以 1/16 为单位的整数坐标 (X, Y)，落在 [0,32]。
   * 对基点 (行 r, 列 c)，四个像素中的位置：
   *   (0,0) 偶  X=2c+1,     Y=2r+1
   *   (1,0) 奇  X=31−2r,    Y=2c+1
   *   (0,1) 奇  X=15−2r,    Y=17+2c
   *   (1,1) 偶  X=17+2c,    Y=17+2r
   * 覆盖判据：a·X + b·Y ≤ 16c。
   * ------------------------------------------------------------------ */

  function pointCoords(r, c) {
    return [
      [2 * c + 1, 2 * r + 1],
      [31 - 2 * r, 2 * c + 1],
      [15 - 2 * r, 17 + 2 * c],
      [17 + 2 * c, 17 + 2 * r],
    ];
  }

  function pointCovered(a, b, c, X, Y) { return a * X + b * Y <= 16 * c; }
  function pointOnLine(a, b, c, X, Y) { return a * X + b * Y === 16 * c; }

  // 每个基点 (r,c) 被 4 个像素中的多少个采样点覆盖（0..4）。
  function coverageTable(a, b, c) {
    const tbl = new Int8Array(64); // 索引 r*8+c
    for (let r = 0; r < 8; r++) {
      for (let col = 0; col < 8; col++) {
        let k = 0;
        const pts = pointCoords(r, col);
        for (let p = 0; p < 4; p++) {
          if (pointCovered(a, b, c, pts[p][0], pts[p][1])) k++;
        }
        tbl[r * 8 + col] = k;
      }
    }
    return tbl;
  }

  /* ------------------------------------------------------------------ *
   * 3. 数据集解析与校验
   * ------------------------------------------------------------------ */

  const LIMITS = { tests: 128, ab: 64, c: 256, weight: 32 };

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

  function normalizeTest(item, idx) {
    let a, b, c, w = 1;
    if (Array.isArray(item)) {
      if (item.length < 3) throw new Error(`第 ${idx + 1} 条测例字段不足（需要 a, b, c[, w]）`);
      [a, b, c] = item;
      if (item.length >= 4) w = item[3];
    } else if (item && typeof item === 'object') {
      a = item.a; b = item.b; c = item.c;
      w = item.w === undefined ? 1 : item.w;
    } else {
      throw new Error(`第 ${idx + 1} 条测例格式无效`);
    }
    if (!isInt(a) || !isInt(b) || !isInt(c) || !isInt(w)) {
      throw new Error(`第 ${idx + 1} 条测例的 a、b、c、w 必须为整数`);
    }
    if (Math.abs(a) > LIMITS.ab || Math.abs(b) > LIMITS.ab) {
      throw new Error(`第 ${idx + 1} 条测例的 |a|、|b| 不得超过 ${LIMITS.ab}`);
    }
    if (a === 0 && b === 0) throw new Error(`第 ${idx + 1} 条测例的 a、b 不能同时为 0`);
    if (Math.abs(c) > LIMITS.c) throw new Error(`第 ${idx + 1} 条测例的 |c| 不得超过 ${LIMITS.c}`);
    if (w < 1 || w > LIMITS.weight) {
      throw new Error(`第 ${idx + 1} 条测例的权重必须在 1 到 ${LIMITS.weight} 之间`);
    }
    return { a, b, c, w };
  }

  function normalizeCells(list, name) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error(`${name} 必须是数组`);
    return list.map((cell, i) => {
      if (!Array.isArray(cell) || cell.length !== 2 || !isInt(cell[0]) || !isInt(cell[1])) {
        throw new Error(`${name} 第 ${i + 1} 项必须是 [行, 列] 整数对`);
      }
      const [r, c] = cell;
      if (r < 0 || r > 7 || c < 0 || c > 7) throw new Error(`${name} 第 ${i + 1} 项行列号必须在 0 到 7 之间`);
      return [r, c];
    });
  }

  function dedupeCells(list) {
    const seen = new Set();
    const out = [];
    for (const [r, c] of list) {
      const key = r * 8 + c;
      if (!seen.has(key)) { seen.add(key); out.push([r, c]); }
    }
    return out;
  }

  function parseDataset(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('数据必须是 JSON 对象');
    if (!Array.isArray(raw.tests)) throw new Error('缺少 tests 数组');
    if (raw.tests.length === 0) throw new Error('tests 不能为空');
    if (raw.tests.length > LIMITS.tests) {
      throw new Error(`测例最多 ${LIMITS.tests} 条，当前 ${raw.tests.length} 条`);
    }
    const tests = raw.tests.map(normalizeTest);
    const pins = dedupeCells(normalizeCells(raw.pins, 'pins'));
    const bans = dedupeCells(normalizeCells(raw.bans, 'bans'));
    return { tests, pins, bans };
  }

  /* ------------------------------------------------------------------ *
   * 4. 约束可行性
   * ------------------------------------------------------------------ */

  // 返回 null 表示可行；否则返回冲突说明字符串。
  function checkFeasibility(pins, bans) {
    const pinCol = new Array(8).fill(-1);
    const pinRowOfCol = new Array(8).fill(-1);
    for (const [r, c] of pins) {
      if (pinCol[r] !== -1 && pinCol[r] !== c) {
        return `第 ${r + 1} 行同时锁定了第 ${pinCol[r] + 1} 列和第 ${c + 1} 列`;
      }
      if (pinRowOfCol[c] !== -1 && pinRowOfCol[c] !== r) {
        return `第 ${c + 1} 列同时被第 ${pinRowOfCol[c] + 1} 行和第 ${r + 1} 行锁定`;
      }
      pinCol[r] = c;
      pinRowOfCol[c] = r;
    }
    const banMask = new Array(8).fill(0);
    for (const [r, c] of bans) banMask[r] |= 1 << c;
    for (const [r, c] of bans) {
      if (pinCol[r] === c) return `第 ${r + 1} 行第 ${c + 1} 列同时被锁定和禁用`;
    }
    const freeRows = [];
    const usedCols = new Array(8).fill(false);
    for (let r = 0; r < 8; r++) {
      if (pinCol[r] === -1) freeRows.push(r);
      else usedCols[pinCol[r]] = true;
    }
    const matchRow = new Array(8).fill(-1); // 列 -> 行
    const see = new Array(8).fill(false);

    function tryKuhn(r) {
      for (let c = 0; c < 8; c++) {
        if (usedCols[c] || (banMask[r] & (1 << c)) || see[c]) continue;
        see[c] = true;
        if (matchRow[c] === -1 || tryKuhn(matchRow[c])) {
          matchRow[c] = r;
          return true;
        }
      }
      return false;
    }
    for (const r of freeRows) {
      see.fill(false);
      if (!tryKuhn(r)) return '锁定与禁用约束使点阵无法每行每列各取一点';
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 5. 单条测例分析
   * ------------------------------------------------------------------ */

  function analyzeTest(t) {
    const area = exactArea(t.a, t.b, t.c); // {n,d}
    const trueRatio = rat(area.n, area.d * 4n); // area/4
    const errN = new Array(33);
    const errD = new Array(33);
    for (let k = 0; k <= 32; k++) {
      // |k/32 − area/4| = |k·d − 8n| / (32d)
      errN[k] = babs(area.d * BigInt(k) - 8n * area.n);
      errD[k] = 32n * area.d;
    }
    return {
      a: t.a, b: t.b, c: t.c, w: t.w,
      area,
      trueRatio,
      cnt: coverageTable(t.a, t.b, t.c),
      errN,
      errD,
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. 求解：先最小化最大绝对误差，再最小化加权误差和，
   *    同价取按行、列号字典序最小的点阵。
   * ------------------------------------------------------------------ */

  function nextPermutation(a) {
    let i = a.length - 2;
    while (i >= 0 && a[i] >= a[i + 1]) i--;
    if (i < 0) return false;
    let j = a.length - 1;
    while (a[j] <= a[i]) j--;
    const t = a[i]; a[i] = a[j]; a[j] = t;
    for (let l = i + 1, r = a.length - 1; l < r; l++, r--) {
      const s = a[l]; a[l] = a[r]; a[r] = s;
    }
    return true;
  }

  function makeMaskTables(pins, bans) {
    const pinCol = new Int8Array(8).fill(-1);
    for (const [r, c] of pins) pinCol[r] = c;
    const banMask = new Int8Array(8);
    for (const [r, c] of bans) banMask[r] |= 1 << c;
    return { pinCol, banMask };
  }

  function permutationAllowed(perm, pinCol, banMask) {
    for (let r = 0; r < 8; r++) {
      const c = perm[r];
      if (pinCol[r] !== -1 && c !== pinCol[r]) return false;
      if (banMask[r] & (1 << c)) return false;
    }
    return true;
  }

  function solve(dataset, options) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const conflict = checkFeasibility(dataset.pins || [], dataset.bans || []);
    if (conflict) {
      return { ok: false, reason: conflict, elapsedMs: 0 };
    }
    const tests = dataset.tests;
    const models = tests.map(analyzeTest);
    const T = tests.length;

    // 误差排名：把所有 (测例, k) 的误差有理数放在一起精确排序。
    const keyToIdx = new Map();
    const vals = [];
    const rawRank = models.map((m) => {
      const tbl = new Int32Array(33);
      for (let k = 0; k <= 32; k++) {
        const key = m.errN[k].toString() + '/' + m.errD[k].toString();
        let idx = keyToIdx.get(key);
        if (idx === undefined) {
          idx = vals.length;
          keyToIdx.set(key, idx);
          vals.push({ n: m.errN[k], d: m.errD[k] });
        }
        tbl[k] = idx;
      }
      return tbl;
    });
    const order = vals.map((_, i) => i).sort((x, y) => rCmp(vals[x], vals[y]));
    const rankOf = new Int32Array(vals.length);
    for (let pos = 0; pos < order.length; pos++) rankOf[order[pos]] = pos;
    const rankTables = rawRank.map((tbl) => {
      const out = new Int32Array(33);
      for (let k = 0; k <= 32; k++) out[k] = rankOf[tbl[k]];
      return out;
    });

    const { pinCol, banMask } = makeMaskTables(dataset.pins || [], dataset.bans || []);
    const cnts = models.map((m) => m.cnt);

    let bestMax = Infinity;
    let bestSumN = 0n, bestSumD = 1n;
    let bestPerm = null;
    let feasibleCount = 0;
    let evaluated = 0;

    const perm = [0, 1, 2, 3, 4, 5, 6, 7];
    const ks = new Int32Array(T);
    const sumCache = new Map();

    function weightedSumExact(ksArr) {
      let key = '';
      for (let i = 0; i < T; i++) key += String.fromCharCode(ksArr[i]);
      const hit = sumCache.get(key);
      if (hit !== undefined) return hit;
      let sn = 0n, sd = 1n;
      for (let i = 0; i < T; i++) {
        const k = ksArr[i];
        const ni = BigInt(models[i].w) * models[i].errN[k];
        const di = models[i].errD[k];
        if (ni === 0n) continue;
        // sn/sd + ni/di，每一步都约分
        let a = sn, b = sd;
        const g1 = b === 0n ? 1n : bgcd(a, b);
        if (g1 > 1n) { a /= g1; b /= g1; }
        let n2 = a * di + ni * b;
        let d2 = b * di;
        const g2 = n2 === 0n ? 1n : bgcd(n2, d2);
        if (g2 > 1n) { n2 /= g2; d2 /= g2; }
        sn = n2; sd = d2;
      }
      if (sn === 0n) sd = 1n;
      const out = { n: sn, d: sd };
      sumCache.set(key, out);
      return out;
    }

    do {
      if (!permutationAllowed(perm, pinCol, banMask)) continue;
      feasibleCount++;

      let maxRank = -1;
      let pruned = false;
      for (let i = 0; i < T; i++) {
        const ci = cnts[i];
        const k = ci[perm[0]] + ci[8 + perm[1]] + ci[16 + perm[2]] + ci[24 + perm[3]] +
                  ci[32 + perm[4]] + ci[40 + perm[5]] + ci[48 + perm[6]] + ci[56 + perm[7]];
        ks[i] = k;
        const rk = rankTables[i][k];
        if (rk > maxRank) {
          maxRank = rk;
          if (maxRank > bestMax) { pruned = true; break; }
        }
      }
      if (pruned) continue;
      evaluated++;

      let better = maxRank < bestMax;
      if (!better && maxRank === bestMax) {
        const s = weightedSumExact(ks);
        const cmp = rCmp({ n: s.n, d: s.d }, { n: bestSumN, d: bestSumD });
        if (cmp < 0) better = true;
      }
      if (better) {
        bestMax = maxRank;
        const s = weightedSumExact(ks);
        bestSumN = s.n; bestSumD = s.d;
        bestPerm = perm.slice();
      }
    } while (nextPermutation(perm));

    const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;

    if (!bestPerm) {
      return { ok: false, reason: '约束冲突：没有任何点阵能满足锁定与禁用', elapsedMs };
    }

    const details = describePermutation(dataset, bestPerm);
    const maxErrRaw = bestMax === Infinity ? RZERO : vals[order[bestMax]];
    const maxErr = rat(maxErrRaw.n, maxErrRaw.d);
    return {
      ok: true,
      perm: bestPerm,
      maxError: maxErr,
      weightedSum: { n: bestSumN, d: bestSumD },
      details,
      elapsedMs,
      feasibleCount,
      evaluated,
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. 给定点阵的描述（用于展示与导出）
   * ------------------------------------------------------------------ */

  function describePermutation(dataset, perm) {
    const tests = dataset.tests;
    let maxN = 0n, maxD = 1n;
    let sumN = 0n, sumD = 1n;
    const rows = [];
    for (let i = 0; i < tests.length; i++) {
      const m = analyzeTest(tests[i]);
      let k = 0;
      for (let r = 0; r < 8; r++) k += m.cnt[r * 8 + perm[r]];
      const eN = m.errN[k], eD = m.errD[k];
      const err = rat(eN, eD);
      rows.push({
        index: i,
        a: tests[i].a, b: tests[i].b, c: tests[i].c, w: tests[i].w,
        covered: k,
        sampleRatio: rat(k, 32),
        trueRatio: m.trueRatio,
        error: err,
      });
      if (rCmp(err, { n: maxN, d: maxD }) > 0) { maxN = err.n; maxD = err.d; }
      if (err.n !== 0n) {
        const wn = BigInt(tests[i].w) * err.n;
        let a = sumN, b = sumD;
        const g1 = b === 0n ? 1n : bgcd(a, b);
        if (g1 > 1n) { a /= g1; b /= g1; }
        let n2 = a * err.d + wn * b;
        let d2 = b * err.d;
        const g2 = n2 === 0n ? 1n : bgcd(n2, d2);
        if (g2 > 1n) { n2 /= g2; d2 /= g2; }
        sumN = n2; sumD = d2;
      }
    }
    if (sumN === 0n) sumD = 1n;
    return { perm, rows, maxError: { n: maxN, d: maxD }, weightedSum: { n: sumN, d: sumD } };
  }

  // 给定排列的每像素采样点覆盖情况（用于可视化）
  function samplePointsForTest(test, perm) {
    const pts = [];
    for (let r = 0; r < 8; r++) {
      const c = perm[r];
      const coords = pointCoords(r, c);
      const names = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (let p = 0; p < 4; p++) {
        const X = coords[p][0], Y = coords[p][1];
        pts.push({
          row: r, col: c,
          X, Y,
          x: X / 16, y: Y / 16,
          covered: pointCovered(test.a, test.b, test.c, X, Y),
          onLine: pointOnLine(test.a, test.b, test.c, X, Y),
          pixel: names[p],
        });
      }
    }
    return pts;
  }

  function defaultPermutation() { return [0, 1, 2, 3, 4, 5, 6, 7]; }

  return {
    // rational
    rat, rAdd, rSub, rMul, rDiv, rCmp, rNeg, rAbs, rIsZero, rNum, rToFixed, rToString,
    // geometry
    clipPolygon, polygonArea, exactArea,
    // sampling
    pointCoords, pointCovered, pointOnLine, coverageTable, samplePointsForTest,
    // data
    parseDataset, checkFeasibility, LIMITS,
    // solve
    analyzeTest, solve, describePermutation, defaultPermutation,
    // misc
    SAMPLE_DEN: 32n,
  };
});
