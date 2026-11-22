/*
 * 机器人接力游戏 —— 批量复位选点核心逻辑（浏览器 / Node 通用）
 *
 * 规则：
 * - 距离一律按四邻可通行格的 BFS 最短路径。
 * - 候选点合规条件：队伍限制通过、格子可通行、未被在场机器人占用、能到达公共接力点。
 * - 同批任意两个落点的距离必须 >= minGap（同一候选点也不能重复分配）。
 * - 安全分 = 到最近在场对手的距离，上限 12；没有可达对手时记 12。
 * - 整批比较顺序：最低安全分（大优）→ 总安全分（大优）→ 到各自集合点的总距离（小优）
 *   → 按请求编号顺序比较候选点编号（字典序小优）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RelaySelector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAFETY_CAP = 12;
  var RALLY_PENALTY = 100000; // 集合点不可达时的惩罚距离（不淘汰，只在比较中垫底）
  var NODE_CAP = 2000000;     // 搜索节点上限，防止极端输入卡死页面

  function cellKey(x, y) { return x + ',' + y; }

  // 四邻 BFS 距离场；sources: [[x,y], ...]；只经过可通行格，不可达为 -1
  function bfsField(w, h, walk, sources) {
    var dist = new Int32Array(w * h);
    dist.fill(-1);
    var q = [];
    for (var i = 0; i < sources.length; i++) {
      var x = sources[i][0], y = sources[i][1];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      var s = y * w + x;
      if (dist[s] === -1) { dist[s] = 0; q.push(s); }
    }
    var head = 0;
    while (head < q.length) {
      var cur = q[head++];
      var cx = cur % w, cy = (cur / w) | 0;
      var d = dist[cur] + 1;
      if (cx > 0) relax(cur - 1, d);
      if (cx < w - 1) relax(cur + 1, d);
      if (cy > 0) relax(cur - w, d);
      if (cy < h - 1) relax(cur + w, d);
    }
    function relax(n, nd) {
      if (walk[n] && dist[n] === -1) { dist[n] = nd; q.push(n); }
    }
    return dist;
  }

  function computeSelection(cfg) {
    var errors = [], warnings = [];
    var grid = cfg.grid || [];
    var h = grid.length, w = h ? grid[0].length : 0;
    for (var r = 1; r < h; r++) {
      if (grid[r].length !== w) errors.push('地图第 ' + r + ' 行宽度不一致');
    }
    if (!w || !h) errors.push('地图为空');
    if (errors.length) return { errors: errors, warnings: warnings };
    if (w > 48 || h > 48) warnings.push('地图超过 48×48（实际 ' + w + '×' + h + '）');

    var walk = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) walk[y * w + x] = grid[y][x] !== '#' ? 1 : 0;
    }

    var active = cfg.active || [];
    var requests = cfg.requests || [];
    var sites = cfg.sites || [];
    var minGap = cfg.minGap == null ? 0 : cfg.minGap;
    if (requests.length > 6) warnings.push('同批请求超过 6 个（实际 ' + requests.length + '）');
    if (sites.length > 24) warnings.push('候选点超过 24 个（实际 ' + sites.length + '）');
    if (!cfg.checkpoint) errors.push('缺少公共接力点 checkpoint');
    if (!requests.length) warnings.push('本批没有请求');
    if (errors.length) return { errors: errors, warnings: warnings };

    var occupied = {};
    active.forEach(function (a) { occupied[cellKey(a.xy[0], a.xy[1])] = a.team; });

    var cpField = bfsField(w, h, walk, [cfg.checkpoint]);

    var teams = [];
    requests.forEach(function (rq) { if (teams.indexOf(rq.team) < 0) teams.push(rq.team); });

    // 安全分距离场：对每个队伍，从所有异队在场机器人做多源 BFS
    var safetyField = {};
    teams.forEach(function (t) {
      var opp = active.filter(function (a) { return a.team !== t; })
                      .map(function (a) { return a.xy; });
      safetyField[t] = opp.length ? bfsField(w, h, walk, opp) : null; // null → 全图 12
    });
    // 集合点距离场
    var rallyField = {};
    teams.forEach(function (t) {
      if (cfg.rally && cfg.rally[t]) rallyField[t] = bfsField(w, h, walk, [cfg.rally[t]]);
      else warnings.push('队伍 ' + t + ' 缺少集合点，其集合距离按 0 计');
    });

    function safetyAt(team, x, y) {
      var f = safetyField[team];
      if (!f) return SAFETY_CAP;
      var d = f[y * w + x];
      return d === -1 ? SAFETY_CAP : Math.min(d, SAFETY_CAP);
    }

    // 候选点基础信息（与请求无关）
    var siteInfo = sites.map(function (s) {
      var sx = s.xy[0], sy = s.xy[1];
      var inBounds = sx >= 0 && sy >= 0 && sx < w && sy < h;
      return {
        id: s.id, xy: s.xy, teams: s.teams || [],
        inBounds: inBounds,
        walkable: inBounds && !!walk[sy * w + sx],
        occupiedBy: inBounds ? (occupied[cellKey(sx, sy)] || null) : null,
        distCheckpoint: inBounds ? cpField[sy * w + sx] : -1
      };
    });

    // 每个请求的候选评估（含淘汰原因）
    var reqEvals = requests.map(function (req) {
      var cands = siteInfo.map(function (info) {
        var reasons = [];
        if (info.teams.indexOf(req.team) < 0) reasons.push('队伍限制：不允许 ' + req.team + ' 队');
        if (!info.inBounds) reasons.push('坐标越界');
        else if (!info.walkable) reasons.push('位于不可通行格');
        if (info.occupiedBy) reasons.push('被在场 ' + info.occupiedBy + ' 队机器人占用');
        if (info.inBounds && info.walkable && info.distCheckpoint === -1) reasons.push('无法到达公共接力点');
        var c = { siteId: info.id, xy: info.xy, valid: reasons.length === 0, reasons: reasons };
        if (c.valid) {
          var sx = info.xy[0], sy = info.xy[1];
          c.safety = safetyAt(req.team, sx, sy);
          c.distCheckpoint = info.distCheckpoint;
          var rf = rallyField[req.team];
          if (rf) {
            var d = rf[sy * w + sx];
            c.distRally = d === -1 ? RALLY_PENALTY : d;
            if (d === -1) c.rallyUnreachable = true;
          } else c.distRally = 0;
        }
        return c;
      });
      return {
        id: req.id, team: req.team, candidates: cands,
        validCandidates: cands.filter(function (c) { return c.valid; })
      };
    });
    var evalById = {};
    reqEvals.forEach(function (re) { evalById[re.id] = re; });

    // 候选点两两距离（只对至少对一个请求合规的点建 BFS 场）
    var usable = {};
    reqEvals.forEach(function (re) {
      re.validCandidates.forEach(function (c) { usable[c.siteId] = true; });
    });
    var siteById = {};
    sites.forEach(function (s) { siteById[s.id] = s; });
    var fields = {};
    Object.keys(usable).forEach(function (id) {
      fields[id] = bfsField(w, h, walk, [siteById[id].xy]);
    });
    function pairDist(a, b) {
      var s = siteById[b];
      return fields[a][s.xy[1] * w + s.xy[0]]; // -1 表示不可达
    }
    var conflictEdges = [];
    var usableIds = Object.keys(usable);
    for (var i = 0; i < usableIds.length; i++) {
      for (var j = i + 1; j < usableIds.length; j++) {
        var dd = pairDist(usableIds[i], usableIds[j]);
        if (dd !== -1 && dd < minGap) conflictEdges.push({ a: usableIds[i], b: usableIds[j], dist: dd });
      }
    }

    // ---- 整批搜索 ----
    var reqOrderById = requests.map(function (rq) { return rq.id; }).sort();
    var searchReqs = reqEvals.slice().sort(function (a, b) {
      return a.validCandidates.length - b.validCandidates.length || (a.id < b.id ? -1 : 1);
    });

    var truncated = false;
    function conflictsWithAssigned(c, assign) {
      for (var rid in assign) {
        var d = pairDist(c.siteId, assign[rid].siteId);
        if (d !== -1 && d < minGap) return true;
      }
      return false;
    }

    // 最优解比较：最低安全分 ↓大优、总安全分 ↓大优、集合总距离 ↑小优、点号字典序 ↑小优
    function betterThan(a, b) {
      if (a.minS !== b.minS) return a.minS > b.minS;
      if (a.sumS !== b.sumS) return a.sumS > b.sumS;
      if (a.rallySum !== b.rallySum) return a.rallySum < b.rallySum;
      for (var k = 0; k < reqOrderById.length; k++) {
        var rid = reqOrderById[k];
        var sa = a.assign[rid], sb = b.assign[rid];
        if (sa !== sb) return sa < sb;
      }
      return false;
    }

    // 后缀和：剩余请求乐观情况下最多能贡献的安全分 / 最少能贡献的集合距离（O(1) 查界）
    var nReq = searchReqs.length;
    var sufMaxSafety = new Array(nReq + 1).fill(0);
    var sufMinRally = new Array(nReq + 1).fill(0);
    for (var si = nReq - 1; si >= 0; si--) {
      var svc = searchReqs[si].validCandidates, smx = 0, smn = Infinity;
      for (var su = 0; su < svc.length; su++) {
        if (svc[su].safety > smx) smx = svc[su].safety;
        if (svc[su].distRally < smn) smn = svc[su].distRally;
      }
      sufMaxSafety[si] = sufMaxSafety[si + 1] + smx;
      sufMinRally[si] = sufMinRally[si + 1] + (smn === Infinity ? 0 : smn);
    }

    var best = null, nodes = 0;
    var assigned = {}, usedSite = {};
    function dfs(k, minS, sumS, rally) {
      if (truncated) return;
      if (++nodes > NODE_CAP) {
        truncated = true;
        warnings.push('搜索规模超限，结果为当前最优（可能非全局最优）');
        return;
      }
      if (best) { // 剪枝：部分解已不可能更优
        if (minS < best.minS) return;
        if (minS === best.minS) {
          var optSum = sumS + sufMaxSafety[k];
          if (optSum < best.sumS) return;
          if (optSum === best.sumS) {
            var optRally = rally + sufMinRally[k];
            if (optRally > best.rallySum) return;
            if (optRally === best.rallySum) {
              // 前三项都可能持平，只剩点号字典序：已分配的请求编号前缀若已劣于 best 则剪掉
              for (var p = 0; p < reqOrderById.length; p++) {
                var prid = reqOrderById[p];
                if (!assigned[prid]) break; // 前缀到此为止，无法判定
                var psa = assigned[prid].siteId, psb = best.assign[prid];
                if (psa !== psb) { if (psa > psb) return; break; }
              }
            }
          }
        }
      }
      if (k === nReq) {
        var assign = {};
        for (var rid in assigned) assign[rid] = assigned[rid].siteId;
        var sol = { assign: assign, minS: minS, sumS: sumS, rallySum: rally };
        if (!best || betterThan(sol, best)) best = sol;
        return;
      }
      var re = searchReqs[k];
      // 安全分高、集合距离近、编号小的先尝试，让 best 尽早收紧
      var cands = re.validCandidates.slice().sort(function (a, b) {
        return b.safety - a.safety || a.distRally - b.distRally || (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0);
      });
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (usedSite[c.siteId] || conflictsWithAssigned(c, assigned)) continue;
        assigned[re.id] = c; usedSite[c.siteId] = true;
        dfs(k + 1, Math.min(minS, c.safety), sumS + c.safety, rally + c.distRally);
        delete assigned[re.id]; delete usedSite[c.siteId];
        if (truncated) return;
      }
    }
    var allHaveCandidates = searchReqs.every(function (re) { return re.validCandidates.length > 0; });
    if (requests.length && allHaveCandidates) dfs(0, Infinity, 0, 0);

    // ---- 结果 / 失败诊断 ----
    var result = null, failure = null;
    if (best) {
      var safetyByReq = {};
      reqEvals.forEach(function (re) {
        var sid = best.assign[re.id];
        for (var i = 0; i < re.validCandidates.length; i++) {
          if (re.validCandidates[i].siteId === sid) { safetyByReq[re.id] = re.validCandidates[i].safety; break; }
        }
      });
      result = {
        assign: best.assign,
        safety: requests.map(function (rq) { return safetyByReq[rq.id]; }), // 按输入请求顺序
        minSafety: best.minS, sumSafety: best.sumS, rallySum: best.rallySum
      };
    } else if (requests.length) {
      // 最大可安置子集，用于指出冲突
      var bestP = { count: -1, assign: null };
      var cur = {}, used2 = {}, nodes2 = 0;
      (function rec(k, count) {
        if (truncated) return;
        if (++nodes2 > NODE_CAP) {
          truncated = true;
          warnings.push('冲突诊断搜索规模超限，诊断可能不完整');
          return;
        }
        if (count + (searchReqs.length - k) <= bestP.count) return;
        if (k === searchReqs.length) {
          bestP.count = count;
          bestP.assign = {};
          for (var rid in cur) bestP.assign[rid] = cur[rid].siteId;
          return;
        }
        var re = searchReqs[k];
        for (var i = 0; i < re.validCandidates.length; i++) {
          var c = re.validCandidates[i];
          if (used2[c.siteId] || conflictsWithAssigned(c, cur)) continue;
          cur[re.id] = c; used2[c.siteId] = true;
          rec(k + 1, count + 1);
          delete cur[re.id]; delete used2[c.siteId];
        }
        rec(k + 1, count); // 跳过该请求
      })(0, 0);

      var unplaced = [];
      reqEvals.forEach(function (re) {
        if (bestP.assign && bestP.assign[re.id]) return;
        var entry = { id: re.id, team: re.team };
        if (!re.validCandidates.length) {
          entry.reason = '无合规候选点';
          var summary = {};
          re.candidates.forEach(function (c) {
            c.reasons.forEach(function (r) {
              var k2 = r.split('：')[0];
              summary[k2] = (summary[k2] || 0) + 1;
            });
          });
          entry.reasonSummary = summary;
        } else {
          entry.reason = '候选点均与同批已安置落点距离过近';
          entry.blockedBy = re.validCandidates.map(function (c) {
            var conf = [];
            for (var rid in bestP.assign) {
              var d = pairDist(c.siteId, bestP.assign[rid]);
              if (d !== -1 && d < minGap) conf.push({ request: rid, site: bestP.assign[rid], dist: d });
            }
            return { site: c.siteId, safety: c.safety, conflicts: conf };
          });
        }
        unplaced.push(entry);
      });
      failure = { maxPlaced: Math.max(bestP.count, 0), total: requests.length, placedAssign: bestP.assign || {}, unplaced: unplaced };
    }

    return {
      errors: errors, warnings: warnings, truncated: truncated,
      meta: { w: w, h: h, minGap: minGap, checkpoint: cfg.checkpoint || null, rally: cfg.rally || {} },
      requests: reqEvals,
      conflictEdges: conflictEdges,
      result: result,
      failure: failure
    };
  }

  return {
    computeSelection: computeSelection,
    bfsField: bfsField,
    SAFETY_CAP: SAFETY_CAP,
    RALLY_PENALTY: RALLY_PENALTY
  };
});
