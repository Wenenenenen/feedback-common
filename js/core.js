/*
 * 反 3:2 下拉 —— 纯计算核心（不依赖 DOM）。
 *
 * 输入：N 帧灰度画面。每帧由两场交错组成：偶数行 = 上场（top），奇数行 = 下场（bottom）。
 *
 * 判定依据只有两条，都按场自身的垂直细节归一化，因此与画面明暗、对比度无关：
 *   1. 梳齿分 cross(t,b)：若上、下场来自同一格胶片画面，把下场当作缺失行去预测上场
 *      （反之亦然）会非常准；来自不同时刻的两场则误差很大。
 *   2. 重复分 dup(t1,t2)：3:2 下拉会把同一个场重复显示，两个场几乎逐像素相同。
 *
 * 用这两个分数在 2N 个场之间建立“同源”边，用并查集合并成“格”（cell）。
 * 合并时施加真实 3:2 下拉必然满足的形态约束：每格 ≤3 场、每种场 ≤2 个、跨 ≤2 帧。
 *
 * 场序不靠整段假设：把每一格看作时间轴上一段连续的场，相邻帧的场序必须让
 * 跨这两帧的格落在连续时间槽上。约束是局部的，因此剪辑点、半路换场序都能重新锁定。
 * 纯隔行段两场互不同源，自然落成 interlaced，不参与胶片格。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PCR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    combThreshold: 1.2,   // 归一化梳齿分低于此值视为同源（实测同源≈0.52，异源≥4）
    dupThreshold: 0.06,   // 归一化重复分低于此值视为同一场的重复（示例中重复场差 0，隔行相邻场≥0.14）
    searchWindow: 3,      // 场与场之间最多允许相距多少个视频帧
    maxCellFields: 3,     // 3:2 下拉中一格的场数上限
    maxCellSpan: 1,       // 一格的场最多跨几个视频帧
    switchPenalty: 8,     // 无约束时相邻帧换场序的代价（用于剪辑点之外的平局裁决）
    viewWidth: 96         // 度量视图的列数上限（按列降采样，保留行结构）
  };

  var TFF = 0, BFF = 1;

  function mergeOptions(o) {
    var r = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) r[k] = DEFAULTS[k];
    if (o) for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* 度量视图                                                            */
  /* ------------------------------------------------------------------ */

  /* 按列分组取均值，保留完整行结构（行结构是梳齿检测的关键）。 */
  function makeView(pixels, width, height, rowStart, rowStep, stepX) {
    var rows = Math.ceil((height - rowStart) / rowStep);
    var w = Math.max(1, Math.floor(width / stepX));
    var data = new Float32Array(rows * w);
    var inv = 1 / stepX;
    for (var y = 0; y < rows; y++) {
      var src = (rowStart + y * rowStep) * width;
      var dst = y * w;
      for (var x = 0; x < w; x++) {
        var base = src + x * stepX;
        var s = 0;
        for (var k = 0; k < stepX; k++) s += pixels[base + k];
        data[dst + x] = s * inv;
      }
    }
    return { w: w, h: rows, data: data };
  }

  function meanAbsolute(a, b) {
    var n = Math.min(a.length, b.length), s = 0;
    for (var i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
    return n ? s / n : 0;
  }

  /* 场自身的垂直平滑度（行预测残差），作为归一化尺度。 */
  function selfResidual(v) {
    var w = v.w, h = v.h, d = v.data, s = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      var r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
      for (var x = 0; x < w; x++) {
        s += Math.abs(d[r1 + x] - (d[r0 + x] + d[r2 + x]) * 0.5);
        n++;
      }
    }
    return n ? s / n : 0;
  }

  function deviation(v) {
    var d = v.data, n = d.length, mean = 0, i;
    if (!n) return 0;
    for (i = 0; i < n; i++) mean += d[i];
    mean /= n;
    var s = 0;
    for (i = 0; i < n; i++) s += Math.abs(d[i] - mean);
    return s / n;
  }

  /*
   * 两场是否来自同一格同一时刻：
   *   t[y] 应接近 (b[y-1]+b[y])/2，b[y] 应接近 (t[y]+t[y+1])/2。
   * 返回平均绝对残差（未归一化）。
   */
  function combResidual(t, b) {
    var w = t.w, h = Math.min(t.h, b.h), td = t.data, bd = b.data;
    if (h < 3) return 0;
    var s = 0, n = 0, y, x;
    for (y = 1; y < h; y++) {
      var r0 = (y - 1) * w, r1 = y * w;
      for (x = 0; x < w; x++) {
        s += Math.abs(td[r1 + x] - (bd[r0 + x] + bd[r1 + x]) * 0.5);
        n++;
      }
    }
    for (y = 0; y < h - 1; y++) {
      var s0 = y * w, s1 = (y + 1) * w;
      for (x = 0; x < w; x++) {
        s += Math.abs(bd[s0 + x] - (td[s0 + x] + td[s1 + x]) * 0.5);
        n++;
      }
    }
    return n ? s / n : 0;
  }

  function buildModel(frames, width, height, opts) {
    var N = frames.length;
    var stepX = Math.max(1, Math.floor(width / opts.viewWidth));
    if (stepX > 1 && width % stepX !== 0) {
      /* 让宽度能被整除，避免最后几列被丢弃 */
      while (stepX > 1 && width % stepX !== 0) stepX--;
    }
    var top = new Array(N), bottom = new Array(N);
    var topSelf = new Float32Array(N), botSelf = new Float32Array(N);
    var topDev = new Float32Array(N), botDev = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var t = makeView(frames[i], width, height, 0, 2, stepX);
      var b = makeView(frames[i], width, height, 1, 2, stepX);
      top[i] = t; bottom[i] = b;
      topSelf[i] = selfResidual(t);
      botSelf[i] = selfResidual(b);
      topDev[i] = deviation(t);
      botDev[i] = deviation(b);
    }
    return {
      width: width, height: height, count: N, stepX: stepX,
      top: top, bottom: bottom,
      topSelf: topSelf, bottomSelf: botSelf,
      topDev: topDev, bottomDev: botDev
    };
  }

  function makeScorer(model, opts) {
    function norm(a, b) { return Math.max(opts.minCombScale || 0.75, (a + b) * 0.5); }
    return {
      crossTB: function (i, j) {
        return combResidual(model.top[i], model.bottom[j]) / norm(model.topSelf[i], model.bottomSelf[j]);
      },
      crossBT: function (i, j) {
        return combResidual(model.bottom[i], model.top[j]) / norm(model.bottomSelf[i], model.topSelf[j]);
      },
      dupT: function (i, j) {
        return meanAbsolute(model.top[i].data, model.top[j].data) / norm(model.topDev[i], model.topDev[j]);
      },
      dupB: function (i, j) {
        return meanAbsolute(model.bottom[i].data, model.bottom[j].data) / norm(model.bottomDev[i], model.bottomDev[j]);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 场 → 格                                                             */
  /* ------------------------------------------------------------------ */

  function buildCells(model, opts, scorer) {
    var N = model.count, W = opts.searchWindow, i, j;
    var links = [];
    for (i = 0; i < N; i++) {
      for (j = Math.max(0, i - W); j <= Math.min(N - 1, i + W); j++) {
        links.push({ score: scorer.crossTB(i, j), kind: 'TB', i: i, j: j });
        links.push({ score: scorer.crossBT(i, j), kind: 'BT', i: i, j: j });
      }
      for (j = i + 1; j <= Math.min(N - 1, i + W); j++) {
        links.push({ score: scorer.dupT(i, j), kind: 'TT', i: i, j: j });
        links.push({ score: scorer.dupB(i, j), kind: 'BB', i: i, j: j });
      }
    }
    links.sort(function (a, b) { return a.score - b.score; });

    var parent = new Int32Array(2 * N);
    var members = new Array(2 * N);
    for (i = 0; i < 2 * N; i++) { parent[i] = i; members[i] = [i]; }
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function shapeOk(ms) {
      if (ms.length > opts.maxCellFields) return false;
      var tops = 0, bots = 0, minF = Infinity, maxF = -Infinity;
      for (var k = 0; k < ms.length; k++) {
        var node = ms[k], f = node >> 1;
        if (node & 1) bots++; else tops++;
        if (f < minF) minF = f;
        if (f > maxF) maxF = f;
      }
      if (tops > 2 || bots > 2) return false;
      return maxF - minF <= opts.maxCellSpan;
    }

    var accepted = [];
    for (var li = 0; li < links.length; li++) {
      var l = links[li];
      var lim = (l.kind === 'TB' || l.kind === 'BT') ? opts.combThreshold : opts.dupThreshold;
      if (l.score > lim) continue;
      var a, b;
      if (l.kind === 'TB') { a = 2 * l.i; b = 2 * l.j + 1; }
      else if (l.kind === 'BT') { a = 2 * l.i + 1; b = 2 * l.j; }
      else if (l.kind === 'TT') { a = 2 * l.i; b = 2 * l.j; }
      else { a = 2 * l.i + 1; b = 2 * l.j + 1; }
      var ra = find(a), rb = find(b);
      if (ra === rb) continue;
      if (!shapeOk(members[ra].concat(members[rb]))) continue;
      parent[rb] = ra;
      members[ra] = members[ra].concat(members[rb]);
      accepted.push(l);
    }

    var rootToCell = {};
    var cells = [];
    for (i = 0; i < 2 * N; i++) {
      var r = find(i);
      if (rootToCell[r] === undefined) {
        rootToCell[r] = cells.length;
        cells.push({ id: cells.length, fields: [], topFrames: [], botFrames: [] });
      }
      var c = cells[rootToCell[r]];
      var f = i >> 1, parity = (i & 1) ? 'bottom' : 'top';
      c.fields.push({ frame: f, parity: parity });
      if (i & 1) c.botFrames.push(f); else c.topFrames.push(f);
    }
    cells.forEach(function (c) {
      c.topFrames.sort(function (a, b) { return a - b; });
      c.botFrames.sort(function (a, b) { return a - b; });
      c.fields.sort(function (a, b) {
        return a.frame - b.frame || (a.parity === 'top' ? 0 : 1) - (b.parity === 'top' ? 0 : 1);
      });
      c.minFrame = Math.min.apply(null, c.fields.map(function (x) { return x.frame; }));
      c.maxFrame = Math.max.apply(null, c.fields.map(function (x) { return x.frame; }));
      c.hasTop = c.topFrames.length > 0;
      c.hasBottom = c.botFrames.length > 0;
      c.linked = c.fields.length > 1;
      c.kind = c.hasTop && c.hasBottom ? 'film' : 'orphan';
    });

    var fieldCell = new Int32Array(2 * N).fill(-1);
    cells.forEach(function (c) {
      c.fields.forEach(function (x) {
        fieldCell[2 * x.frame + (x.parity === 'bottom' ? 1 : 0)] = c.id;
      });
    });
    return { cells: cells, fieldCell: fieldCell, links: accepted };
  }

  function classifyFrames(model, cellInfo) {
    var N = model.count, cells = cellInfo.cells, fc = cellInfo.fieldCell;
    var state = new Array(N);
    for (var i = 0; i < N; i++) {
      var tl = cells[fc[2 * i]].linked, bl = cells[fc[2 * i + 1]].linked;
      state[i] = tl && bl ? 'film' : (!tl && !bl ? 'interlaced' : 'orphan');
    }
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* 场序求解                                                            */
  /* ------------------------------------------------------------------ */
  /*
   * 第 i 帧：TFF 时上场在 2i、下场在 2i+1；BFF 时相反。
   * 一个格的所有场必须占据连续且互不重复的时间槽——这是 3:2 下拉的定义。
   * 跨帧的格只在相邻两帧内，于是每一处帧边界都能导出一组允许的 (o[i-1], o[i])。
   * 用一条链上的动态规划求解；没有约束的边界按“保持上一个场序”处理。
   */
  function slotOf(frame, parity, order) {
    var topFirst = order === TFF;
    if (parity === 'top') return 2 * frame + (topFirst ? 0 : 1);
    return 2 * frame + (topFirst ? 1 : 0);
  }

  function cellsContiguous(c, o0, o1) {
    var slots = c.fields.map(function (f) {
      return slotOf(f.frame, f.parity, f.frame === c.minFrame ? o0 : o1);
    });
    slots.sort(function (a, b) { return a - b; });
    for (var k = 1; k < slots.length; k++) {
      if (slots[k] === slots[k - 1]) return false;
      if (slots[k] !== slots[k - 1] + 1) return false;
    }
    return true;
  }

  function solveOrder(model, cellInfo, frameStates, opts) {
    var N = model.count, cells = cellInfo.cells;
    /* 每个边界 b（b-1 | b）允许的场序组合 */
    var allowed = new Array(N + 1);
    for (var b = 0; b <= N; b++) allowed[b] = null;
    var hasSpanning = new Uint8Array(N + 1); /* 有格跨过该边界 */

    cells.forEach(function (c) {
      if (c.fields.length < 2) return;
      if (c.minFrame !== c.maxFrame) hasSpanning[c.maxFrame] = 1;
      if (c.maxFrame === c.minFrame) return;
      var lo = c.minFrame, hi = c.maxFrame; /* hi = lo + 1 */
      var ok = [];
      for (var a = 0; a < 2; a++) {
        for (var d = 0; d < 2; d++) {
          if (cellsContiguousAcross(c, a, d)) ok.push([a, d]);
        }
      }
      if (!ok.length) ok = [[0, 0]];
      if (allowed[hi]) {
        allowed[hi] = allowed[hi].filter(function (p) {
          return ok.some(function (q) { return q[0] === p[0] && q[1] === p[1]; });
        });
        if (!allowed[hi].length) allowed[hi] = ok;
      } else {
        allowed[hi] = ok;
      }
    });

    /*
     * 切换场序的代价：
     *   - 边界上有格跨过：3:2 下拉里换序会破坏那格的连续时间槽，约束本身通常已排除；
     *     仍允许但代价高。
     *   - 边界是结构断点（前后帧的判定不同，例如胶片段接隔行段）：换序几乎免费，
     *     新素材本来就可以有自己的场序。
     *   - 其他边界：中等代价，但不鼓励在节奏内部抖动。
     * 平局时倾向“晚切换”，把节奏内部的模糊帧留在前一段。
     */
    var SPAN_SWITCH = 120;
    var BREAK_SWITCH = 1;
    var FREE_SWITCH = 25;
    var LATE_EPS = 0.0001;

    var INF = 1e12;
    var dp = [INF, INF, INF, INF];
    var history = new Array(N);
    for (var s = 0; s < 4; s++) {
      var o0 = s >> 1, o1 = s & 1;
      if (o0 === o1) dp[s] = 0;
    }
    history[0] = null;

    for (var i = 1; i < N; i++) {
      var nd = [INF, INF, INF, INF];
      var from = [-1, -1, -1, -1];
      var allow = allowed[i];
      var structural = frameStates[i] !== frameStates[i - 1];
      var base = structural ? BREAK_SWITCH : (hasSpanning[i] ? SPAN_SWITCH : FREE_SWITCH);
      for (var key = 0; key < 4; key++) {
        if (dp[key] >= INF) continue;
        var curO = key & 1;
        for (var next = 0; next < 2; next++) {
          if (allow && !allow.some(function (p) { return p[0] === curO && p[1] === next; })) continue;
          var add = curO === next ? 0 : base + LATE_EPS * (N - i);
          var nkey = curO * 2 + next;
          if (dp[key] + add < nd[nkey]) { nd[nkey] = dp[key] + add; from[nkey] = key; }
        }
      }
      if (nd.every(function (v) { return v >= INF; })) {
        for (var key2 = 0; key2 < 4; key2++) {
          if (dp[key2] >= INF) continue;
          for (var nx2 = 0; nx2 < 2; nx2++) {
            var nk2 = (key2 & 1) * 2 + nx2;
            var add2 = (key2 & 1) === nx2 ? 0 : base + LATE_EPS * (N - i);
            if (dp[key2] + add2 < nd[nk2]) { nd[nk2] = dp[key2] + add2; from[nk2] = key2; }
          }
        }
      }
      dp = nd;
      history[i] = from;
    }

    var bestKey = 0, bestVal = dp[0];
    for (var k = 1; k < 4; k++) if (dp[k] < bestVal) { bestVal = dp[k]; bestKey = k; }
    var order = new Array(N);
    order[N - 1] = bestKey & 1;
    if (N > 1) order[N - 2] = bestKey >> 1;
    var st = bestKey;
    for (var i2 = N - 1; i2 >= 1; i2--) {
      var fr = history[i2];
      if (!fr || fr[st] < 0) break;
      st = fr[st];
      if (i2 - 2 >= 0) order[i2 - 2] = st >> 1;
    }
    for (var z = 0; z < N; z++) if (order[z] === undefined) order[z] = z > 0 ? order[z - 1] : TFF;

    /*
     * 后处理一：纯隔行帧没有任何格约束场序，标签本身不带信息。
     * 按相邻胶片帧的场序补上（优先取后面那一段），都没有就用 TFF。
     */
    for (var r0 = 0; r0 < N; r0++) {
      if (frameStates[r0] !== 'interlaced') continue;
      var r1 = r0;
      while (r1 + 1 < N && frameStates[r1 + 1] === 'interlaced') r1++;
      var val;
      if (r1 + 1 < N) val = order[r1 + 1];
      else if (r0 - 1 >= 0) val = order[r0 - 1];
      else val = TFF;
      for (var rk = r0; rk <= r1; rk++) order[rk] = val;
      r0 = r1;
    }

    /*
     * 后处理二：场序切换应落在“素材断点”上，而不是它前一帧。
     * 若某个换序点紧挨着结构断点（例如胶片段 → 隔行段），把换序挪到断点那一帧。
     */
    for (var b2 = 1; b2 < N; b2++) {
      if (order[b2] === order[b2 - 1]) continue;
      if (frameStates[b2] !== frameStates[b2 - 1]) continue;
      if (b2 + 1 < N && frameStates[b2 + 1] !== frameStates[b2]) {
        order[b2] = order[b2 - 1];
      }
    }

    /*
     * 后处理三：两场同源的帧（同一格的两场落在同一帧里）在两种场序下占据同样
     * 的时间槽，像素上也完全一样，标签本身不可观测。参考约定把它划给新的一段：
     * 换序点由这一帧自己开始。若它正好在换序点前且不跨结构断点，就并到新的一段。
     */
    function isFreeFrame(f) {
      var fc = cellInfo.fieldCell;
      if (fc[2 * f] !== fc[2 * f + 1]) return false;
      var c = cellInfo.cells[fc[2 * f]];
      return c.fields.length === 2 && c.minFrame === f && c.maxFrame === f;
    }
    for (var b3 = 1; b3 < N; b3++) {
      if (order[b3] === order[b3 - 1] || !isFreeFrame(b3 - 1)) continue;
      if (frameStates[b3] !== frameStates[b3 - 1]) continue;
      var trial = order.slice();
      trial[b3 - 1] = order[b3];
      if (cellsAllContiguous(cells, trial)) order[b3 - 1] = order[b3];
    }

    /* 统计节奏被约束是否被满足 */
    var unsatisfied = 0;
    cells.forEach(function (c) {
      if (c.fields.length < 2) return;
      var slots = assignSlots(c, order);
      for (var k2 = 1; k2 < slots.length; k2++) {
        if (slots[k2] !== slots[k2 - 1] + 1) { unsatisfied++; break; }
      }
    });

    return {
      orders: order, hasSpanning: hasSpanning,
      unsatisfied: unsatisfied, cost: bestVal
    };
  }

  function cellsContiguousAcross(c, oMin, oMax) {
    var slots = c.fields.map(function (f) {
      return slotOf(f.frame, f.parity, f.frame === c.minFrame ? oMin : oMax);
    });
    slots.sort(function (a, b) { return a - b; });
    for (var k = 1; k < slots.length; k++) {
      if (slots[k] !== slots[k - 1] + 1) return false;
    }
    return true;
  }

  function cellsAllContiguous(cells, order) {
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.fields.length < 2) continue;
      var slots = assignSlots(c, order);
      for (var k = 1; k < slots.length; k++) {
        if (slots[k] !== slots[k - 1] + 1) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 每个场的匹配报告                                                    */
  /* ------------------------------------------------------------------ */

  function describeField(model, scorer, cellInfo, frame, parity, opts) {
    var W = opts.searchWindow, best = null, second = null, dup = null, i;
    for (i = Math.max(0, frame - W); i <= Math.min(model.count - 1, frame + W); i++) {
      var s = parity === 'top' ? scorer.crossTB(frame, i) : scorer.crossBT(frame, i);
      var cand = { score: s, frame: i };
      if (!best || cand.score < best.score) { second = best; best = cand; }
      else if (!second || cand.score < second.score) second = cand;
    }
    for (i = Math.max(0, frame - W); i <= Math.min(model.count - 1, frame + W); i++) {
      if (i === frame) continue;
      var d = parity === 'top' ? scorer.dupT(frame, i) : scorer.dupB(frame, i);
      if (!dup || d < dup.score) dup = { score: d, frame: i };
    }
    var cellId = cellInfo.fieldCell[2 * frame + (parity === 'bottom' ? 1 : 0)];
    var cell = cellInfo.cells[cellId];
    return {
      parity: parity,
      best: best,
      second: second,
      dup: dup,
      sameSource: !!best && best.score <= opts.combThreshold,
      duplicated: !!dup && dup.score <= opts.dupThreshold,
      cellId: cellId,
      linked: cell.linked
    };
  }

  /* ------------------------------------------------------------------ */
  /* 时间槽分配与输出                                                    */
  /* ------------------------------------------------------------------ */

  function assignSlots(cell, orders) {
    var slots = cell.fields.map(function (f) { return slotOf(f.frame, f.parity, orders[f.frame]); });
    slots.sort(function (a, b) { return a - b; });
    return slots;
  }

  /*
   * 3:2 节奏：连续胶片格的场数应在 2 与 3 之间交替（2 场 = 24 格素材占 2 个视频帧，
   * 3 场 = 占 3 个）。孤立场与隔行帧会打断交替；用局部拟合找出相位，
   * 并把不跟随交替的格标出来，方便界面显示“节奏在这里断开/重新锁定”。
   */
  /*
   * 3:2 下拉的场数节奏是 2、3 交替：一格胶片画面要么占 2 个场（同一视频帧的上、下场），
   * 要么占 3 个场（跨到下一视频帧）。
   *
   * 不假设整段同一个相位：从左到右贪心锁定——每一格必须与前一格交替（2↔3）。
   * 一旦不交替（连续两个 2、连续两个 3、孤场、隔行段），就在下一格重新锁定。
   * 这样剪辑点、换场序、隔行插播都会自然形成新的节奏段，而不会被整段套用相位。
   */
  /*
   * 3:2 下拉的场数节奏是 2、3 交替：一格胶片画面要么占 2 个场（本视频帧的上、下场），
   * 要么占 3 个场（还要跨到下一视频帧）。孤场少了一场，不占相位步。
   *
   * 节奏不整段套用：以“场序段”为边界重新锁定相位。场序变化本身就意味着换了一段素材，
   * 新素材的节奏相位与之前无关；纯隔行段同理。每一段内用最小失配数拟合起始相位，
   * 并逐格标出是否符合 2/3 交替（不符合的通常是剪辑切残的格）。
   */
  function annotateCadence(outputs, orders) {
    var phase = new Array(outputs.length).fill(null);
    var ok = new Array(outputs.length).fill(null);
    var runOf = new Array(outputs.length).fill(-1);
    var runs = [];
    var cur = null;

    function expectAt(run) {
      var even = (run.step & 1) === 0;
      return run.firstSize === 2 ? (even ? 2 : 3) : (even ? 3 : 2);
    }
    function open(idx, size) {
      cur = {
        id: runs.length,
        startOutput: idx, endOutput: idx,
        startFrame: outputs[idx].minFrame, endFrame: outputs[idx].maxFrame,
        firstSize: size, step: 0, length: 0, mismatches: 0
      };
      runs.push(cur);
      note(idx, size === 2 ? 0 : 1, true);
      cur.step++;
    }
    function note(idx, ph, good) {
      phase[idx] = ph;
      ok[idx] = good;
      runOf[idx] = cur.id;
      cur.endOutput = idx;
      cur.endFrame = outputs[idx].maxFrame;
      cur.length++;
      if (good === false) cur.mismatches++;
    }
    /* 该格之后是不是素材结构断点（隔行段或场序改变） */
    function structuralAfter(idx) {
      if (idx + 1 >= outputs.length) return true;
      var a = outputs[idx], b = outputs[idx + 1];
      if (b.type === 'interlaced') return true;
      return orders[a.minFrame] !== orders[b.minFrame];
    }
    function structuralBefore(idx) {
      if (idx === 0) return true;
      var a = outputs[idx - 1], b = outputs[idx];
      if (a.type === 'interlaced') return true;
      return orders[a.minFrame] !== orders[b.minFrame];
    }

    for (var i = 0; i < outputs.length; i++) {
      var o = outputs[i];
      if (o.type === 'interlaced') { cur = null; continue; }
      if (!cur) { open(i, o.slotCount >= 2 ? o.slotCount : 2); continue; }

      if (o.slotCount < 2) {
        /*
         * 孤场：这一格丢掉一场，原本占 2 还是 3 场不可知。它不判对错，
         * 但 3:2 节奏仍在继续，所以让它占一步（按 2 场算），后面的格据此对齐。
         */
        var expect = expectAt(cur);
        note(i, null, null);
        cur.step++;
        continue;
      }

      var exp = expectAt(cur);
      if (o.slotCount === exp) { note(i, exp === 2 ? 0 : 1, true); cur.step++; continue; }

      /*
       * 不跟随交替：多半是素材被剪辑切残的最后一格（下一格就要换素材了）。
       * 这种情况标成“节奏不规则”，但不另起一段；否则确实是节奏在这里重锁，
       * 从这一格开始新的一段。
       */
      if (structuralAfter(i)) {
        note(i, exp === 2 ? 0 : 1, false);
        cur.step++;
      } else {
        open(i, o.slotCount);
      }
    }
    runs.forEach(function (r) { delete r.step; });
    return { phase: phase, ok: ok, runOf: runOf, runs: runs, reLockedAt: runs.map(function (r) { return r.startFrame; }) };
  }

  /* ------------------------------------------------------------------ */
  /* 场内插补（孤场与隔行去隔行）                                        */
  /* ------------------------------------------------------------------ */

  /*
   * 边导向插值：缺失行由上下两行生成垂直、左下/右上、右下/左上三个候选，
   * 选局部梯度最小的方向，比单纯垂直平均少锯齿。
   * field 为紧凑存储（只有已存在的行），rowStart 为第一行在整幅画面中的位置（0 或 1）。
   */
  function interpolateField(field, width, rows, rowStart, height) {
    var out = new Float32Array(width * height);
    var present = new Uint8Array(height);
    for (var y = rowStart; y < height; y += 2) {
      var idx = (y - rowStart) >> 1;
      present[y] = 1;
      out.set(field.subarray(idx * width, idx * width + width), y * width);
    }
    for (var yy = 0; yy < height; yy++) {
      if (present[yy]) continue;
      var hasUp = yy - 1 >= 0 && present[yy - 1];
      var hasDown = yy + 1 < height && present[yy + 1];
      if (!hasUp && !hasDown) continue;
      if (!hasUp) { out.copyWithin(yy * width, (yy + 1) * width, (yy + 2) * width); continue; }
      if (!hasDown) { out.copyWithin(yy * width, (yy - 1) * width, yy * width); continue; }
      for (var x = 0; x < width; x++) {
        var xm = x > 0 ? x - 1 : 0, xp = x < width - 1 ? x + 1 : width - 1;
        var a = out[(yy - 1) * width + x], b = out[(yy + 1) * width + x];
        var aL = out[(yy - 1) * width + xm], aR = out[(yy - 1) * width + xp];
        var bL = out[(yy + 1) * width + xm], bR = out[(yy + 1) * width + xp];
        var gV = Math.abs(a - b), gL = Math.abs(aL - bR), gR = Math.abs(aR - bL);
        var v;
        if (gV <= gL && gV <= gR) v = (a + b) * 0.5;
        else if (gL <= gR) v = (aL + bR) * 0.5;
        else v = (aR + bL) * 0.5;
        out[yy * width + x] = v;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 主流程                                                              */
  /* ------------------------------------------------------------------ */

  function analyze(input) {
    var opts = mergeOptions(input.options);
    var width = input.width, height = input.height, frames = input.frames, N = frames.length;
    if (!N) throw new Error('没有可分析的帧');

    var model = buildModel(frames, width, height, opts);
    var scorer = makeScorer(model, opts);
    var cellInfo = buildCells(model, opts, scorer);
    var cells = cellInfo.cells;
    var frameStates = classifyFrames(model, cellInfo);
    var orderInfo = solveOrder(model, cellInfo, frameStates, opts);
    var orders = orderInfo.orders;

    /* 场的匹配报告 */
    var fieldReports = new Array(N);
    for (var f = 0; f < N; f++) {
      fieldReports[f] = {
        frame: f,
        top: describeField(model, scorer, cellInfo, f, 'top', opts),
        bottom: describeField(model, scorer, cellInfo, f, 'bottom', opts)
      };
    }

    /* 输出画面：所有不是“只由隔行帧构成”的格，加上每个隔行帧 */
    var cellOutputs = [];
    cells.forEach(function (c) {
      var allInterlaced = c.fields.every(function (x) { return frameStates[x.frame] === 'interlaced'; });
      if (allInterlaced) return;
      var slots = assignSlots(c, orders);
      cellOutputs.push({
        /* 孤场在时间线上仍是这一格画面，只是缺一场；对外统一记作 film，
           用 exact=false + interpolated 标明是哪一侧补出来的。 */
        type: 'film',
        cellKind: c.kind,
        cellId: c.id,
        key: slots[0],
        slots: slots,
        slotCount: slots.length,
        topFrames: c.topFrames.slice(),
        botFrames: c.botFrames.slice(),
        fields: c.fields.slice(),
        minFrame: c.minFrame,
        maxFrame: c.maxFrame
      });
    });
    for (var fi = 0; fi < N; fi++) {
      if (frameStates[fi] !== 'interlaced') continue;
      cellOutputs.push({
        type: 'interlaced',
        cellId: -1,
        key: 2 * fi,
        slots: [2 * fi, 2 * fi + 1],
        slotCount: 2,
        frame: fi,
        topFrames: [fi],
        botFrames: [fi],
        fields: [{ frame: fi, parity: 'top' }, { frame: fi, parity: 'bottom' }],
        minFrame: fi, maxFrame: fi
      });
    }
    cellOutputs.sort(function (a, b) {
      if (a.key !== b.key) return a.key - b.key;
      if (a.type === 'interlaced' && b.type !== 'interlaced') return 1;
      if (b.type === 'interlaced' && a.type !== 'interlaced') return -1;
      return 0;
    });

    var cadence = annotateCadence(cellOutputs, orders);


    /*
     * 每个输出实际使用的配对分数：
     *  - 两场齐全：直接算这两场的梳齿分（比“窗口内最佳”更能说明这一格的判源依据）；
     *  - 孤场：只有一场，记 null，界面按插补处理；
     *  - 纯隔行：记两场各自最好的异源匹配分，说明“为什么拼不起来”。
     */
    function pairScore(topFrame, bottomFrame) {
      if (topFrame === null || bottomFrame === null) return null;
      return scorer.crossTB(topFrame, bottomFrame);
    }

    var outputs = cellOutputs.map(function (o, idx) {
      var refFrame = o.type === 'interlaced' ? o.frame : (o.topFrames.length ? o.topFrames[0] : o.botFrames[0]);
      var order = orders[refFrame];
      var exact = o.type === 'film' && o.topFrames.length > 0 && o.botFrames.length > 0;
      var interp = null;
      if (o.type === 'film' && !exact) interp = o.topFrames.length ? 'bottom' : 'top';
      var topFrame = o.topFrames.length ? o.topFrames[0] : null;
      var bottomFrame = o.botFrames.length ? o.botFrames[0] : null;
      var score = o.type === 'interlaced' ? null : pairScore(topFrame, bottomFrame);
      return {
        index: idx,
        type: o.type,
        /* 时间键：场上时间槽（每视频帧两个槽）。用于排序与和时间轴对齐。 */
        key: o.key,
        slots: o.slots,
        slotCount: o.slotCount,
        /* 使用了哪一帧的哪一场 */
        topFrame: topFrame,
        bottomFrame: bottomFrame,
        score: score,
        sourceFrame: refFrame,
        order: order === TFF ? 'tff' : 'bff',
        exact: o.type === 'film' ? exact : null,
        interpolated: interp,
        cadencePhase: cadence.phase[idx],
        cadenceOk: cadence.ok[idx],
        cadenceRun: cadence.runOf[idx],
        minFrame: o.minFrame,
        maxFrame: o.maxFrame
      };
    });

    /* 场序分段 */
    var orderRuns = [];
    for (var oi = 0; oi < N; oi++) {
      var name = orders[oi] === TFF ? 'tff' : 'bff';
      if (orderRuns.length && orderRuns[orderRuns.length - 1].order === name) {
        orderRuns[orderRuns.length - 1].end = oi;
      } else {
        orderRuns.push({ start: oi, end: oi, order: name });
      }
    }

    /*
     * 结构断点（可观测、可复核的“重新锁定”位置）：
     *   - 场序改变（换成了另一种场序的素材分区）；
     *   - 3:2 节奏重新锁定（新的一段节奏开始）；
     *   - 进入纯隔行段。
     * 这些点都不需要知道真实剪辑点在哪里，只要保证不把相位整段套过去。
     */
    var reLock = [];
    for (var r1 = 1; r1 < N; r1++) if (orders[r1] !== orders[r1 - 1]) reLock.push({ frame: r1, reason: 'order' });
    cadence.runs.forEach(function (run, ri) {
      if (ri === 0) return;
      reLock.push({ frame: run.startFrame, reason: 'cadence' });
    });
    for (var r2 = 0; r2 < N; r2++) {
      if (frameStates[r2] === 'interlaced' && (r2 === 0 || frameStates[r2 - 1] !== 'interlaced')) {
        reLock.push({ frame: r2, reason: 'interlaced-start' });
      }
    }
    reLock.sort(function (a, b) { return a.frame - b.frame; });
    /* 同一帧可能同时触发多个原因，合并成一条 */
    var merged = [];
    reLock.forEach(function (r) {
      var prev = merged[merged.length - 1];
      if (prev && prev.frame === r.frame) {
        if (prev.reason.indexOf(r.reason) < 0) prev.reason += '+' + r.reason;
      } else {
        merged.push({ frame: r.frame, reason: r.reason });
      }
    });
    reLock = merged;

    /* 孤场（只有一场的格） */
    var orphans = outputs
      .filter(function (o) { return o.type === 'film' && o.interpolated; })
      .map(function (o) {
        return {
          outputIndex: o.index,
          sourceFrame: o.sourceFrame,
          topFrame: o.topFrame,
          bottomFrame: o.bottomFrame,
          missing: o.interpolated,
          present: o.interpolated === 'bottom' ? 'top' : 'bottom'
        };
      });

    return {
      width: width, height: height, frameCount: N, options: opts,
      cells: cells.map(function (c) {
        return {
          id: c.id, kind: c.kind, linked: c.linked,
          topFrames: c.topFrames, botFrames: c.botFrames,
          fields: c.fields, minFrame: c.minFrame, maxFrame: c.maxFrame
        };
      }),
      fieldReports: fieldReports,
      frameStates: frameStates,
      orders: orders.slice(),
      orderRuns: orderRuns,
      reLock: reLock,
      orphans: orphans,
      outputs: outputs,
      cadence: cadence,
      unsatisfiedCells: orderInfo.unsatisfied
    };
  }

  /* ------------------------------------------------------------------ */
  /* 还原画面                                                            */
  /* ------------------------------------------------------------------ */

  function rawField(frames, frame, parity, width, height) {
    var src = frames[frame];
    var start = parity === 'top' ? 0 : 1;
    var rows = Math.ceil((height - start) / 2);
    var out = new Float32Array(width * rows);
    for (var y = 0; y < rows; y++) {
      var srcRow = (start + 2 * y) * width;
      for (var x = 0; x < width; x++) out[y * width + x] = src[srcRow + x];
    }
    return { data: out, rows: rows };
  }

  /*
   * 渲染一个输出画面。
   *   film（两场齐全）→ 逐像素拼回；
   *   film（孤场）    → 已有的一场 + 场内插值补另一场；
   *   interlaced      → 上、下场各做场内插值，再按行取用，得到去隔行画面。
   */
  function renderOutput(input, analysis, output) {
    var w = input.width, h = input.height, frames = input.frames;
    var pixels = new Uint8ClampedArray(w * h);
    var y, x, k;

    if (output.type === 'interlaced') {
      /*
       * 两个场来自不同时刻，织在一起会把两个时间点叠进同一幅画面（正是要避免的梳齿/台阶）。
       * 所以只用上场单独插值成整幅，时间上是一致的；下半行由场内边导向插值补出。
       */
      var f = output.sourceFrame === null || output.sourceFrame === undefined ? output.frame : output.sourceFrame;
      var tf = rawField(frames, f, 'top', w, h);
      var tFull = interpolateField(tf.data, w, tf.rows, 0, h);
      for (k = 0; k < pixels.length; k++) pixels[k] = tFull[k];
      return { pixels: pixels, note: 'interlaced', field: 'top' };
    }

    var hasTop = output.topFrame !== null && output.topFrame !== undefined;
    var hasBottom = output.bottomFrame !== null && output.bottomFrame !== undefined;
    if (hasTop && hasBottom) {
      var top = rawField(frames, output.topFrame, 'top', w, h).data;
      var bot = rawField(frames, output.bottomFrame, 'bottom', w, h).data;
      var tRows = Math.ceil(h / 2), bRows = Math.floor(h / 2);
      for (y = 0; y < tRows; y++) for (x = 0; x < w; x++) pixels[(2 * y) * w + x] = top[y * w + x];
      for (y = 0; y < bRows; y++) for (x = 0; x < w; x++) pixels[(2 * y + 1) * w + x] = bot[y * w + x];
      return { pixels: pixels, note: 'exact' };
    }
    var haveParity = hasTop ? 'top' : 'bottom';
    var frame = hasTop ? output.topFrame : output.bottomFrame;
    var field = rawField(frames, frame, haveParity, w, h);
    var full = interpolateField(field.data, w, field.rows, haveParity === 'top' ? 0 : 1, h);
    for (k = 0; k < pixels.length; k++) pixels[k] = full[k];
    return { pixels: pixels, note: 'interpolated-' + haveParity };
  }

  /* ------------------------------------------------------------------ */
  /* 彩色还原（素材为 RGB 时使用）                                       */
  /* ------------------------------------------------------------------ */

  function rawFieldRGB(frames, frame, parity, width, height) {
    var src = frames[frame];
    var start = parity === 'top' ? 0 : 1;
    var rows = Math.ceil((height - start) / 2);
    var out = new Float32Array(width * rows * 3);
    for (var y = 0; y < rows; y++) {
      var srcRow = (start + 2 * y) * width;
      for (var x = 0; x < width; x++) {
        var si = (srcRow + x) * 3, di = (y * width + x) * 3;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
      }
    }
    return { data: out, rows: rows };
  }

  /* 对三通道分别做与灰度相同的边导向插值 */
  function interpolateFieldRGB(field, width, rows, rowStart, height) {
    var planes = [];
    for (var c = 0; c < 3; c++) {
      var plane = new Float32Array(width * rows);
      for (var i = 0; i < rows * width; i++) plane[i] = field[i * 3 + c];
      planes.push(plane);
    }
    var fulls = planes.map(function (p) { return interpolateField(p, width, rows, rowStart, height); });
    var out = new Uint8ClampedArray(width * height * 3);
    for (var k = 0; k < width * height; k++) {
      out[k * 3] = fulls[0][k];
      out[k * 3 + 1] = fulls[1][k];
      out[k * 3 + 2] = fulls[2][k];
    }
    return out;
  }

  /*
   * 与 renderOutput 相同的时间结构，但输出 RGB。
   * input.rgbFrames 为每帧的 RGB 数组（每像素 3 字节）。
   */
  function renderOutputRGB(input, analysis, output) {
    var w = input.width, h = input.height, rgbFrames = input.rgbFrames;
    if (!rgbFrames) return null;
    var y, x, k;

    if (output.type === 'interlaced') {
      var f = output.sourceFrame;
      var tf = rawFieldRGB(rgbFrames, f, 'top', w, h);
      return interpolateFieldRGB(tf.data, w, tf.rows, 0, h);
    }

    var hasTop = output.topFrame !== null && output.topFrame !== undefined;
    var hasBottom = output.bottomFrame !== null && output.bottomFrame !== undefined;
    if (hasTop && hasBottom) {
      var top = rawFieldRGB(rgbFrames, output.topFrame, 'top', w, h).data;
      var bot = rawFieldRGB(rgbFrames, output.bottomFrame, 'bottom', w, h).data;
      var out = new Uint8ClampedArray(w * h * 3);
      var tRows = Math.ceil(h / 2), bRows = Math.floor(h / 2);
      for (y = 0; y < tRows; y++) {
        for (x = 0; x < w * 3; x++) out[(2 * y) * w * 3 + x] = top[y * w * 3 + x];
      }
      for (y = 0; y < bRows; y++) {
        for (x = 0; x < w * 3; x++) out[(2 * y + 1) * w * 3 + x] = bot[y * w * 3 + x];
      }
      return out;
    }
    var haveParity = hasTop ? 'top' : 'bottom';
    var frame = hasTop ? output.topFrame : output.bottomFrame;
    var field = rawFieldRGB(rgbFrames, frame, haveParity, w, h);
    return interpolateFieldRGB(field.data, w, field.rows, haveParity === 'top' ? 0 : 1, h);
  }

  return {
    analyze: analyze,
    renderOutput: renderOutput,
    renderOutputRGB: renderOutputRGB,
    rawField: rawField,
    interpolateField: interpolateField,
    defaults: DEFAULTS,
    slotOf: slotOf
  };
});
