/**
 * 接力回放自动导播 —— 求解器
 *
 * 数据约定：拍（beat）在数据层一律使用 0 基索引（与样例 JSON 一致），
 * UI 展示拍号时转换为 1 基。
 *
 * 成本模型（每拍）：
 *   必拍矩形必须完整落入镜头安全框（四边内缩 inset，贴边也算入镜），否则该镜头不可用；
 *   可选矩形未入镜则累加其权重作为漏拍代价。
 * 切换（相邻两拍之间）：
 *   同镜头 = 0 代价；存在有向跟拍边 = 边代价；否则为硬切，代价 cutCost，
 *   且相邻两次硬切的拍索引差必须 >= cutGap。
 * 目标：整段总成本最低；同价时取镜头编号（按 shots 声明顺序的 0 基序号）
 *   序列字典序最小。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReplayDirector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BEATS = 240;
  var MAX_SHOTS = 24;

  function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

  function asBox(v, ctx) {
    if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) {
      throw new Error(ctx + ' 矩形必须是 4 个数字 [左, 上, 右, 下]');
    }
    return v.slice();
  }

  /** 包含判定，恰好贴边也算完整入镜 */
  function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1] &&
           inner[2] <= outer[2] && inner[3] <= outer[3];
  }

  /** 安全框 = 镜头矩形四边内缩 inset */
  function safeFrame(shot, inset) {
    return [shot[0] + inset, shot[1] + inset, shot[2] - inset, shot[3] - inset];
  }

  /**
   * 校验并预计算模型：安全框、每拍每个镜头的可行性与漏拍代价。
   * 输入非法时直接抛 Error。
   */
  function buildModel(input) {
    if (!input || typeof input !== 'object') throw new Error('输入必须是对象');
    if (!input.shots || typeof input.shots !== 'object') throw new Error('缺少 shots 镜头表');

    var shotIds = Object.keys(input.shots);
    if (shotIds.length === 0) throw new Error('shots 不能为空');
    if (shotIds.length > MAX_SHOTS) throw new Error('候选镜头最多 ' + MAX_SHOTS + ' 个');

    var shotRects = shotIds.map(function (id) {
      var r = asBox(input.shots[id], 'shots.' + id);
      if (!(r[2] > r[0] && r[3] > r[1])) {
        throw new Error('shots.' + id + ' 矩形无效：右需大于左、下需大于上');
      }
      return r;
    });

    var inset = input.inset == null ? 0 : input.inset;
    if (!isNum(inset) || inset < 0) throw new Error('inset 必须是非负数字');
    var cutCost = input.cutCost == null ? 1 : input.cutCost;
    if (!isNum(cutCost)) throw new Error('cutCost 必须是数字');
    var cutGap = input.cutGap == null ? 1 : input.cutGap;
    if (!isNum(cutGap) || cutGap <= 0) throw new Error('cutGap 必须是正数');

    var follow = new Map();
    (input.follow || []).forEach(function (e, k) {
      if (!Array.isArray(e) || e.length !== 3 || !isNum(e[2])) {
        throw new Error('follow[' + k + '] 必须是 [起镜, 目标镜头, 代价]');
      }
      if (shotIds.indexOf(e[0]) < 0 || shotIds.indexOf(e[1]) < 0) {
        throw new Error('follow[' + k + '] 引用了未知镜头 ' + e[0] + ' -> ' + e[1]);
      }
      var key = e[0] + ' ' + e[1];
      if (!follow.has(key) || e[2] < follow.get(key)) follow.set(key, e[2]);
    });

    if (!Array.isArray(input.beats)) throw new Error('缺少 beats 数组');
    if (input.beats.length > MAX_BEATS) throw new Error('最多支持 ' + MAX_BEATS + ' 拍');

    var beats = input.beats.map(function (b, bi) {
      if (!b || typeof b !== 'object') throw new Error('beats[' + bi + '] 必须是对象');
      var required = (b.required || []).map(function (x) {
        return asBox(x, 'beats[' + bi + '].required');
      });
      var optional = (b.optional || []).map(function (o, oi) {
        if (!o || !Array.isArray(o.box)) {
          throw new Error('beats[' + bi + '].optional[' + oi + '] 缺少 box');
        }
        return {
          box: asBox(o.box, 'beats[' + bi + '].optional[' + oi + '].box'),
          weight: isNum(o.weight) ? o.weight : 0
        };
      });
      return { required: required, optional: optional };
    });

    var safe = shotRects.map(function (r) { return safeFrame(r, inset); });

    var perBeat = beats.map(function (b) {
      var options = shotIds.map(function (id, si) {
        var frame = safe[si];
        var feasible = b.required.every(function (req) { return contains(frame, req); });
        var missed = [];
        var missCost = 0;
        if (feasible) {
          b.optional.forEach(function (o) {
            if (!contains(frame, o.box)) {
              missed.push(o);
              missCost += o.weight;
            }
          });
        }
        return {
          idx: si, id: id, feasible: feasible,
          missed: missed, missCost: feasible ? missCost : null
        };
      });
      return { options: options, eligible: options.filter(function (o) { return o.feasible; }) };
    });

    return {
      shotIds: shotIds, shotRects: shotRects, safe: safe,
      inset: inset, cutCost: cutCost, cutGap: cutGap,
      follow: follow, beats: beats, perBeat: perBeat
    };
  }

  function normalizeLocks(model, locksArg) {
    var map = new Map();
    var warnings = [];
    if (!locksArg) return { map: map, warnings: warnings };
    Object.keys(locksArg).forEach(function (k) {
      var bi = Number(k);
      if (!Number.isInteger(bi) || bi < 0 || bi >= model.beats.length) {
        warnings.push('锁定拍索引 ' + k + ' 超出范围（共 ' + model.beats.length + ' 拍），已忽略');
        return;
      }
      var si = model.shotIds.indexOf(locksArg[k]);
      if (si < 0) {
        warnings.push('锁定的镜头 ' + locksArg[k] + ' 不存在，已忽略');
        return;
      }
      map.set(bi, si);
    });
    return { map: map, warnings: warnings };
  }

  /**
   * 一层节点用平行 TypedArray 存储，避免海量小对象：
   * shot/lastCut/parent/parentRank/rank 为整数，cost 为浮点。
   * parent 是上一层的局部索引。
   */
  function makeLayer(cap) {
    return {
      len: 0,
      shot: new Int16Array(cap),
      lastCut: new Int32Array(cap),
      cost: new Float64Array(cap),
      parent: new Int32Array(cap),
      parentRank: new Int32Array(cap),
      rank: new Int32Array(cap)
    };
  }

  /** 沿父索引回溯，得到镜头序号序列（长度 n） */
  function traceback(layers, lastLocal) {
    var n = layers.length;
    var seq = new Array(n);
    var local = lastLocal;
    for (var bi = n - 1; bi >= 0; bi--) {
      var L = layers[bi];
      seq[bi] = L.shot[local];
      local = L.parent[local];
    }
    return seq;
  }

  /**
   * 给一层节点按 (shot, 父层 rank) 排序并赋规范排名 rank。
   * 同状态节点在排序前已决出唯一胜者，故同 (shot,lastCut) 只有一个节点。
   */
  function assignRanks(L) {
    var order = new Array(L.len);
    for (var i = 0; i < L.len; i++) order[i] = i;
    order.sort(function (a, b) {
      if (L.shot[a] !== L.shot[b]) return L.shot[a] - L.shot[b];
      return L.parentRank[a] - L.parentRank[b];
    });
    for (var r = 0; r < order.length; r++) L.rank[order[r]] = r;
  }

  function failResult(bi, model, locks, warnings, layers, reason) {
    // 给出可达前缀里成本最低（同价字典序最小）的一条，供界面展示
    var prefix = null;
    if (layers.length) {
      var prev = layers[layers.length - 1];
      if (prev.len) {
        var bestLocal = 0;
        for (var k = 1; k < prev.len; k++) {
          if (prev.cost[k] < prev.cost[bestLocal] ||
              (prev.cost[k] === prev.cost[bestLocal] && prev.rank[k] < prev.rank[bestLocal])) {
            bestLocal = k;
          }
        }
        prefix = {
          shot: prev.shot[bestLocal],
          cost: prev.cost[bestLocal],
          sequenceIdx: traceback(layers, bestLocal)
        };
      }
    }
    return {
      ok: false,
      firstImpossibleBeat: bi,
      reason: reason,
      locks: locks,
      warnings: warnings,
      prefixBest: prefix
    };
  }

  /** 沿最终镜头序列复盘每拍的代价明细 */
  function finalize(seqIdx, model, locks, warnings) {
    var cutBeats = [];
    var cumulative = 0;
    var details = seqIdx.map(function (si, bi) {
      var opt = model.perBeat[bi].options[si];
      var transition = null;
      var transitionCost = 0;
      var fromShot = null;
      if (bi > 0) {
        var prev = seqIdx[bi - 1];
        fromShot = model.shotIds[prev];
        if (si === prev) {
          transition = 'stay';
        } else {
          var edge = model.follow.get(model.shotIds[prev] + ' ' + model.shotIds[si]);
          if (edge !== undefined) {
            transition = 'follow';
            transitionCost = edge;
          } else {
            transition = 'cut';
            transitionCost = model.cutCost;
            cutBeats.push(bi);
          }
        }
      }
      var subtotal = opt.missCost + transitionCost;
      cumulative += subtotal;
      return {
        beat: bi,
        shotIdx: si,
        shot: model.shotIds[si],
        fromShot: fromShot,
        required: model.beats[bi].required.map(function (b) { return b.slice(); }),
        missed: opt.missed.map(function (o) { return { box: o.box.slice(), weight: o.weight }; }),
        missCost: opt.missCost,
        transition: transition,
        transitionCost: transitionCost,
        subtotal: subtotal,
        cumulative: cumulative,
        locked: locks.has(bi)
      };
    });

    return {
      ok: true,
      sequenceIdx: seqIdx,
      sequence: seqIdx.map(function (si) { return model.shotIds[si]; }),
      totalCost: cumulative,
      cutBeats: cutBeats,
      details: details,
      locks: locks,
      warnings: warnings
    };
  }

  /**
   * 动态规划求解。
   * 状态 = (当前镜头, 最近一次硬切的拍索引，-1 表示尚无硬切)。
   * 同状态只保留成本最低、同价按 (镜头序号, 父层规范排名) 字典序最小的节点；
   * 每层结束后赋 rank，使跨层字典序比较退化为 O(1) 的 rank 比较。
   */
  function solve(model, locksArg) {
    var n = model.beats.length;
    var norm = normalizeLocks(model, locksArg);
    var locks = norm.map;
    var warnings = norm.warnings;

    if (n === 0) {
      return { ok: true, sequenceIdx: [], sequence: [], totalCost: 0, cutBeats: [], details: [], locks: locks, warnings: warnings };
    }

    function lockedElse(bi, si) {
      if (locks.has(bi)) return locks.get(bi) === si;
      return true;
    }

    var maxStates = model.shotIds.length * (n + 1);
    var layers = [];

    // 第 0 拍：没有切换代价
    var layer = makeLayer(Math.max(8, model.shotIds.length));
    model.perBeat[0].eligible.forEach(function (o) {
      if (!lockedElse(0, o.idx)) return;
      var local = layer.len++;
      layer.shot[local] = o.idx;
      layer.lastCut[local] = -1;
      layer.cost[local] = o.missCost;
      layer.parent[local] = -1;
      layer.parentRank[local] = -1;
    });
    if (layer.len === 0) {
      var reason0 = locks.has(0) && !model.perBeat[0].options[locks.get(0)].feasible
        ? 'lock-infeasible' : 'no-eligible';
      return failResult(0, model, locks, warnings, layers, reason0);
    }
    assignRanks(layer);
    layers.push(layer);

    for (var bi = 1; bi < n; bi++) {
      var next = makeLayer(Math.max(8, Math.min(maxStates, layer.len * model.shotIds.length)));
      var nextKey = new Map();
      var sawBlockedByGap = false;

      for (var pi = 0; pi < layer.len; pi++) {
        var pShot = layer.shot[pi];
        var pLastCut = layer.lastCut[pi];
        var pCost = layer.cost[pi];
        var pRank = layer.rank[pi];
        var opts = model.perBeat[bi].eligible;
        for (var oi = 0; oi < opts.length; oi++) {
          var o = opts[oi];
          var j = o.idx;
          if (!lockedElse(bi, j)) continue;

          var tCost;
          var lastCut = pLastCut;
          if (j === pShot) {
            tCost = 0;
          } else {
            var edge = model.follow.get(model.shotIds[pShot] + ' ' + model.shotIds[j]);
            if (edge !== undefined) {
              tCost = edge; // 跟拍边，不计硬切
            } else {
              if (pLastCut !== -1 && bi - pLastCut < model.cutGap) {
                // 拍号差未达到 cutGap 下限，硬切不允许
                sawBlockedByGap = true;
                continue;
              }
              tCost = model.cutCost;
              lastCut = bi;
            }
          }

          var cost = pCost + o.missCost + tCost;
          var key = j + ':' + lastCut;
          var existingLocal = nextKey.get(key);

          if (existingLocal === undefined) {
            var nl = next.len++;
            nextKey.set(key, nl);
            next.shot[nl] = j;
            next.lastCut[nl] = lastCut;
            next.cost[nl] = cost;
            next.parent[nl] = pi;
            next.parentRank[nl] = pRank;
          } else if (cost < next.cost[existingLocal] ||
                     (cost === next.cost[existingLocal] && pRank < next.parentRank[existingLocal])) {
            // 同状态 shot 相同，字典序只需比父层 rank
            next.cost[existingLocal] = cost;
            next.lastCut[existingLocal] = lastCut;
            next.parent[existingLocal] = pi;
            next.parentRank[existingLocal] = pRank;
          }
        }
      }

      if (next.len === 0) {
        var reason;
        if (model.perBeat[bi].eligible.length === 0) reason = 'no-eligible';
        else if (locks.has(bi) && !model.perBeat[bi].options[locks.get(bi)].feasible) reason = 'lock-infeasible';
        else if (locks.has(bi)) reason = 'lock-blocked';
        else reason = sawBlockedByGap ? 'cut-gap' : 'no-eligible';
        return failResult(bi, model, locks, warnings, layers, reason);
      }
      assignRanks(next);
      layers.push(next);
      layer = next;
    }

    var bestLocal = 0;
    for (var k = 1; k < layer.len; k++) {
      if (layer.cost[k] < layer.cost[bestLocal] ||
          (layer.cost[k] === layer.cost[bestLocal] && layer.rank[k] < layer.rank[bestLocal])) {
        bestLocal = k;
      }
    }
    var seqIdx = traceback(layers, bestLocal);
    return finalize(seqIdx, model, locks, warnings);
  }

  return {
    MAX_BEATS: MAX_BEATS,
    MAX_SHOTS: MAX_SHOTS,
    contains: contains,
    safeFrame: safeFrame,
    buildModel: buildModel,
    solve: solve
  };
});
