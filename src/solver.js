/* paper-grid-evidence — 精确矩形铺排求解器
 *
 * 输入为 R 行 C 列基础网格（R ≤ 24，C ≤ 8）上每条内部短边的两种代价：
 *   keep = 保留该短边（两侧属于不同矩形）的代价
 *   remove = 去掉该短边（两侧并入同一矩形）的代价
 *
 * 目标是：每个基础格恰属于一个矩形；矩形内部短边全部去掉，矩形之间短边全部保留。
 * 按 (总损失, 矩形数, 按上/左/下/右排序的半开矩形列表) 字典序取全表最优。
 *
 * 算法：自研的逐行轮廓动态规划（skyline DP），不使用任何现成铺排器或优化器。
 *   状态 = 当前行结束时的列分区（哪些相邻列仍属于同一个尚未结束的矩形）。
 *   转移 = 由上一行分区 P 与下一行分区 Q 构造：Q 中与 P 相同跨度的块可以选择继续
 *          （该块对应的矩形向下延伸），其余块必须新开矩形。每个 Q 至多 2^(C-1) 个
 *          状态、至多 2^(C-1) 种合并选择，C ≤ 8 时每行转移有限且可枚举。
 *   最优性：任何矩形铺排都可唯一地表示为这样一串逐行转移；反之每串转移都对应
 *          一个合法铺排，因此 DP 覆盖全部候选。每个状态只保留字典序最优的前缀解，
 *          因为后续追加的矩形都不影响已创建前缀的排序位置与比较结果。
 *
 * 该实现同时提供浏览器全局 globalThis.GridSolver 与 CommonJS 导出。
 */
(function (root) {
  'use strict';

  var OPEN = 255; // 未结束矩形的底边哨兵，必须大于最大行数 24

  function popcount(x) {
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  // 把列边界掩码拆成若干 [l, r) 块。
  // 位 c-1 置位表示第 c-1 列与第 c 列之间保留竖线，即这是两个矩形的分界。
  function blocksOf(mask, C) {
    var out = [], l = 0, c;
    for (c = 1; c < C; c++) {
      if (mask & (1 << (c - 1))) { out.push([l, c]); l = c; }
    }
    out.push([l, C]);
    return out;
  }

  var META = new Map();
  function getMeta(C) {
    if (META.has(C)) return META.get(C);
    var nmask = 1 << (C - 1);
    var blocks = new Array(nmask);
    var spans = new Array(nmask);
    var pairs = new Array(nmask);
    for (var m = 0; m < nmask; m++) {
      var b = blocksOf(m, C);
      blocks[m] = b;
      var sp = new Int32Array(b.length);
      for (var i = 0; i < b.length; i++) {
        var sm = 0;
        for (var c = b[i][0]; c < b[i][1]; c++) sm |= (1 << c);
        sp[i] = sm;
      }
      spans[m] = sp;
    }
    // pairs[P][Q]：Q 的哪些块与 P 的某块跨度完全相同（可继续延伸），按 Q 块序号置位。
    for (var P = 0; P < nmask; P++) {
      var set = new Map();
      for (var k = 0; k < blocks[P].length; k++) set.set(blocks[P][k][0], blocks[P][k][1]);
      var row = new Int32Array(nmask);
      for (var Q = 0; Q < nmask; Q++) {
        var mm = 0, qb = blocks[Q];
        for (var j = 0; j < qb.length; j++) {
          if (set.get(qb[j][0]) === qb[j][1]) mm |= (1 << j);
        }
        row[Q] = mm;
      }
      pairs[P] = row;
    }
    var meta = { nmask: nmask, blocks: blocks, spans: spans, pairs: pairs };
    META.set(C, meta);
    return meta;
  }

  // 比较两个“创建顺序”矩形列表（每项 4 个整数：上、左、下、右；未结束的底边为 OPEN）。
  // 创建顺序与按 (上, 左) 排序一致：同一行内自左向右创建，跨行自上而下创建。
  // 若一个列表是另一个的真前缀，则较长者更小：其多出的矩形顶边必小于对方后续矩形。
  function cmpLists(A, B) {
    var n = Math.min(A.length, B.length);
    for (var i = 0; i < n; i += 4) {
      for (var k = 0; k < 4; k++) {
        var a = A[i + k], b = B[i + k];
        if (a !== b) return a < b ? -1 : 1;
      }
    }
    if (A.length === B.length) return 0;
    return A.length > B.length ? -1 : 1;
  }

  function fail(reason, detail) {
    return { feasible: false, reason: reason, detail: detail || '' };
  }

  function solve(spec) {
    var R = spec.R | 0, C = spec.C | 0;
    if (R < 1 || C < 1) throw new RangeError('网格行列数必须为正');
    if (R < 1 || R > 24 || C > 8) throw new RangeError('基础网格最多 24 行 8 列');
    var vKeep = spec.vKeep, vRem = spec.vRem, hKeep = spec.hKeep, hRem = spec.hRem;
    var vLen = R * (C - 1), hLen = (R - 1) * C;
    if (!vKeep || vKeep.length !== vLen || vRem.length !== vLen ||
        (hLen > 0 && (!hKeep || hKeep.length !== hLen || hRem.length !== hLen))) {
      throw new TypeError('代价数组长度与网格不匹配');
    }

    var meta = getMeta(C);
    var nmask = meta.nmask, blocks = meta.blocks, spans = meta.spans, pairs = meta.pairs;
    var C1 = C - 1;
    var allV = (1 << C1) - 1;

    // 锁定：竖边按列位（0..C-2）记，横边按列位（0..C-1）记。
    var vKeepMask = new Int32Array(R), vRemMask = new Int32Array(R);
    var hKeepMask = new Int32Array(R), hRemMask = new Int32Array(R);
    var locks = spec.locks || [];
    for (var li = 0; li < locks.length; li++) {
      var L = locks[li];
      if (L.axis === 'v') {
        if (!(L.row >= 0 && L.row < R && L.col >= 1 && L.col < C)) return fail('lock-out-of-range');
        if (L.keep) vKeepMask[L.row] |= 1 << (L.col - 1);
        else vRemMask[L.row] |= 1 << (L.col - 1);
      } else if (L.axis === 'h') {
        if (!(L.row >= 1 && L.row < R && L.col >= 0 && L.col < C)) return fail('lock-out-of-range');
        if (L.keep) hKeepMask[L.row] |= 1 << L.col;
        else hRemMask[L.row] |= 1 << L.col;
      } else {
        return fail('lock-out-of-range');
      }
    }
    for (var r0 = 0; r0 < R; r0++) {
      if ((vKeepMask[r0] & vRemMask[r0]) !== 0) return fail('lock-conflict', '同一短边同时锁定保留与去掉');
    }
    for (var r1 = 0; r1 < R; r1++) {
      if ((hKeepMask[r1] & hRemMask[r1]) !== 0) return fail('lock-conflict', '同一短边同时锁定保留与去掉');
    }

    var forced = spec.force || null;
    if (forced) {
      if (forced.axis === 'v') {
        if (!(forced.row >= 0 && forced.row < R && forced.col >= 1 && forced.col < C)) return fail('force-out-of-range');
        var vb = 1 << (forced.col - 1);
        if (forced.keep) { if (vRemMask[forced.row] & vb) return fail('force-conflict'); vKeepMask[forced.row] |= vb; }
        else { if (vKeepMask[forced.row] & vb) return fail('force-conflict'); vRemMask[forced.row] |= vb; }
      } else if (forced.axis === 'h') {
        if (!(forced.row >= 1 && forced.row < R && forced.col >= 0 && forced.col < C)) return fail('force-out-of-range');
        var hb = 1 << forced.col;
        if (forced.keep) { if (hRemMask[forced.row] & hb) return fail('force-conflict'); hKeepMask[forced.row] |= hb; }
        else { if (hKeepMask[forced.row] & hb) return fail('force-conflict'); hRemMask[forced.row] |= hb; }
      } else {
        return fail('force-out-of-range');
      }
    }

    // 每行预计算：竖边代价、是否与竖边锁定相容；横边按 Q 块聚合的保留和与去线增量。
    var rowInfo = new Array(R);
    for (var r2 = 0; r2 < R; r2++) {
      var vc = new Float64Array(nmask);
      var vok = new Uint8Array(nmask);
      for (var Q2 = 0; Q2 < nmask; Q2++) {
        if ((Q2 & vRemMask[r2]) !== 0) continue;
        if ((~Q2 & vKeepMask[r2] & allV) !== 0) continue;
        var cost = 0;
        for (var c2 = 1; c2 < C; c2++) {
          cost += (Q2 & (1 << (c2 - 1))) ? vKeep[r2 * C1 + (c2 - 1)] : vRem[r2 * C1 + (c2 - 1)];
        }
        vc[Q2] = cost;
        vok[Q2] = 1;
      }
      var info = { vcost: vc, vok: vok, h: null };
      if (r2 >= 1) {
        var hkSum = new Float64Array(nmask);
        var hOk = new Uint8Array(nmask);
        var deltas = new Array(nmask);
        var subSums = new Array(nmask);
        var fRem = new Int32Array(nmask);
        var fKeep = new Int32Array(nmask);
        var hr = hRemMask[r2], hk = hKeepMask[r2];
        for (var Q3 = 0; Q3 < nmask; Q3++) {
          if (!vok[Q3]) continue;
          var qb = blocks[Q3], nb = qb.length, ok = true, keepSum = 0;
          var del = new Float64Array(nb);
          var remBits = 0, keepBits = 0;
          for (var j = 0; j < nb; j++) {
            var span = spans[Q3][j];
            var a = qb[j][0], b = qb[j][1];
            var hasRem = (hr & span) !== 0, hasKeep = (hk & span) !== 0;
            if (hasRem && hasKeep) { ok = false; break; }
            if (hasRem) remBits |= 1 << j;
            if (hasKeep) keepBits |= 1 << j;
            var ks = 0, ds = 0;
            for (var cc = a; cc < b; cc++) {
              var hi = (r2 - 1) * C + cc;
              ks += hKeep[hi];
              ds += hRem[hi] - hKeep[hi];
            }
            keepSum += ks;
            del[j] = ds;
          }
          if (!ok) continue;
          hOk[Q3] = 1;
          hkSum[Q3] = keepSum;
          deltas[Q3] = del;
          fRem[Q3] = remBits;
          fKeep[Q3] = keepBits;
          var sums = new Float64Array(1 << nb);
          for (var s = 1; s < (1 << nb); s++) {
            var low = s & -s;
            var bi = 31 - Math.clz32(low);
            sums[s] = sums[s ^ low] + del[bi];
          }
          subSums[Q3] = sums;
        }
        info.h = {
          keepSum: hkSum, ok: hOk, deltas: deltas, subSums: subSums,
          forcedRem: fRem, forcedKeep: fKeep
        };
      }
      rowInfo[r2] = info;
    }

    // DP 主循环。dpList 按创建顺序存 4×n 整数；dpOpen[块序号] 指向该块对应矩形在列表中的下标。
    var dpLoss = new Float64Array(nmask);
    var dpCount = new Int32Array(nmask);
    var dpList = new Array(nmask);
    var dpOpen = new Array(nmask);
    var dpAlive = new Uint8Array(nmask);
    var any = false;
    for (var Q0 = 0; Q0 < nmask; Q0++) {
      if (!rowInfo[0].vok[Q0]) continue;
      var b0 = blocks[Q0], n0 = b0.length;
      var list0 = new Int32Array(n0 * 4);
      var open0 = new Int32Array(n0);
      for (var j0 = 0; j0 < n0; j0++) {
        list0[j0 * 4] = 0; list0[j0 * 4 + 1] = b0[j0][0];
        list0[j0 * 4 + 2] = OPEN; list0[j0 * 4 + 3] = b0[j0][1];
        open0[j0] = j0;
      }
      dpLoss[Q0] = rowInfo[0].vcost[Q0];
      dpCount[Q0] = n0;
      dpList[Q0] = list0;
      dpOpen[Q0] = open0;
      dpAlive[Q0] = 1;
      any = true;
    }
    if (!any) return fail('no-tiling');

    for (var r = 1; r < R; r++) {
      var info2 = rowInfo[r], h = info2.h;
      var nLoss = new Float64Array(nmask), nCount = new Int32Array(nmask);
      var nList = new Array(nmask), nOpen = new Array(nmask);
      var nAlive = new Uint8Array(nmask);
      for (var P = 0; P < nmask; P++) {
        if (!dpAlive[P]) continue;
        var ploss = dpLoss[P], pcount = dpCount[P], plist = dpList[P], popen = dpOpen[P];
        var pblocks = blocks[P], pairRow = pairs[P];
        for (var Qd = 0; Qd < nmask; Qd++) {
          if (!h.ok[Qd]) continue;
          var mm = pairRow[Qd];
          var fR = h.forcedRem[Qd], fK = h.forcedKeep[Qd];
          if ((fR & ~mm) !== 0) continue; // 被锁定为去掉，但两侧矩形无法合并
          var opt = mm & ~fR & ~fK;        // 可选继续的块
          var nb = blocks[Qd].length;
          var base = ploss + info2.vcost[Qd] + h.keepSum[Qd] + h.subSums[Qd][fR];
          var sub = opt;
          while (true) {
            var merged = fR | sub;
            var candLoss = base + (sub ? h.subSums[Qd][sub] : 0);
            var candCount = pcount + nb - popcount(merged);
            var better = false;
            if (!nAlive[Qd]) better = true;
            else if (candLoss < nLoss[Qd]) better = true;
            else if (candLoss === nLoss[Qd]) {
              if (candCount < nCount[Qd]) better = true;
              else if (candCount === nCount[Qd]) {
                if (cmpLists(build(plist, popen, pblocks, blocks[Qd], merged, r).list, nList[Qd]) < 0) better = true;
              }
            }
            if (better) {
              var built = build(plist, popen, pblocks, blocks[Qd], merged, r);
              nLoss[Qd] = candLoss; nCount[Qd] = candCount;
              nList[Qd] = built.list; nOpen[Qd] = built.open;
              nAlive[Qd] = 1;
            }
            if (sub === 0) break;
            sub = (sub - 1) & opt;
          }
        }
      }
      dpLoss = nLoss; dpCount = nCount; dpList = nList; dpOpen = nOpen; dpAlive = nAlive;
      var any2 = false;
      for (var z = 0; z < nmask; z++) if (dpAlive[z]) { any2 = true; break; }
      if (!any2) return fail('no-tiling');
    }

    // 收尾：把未结束矩形的底边补成 R，再按字典序取最优。
    var bestLoss = Infinity, bestCount = Infinity, bestList = null;
    for (var Qf = 0; Qf < nmask; Qf++) {
      if (!dpAlive[Qf]) continue;
      var fin = new Int32Array(dpList[Qf].length);
      fin.set(dpList[Qf]);
      var op = dpOpen[Qf];
      for (var oi = 0; oi < op.length; oi++) fin[op[oi] * 4 + 2] = R;
      var L2 = dpLoss[Qf], C2 = dpCount[Qf];
      var win = false;
      if (L2 < bestLoss) win = true;
      else if (L2 === bestLoss) {
        if (C2 < bestCount) win = true;
        else if (C2 === bestCount && cmpLists(fin, bestList) < 0) win = true;
      }
      if (win) { bestLoss = L2; bestCount = C2; bestList = fin; }
    }
    if (!bestList) return fail('no-tiling');

    var rects = [];
    for (var i2 = 0; i2 < bestList.length; i2 += 4) {
      rects.push([bestList[i2], bestList[i2 + 1], bestList[i2 + 2], bestList[i2 + 3]]);
    }
    rects.sort(function (a, b) {
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
    });
    return { feasible: true, loss: bestLoss, count: bestCount, rects: rects };

    // 由 P 行状态与 Q 行合并结果构造新列表（关闭不再继续的矩形，追加新矩形）。
    function build(plist, popen, pblocks, qblocks, merged, row) {
      var qn = qblocks.length;
      var mapP = new Int32Array(qn).fill(-1);
      var newBlocks = 0;
      for (var j = 0; j < qn; j++) {
        if ((merged >> j) & 1) {
          for (var k = 0; k < pblocks.length; k++) {
            if (pblocks[k][0] === qblocks[j][0] && pblocks[k][1] === qblocks[j][1]) { mapP[j] = k; break; }
          }
        } else {
          newBlocks++;
        }
      }
      var list = new Int32Array(plist.length + newBlocks * 4);
      list.set(plist);
      var open = new Int32Array(qn);
      for (var pi = 0; pi < pblocks.length; pi++) {
        var cont = false;
        for (var j2 = 0; j2 < qn; j2++) if (((merged >> j2) & 1) && mapP[j2] === pi) { cont = true; break; }
        if (!cont) list[popen[pi] * 4 + 2] = row;
      }
      var pos = plist.length;
      for (var j3 = 0; j3 < qn; j3++) {
        if ((merged >> j3) & 1) {
          open[j3] = popen[mapP[j3]];
        } else {
          list[pos] = row;
          list[pos + 1] = qblocks[j3][0];
          list[pos + 2] = OPEN;
          list[pos + 3] = qblocks[j3][1];
          open[j3] = pos >> 2;
          pos += 4;
        }
      }
      return { list: list, open: open };
    }
  }

  // 由矩形列表推出每条内部短边的决定（1 = 保留，0 = 去掉）。
  function decisionsFromRects(R, C, rects) {
    var owner = new Int16Array(R * C).fill(-1);
    for (var i = 0; i < rects.length; i++) {
      var rc = rects[i];
      for (var y = rc[0]; y < rc[2]; y++) {
        for (var x = rc[1]; x < rc[3]; x++) owner[y * C + x] = i;
      }
    }
    var v = new Uint8Array(R * Math.max(0, C - 1));
    var h = new Uint8Array(Math.max(0, R - 1) * C);
    for (var r = 0; r < R; r++) {
      for (var c = 1; c < C; c++) {
        v[r * (C - 1) + (c - 1)] = owner[r * C + c - 1] === owner[r * C + c] ? 0 : 1;
      }
    }
    for (var r2 = 1; r2 < R; r2++) {
      for (var c2 = 0; c2 < C; c2++) {
        h[(r2 - 1) * C + c2] = owner[(r2 - 1) * C + c2] === owner[r2 * C + c2] ? 0 : 1;
      }
    }
    return { v: v, h: h, owner: owner };
  }

  var GridSolver = {
    solve: solve,
    cmpLists: cmpLists,
    blocksOf: blocksOf,
    decisionsFromRects: decisionsFromRects
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GridSolver;
  root.GridSolver = GridSolver;
})(typeof globalThis !== 'undefined' ? globalThis : this);
