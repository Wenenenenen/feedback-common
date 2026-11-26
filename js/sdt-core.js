/*
 * sdt-core.js — 精确平方欧氏距离变换核心（无第三方依赖）
 *
 * 距离定义：
 *   格 (c,r) 与种子 (sc,sr) 的整数坐标差 dx=|c-sc|, dy=|r-sr|
 *   环绕时各轴独立取最短：dx=min(dx,W-dx)，dy 同理
 *   d2 = (dx*sx)^2 + (dy*sy)^2   —— 全部为精确整数
 *
 * 算法：每个标签独立做两遍一维广义距离变换（FH 抛物线包络，权重 a=间距²）。
 *   环绕用 FH 倍增域：站点复制到 q+L，对 p 与 p+L 两个求值位置折叠取最小。
 *   源种子身份（原始行列）随包络传递，破并列键：
 *     (d2 升序, 标签升序, 源行升序, 源列升序)
 *
 * 同一套代码可运行在浏览器主线程、Web Worker(importScripts) 与 Node 中。
 */
(function (global) {
  'use strict';

  const INF = 0xffffffff; // 2^32-1，本问题最大 d2 约 2.15e9，远小于此值

  // ---------------------------------------------------------------------------
  // 一维广义距离变换（带源点身份）
  //
  // 站点按位置递增：sitePos / siteF / siteSR / siteSC（长度 ns）
  // 求 D[p] = min_i (f_i + a*(p-q_i)^2)，p ∈ [0,n)。
  // 环绕由调用方构造 2L 倍增域（站点 q 与 q+L，位置单调），再折叠两个求值位置。
  // ---------------------------------------------------------------------------
  function envelope1d(n, sitePos, siteF, siteSR, siteSC, ns, a,
                      outD, outSR, outSC, scratch) {
    const v = scratch.v;
    // 快路径全程浮点交点 z，不分配 BigInt。仅当新交点与栈顶交点浮点差极小
    //（疑似整数并列）时，才从原始站点现场用 BigInt 精确裁决。
    const z = scratch.z;
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    const twoA = 2 * a;

    const srcLess = (ia, ib) =>
      siteSR[ia] < siteSR[ib] ||
      (siteSR[ia] === siteSR[ib] && siteSC[ia] < siteSC[ib]);

    // 站点 i 与 j 的交点精确分数 [分子, 分母]（BigInt，分母归一化为正）
    const frac = (i, j) => {
      const q = sitePos[i], qj = sitePos[j];
      let num = BigInt((siteF[i] + a * q * q) - (siteF[j] + a * qj * qj));
      let den = BigInt(twoA * (q - qj));
      if (den < 0n) { num = -num; den = -den; }
      return [num, den];
    };
    const cmpFrac = (n1, d1, n2, d2) => {
      const lhs = n1 * d2, rhs = n2 * d1;
      return lhs < rhs ? -1 : (lhs === rhs ? 0 : 1);
    };

    for (let qi = 1; qi < ns; qi++) {
      const q = sitePos[qi];
      let vi = v[k];
      let qv = sitePos[vi];
      let numI = (siteF[qi] + a * q * q) - (siteF[vi] + a * qv * qv);
      let denI = twoA * (q - qv);
      if (denI < 0) { numI = -numI; denI = -denI; }
      let s = numI / denI;
      // 浮点快弹：明显更靠左直接弹
      while (s < z[k] - 1e-6) {
        k--;
        vi = v[k];
        qv = sitePos[vi];
        numI = (siteF[qi] + a * q * q) - (siteF[vi] + a * qv * qv);
        denI = twoA * (q - qv);
        if (denI < 0) { numI = -numI; denI = -denI; }
        s = numI / denI;
      }
      // 灰区（疑似相等）：BigInt 精确裁决，仅稀疏/边界并列时偶发。
      // 新交点 sNew = inter(qi, v[k])，栈顶交点 z[k] = inter(v[k], v[k-1])。
      while (k > 0 && isFinite(z[k]) && Math.abs(s - z[k]) <= 1e-6) {
        const [nn, nd] = frac(qi, v[k]);
        const [pn, pd] = frac(v[k], v[k - 1]);
        const cmp = cmpFrac(nn, nd, pn, pd);
        if (cmp > 0) break;                    // 新交点更靠右，入栈
        if (cmp < 0) k--;                      // 更靠左，弹栈顶
        else if (srcLess(qi, v[k])) k--;       // 等交点保留身份更小者
        else break;
        vi = v[k]; qv = sitePos[vi];
        numI = (siteF[qi] + a * q * q) - (siteF[vi] + a * qv * qv);
        denI = twoA * (q - qv);
        if (denI < 0) { numI = -numI; denI = -denI; }
        s = numI / denI;
      }
      k++;
      v[k] = qi;
      z[k] = s;
      z[k + 1] = Infinity;
    }

    // 求值。两种精确策略，按站点数选择：
    //  - 浅栈（稀疏种子，ns 含倍增副本仍很短）：全栈逐段精确整数取最小，
    //    正确处理被隔开的等代价并列，O(n·k) 稀疏时可接受；
    //  - 深栈（密集种子）：经典 FH 单调游标 O(n) 推进，邻段精确整数复核兜底并列。
    //    密集时站点间距小，环绕镜像距离 ≥L/2，不会产生被隔开的等代价并列。
    const cost = (idx, p) => {
      const d = p - sitePos[idx];
      return siteF[idx] + a * d * d;
    };
    const EXACT_SCAN_LIMIT = 96; // 按原始（去镜像）站点数计
    if (ns <= EXACT_SCAN_LIMIT) {
      for (let p = 0; p < n; p++) {
        let bi = v[0];
        let bd = cost(bi, p);
        let br = siteSR[bi], bc = siteSC[bi];
        for (let ii = 1; ii <= k; ii++) {
          const idx = v[ii];
          const cd = cost(idx, p);
          if (cd < bd || (cd === bd &&
              (siteSR[idx] < br ||
               (siteSR[idx] === br && siteSC[idx] < bc)))) {
            bd = cd; br = siteSR[idx]; bc = siteSC[idx];
          }
        }
        outD[p] = bd;
        outSR[p] = br;
        outSC[p] = bc;
      }
      return;
    }
    // 深栈：单调游标，随 p 递增只往前走
    let ki = 0;
    for (let p = 0; p < n; p++) {
      while (ki < k && cost(v[ki + 1], p) <= cost(v[ki], p)) ki++;
      let bi = v[ki];
      let bd = cost(bi, p);
      let br = siteSR[bi], bc = siteSC[bi];
      const take = (idx) => {
        const cd = cost(idx, p);
        if (cd < bd || (cd === bd &&
            (siteSR[idx] < br ||
             (siteSR[idx] === br && siteSC[idx] < bc)))) {
          bd = cd; br = siteSR[idx]; bc = siteSC[idx];
        }
      };
      if (ki > 0) take(v[ki - 1]);
      if (ki < k) take(v[ki + 1]);
      outD[p] = bd;
      outSR[p] = br;
      outSC[p] = bc;
    }
  }

  function makeScratch(W, H) {
    // 环绕用 FH 倍增域：站点复制到 q+L，长度 2L
    const m2 = 2 * Math.max(W, H) + 2;
    return {
      v: new Int32Array(m2),
      z: new Float64Array(m2 + 1),
      sitePos: new Int32Array(m2),
      siteF: new Uint32Array(m2),
      siteSR: new Int32Array(m2),
      siteSC: new Int32Array(m2),
      colPos: new Int32Array(m2),
      colF: new Uint32Array(m2),
      colSR: new Int32Array(m2),
      colSC: new Int32Array(m2),
      tmpXD: new Uint32Array(2 * W),
      tmpXR: new Int32Array(2 * W),
      tmpXC: new Int32Array(2 * W),
      tmpD: new Uint32Array(2 * H),
      tmpR: new Int32Array(2 * H),
      tmpC: new Int32Array(2 * H),
    };
  }

  function makeBuffers(W, H) {
    const n = W * H;
    return {
      d2: new Uint32Array(n),
      sr: new Int32Array(n),
      sc: new Int32Array(n),
    };
  }

  // ---------------------------------------------------------------------------
  // 单个标签的二维 SDT
  // coords: Int32Array 长度 2*cnt，[col0,row0,col1,row1,...]
  // 输出 buf: { d2:Uint32(WH), sr:Int32(WH), sc:Int32(WH) }（调用方复用）
  // ---------------------------------------------------------------------------
  // 在 2L 倍增域的两个求值结果 (p 与 p+L) 间折叠，按 (d2, 源行, 源列) 取优。
  // 倍增域站点为 q 与 q+L（同身份），两位置取最小即周期最短距离。
  function fold2(L, tD, tR, tC, outD, outR, outC) {
    for (let p = 0; p < L; p++) {
      const aD = tD[p], bD = tD[p + L];
      if (bD < aD ||
          (bD === aD &&
           (tR[p + L] < tR[p] ||
            (tR[p + L] === tR[p] && tC[p + L] < tC[p])))) {
        outD[p] = bD; outR[p] = tR[p + L]; outC[p] = tC[p + L];
      } else {
        outD[p] = aD; outR[p] = tR[p]; outC[p] = tC[p];
      }
    }
  }

  function sdtLabel(W, H, coords, cnt, sx, sy, wrap, buf, scratch) {
    const { d2, sr, sc } = buf;
    const ax = sx * sx;
    const ay = sy * sy;

    // 按行整理该标签种子，每行内按列排序（保证站点位置单调）
    const rowCols = Array.from({ length: H }, () => []);
    for (let i = 0; i < cnt; i++) {
      const c0 = coords[2 * i];
      const r0 = coords[2 * i + 1];
      rowCols[r0].push(c0);
    }
    for (let r = 0; r < H; r++) rowCols[r].sort((a, b) => a - b);
    const finiteRows = [];
    for (let r = 0; r < H; r++) if (rowCols[r].length) finiteRows.push(r);

    const sPos = scratch.sitePos;
    const sF = scratch.siteF;
    const sSR = scratch.siteSR;
    const sSC = scratch.siteSC;

    // ---- 第一遍：逐行 x 方向，f=0 站点 ----
    for (let r = 0; r < H; r++) {
      const cols = rowCols[r];
      const outBase = r * W;
      if (cols.length === 0) {
        for (let c = 0; c < W; c++) {
          d2[outBase + c] = INF;
          sr[outBase + c] = -1;
          sc[outBase + c] = -1;
        }
        continue;
      }
      let ns = 0;
      if (wrap) {
        // FH 倍增：站点 q 与 q+W（身份同为原种子 c0），位置单调
        for (let t = 0; t < cols.length; t++) {
          const c0 = cols[t];
          sPos[ns] = c0; sF[ns] = 0; sSR[ns] = r; sSC[ns] = c0; ns++;
        }
        for (let t = 0; t < cols.length; t++) {
          const c0 = cols[t];
          sPos[ns] = c0 + W; sF[ns] = 0; sSR[ns] = r; sSC[ns] = c0; ns++;
        }
        envelope1d(2 * W, sPos, sF, sSR, sSC, ns, ax,
                   scratch.tmpXD, scratch.tmpXR, scratch.tmpXC, scratch);
        fold2(W, scratch.tmpXD, scratch.tmpXR, scratch.tmpXC,
              d2.subarray(outBase, outBase + W),
              sr.subarray(outBase, outBase + W),
              sc.subarray(outBase, outBase + W));
      } else {
        for (let t = 0; t < cols.length; t++) {
          const c0 = cols[t];
          sPos[ns] = c0; sF[ns] = 0; sSR[ns] = r; sSC[ns] = c0; ns++;
        }
        envelope1d(W, sPos, sF, sSR, sSC, ns, ax,
                   d2.subarray(outBase, outBase + W),
                   sr.subarray(outBase, outBase + W),
                   sc.subarray(outBase, outBase + W),
                   scratch);
      }
    }

    // ---- 第二遍：逐列 y 方向，f=第一遍结果 ----
    const colPos = scratch.colPos;
    const colF = scratch.colF;
    const colSR = scratch.colSR;
    const colSC = scratch.colSC;
    for (let c = 0; c < W; c++) {
      let ns = 0;
      if (wrap) {
        // 倍增：行站点 q 与 q+H，f/身份来自第一遍
        const fr = finiteRows;
        for (let t = 0; t < fr.length; t++) {
          const q = fr[t], idx = q * W + c;
          colPos[ns] = q; colF[ns] = d2[idx]; colSR[ns] = sr[idx]; colSC[ns] = sc[idx]; ns++;
        }
        for (let t = 0; t < fr.length; t++) {
          const q = fr[t], idx = q * W + c;
          colPos[ns] = q + H; colF[ns] = d2[idx]; colSR[ns] = sr[idx]; colSC[ns] = sc[idx]; ns++;
        }
        if (ns === 0) {
          for (let r = 0; r < H; r++) {
            const idx = r * W + c;
            d2[idx] = INF; sr[idx] = -1; sc[idx] = -1;
          }
          continue;
        }
        envelope1d(2 * H, colPos, colF, colSR, colSC, ns, ay,
                   scratch.tmpD, scratch.tmpR, scratch.tmpC, scratch);
        fold2(H, scratch.tmpD, scratch.tmpR, scratch.tmpC,
              scratch.tmpD, scratch.tmpR, scratch.tmpC); // 原地折叠到前 H
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          d2[idx] = scratch.tmpD[r];
          sr[idx] = scratch.tmpR[r];
          sc[idx] = scratch.tmpC[r];
        }
      } else {
        for (let t = 0; t < finiteRows.length; t++) {
          const q = finiteRows[t];
          const idx = q * W + c;
          colPos[ns] = q;
          colF[ns] = d2[idx];
          colSR[ns] = sr[idx];
          colSC[ns] = sc[idx];
          ns++;
        }
        if (ns === 0) {
          for (let r = 0; r < H; r++) {
            const idx = r * W + c;
            d2[idx] = INF; sr[idx] = -1; sc[idx] = -1;
          }
          continue;
        }
        envelope1d(H, colPos, colF, colSR, colSC, ns, ay,
                   scratch.tmpD, scratch.tmpR, scratch.tmpC, scratch);
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          d2[idx] = scratch.tmpD[r];
          sr[idx] = scratch.tmpR[r];
          sc[idx] = scratch.tmpC[r];
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 部分合并：对一组标签求每格的“最近 / 最近异类”候选（全局前两名，标签不同）
  // 输入 labelCoords: Map<label, Int32Array 交错坐标>，labelIds: 本批标签
  // 输出 partial: { d1,d2:Uint32, l1,l2:Uint8, r1,c1,r2,c2:Int32 }
  // 候选比较键：(d2, 标签, 源行, 源列)
  // ---------------------------------------------------------------------------
  function runLabels(W, H, labelCoords, labelIds, sx, sy, wrap, onProgress) {
    const n = W * H;
    const buf = makeBuffers(W, H);
    const scratch = makeScratch(W, H);
    const d1 = new Uint32Array(n); d1.fill(INF);
    const d2 = new Uint32Array(n); d2.fill(INF);
    const l1 = new Uint8Array(n);
    const l2 = new Uint8Array(n);
    const r1 = new Int32Array(n).fill(-1); const c1 = new Int32Array(n).fill(-1);
    const r2 = new Int32Array(n).fill(-1); const c2 = new Int32Array(n).fill(-1);

    const ids = labelIds.slice().sort((a, b) => a - b);
    for (let li = 0; li < ids.length; li++) {
      const lab = ids[li];
      const coords = labelCoords.get(lab);
      const cnt = coords.length >> 1;
      if (cnt === 0) continue;
      sdtLabel(W, H, coords, cnt, sx, sy, wrap, buf, scratch);

      const bd = buf.d2, br = buf.sr, bc = buf.sc;
      for (let p = 0; p < n; p++) {
        const candD = bd[p];
        if (candD === INF) continue;
        const candR = br[p], candC = bc[p];
        if (d1[p] === INF ||
            candD < d1[p] ||
            (candD === d1[p] &&
             (lab < l1[p] ||
              (lab === l1[p] &&
               (candR < r1[p] ||
                (candR === r1[p] && candC < c1[p])))))) {
          // 仅槽位非空且旧第一名是异类时，才把旧第一名降为最近异类；
          // 空槽或同标签换源不影响已有的异类第二候选
          if (d1[p] !== INF && l1[p] !== lab) {
            d2[p] = d1[p]; l2[p] = l1[p]; r2[p] = r1[p]; c2[p] = c1[p];
          }
          d1[p] = candD; l1[p] = lab; r1[p] = candR; c1[p] = candC;
        } else if (lab !== l1[p] &&
                   (d2[p] === INF ||
                    candD < d2[p] ||
                    (candD === d2[p] &&
                     (lab < l2[p] ||
                      (lab === l2[p] &&
                       (candR < r2[p] ||
                        (candR === r2[p] && candC < c2[p]))))))) {
          // 仅异类可占据第二候选（最近异类种子）
          d2[p] = candD; l2[p] = lab; r2[p] = candR; c2[p] = candC;
        }
      }
      if (onProgress) onProgress(li + 1, ids.length);
    }
    return { d1, d2, l1, l2, r1, c1, r2, c2 };
  }

  // ---------------------------------------------------------------------------
  // 跨 partial 合并：每路 partial 已是 (d2,label,row,col) 有序的前两名
  // ---------------------------------------------------------------------------
  function mergePartials(W, H, parts) {
    const n = W * H;
    const d1 = new Uint32Array(n); d1.fill(INF);
    const d2 = new Uint32Array(n); d2.fill(INF);
    const l1 = new Uint8Array(n);
    const l2arr = new Uint8Array(n);
    const r1 = new Int32Array(n).fill(-1); const c1 = new Int32Array(n).fill(-1);
    const r2 = new Int32Array(n).fill(-1); const c2 = new Int32Array(n).fill(-1);

    const consider = (p, candD, candL, candR, candC) => {
      if (candD === INF) return;
      if (d1[p] === INF ||
          candD < d1[p] ||
          (candD === d1[p] &&
           (candL < l1[p] ||
            (candL === l1[p] &&
             (candR < r1[p] ||
              (candR === r1[p] && candC < c1[p])))))) {
        if (d1[p] !== INF && l1[p] !== candL) {
          d2[p] = d1[p]; l2arr[p] = l1[p]; r2[p] = r1[p]; c2[p] = c1[p];
        }
        d1[p] = candD; l1[p] = candL; r1[p] = candR; c1[p] = candC;
      } else if (candL !== l1[p] &&
                 (d2[p] === INF ||
                  candD < d2[p] ||
                  (candD === d2[p] &&
                   (candL < l2arr[p] ||
                    (candL === l2arr[p] &&
                     (candR < r2[p] ||
                      (candR === r2[p] && candC < c2[p]))))))) {
        d2[p] = candD; l2arr[p] = candL; r2[p] = candR; c2[p] = candC;
      }
    };

    for (const pt of parts) {
      for (let p = 0; p < n; p++) {
        if (pt.d1[p] !== INF) consider(p, pt.d1[p], pt.l1[p], pt.r1[p], pt.c1[p]);
        if (pt.d2[p] !== INF) consider(p, pt.d2[p], pt.l2[p], pt.r2[p], pt.c2[p]);
      }
    }
    return { d1, d2, l1, l2: l2arr, r1, c1, r2, c2 };
  }

  // ---------------------------------------------------------------------------
  // 填充规则：
  //   无任何种子 -> 0
  //   d1^2 <= radius^2 且（无异类 或 d2^2-d1^2 >= margin）-> l1，否则 0
  // ---------------------------------------------------------------------------
  function applyFill(W, H, top, radius, margin) {
    const n = W * H;
    const out = new Uint8Array(n);
    const r2 = radius * radius;
    let filled = 0;
    for (let p = 0; p < n; p++) {
      if (top.d1[p] === INF || top.d1[p] > r2) { out[p] = 0; continue; }
      if (top.d2[p] === INF) { out[p] = top.l1[p]; filled++; continue; }
      if (top.d2[p] - top.d1[p] >= margin) { out[p] = top.l1[p]; filled++; }
    }
    return { out, filled };
  }

  // 朴素参考实现（O(WH·S)，仅用于测试对照）
  function bruteForce(W, H, seeds, sx, sy, wrap, radius, margin) {
    const n = W * H;
    const ref = new Uint8Array(n);
    const info = [];
    for (let p = 0; p < n; p++) info.push({ d1: INF, d2: INF, l1: 0, l2: 0, r1: -1, c1: -1, r2: -1, c2: -1 });
    for (const [sc0, sr0, lab] of seeds) {
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          let dx = Math.abs(c - sc0);
          let dy = Math.abs(r - sr0);
          if (wrap) { dx = Math.min(dx, W - dx); dy = Math.min(dy, H - dy); }
          const ddv = (dx * sx) * (dx * sx) + (dy * sy) * (dy * sy);
          const p = r * W + c;
          const t = info[p];
          const better = (a, bd, bl, br, bc) =>
            bd < a.d || (bd === a.d && (bl < a.l ||
              (bl === a.l && (br < a.r || (br === a.r && bc < a.c)))));
          if (t.d1 === INF || better({ d: t.d1, l: t.l1, r: t.r1, c: t.c1 }, ddv, lab, sr0, sc0)) {
            if (t.d1 !== INF && t.l1 !== lab) {
              t.d2 = t.d1; t.l2 = t.l1; t.r2 = t.r1; t.c2 = t.c1;
            }
            t.d1 = ddv; t.l1 = lab; t.r1 = sr0; t.c1 = sc0;
          } else if (lab !== t.l1 &&
                     (t.d2 === INF || better({ d: t.d2, l: t.l2, r: t.r2, c: t.c2 }, ddv, lab, sr0, sc0))) {
            t.d2 = ddv; t.l2 = lab; t.r2 = sr0; t.c2 = sc0;
          }
        }
      }
    }
    for (let p = 0; p < n; p++) {
      const t = info[p];
      if (t.d1 === INF || t.d1 > radius * radius) { ref[p] = 0; continue; }
      if (t.d2 === INF || t.d2 - t.d1 >= margin) ref[p] = t.l1;
    }
    return { ref, info };
  }

  const SDTCore = {
    INF,
    envelope1d,
    sdtLabel,
    runLabels,
    mergePartials,
    applyFill,
    bruteForce,
    makeScratch,
    makeBuffers,
  };

  global.SDTCore = SDTCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = SDTCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
