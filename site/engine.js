/*
 * 脚锁动作格子（Footlock Lattice）—— 求解引擎
 *
 * 无 DOM 依赖；浏览器里暴露 window.FootlockEngine，Node 里 module.exports。
 *
 * 数据约定
 *  - samples[]：编号 id 唯一；left / right 为 [局部 x, 局部 y, 是否支撑]。
 *  - 朝向 angle：逆时针角度，必须是 90° 的整数倍（四向）；内部归一为 0/90/180/270。
 *  - 世界落点 = 根位置 + R(朝向) · 局部落点，R 为逆时针整数旋转。
 *  - ticks[]：root 为整数坐标；costs 为 { 样本编号: 姿势费用 }，
 *             未列出的样本（或值为 null）本拍不可选。
 *  - edges[]：只允许沿给出的有向边从上一拍换到下一拍；jump=true 为跨片跳转。
 *  - 脚锁：相邻两拍若同一只脚都支撑，两拍的世界落点必须完全相等；
 *          支撑 → 离地（刚离地）不受这条限制。
 *  - 跳转冷却：一次跨片跳转之后的连续两条边都不能再跳转；首拍起始没有冷却。
 *  - 费用：十进制整数（字符串或安全整数），单项绝对值不超过 10^15；
 *          总代价用 BigInt 精确相加，不受双精度浮点舍入影响。
 *  - 目标：总代价最小；同价按样本编号序列（从第 1 拍起逐项）字典序最小。
 *  - 无解：报告首个不可达拍的 0 基下标（界面显示 1 基）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FootlockEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'footlock-lattice-replay-v1';
  var VERSION = '1.0.0';
  var COOLDOWN_AFTER_JUMP = 2;
  var LIMITS = { ticks: 240, samples: 4096, edges: 60000, itemLimit: '1000000000000000' };
  var ITEM_LIMIT = 1000000000000000n;
  var COORD_LIMIT = 1000000000;
  var INT_RE = /^[+-]?\d+$/;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function bad(msg) { throw new Error(msg); }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function readSafeInt(v, where, min, max) {
    var n;
    if (typeof v === 'number' && Number.isSafeInteger(v)) n = v;
    else if (typeof v === 'string' && INT_RE.test(v.trim())) {
      n = Number(v.trim());
      if (!Number.isSafeInteger(n)) bad(where + ' 超出安全整数范围');
    } else bad(where + ' 必须是整数');
    if (min !== undefined && n < min) bad(where + ' 不能小于 ' + min);
    if (max !== undefined && n > max) bad(where + ' 不能大于 ' + max);
    return n;
  }

  /** 费用：字符串或安全整数 → BigInt；单项绝对值 ≤ 10^15 */
  function readFee(v, where) {
    var b;
    if (typeof v === 'bigint') b = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) b = BigInt(v);
    else if (typeof v === 'string' && INT_RE.test(v.trim())) b = BigInt(v.trim());
    else bad(where + ' 必须是十进制整数字符串或安全整数');
    if (b > ITEM_LIMIT || b < -ITEM_LIMIT) bad(where + ' 绝对值不能超过 10^15');
    return b;
  }

  /** 朝向归一到 0..3 个 90°（逆时针）；仅接受 90° 的整数倍 */
  function readQuarter(v, where) {
    var a = readSafeInt(v, where);
    if (a % 90 !== 0) bad(where + ' 必须是 90° 的整数倍（四向朝向）');
    return ((a / 90) % 4 + 4) % 4;
  }

  function readFoot(v, where) {
    if (!Array.isArray(v) || v.length !== 3) bad(where + ' 必须是 [x, y, 是否支撑]');
    var x = readSafeInt(v[0], where + '[0]', -COORD_LIMIT, COORD_LIMIT);
    var y = readSafeInt(v[1], where + '[1]', -COORD_LIMIT, COORD_LIMIT);
    if (typeof v[2] !== 'boolean') bad(where + '[2] 必须是布尔值');
    return { x: x, y: y, support: v[2] };
  }

  function readRoot(v, where) {
    if (!Array.isArray(v) || v.length !== 2) bad(where + ' 必须是 [x, y]');
    return [
      readSafeInt(v[0], where + '[0]', -COORD_LIMIT, COORD_LIMIT),
      readSafeInt(v[1], where + '[1]', -COORD_LIMIT, COORD_LIMIT)
    ];
  }

  /* ------------------------------------------------------------------ */
  /* 几何                                                                */
  /* ------------------------------------------------------------------ */

  /** 逆时针旋转 q 个 90°：(x,y) → (-y,x) → (-x,-y) → (y,-x) */
  function rotateQuarter(x, y, q) {
    switch (q & 3) {
      case 0: return [x, y];
      case 1: return [-y, x];
      case 2: return [-x, -y];
      default: return [y, -x];
    }
  }

  /** 某拍某样本的世界落点（整数） */
  function worldFoot(root, quarter, foot) {
    var r = rotateQuarter(foot.x, foot.y, quarter);
    return [root[0] + r[0], root[1] + r[1]];
  }

  /* ------------------------------------------------------------------ */
  /* 输入解析与校验                                                       */
  /* ------------------------------------------------------------------ */

  function normalizeInput(raw) {
    if (!isPlainObject(raw)) bad('输入必须是 JSON 对象');
    var src = raw;
    if (raw.format === FORMAT && raw.input) src = raw.input;

    var samplesIn = src.samples;
    if (!Array.isArray(samplesIn) || samplesIn.length === 0) bad('缺少 samples 数组');
    if (samplesIn.length > LIMITS.samples) bad('样本最多 ' + LIMITS.samples + ' 个');

    var samples = [];
    var idToIndex = new Map();
    samplesIn.forEach(function (s, i) {
      if (!isPlainObject(s)) bad('samples[' + i + '] 必须是对象');
      var id = readSafeInt(s.id, 'samples[' + i + '].id');
      if (idToIndex.has(id)) bad('样本编号重复：' + id);
      var left = readFoot(s.left, 'samples[' + i + '].left');
      var right = readFoot(s.right, 'samples[' + i + '].right');
      idToIndex.set(id, i);
      samples.push({ index: i, id: id, left: left, right: right, idRank: 0 });
    });

    // 样本编号序：用于同价时的“编号序列最早”字典序
    var idOrder = samples.slice().sort(function (a, b) { return a.id - b.id; });
    idOrder.forEach(function (s, r) { s.idRank = r; });

    var edgesIn = src.edges || [];
    if (!Array.isArray(edgesIn)) bad('edges 必须是数组');
    if (edgesIn.length > LIMITS.edges) bad('衔接边最多 ' + LIMITS.edges + ' 条');
    var edges = edgesIn.map(function (e, i) {
      if (!isPlainObject(e)) bad('edges[' + i + '] 必须是对象');
      var from = idToIndex.get(readSafeInt(e.from, 'edges[' + i + '].from'));
      var to = idToIndex.get(readSafeInt(e.to, 'edges[' + i + '].to'));
      if (from === undefined) bad('edges[' + i + '].from 引用了未知样本 ' + e.from);
      if (to === undefined) bad('edges[' + i + '].to 引用了未知样本 ' + e.to);
      if (typeof e.jump !== 'boolean') bad('edges[' + i + '].jump 必须是布尔值');
      var fee = readFee(e.fee, 'edges[' + i + '].fee');
      return { index: i, from: from, to: to, fee: fee, jump: e.jump };
    });

    var ticksIn = src.ticks;
    if (!Array.isArray(ticksIn) || ticksIn.length === 0) bad('缺少 ticks 数组');
    if (ticksIn.length > LIMITS.ticks) bad('最多支持 ' + LIMITS.ticks + ' 拍');

    var ticks = ticksIn.map(function (t, ti) {
      if (!isPlainObject(t)) bad('ticks[' + ti + '] 必须是对象');
      var root = readRoot(t.root, 'ticks[' + ti + '].root');
      var quarter = readQuarter(t.angle, 'ticks[' + ti + '].angle');
      if (!isPlainObject(t.costs)) bad('ticks[' + ti + '].costs 必须是对象');
      var allowed = new Uint8Array(samples.length);
      var poseCost = new Array(samples.length).fill(null);
      var allowedList = [];
      Object.keys(t.costs).forEach(function (key) {
        var v = t.costs[key];
        if (v === null || v === undefined) return;
        var idNum = Number(key);
        if (!Number.isSafeInteger(idNum) || String(idNum) !== key) {
          bad('ticks[' + ti + '].costs 的键 ' + key + ' 不是样本编号');
        }
        var si = idToIndex.get(idNum);
        if (si === undefined) bad('ticks[' + ti + '].costs 引用了未知样本 ' + key);
        if (allowed[si]) bad('ticks[' + ti + '].costs 重复列出样本 ' + key);
        allowed[si] = 1;
        poseCost[si] = readFee(v, 'ticks[' + ti + '].costs[' + key + ']');
        allowedList.push(si);
      });
      return {
        index: ti, root: root, quarter: quarter, angle: quarter * 90,
        allowed: allowed, allowedList: allowedList, poseCost: poseCost
      };
    });

    if (src.rules !== undefined && typeof src.rules !== 'string') bad('rules 必须是字符串');

    return {
      format: FORMAT,
      samples: samples,
      idToIndex: idToIndex,
      edges: edges,
      ticks: ticks,
      rules: src.rules || ''
    };
  }

  /** 某拍的世界落点表（左/右），供脚锁比较 */
  function buildWorldTable(tick, samples) {
    var n = samples.length;
    var wlx = new Float64Array(n), wly = new Float64Array(n);
    var wrx = new Float64Array(n), wry = new Float64Array(n);
    var root = tick.root, q = tick.quarter;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      var l = rotateQuarter(s.left.x, s.left.y, q);
      wlx[i] = root[0] + l[0]; wly[i] = root[1] + l[1];
      var r = rotateQuarter(s.right.x, s.right.y, q);
      wrx[i] = root[0] + r[0]; wry[i] = root[1] + r[1];
    }
    return { wlx: wlx, wly: wly, wrx: wrx, wry: wry };
  }

  /* ------------------------------------------------------------------ */
  /* 求解：前向动态规划                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 状态 = (样本下标, 冷却)。冷却 c ∈ {0,1,2} 表示接下来还有 c 条边禁止跳转。
   * 同状态只保留总代价最低、同价前缀编号序列字典序最小的一条；
   * 每层按 (父层 rank, 样本编号) 赋规范 rank，使跨层字典序比较为 O(1)。
   */
  function solve(input, opts) {
    opts = opts || {};
    var t0 = now();
    var samples = input.samples, ticks = input.ticks, edges = input.edges;
    var N = samples.length, T = ticks.length, E = edges.length;
    var SZ = N * 3;
    var COOLDOWN = opts.cooldownAfterJump === undefined ? COOLDOWN_AFTER_JUMP : opts.cooldownAfterJump;

    // 扁平化的边与样本属性，内层循环只碰 TypedArray
    var eTo = new Int32Array(E), eJump = new Uint8Array(E), eFee = new Array(E);
    var outStart = new Int32Array(N + 1);
    for (var e = 0; e < E; e++) {
      eTo[e] = edges[e].to;
      eJump[e] = edges[e].jump ? 1 : 0;
      eFee[e] = edges[e].fee;
      outStart[edges[e].from + 1]++;
    }
    for (var s = 0; s < N; s++) outStart[s + 1] += outStart[s];
    var outEdges = new Int32Array(E);
    var cursor = outStart.slice(0, N);
    for (var ei = 0; ei < E; ei++) outEdges[cursor[edges[ei].from]++] = ei;

    var supL = new Uint8Array(N), supR = new Uint8Array(N), idRank = new Int32Array(N);
    for (var i = 0; i < N; i++) {
      supL[i] = samples[i].left.support ? 1 : 0;
      supR[i] = samples[i].right.support ? 1 : 0;
      idRank[i] = samples[i].idRank;
    }

    var parentLayers = new Array(T);
    var edgeLayers = new Array(T);
    var rankPrev = new Int32Array(SZ);
    var costPrev = new Array(SZ).fill(null);
    var activePrev = [];
    rankPrev.fill(-1);

    // 第 0 拍：c=0 起始，无跳转冷却；只有 costs 中列出的样本可选
    var tick0 = ticks[0];
    var tabPrev = buildWorldTable(tick0, samples);
    var active0 = [];
    for (var k = 0; k < tick0.allowedList.length; k++) {
      var si = tick0.allowedList[k];
      costPrev[si * 3] = tick0.poseCost[si];
      active0.push(si * 3);
    }
    if (active0.length === 0) return failAt(0, T, 0, t0);
    countingSortById(active0, idRank);
    for (var a0 = 0; a0 < active0.length; a0++) rankPrev[active0[a0]] = a0;
    activePrev = active0;

    var firstFail = -1;
    var layerSizes = new Int32Array(T);
    layerSizes[0] = activePrev.length;
    var tmp = new Int32Array(SZ);
    var order = new Int32Array(SZ);
    var countsId = new Int32Array(N + 1);
    var countsRank = new Int32Array(SZ + 1);

    for (var t = 1; t < T; t++) {
      var tick = ticks[t];
      var allowed = tick.allowed;
      var tab = buildWorldTable(tick, samples);
      var costNext = new Array(SZ).fill(null);
      var parNext = new Int32Array(SZ).fill(-1);
      var edgeNext = new Int32Array(SZ).fill(-1);
      var prankNext = new Int32Array(SZ).fill(-1);
      var activeNext = [];

      for (var ai = 0; ai < activePrev.length; ai++) {
        var pst = activePrev[ai];
        var pa = (pst / 3) | 0;
        var pc = pst - pa * 3;
        var pCost = costPrev[pst];
        if (pCost === null) continue;
        var pRank = rankPrev[pst];
        var sl = supL[pa], sr = supR[pa];
        var axL = tabPrev.wlx[pa], ayL = tabPrev.wly[pa];
        var axR = tabPrev.wrx[pa], ayR = tabPrev.wry[pa];
        var st0 = outStart[pa], en0 = outStart[pa + 1];
        for (var oi = st0; oi < en0; oi++) {
          var ee = outEdges[oi];
          var b = eTo[ee];
          var j = eJump[ee];
          if (!allowed[b]) continue; // 未列在 costs 内的样本本拍不可选
          if (j && pc > 0) continue; // 冷却中禁止再次跳转
          if (sl && supL[b] && (axL !== tab.wlx[b] || ayL !== tab.wly[b])) continue; // 左脚锁
          if (sr && supR[b] && (axR !== tab.wrx[b] || ayR !== tab.wry[b])) continue; // 右脚锁
          var nc = j ? COOLDOWN : (pc > 0 ? pc - 1 : 0);
          var nst = b * 3 + nc;
          var cand = pCost + eFee[ee];
          var old = costNext[nst];
          if (old === null) {
            costNext[nst] = cand;
            parNext[nst] = pst; edgeNext[nst] = ee; prankNext[nst] = pRank;
            activeNext.push(nst);
          } else if (cand < old || (cand === old && pRank < prankNext[nst])) {
            costNext[nst] = cand;
            parNext[nst] = pst; edgeNext[nst] = ee; prankNext[nst] = pRank;
          }
        }
      }

      if (activeNext.length === 0) { firstFail = t; break; }

      // 加上本拍姿势费用
      for (var q = 0; q < activeNext.length; q++) {
        var stn = activeNext[q];
        costNext[stn] = costNext[stn] + tick.poseCost[(stn / 3) | 0];
      }

      // 规范 rank：按 (父层 rank 序列, 样本编号) 排序。
      // 两条状态若父层 rank 与样本编号都相同，则编号序列完全一致，必须共享同一 rank，
      // 否则跨层比较会把“同前缀但不同冷却”的状态误判为不同序列。
      stableSortTwoKey(activeNext, tmp, order, countsId, countsRank, prankNext, idRank, N);
      var rankNext = new Int32Array(SZ).fill(-1);
      var curRank = -1, lastP = -2, lastI = -2;
      for (var r = 0; r < activeNext.length; r++) {
        var node = activeNext[r];
        var np = prankNext[node];
        var ni = idRank[(node / 3) | 0];
        if (np !== lastP || ni !== lastI) { curRank++; lastP = np; lastI = ni; }
        rankNext[node] = curRank;
      }
      var numRanks = curRank + 1;
      layerSizes[t] = activeNext.length;

      parentLayers[t] = parNext;
      edgeLayers[t] = edgeNext;
      costPrev = costNext;
      rankPrev = rankNext;
      activePrev = activeNext;
      tabPrev = tab;
    }

    if (firstFail !== -1) {
      var pref = bestInLayer(activePrev, costPrev, rankPrev);
      var prefixIds = [];
      if (pref !== -1) {
        var px = traceback(pref, firstFail, parentLayers, edgeLayers);
        prefixIds = px.samples.map(function (x) { return samples[x].id; });
      }
      return failAt(firstFail, T, firstFail, t0, prefixIds);
    }

    var bestSt = -1, bestCost = null, bestRank = Infinity;
    for (var z = 0; z < activePrev.length; z++) {
      var stz = activePrev[z];
      var cz = costPrev[stz];
      if (cz === null) continue;
      var rz = rankPrev[stz];
      if (bestCost === null || cz < bestCost || (cz === bestCost && rz < bestRank)) {
        bestCost = cz; bestRank = rz; bestSt = stz;
      }
    }
    if (bestSt === -1) return failAt(T - 1, T, T - 1, t0);

    var seq = traceback(bestSt, T, parentLayers, edgeLayers);
    return finalize(input, seq, bestCost, t0, layerSizes);
  }

  function failAt(tick, T, reached, t0, prefixIds) {
    return {
      ok: false,
      firstImpossibleTick: tick,
      firstImpossibleBeat: tick + 1,
      ticks: T,
      reachedTicks: reached,
      prefixIds: prefixIds || [],
      solveMs: now() - t0
    };
  }

  function bestInLayer(active, cost, rank) {
    var best = -1, bestCost = null, bestRank = Infinity;
    for (var i = 0; i < active.length; i++) {
      var st = active[i], c = cost[st];
      if (c === null) continue;
      var r = rank[st];
      if (bestCost === null || c < bestCost || (c === bestCost && r < bestRank)) {
        bestCost = c; bestRank = r; best = st;
      }
    }
    return best;
  }

  /** 一次计数排序：按样本编号 rank 升序（稳定） */
  function countingSortById(active, idRank) {
    var len = active.length;
    var max = 0;
    for (var i = 0; i < len; i++) { var r = idRank[(active[i] / 3) | 0]; if (r > max) max = r; }
    var cnt = new Int32Array(max + 1);
    for (var j = 0; j < len; j++) cnt[idRank[(active[j] / 3) | 0]]++;
    var acc = 0;
    for (var k = 0; k <= max; k++) { var c = cnt[k]; cnt[k] = acc; acc += c; }
    var out = new Int32Array(len);
    for (var m = 0; m < len; m++) {
      var st = active[m];
      out[cnt[idRank[(st / 3) | 0]]++] = st;
    }
    for (var p = 0; p < len; p++) active[p] = out[p];
  }

  /** 稳定排序 active：主键父层 rank、次键样本编号 rank（两轮计数排序） */
  function stableSortTwoKey(active, tmp, out, countsId, countsRank, prank, idRank, N) {
    var len = active.length;
    var i, c, acc;

    countsId.fill(0, 0, N);
    for (i = 0; i < len; i++) countsId[idRank[(active[i] / 3) | 0]]++;
    acc = 0;
    for (var r = 0; r < N; r++) { c = countsId[r]; countsId[r] = acc; acc += c; }
    for (i = 0; i < len; i++) {
      var st = active[i];
      tmp[countsId[idRank[(st / 3) | 0]]++] = st;
    }

    var maxRank = 0;
    for (i = 0; i < len; i++) { var pr = prank[tmp[i]]; if (pr > maxRank) maxRank = pr; }
    countsRank.fill(0, 0, maxRank + 1);
    for (i = 0; i < len; i++) countsRank[prank[tmp[i]]]++;
    acc = 0;
    for (var r2 = 0; r2 <= maxRank; r2++) { c = countsRank[r2]; countsRank[r2] = acc; acc += c; }
    for (i = 0; i < len; i++) out[countsRank[prank[tmp[i]]]++] = tmp[i];

    for (i = 0; i < len; i++) active[i] = out[i];
  }

  /** 从末状态回溯样本序列与冷却序列 */
  function traceback(bestSt, T, parentLayers, edgeLayers) {
    var samplesSeq = new Array(T);
    var coolSeq = new Array(T);
    var edgesSeq = new Array(T);
    var st = bestSt;
    for (var t = T - 1; t >= 0; t--) {
      var s = (st / 3) | 0;
      samplesSeq[t] = s;
      coolSeq[t] = st - s * 3;
      if (t > 0) {
        edgesSeq[t] = edgeLayers[t][st];
        st = parentLayers[t][st];
      } else {
        edgesSeq[t] = -1;
      }
    }
    return { samples: samplesSeq, cool: coolSeq, edges: edgesSeq };
  }

  /** 沿给定样本序列复盘逐拍明细（不重新求解） */
  function finalize(input, seq, bestCost, t0, layerSizes) {
    var samples = input.samples, ticks = input.ticks, edges = input.edges;
    var T = ticks.length;
    var details = [];
    var cumulative = 0n;
    for (var tt = 0; tt < T; tt++) {
      var si = seq.samples[tt];
      var smp = samples[si];
      var tk = ticks[tt];
      var poseCost = tk.poseCost[si];
      var edgeFee = 0n, jump = false, edgeIndex = -1, fromSample = null;
      if (tt > 0) {
        edgeIndex = seq.edges[tt];
        var ed = edges[edgeIndex];
        edgeFee = ed.fee;
        jump = ed.jump;
        fromSample = seq.samples[tt - 1];
      }
      cumulative += poseCost + edgeFee;
      var wl = worldFoot(tk.root, tk.quarter, smp.left);
      var wr = worldFoot(tk.root, tk.quarter, smp.right);
      var lockL = 'air', lockR = 'air';
      if (tt > 0) {
        var ps = samples[seq.samples[tt - 1]];
        var ptk = ticks[tt - 1];
        var pwl = worldFoot(ptk.root, ptk.quarter, ps.left);
        var pwr = worldFoot(ptk.root, ptk.quarter, ps.right);
        if (ps.left.support && smp.left.support) lockL = (pwl[0] === wl[0] && pwl[1] === wl[1]) ? 'locked' : 'break';
        if (ps.right.support && smp.right.support) lockR = (pwr[0] === wr[0] && pwr[1] === wr[1]) ? 'locked' : 'break';
      }
      details.push({
        tick: tt,
        sample: si,
        sampleId: smp.id,
        root: tk.root.slice(),
        angle: tk.angle,
        poseCost: poseCost.toString(),
        edgeIndex: edgeIndex,
        edgeFee: edgeFee.toString(),
        jump: jump,
        fromSample: fromSample,
        fromSampleId: fromSample === null ? null : samples[fromSample].id,
        cooldownBefore: tt > 0 ? seq.cool[tt - 1] : 0,
        cooldownAfter: seq.cool[tt],
        worldLeft: wl,
        worldRight: wr,
        supportLeft: smp.left.support,
        supportRight: smp.right.support,
        footlockLeft: lockL,
        footlockRight: lockR,
        cumulative: cumulative.toString()
      });
    }
    return {
      ok: true,
      totalCost: bestCost,
      totalCostString: bestCost.toString(),
      sequence: seq.samples,
      sequenceIds: seq.samples.map(function (x) { return samples[x].id; }),
      cooldowns: seq.cool,
      details: details,
      solveMs: now() - t0,
      stats: {
        ticks: T, samples: samples.length, edges: edges.length,
        states: Array.prototype.slice.call(layerSizes, 0, T)
      }
    };
  }

  /**
   * 评估给定样本编号序列：返回 { ok, totalCost, firstError }。
   * 独立于 DP，用于导入核验与测试。
   *
   * 同一对样本之间可能有多条平行衔接边（费用、是否跳转不同）。
   * 固定样本序列后，沿固定序列对冷却状态 {0,1,2} 做一次极小的动态规划，
   * 取各条平行边的合法组合里总费用最低者——与主求解器“总代价最小”的定义一致。
   */
  function evaluateSequence(input, ids) {
    var samples = input.samples, ticks = input.ticks, edges = input.edges;
    if (!Array.isArray(ids) || ids.length !== ticks.length) {
      return { ok: false, error: '序列长度应为 ' + ticks.length };
    }
    if (ids.length === 0) return { ok: true, totalCost: 0n, totalCostString: '0' };

    // 按前驱样本分组出边
    var outs = new Map();
    edges.forEach(function (e) {
      if (!outs.has(e.from)) outs.set(e.from, []);
      outs.get(e.from).push(e);
    });

    var prevId = ids[0];
    var prev = input.idToIndex.get(prevId);
    if (prev === undefined) return { ok: false, error: '第 1 拍样本编号 ' + prevId + ' 不存在' };
    if (!ticks[0].allowed[prev]) return { ok: false, error: '第 1 拍样本不在 costs 内' };

    // 冷却状态 0/1/2 -> 最小累计代价（null 表示不可达）
    var INF = null;
    var dp = [ticks[0].poseCost[prev], INF, INF];
    var prevTab = buildWorldTable(ticks[0], samples);

    for (var t = 1; t < ticks.length; t++) {
      var si = input.idToIndex.get(ids[t]);
      if (si === undefined) return { ok: false, error: '第 ' + (t + 1) + ' 拍样本编号 ' + ids[t] + ' 不存在' };
      var tick = ticks[t];
      if (!tick.allowed[si]) return { ok: false, error: '第 ' + (t + 1) + ' 拍样本不在 costs 内' };
      var tab = buildWorldTable(tick, samples);

      // 脚锁与边无关，先判一次
      if (samples[prev].left.support && samples[si].left.support &&
          (prevTab.wlx[prev] !== tab.wlx[si] || prevTab.wly[prev] !== tab.wly[si])) {
        return { ok: false, error: '第 ' + (t + 1) + ' 拍左脚脚锁被破坏' };
      }
      if (samples[prev].right.support && samples[si].right.support &&
          (prevTab.wrx[prev] !== tab.wrx[si] || prevTab.wry[prev] !== tab.wry[si])) {
        return { ok: false, error: '第 ' + (t + 1) + ' 拍右脚脚锁被破坏' };
      }

      var list = outs.get(prev) || [];
      var next = [INF, INF, INF];
      var anyEdge = false;
      for (var k = 0; k < list.length; k++) {
        var e = list[k];
        if (e.to !== si) continue;
        anyEdge = true;
        for (var c = 0; c < 3; c++) {
          var base = dp[c];
          if (base === null) continue;
          if (e.jump && c > 0) continue; // 冷却中禁止跳转
          var nc = e.jump ? COOLDOWN_AFTER_JUMP : (c > 0 ? c - 1 : 0);
          var cand = base + e.fee + tick.poseCost[si];
          if (next[nc] === null || cand < next[nc]) next[nc] = cand;
        }
      }
      if (!anyEdge) return { ok: false, error: '第 ' + (t + 1) + ' 拍没有给定的衔接边' };
      if (next[0] === null && next[1] === null && next[2] === null) {
        return { ok: false, error: '第 ' + (t + 1) + ' 拍在跳转冷却中使用了跳转边' };
      }
      dp = next;
      prev = si; prevTab = tab;
    }

    var best = null;
    for (var m = 0; m < 3; m++) {
      if (dp[m] !== null && (best === null || dp[m] < best)) best = dp[m];
    }
    return { ok: true, totalCost: best, totalCostString: best.toString() };
  }

  /* ------------------------------------------------------------------ */
  /* 导出与重导核算                                                       */
  /* ------------------------------------------------------------------ */

  function buildReplay(input, result) {
    var doc = {
      format: FORMAT,
      engineVersion: VERSION,
      exportedAt: new Date().toISOString(),
      ok: result.ok,
      input: serializeInput(input),
      limits: LIMITS,
      cooldownAfterJump: COOLDOWN_AFTER_JUMP
    };
    if (result.ok) {
      doc.totalCost = result.totalCostString;
      doc.sequenceIds = result.sequenceIds.slice();
      doc.ticks = result.details.map(function (d) {
        return {
          tick: d.tick + 1,
          sampleId: d.sampleId,
          fromSampleId: d.fromSampleId,
          edgeIndex: d.edgeIndex,
          poseCost: d.poseCost,
          edgeFee: d.edgeFee,
          jump: d.jump,
          cooldownAfter: d.cooldownAfter,
          worldLeft: d.worldLeft.slice(),
          worldRight: d.worldRight.slice(),
          supportLeft: d.supportLeft,
          supportRight: d.supportRight,
          footlockLeft: d.footlockLeft,
          footlockRight: d.footlockRight,
          cumulative: d.cumulative
        };
      });
    } else {
      doc.firstImpossibleTick = result.firstImpossibleTick + 1;
    }
    return doc;
  }

  function serializeInput(input) {
    return {
      samples: input.samples.map(function (s) {
        return { id: s.id, left: [s.left.x, s.left.y, s.left.support], right: [s.right.x, s.right.y, s.right.support] };
      }),
      edges: input.edges.map(function (e) {
        return { from: input.samples[e.from].id, to: input.samples[e.to].id, fee: e.fee.toString(), jump: e.jump };
      }),
      ticks: input.ticks.map(function (t) {
        var costs = {};
        t.allowedList.forEach(function (si) {
          costs[String(input.samples[si].id)] = t.poseCost[si].toString();
        });
        return { root: t.root.slice(), angle: t.angle, costs: costs };
      }),
      rules: input.rules
    };
  }

  /**
   * 重导核算：从导出文档内嵌的输入重新求解，并逐拍独立核验
   * （边存在、脚锁成立、跳转冷却成立、费用逐项加总一致）。
   */
  function verifyReplay(doc) {
    var errors = [];
    if (!isPlainObject(doc)) return { ok: false, errors: ['导出文档必须是对象'] };
    if (doc.format !== FORMAT) errors.push('format 应为 ' + FORMAT);
    if (!doc.input) return { ok: false, errors: errors.concat('缺少 input 数据包') };

    var input;
    try { input = normalizeInput(doc.input); }
    catch (err) { return { ok: false, errors: errors.concat('数据包校验失败：' + err.message) }; }

    var result = solve(input);
    if (!doc.ok) {
      if (result.ok) errors.push('导出声称无解，但重算有解');
      else if (doc.firstImpossibleTick - 1 !== result.firstImpossibleTick) {
        errors.push('首个不可达拍不一致：导出 ' + doc.firstImpossibleTick + '，重算 ' + (result.firstImpossibleTick + 1));
      }
      return { ok: errors.length === 0, errors: errors, result: result };
    }

    if (!result.ok) {
      errors.push('导出声称有解，但重算无解（首个不可达拍 ' + (result.firstImpossibleTick + 1) + '）');
      return { ok: false, errors: errors, result: result };
    }
    if (doc.totalCost !== result.totalCostString) {
      errors.push('总代价不一致：导出 ' + doc.totalCost + '，重算 ' + result.totalCostString);
    }
    var seq = doc.sequenceIds;
    if (!Array.isArray(seq) || seq.length !== result.sequenceIds.length) {
      errors.push('序列长度不一致或缺失');
    } else {
      for (var i = 0; i < seq.length; i++) {
        if (seq[i] !== result.sequenceIds[i]) {
          errors.push('第 ' + (i + 1) + ' 拍样本编号不一致：导出 ' + seq[i] + '，重算 ' + result.sequenceIds[i]);
          break;
        }
      }
    }
    // 独立核验逐拍明细
    var reEval = evaluateSequence(input, doc.sequenceIds);
    if (!reEval.ok) errors.push('序列复核失败：' + reEval.error);
    errors = errors.concat(verifyDetails(input, doc));
    return { ok: errors.length === 0, errors: errors, result: result };
  }

  /** 独立核对导出逐拍明细（不依赖 DP 结果） */
  function verifyDetails(input, doc) {
    var errors = [];
    var samples = input.samples, ticks = input.ticks, edges = input.edges;
    if (!Array.isArray(doc.ticks) || doc.ticks.length !== ticks.length) {
      return ['逐拍明细缺失或长度不符'];
    }
    var prev = -1, prevTab = null, cooldown = 0, sum = 0n;
    for (var t = 0; t < ticks.length; t++) {
      var d = doc.ticks[t];
      var si = input.idToIndex.get(d.sampleId);
      if (si === undefined) { errors.push('第 ' + (t + 1) + ' 拍样本编号 ' + d.sampleId + ' 不存在'); break; }
      var tick = ticks[t];
      if (!tick.allowed[si]) errors.push('第 ' + (t + 1) + ' 拍样本 ' + d.sampleId + ' 不在 costs 内');
      if (tick.poseCost[si].toString() !== String(d.poseCost)) errors.push('第 ' + (t + 1) + ' 拍姿势费用不一致');
      var tab = buildWorldTable(tick, samples);
      var smp = samples[si];
      if (!samePair([tab.wlx[si], tab.wly[si]], d.worldLeft)) errors.push('第 ' + (t + 1) + ' 拍左脚世界落点不一致');
      if (!samePair([tab.wrx[si], tab.wry[si]], d.worldRight)) errors.push('第 ' + (t + 1) + ' 拍右脚世界落点不一致');
      if (smp.left.support !== d.supportLeft || smp.right.support !== d.supportRight) {
        errors.push('第 ' + (t + 1) + ' 拍支撑标记不一致');
      }
      var edgeFee = 0n;
      if (t > 0) {
        var e = null;
        if (Number.isInteger(d.edgeIndex) && d.edgeIndex >= 0 && d.edgeIndex < edges.length) {
          var cand = edges[d.edgeIndex];
          if (cand.from === prev && cand.to === si) e = cand;
        }
        if (!e) {
          // 回退到按 from>to 查找唯一匹配
          var matches = edges.filter(function (x) { return x.from === prev && x.to === si; });
          if (matches.length === 1) e = matches[0];
        }
        if (!e) errors.push('第 ' + (t + 1) + ' 拍使用了不存在的边 ' + samples[prev].id + ' > ' + smp.id);
        else {
          edgeFee = e.fee;
          if (e.jump && cooldown > 0) errors.push('第 ' + (t + 1) + ' 拍在跳转冷却中使用了跳转边');
          if (String(d.edgeFee) !== e.fee.toString()) errors.push('第 ' + (t + 1) + ' 拍衔接费用不一致');
          if (!!d.jump !== e.jump) errors.push('第 ' + (t + 1) + ' 拍跳转标记不一致');
        }
        if (samples[prev].left.support && smp.left.support &&
            (prevTab.wlx[prev] !== tab.wlx[si] || prevTab.wly[prev] !== tab.wly[si])) {
          errors.push('第 ' + (t + 1) + ' 拍左脚脚锁被破坏');
        }
        if (samples[prev].right.support && smp.right.support &&
            (prevTab.wrx[prev] !== tab.wrx[si] || prevTab.wry[prev] !== tab.wry[si])) {
          errors.push('第 ' + (t + 1) + ' 拍右脚脚锁被破坏');
        }
        if (e) cooldown = e.jump ? COOLDOWN_AFTER_JUMP : (cooldown > 0 ? cooldown - 1 : 0);
      }
      sum += tick.poseCost[si] + edgeFee;
      if (String(d.cumulative) !== sum.toString()) {
        errors.push('第 ' + (t + 1) + ' 拍累计代价不一致：导出 ' + d.cumulative + '，独立加总 ' + sum);
      }
      prev = si; prevTab = tab;
    }
    if (doc.totalCost !== undefined && String(doc.totalCost) !== sum.toString()) {
      errors.push('导出总代价与逐拍独立加总不一致');
    }
    return errors;
  }

  function samePair(a, b) {
    return Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    LIMITS: LIMITS,
    COOLDOWN_AFTER_JUMP: COOLDOWN_AFTER_JUMP,
    rotateQuarter: rotateQuarter,
    worldFoot: worldFoot,
    normalizeInput: normalizeInput,
    buildWorldTable: buildWorldTable,
    solve: solve,
    evaluateSequence: evaluateSequence,
    buildReplay: buildReplay,
    serializeInput: serializeInput,
    verifyReplay: verifyReplay,
    verifyDetails: verifyDetails
  };
});
