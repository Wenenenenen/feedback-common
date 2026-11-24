/*
 * 双周期回波折深 —— 核心：记录校验、逐像素反解、分层聚合、16 位 P5 编码。
 *
 * 记录约定（samples/echo-depth.json）：
 *   width, height      1..256
 *   periods            [p0, p1]，各为 3..127 的整数且互素
 *   offsets            [o0, o1]，整数；页面可改写
 *   maxDepth           0..p0*p1-1 的整数；页面可改写
 *   pixels             width*height 项，行优先；每项 [路 1, 路 2]
 *   每路               [[槽, 读数], ...]，最多 4 项、最多 2 个 null；
 *                      槽互异且在 0..p-1；读数为 0..255 整数或 null
 *
 * 观测语义（每路各自）：
 *   槽 s 的读数 = 落在 s 的回波幅度之和。
 *   - 未列槽恰为 0；
 *   - 列为 null 时不约束；
 *   - 列为 255 时表示至少 255；
 *   - 其余列出的值须精确相等。
 *
 * 求解语义：
 *   每像素 0..2 个回波，深度为互异的非负整数（≤ maxDepth），幅度 1..1023；
 *   第 j 路的槽 = (深度 + offsets[j]) mod periods[j]（非负余数）。
 *   先取回波数最少（0→1→2），再枚举该回波数下的全部可行深度组。
 *   解按深度升序排层：层 i 的深度与幅度分别为该组第 i 个回波。
 *
 * 本文件不依赖第三方库，浏览器挂到 self.EchoCore，Node 用 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.EchoCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MAX_DIM = 256;
  var MAX_PERIOD = 127;
  var MIN_PERIOD = 3;
  var MAX_SLOTS = 4;
  var MAX_NULLS = 2;
  var AMP_MIN = 1;
  var AMP_MAX = 1023;
  var SAT = 255;
  var MAX_CAND = MAX_SLOTS * MAX_SLOTS;

  var STATUS = { EMPTY: 0, UNIQUE1: 1, UNIQUE2: 2, MULTI: 3, NONE: 4 };
  var STATUS_LABEL = {
    0: '无回波',
    1: '唯一深度组 · 单层',
    2: '唯一深度组 · 双层',
    3: '多组深度',
    4: '无解',
  };

  function isInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }
  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }
  function mod(v, p) {
    var r = v % p;
    return r < 0 ? r + p : r;
  }

  /* ------------------------------------------------------------------ */
  /* 记录校验                                                             */
  /* ------------------------------------------------------------------ */

  function errorAt(pixelIndex, x, y, lane, slot, entry, message) {
    return {
      pixelIndex: pixelIndex === undefined ? null : pixelIndex,
      x: x === undefined ? null : x,
      y: y === undefined ? null : y,
      lane: lane === undefined ? null : lane,
      slot: slot === undefined ? null : slot,
      entry: entry === undefined ? null : entry,
      message: message,
    };
  }

  function where(x, y) {
    return '像素 (' + x + ', ' + y + ')';
  }

  /**
   * 校验并规范化一份记录。
   * 返回 { ok:true, doc } 或 { ok:false, errors, truncated, totalErrors }
   * doc.pixels 中每路为 [[slot, value|null], ...]，保持原顺序。
   */
  function validateDocument(raw, limit) {
    limit = limit || 64;
    var errors = [];
    var total = 0;
    function push(e) {
      total++;
      if (errors.length < limit) errors.push(e);
    }
    function fail(msg) {
      return {
        ok: false, doc: null,
        errors: [errorAt(null, null, null, null, null, null, msg)],
        truncated: 0, totalErrors: 1,
      };
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('记录须为一个 JSON 对象');
    }
    var width = raw.width, height = raw.height;
    if (!isInt(width) || width < 1 || width > MAX_DIM) {
      return fail('width 须为 1..' + MAX_DIM + ' 的整数（当前 ' + JSON.stringify(raw.width) + '）');
    }
    if (!isInt(height) || height < 1 || height > MAX_DIM) {
      return fail('height 须为 1..' + MAX_DIM + ' 的整数（当前 ' + JSON.stringify(raw.height) + '）');
    }
    var periods = raw.periods;
    if (!Array.isArray(periods) || periods.length !== 2) {
      return fail('periods 须为两个周期组成的数组');
    }
    for (var pi = 0; pi < 2; pi++) {
      if (!isInt(periods[pi]) || periods[pi] < MIN_PERIOD || periods[pi] > MAX_PERIOD) {
        return fail('periods[' + pi + '] 须为 ' + MIN_PERIOD + '..' + MAX_PERIOD + ' 的整数（当前 ' + JSON.stringify(periods[pi]) + '）');
      }
    }
    if (gcd(periods[0], periods[1]) !== 1) {
      return fail('两个周期必须互素（当前 ' + periods[0] + ' 与 ' + periods[1] + '，最大公约数 ' + gcd(periods[0], periods[1]) + '）');
    }
    var p0 = periods[0], p1 = periods[1];
    var product = p0 * p1;

    var offsets = raw.offsets;
    if (!Array.isArray(offsets) || offsets.length !== 2 || !isInt(offsets[0]) || !isInt(offsets[1])) {
      return fail('offsets 须为两个整数');
    }
    if (Math.abs(offsets[0]) > 1000000 || Math.abs(offsets[1]) > 1000000) {
      return fail('offsets 各项绝对值不得超过 1000000');
    }

    var maxDepth = raw.maxDepth;
    if (!isInt(maxDepth) || maxDepth < 0) {
      return fail('maxDepth 须为非负整数（当前 ' + JSON.stringify(raw.maxDepth) + '）');
    }
    if (maxDepth >= product) {
      return fail('maxDepth 须小于两周期乘积 ' + product + '（当前 ' + maxDepth + '）');
    }

    var pixels = raw.pixels;
    if (!Array.isArray(pixels)) {
      return fail('pixels 须为数组');
    }
    var expected = width * height;
    if (pixels.length !== expected) {
      return fail('pixels 数量 ' + pixels.length + ' 与 width×height = ' + expected + ' 不符');
    }

    var outPixels = new Array(expected);
    for (var idx = 0; idx < expected; idx++) {
      var x = idx % width;
      var y = (idx / width) | 0;
      var px = pixels[idx];
      if (!Array.isArray(px) || px.length !== 2) {
        push(errorAt(idx, x, y, null, null, null, where(x, y) + '：须为 [路 1, 路 2] 两个数组'));
        outPixels[idx] = [[], []];
        continue;
      }
      var lanesOut = new Array(2);
      for (var laneI = 0; laneI < 2; laneI++) {
        var lane = px[laneI];
        var p = laneI === 0 ? p0 : p1;
        var laneLabel = where(x, y) + ' 第 ' + (laneI + 1) + ' 路';
        if (!Array.isArray(lane)) {
          push(errorAt(idx, x, y, laneI, null, null, laneLabel + '：须为槽数组'));
          lanesOut[laneI] = [];
          continue;
        }
        if (lane.length > MAX_SLOTS) {
          push(errorAt(idx, x, y, laneI, null, null, laneLabel + '：列出 ' + lane.length + ' 槽，超过每路 ' + MAX_SLOTS + ' 槽上限'));
        }
        var seen = Object.create(null);
        var nulls = 0;
        var kept = [];
        for (var e = 0; e < lane.length; e++) {
          var item = lane[e];
          if (!Array.isArray(item) || item.length !== 2) {
            push(errorAt(idx, x, y, laneI, null, e, laneLabel + ' 第 ' + (e + 1) + ' 项：须为 [槽, 读数]'));
            continue;
          }
          var slot = item[0], value = item[1];
          var slotOk = isInt(slot) && slot >= 0 && slot < p;
          if (!slotOk) {
            push(errorAt(idx, x, y, laneI, slot, e, laneLabel + ' 第 ' + (e + 1) + ' 项：槽 ' + JSON.stringify(slot) + ' 超出 0..' + (p - 1)));
          } else if (seen[slot]) {
            push(errorAt(idx, x, y, laneI, slot, e, laneLabel + '：槽 ' + slot + ' 重复（第 ' + (e + 1) + ' 项）'));
          } else {
            seen[slot] = true;
          }
          if (value === null) {
            nulls++;
            if (nulls > MAX_NULLS) {
              push(errorAt(idx, x, y, laneI, slotOk ? slot : null, e,
                laneLabel + '：第 ' + nulls + ' 处 null' + (slotOk ? '（槽 ' + slot + '）' : '') + '，每路最多 ' + MAX_NULLS + ' 处'));
            }
          } else if (!isInt(value) || value < 0 || value > 255) {
            push(errorAt(idx, x, y, laneI, slotOk ? slot : null, e,
              laneLabel + (slotOk ? ' 槽 ' + slot : ' 第 ' + (e + 1) + ' 项') + '：读数须为 0..255 的整数或 null（当前 ' + JSON.stringify(value) + '）'));
          }
          if (slotOk) kept.push([slot, value === null ? null : value]);
        }
        lanesOut[laneI] = kept;
      }
      outPixels[idx] = lanesOut;
    }

    if (total > 0) {
      return {
        ok: false, doc: null,
        errors: errors, truncated: Math.max(0, total - errors.length), totalErrors: total,
      };
    }
    return {
      ok: true,
      errors: [], truncated: 0, totalErrors: 0,
      doc: {
        width: width,
        height: height,
        periods: [p0, p1],
        offsets: [offsets[0], offsets[1]],
        maxDepth: maxDepth,
        pixels: outPixels,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* 求解器（零分配内循环）                                                */
  /* ------------------------------------------------------------------ */

  // CRT 查找表：下标 r0*p1+r1，值为 [0, p0*p1) 内满足两个余数的最小非负整数。
  var crtCache = { key: '', table: null };
  function crtTable(p0, p1) {
    var key = p0 + ':' + p1;
    if (crtCache.key === key) return crtCache.table;
    var table = new Int32Array(p0 * p1);
    for (var d = 0; d < p0 * p1; d++) table[(d % p0) * p1 + (d % p1)] = d;
    crtCache = { key: key, table: table };
    return table;
  }

  // 一条路的紧凑状态。槽数 ≤ 4，用 touched 清空。
  function newLane(p) {
    return {
      p: p,
      present: new Uint8Array(p),
      val: new Int16Array(p),      // -1 = null；0..255 其余
      posFlag: new Uint8Array(p),  // 读数 > 0
      touched: new Int32Array(MAX_SLOTS),
      touchedN: 0,
      occ: new Int32Array(MAX_SLOTS), // 读数 > 0 或 null 的槽：回波可能的落点
      occN: 0,
      posCount: 0,
    };
  }

  function laneReset(L) {
    for (var i = 0; i < L.touchedN; i++) {
      var s = L.touched[i];
      L.present[s] = 0;
      L.val[s] = -1;
      L.posFlag[s] = 0;
    }
    L.touchedN = 0;
    L.occN = 0;
    L.posCount = 0;
  }

  function laneLoad(L, lane) {
    for (var i = 0; i < lane.length; i++) {
      var s = lane[i][0];
      var v = lane[i][1];
      var val = v === null ? -1 : v;
      L.present[s] = 1;
      L.val[s] = val;
      L.touched[L.touchedN++] = s;
      if (val > 0) {
        L.posFlag[s] = 1;
        L.posCount++;
        L.occ[L.occN++] = s;
      } else if (val < 0) {
        L.occ[L.occN++] = s;
      }
      // 精确 0：求和必须为 0，回波不能落在这里，也不进候选。
    }
  }

  function makeSolver(p0, p1, off0, off1, maxDepth) {
    return {
      p0: p0, p1: p1, off0: mod(off0, p0), off1: mod(off1, p1), maxDepth: maxDepth,
      table: crtTable(p0, p1),
      L0: newLane(p0),
      L1: newLane(p1),
      cands: new Int32Array(MAX_CAND),
      candN: 0,
      // 每路两条回波分别记为 A、B；scratch 布局：
      // [aLo, aHi, bLo, bHi, sumExact(-1 无), sumLower]
      cA: new Float64Array(6),
      cB: new Float64Array(6),
      lastOne: new Int32Array(3),
      lastTwo: new Int32Array(6),
    };
  }

  // 两回波在一条路上的约束。可行返回 true，否则 false。
  function laneTwoInto(L, s1, s2, out) {
    out[0] = AMP_MIN; out[1] = AMP_MAX; out[2] = AMP_MIN; out[3] = AMP_MAX;
    out[4] = -1; out[5] = 0;
    if (s1 === s2) {
      if (L.posCount > (L.posFlag[s1] ? 1 : 0)) return false;
      if (!L.present[s1]) return false;
      var v = L.val[s1];
      if (v === 0) return false;
      if (v < 0) return true;
      if (v === SAT) { out[5] = SAT; return true; }
      if (v < 2) return false;   // 两个 ≥1 的幅度之和至少 2
      out[4] = v;
      return true;
    }
    if (L.posCount > (L.posFlag[s1] ? 1 : 0) + (L.posFlag[s2] ? 1 : 0)) return false;
    if (!L.present[s1] || !L.present[s2]) return false;
    var v1 = L.val[s1], v2 = L.val[s2];
    if (v1 === 0 || v2 === 0) return false;
    if (v1 > 0) { if (v1 === SAT) out[0] = SAT; else { out[0] = v1; out[1] = v1; } }
    if (v2 > 0) { if (v2 === SAT) out[2] = SAT; else { out[2] = v2; out[3] = v2; } }
    return true;
  }

  // 合并两路约束，把结果写进 scratch。可行返回 true。
  var _m = new Float64Array(4);
  function combineTwo(A, B, out) {
    var lo0 = AMP_MIN, hi0 = AMP_MAX, lo1 = AMP_MIN, hi1 = AMP_MAX;
    var sumExact = -1, sumLower = 0;
    for (var i = 0; i < 2; i++) {
      var r = i === 0 ? A : B;
      if (r[4] >= 0) {
        if (sumExact >= 0 && sumExact !== r[4]) return false;
        sumExact = r[4];
      }
      if (r[5] > sumLower) sumLower = r[5];
      var lo = r[0] > lo0 ? r[0] : lo0;
      var hi = r[1] < hi0 ? r[1] : hi0;
      if (lo > hi) return false;
      lo0 = lo; hi0 = hi;
      lo = r[2] > lo1 ? r[2] : lo1;
      hi = r[3] < hi1 ? r[3] : hi1;
      if (lo > hi) return false;
      lo1 = lo; hi1 = hi;
    }
    if (sumExact >= 0) {
      if (sumExact < sumLower) return false;
      var A0 = Math.max(lo0, sumExact - hi1);
      var B0 = Math.min(hi0, sumExact - lo1);
      if (A0 > B0) return false;
      var lo2 = sumExact - B0;
      var hi2 = sumExact - A0;
      if (lo2 < AMP_MIN || hi2 > AMP_MAX || lo2 > hi2) return false;
      out[0] = A0; out[1] = B0; out[2] = lo2; out[3] = hi2;
      return true;
    }
    if (sumLower > 0) {
      if (hi0 + hi1 < sumLower) return false;
      var nlo0 = Math.max(lo0, sumLower - hi1);
      var nlo1 = Math.max(lo1, sumLower - hi0);
      if (nlo0 > hi0 || nlo1 > hi1) return false;
      lo0 = nlo0; lo1 = nlo1;
    }
    out[0] = lo0; out[1] = hi0; out[2] = lo1; out[3] = hi1;
    return true;
  }

  function preparePixel(S, pixel) {
    laneReset(S.L0);
    laneReset(S.L1);
    laneLoad(S.L0, pixel[0] || []);
    laneLoad(S.L1, pixel[1] || []);
  }

  // 收集该像素可能达到的深度（≤ maxDepth），升序去重。
  function candidates(S) {
    var L0 = S.L0, L1 = S.L1, table = S.table, p1 = S.p1;
    var n = 0, cands = S.cands;
    for (var i = 0; i < L0.occN; i++) {
      var base = mod(L0.occ[i] - S.off0, S.p0) * p1;
      for (var j = 0; j < L1.occN; j++) {
        var d = table[base + mod(L1.occ[j] - S.off1, p1)];
        if (d > S.maxDepth) continue;
        var dup = false;
        for (var k = 0; k < n; k++) { if (cands[k] === d) { dup = true; break; } }
        if (!dup) cands[n++] = d;
      }
    }
    for (var a = 1; a < n; a++) {
      var v = cands[a], b = a - 1;
      while (b >= 0 && cands[b] > v) { cands[b + 1] = cands[b]; b--; }
      cands[b + 1] = v;
    }
    S.candN = n;
    return n;
  }

  // 单回波在某路的读数约束：返回 0 不可行；1 只给下界（null）；2 至少 255；
  // 3..1023 精确值。
  function laneOne(L, s) {
    if (!L.present[s]) return 0;
    var v = L.val[s];
    if (v === 0) return 0;
    if (L.posCount > (L.posFlag[s] ? 1 : 0)) return 0;
    if (v < 0) return 1;
    if (v === SAT) return 2;
    return v;
  }

  /**
   * 解一个已装载的像素。
   * emit=true 收集全部深度组；false 只记第一组与计数（全图快算用）。
   */
  function solvePrepared(S, emit, groups) {
    var L0 = S.L0, L1 = S.L1;
    if (L0.posCount === 0 && L1.posCount === 0) {
      return { kind: 'empty', minEchoes: 0, groupCount: 0, candCount: 0, first: null };
    }
    var n = candidates(S);
    var cands = S.cands;
    var oneCount = 0;
    var firstOne = null;

    for (var i = 0; i < n; i++) {
      var d = cands[i];
      var c0 = laneOne(L0, mod(d + S.off0, S.p0));
      if (c0 === 0) continue;
      var c1 = laneOne(L1, mod(d + S.off1, S.p1));
      if (c1 === 0) continue;
      var lo = c0 === 1 ? AMP_MIN : (c0 === 2 ? SAT : c0);
      var hi = (c0 === 1) ? AMP_MAX : (c0 === 2 ? AMP_MAX : c0);
      var bLo = c1 === 1 ? AMP_MIN : (c1 === 2 ? SAT : c1);
      var bHi = (c1 === 1) ? AMP_MAX : (c1 === 2 ? AMP_MAX : c1);
      if (bLo > lo) lo = bLo;
      if (bHi < hi) hi = bHi;
      if (lo > hi) continue;
      oneCount++;
      if (emit) groups.push({ depths: [d], amps: [[lo, hi]] });
      else if (firstOne === null) {
        firstOne = [d, lo, hi];
      }
    }
    if (oneCount > 0) {
      return {
        kind: oneCount === 1 ? 'unique' : 'multi',
        minEchoes: 1, groupCount: oneCount, candCount: n,
        first: firstOne,
      };
    }

    var twoCount = 0;
    var firstTwo = null;
    var cA = S.cA, cB = S.cB, bound = _m;
    for (var a = 0; a < n - 1; a++) {
      var d1 = cands[a];
      var a0 = mod(d1 + S.off0, S.p0);
      var a1 = mod(d1 + S.off1, S.p1);
      for (var b = a + 1; b < n; b++) {
        var d2 = cands[b];
        var b0 = mod(d2 + S.off0, S.p0);
        var b1 = mod(d2 + S.off1, S.p1);
        if (!laneTwoInto(L0, a0, b0, cA)) continue;
        if (!laneTwoInto(L1, a1, b1, cB)) continue;
        if (!combineTwo(cA, cB, bound)) continue;
        twoCount++;
        if (emit) {
          groups.push({
            depths: [d1, d2],
            amps: [[bound[0], bound[1]], [bound[2], bound[3]]],
          });
        } else if (firstTwo === null) {
          firstTwo = [d1, d2, bound[0], bound[1], bound[2], bound[3]];
        }
      }
    }
    if (twoCount > 0) {
      return {
        kind: twoCount === 1 ? 'unique' : 'multi',
        minEchoes: 2, groupCount: twoCount, candCount: n,
        first: firstTwo,
      };
    }
    return { kind: 'none', minEchoes: null, groupCount: 0, candCount: n, first: null };
  }

  /* ------------------------------------------------------------------ */
  /* 全图求解                                                             */
  /* ------------------------------------------------------------------ */

  function solveAll(doc, params, onChunk) {
    var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    var t0 = now();
    var offsets = (params && params.offsets) ? params.offsets : doc.offsets;
    var maxDepth = (params && params.maxDepth !== undefined) ? params.maxDepth : doc.maxDepth;
    var p0 = doc.periods[0], p1 = doc.periods[1];
    var S = makeSolver(p0, p1, offsets[0], offsets[1], maxDepth);
    var n = doc.width * doc.height;
    var status = new Uint8Array(n);
    var layer0 = new Uint16Array(n);
    var layer1 = new Uint16Array(n);
    var counts = { empty: 0, unique1: 0, unique2: 0, multi: 0, none: 0 };
    var pixels = doc.pixels;

    for (var i = 0; i < n; i++) {
      preparePixel(S, pixels[i]);
      var r = solvePrepared(S, false, null);
      if (r.kind === 'empty') {
        status[i] = STATUS.EMPTY; counts.empty++;
      } else if (r.kind === 'none') {
        status[i] = STATUS.NONE; counts.none++;
      } else if (r.kind === 'multi') {
        status[i] = STATUS.MULTI; counts.multi++;
      } else if (r.minEchoes === 1) {
        status[i] = STATUS.UNIQUE1; counts.unique1++;
        layer0[i] = r.first[0] + 1;
      } else {
        status[i] = STATUS.UNIQUE2; counts.unique2++;
        layer0[i] = r.first[0] + 1;
        layer1[i] = r.first[1] + 1;
      }
    }
    var t1 = now();
    var result = {
      width: doc.width, height: doc.height,
      periods: [p0, p1], offsets: [mod(offsets[0], p0), mod(offsets[1], p1)],
      rawOffsets: [offsets[0], offsets[1]], maxDepth: maxDepth,
      status: status, layer0: layer0, layer1: layer1,
      counts: counts, elapsedMs: t1 - t0,
    };
    if (onChunk) onChunk(result);
    return result;
  }

  // 分块版本：每块让出主线程，避免满额图卡住界面。
  // onDone(res) / onProgress(frac)；返回句柄 { cancel() }，用于改参数时丢弃旧任务。
  function solveAllAsync(doc, params, onDone, onProgress) {
    var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    var t0 = now();
    var offsets = (params && params.offsets) ? params.offsets : doc.offsets;
    var maxDepth = (params && params.maxDepth !== undefined) ? params.maxDepth : doc.maxDepth;
    var p0 = doc.periods[0], p1 = doc.periods[1];
    var S = makeSolver(p0, p1, offsets[0], offsets[1], maxDepth);
    var n = doc.width * doc.height;
    var status = new Uint8Array(n);
    var layer0 = new Uint16Array(n);
    var layer1 = new Uint16Array(n);
    var counts = { empty: 0, unique1: 0, unique2: 0, multi: 0, none: 0 };
    var pixels = doc.pixels;
    var i = 0;
    var cancelled = false;
    var CHUNK = 4096;
    function step() {
      if (cancelled) return;
      var end = Math.min(n, i + CHUNK);
      for (; i < end; i++) {
        preparePixel(S, pixels[i]);
        var r = solvePrepared(S, false, null);
        if (r.kind === 'empty') {
          status[i] = STATUS.EMPTY; counts.empty++;
        } else if (r.kind === 'none') {
          status[i] = STATUS.NONE; counts.none++;
        } else if (r.kind === 'multi') {
          status[i] = STATUS.MULTI; counts.multi++;
        } else if (r.minEchoes === 1) {
          status[i] = STATUS.UNIQUE1; counts.unique1++;
          layer0[i] = r.first[0] + 1;
        } else {
          status[i] = STATUS.UNIQUE2; counts.unique2++;
          layer0[i] = r.first[0] + 1;
          layer1[i] = r.first[1] + 1;
        }
      }
      if (cancelled) return;
      if (i < n) {
        if (onProgress) onProgress(i / n);
        setTimeout(step, 0);
      } else {
        onDone({
          width: doc.width, height: doc.height,
          periods: [p0, p1], offsets: [mod(offsets[0], p0), mod(offsets[1], p1)],
          rawOffsets: [offsets[0], offsets[1]], maxDepth: maxDepth,
          status: status, layer0: layer0, layer1: layer1,
          counts: counts, elapsedMs: now() - t0,
        });
      }
    }
    setTimeout(step, 0);
    return { cancel: function () { cancelled = true; } };
  }

  /* ------------------------------------------------------------------ */
  /* 单像素详情                                                           */
  /* ------------------------------------------------------------------ */

  function solvePixelDetail(doc, index, params) {
    var p0 = doc.periods[0], p1 = doc.periods[1];
    var offsets = (params && params.offsets) ? params.offsets : doc.offsets;
    var maxDepth = (params && params.maxDepth !== undefined) ? params.maxDepth : doc.maxDepth;
    var S = makeSolver(p0, p1, offsets[0], offsets[1], maxDepth);
    preparePixel(S, doc.pixels[index]);
    var groups = [];
    var res = solvePrepared(S, true, groups);
    res.groups = groups;
    res.offsets = [mod(offsets[0], p0), mod(offsets[1], p1)];
    res.rawOffsets = [offsets[0], offsets[1]];
    res.maxDepth = maxDepth;
    res.pixel = index;
    res.x = index % doc.width;
    res.y = (index / doc.width) | 0;
    res.lanes = doc.pixels[index];
    res.periods = [p0, p1];
    res.candDepths = [];
    for (var i = 0; i < S.candN; i++) res.candDepths.push(S.cands[i]);
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 详情聚合：按层汇总全部深度组的深度与幅度上下界                        */
  /* ------------------------------------------------------------------ */

  function layerSummary(detail) {
    if (detail.kind !== 'unique' && detail.kind !== 'multi') {
      return { layers: [], groupCount: 0 };
    }
    var k = detail.minEchoes;
    var layers = [];
    for (var i = 0; i < k; i++) {
      layers.push({ dLo: Infinity, dHi: -Infinity, aLo: Infinity, aHi: -Infinity });
    }
    for (var g = 0; g < detail.groups.length; g++) {
      var grp = detail.groups[g];
      for (var j = 0; j < k; j++) {
        var L = layers[j];
        var d = grp.depths[j];
        var amp = grp.amps[j];
        if (d < L.dLo) L.dLo = d;
        if (d > L.dHi) L.dHi = d;
        if (amp[0] < L.aLo) L.aLo = amp[0];
        if (amp[1] > L.aHi) L.aHi = amp[1];
      }
    }
    return { layers: layers, groupCount: detail.groups.length };
  }

  /* ------------------------------------------------------------------ */
  /* 16 位 P5（PGM）编码                                                  */
  /* ------------------------------------------------------------------ */

  function encodePGM16(width, height, data) {
    var header = 'P5\n' + width + ' ' + height + '\n65535\n';
    var out = new Uint8Array(header.length + width * height * 2);
    for (var i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
    var o = header.length;
    for (var p = 0; p < width * height; p++) {
      var v = data[p] || 0;
      out[o++] = (v >> 8) & 255;
      out[o++] = v & 255;
    }
    return out;
  }

  function exportLayers(result) {
    return {
      layer0: encodePGM16(result.width, result.height, result.layer0),
      layer1: encodePGM16(result.width, result.height, result.layer1),
    };
  }

  return {
    MAX_DIM: MAX_DIM, MAX_PERIOD: MAX_PERIOD, MIN_PERIOD: MIN_PERIOD,
    MAX_SLOTS: MAX_SLOTS, MAX_NULLS: MAX_NULLS,
    AMP_MIN: AMP_MIN, AMP_MAX: AMP_MAX, STATUS: STATUS, STATUS_LABEL: STATUS_LABEL,
    validateDocument: validateDocument,
    solveAll: solveAll,
    solveAllAsync: solveAllAsync,
    solvePixelDetail: solvePixelDetail,
    layerSummary: layerSummary,
    encodePGM16: encodePGM16,
    exportLayers: exportLayers,
    mod: mod,
    gcd: gcd,
  };
});
