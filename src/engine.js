/*
 * Cutline engine — exact enumeration of league qualification scenarios.
 *
 * Rules implemented:
 *   - 3 / 1 / 0 points for win / draw / loss. 局差 (game difference) is the sum
 *     of (left score - right score) over the listed matches.
 *   - Teams tied on total points are partitioned by head-to-head (组内) points,
 *     then head-to-head 局差. Every non-singleton run is recomputed using only
 *     the matches between its own members, recursively.
 *   - A group where every member has identical head-to-head points and 局差
 *     cannot be separated internally: it falls back to total 局差, then team
 *     number ascending.
 *   - Only matches actually listed are counted, in the main table and in every
 *     head-to-head table.
 *
 * Written as a plain factory function with no external references, so the same
 * source runs in Node (tests) and inside a Web Worker built from its source.
 */
function CutlineEngineFactory() {
  'use strict';

  var MAX_TEAMS = 8;
  var MAX_PENDING = 14;
  var MAX_CANDS = 3;

  var nowMs = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  function inputError(message) {
    var e = new Error(message);
    e.name = 'CutlineInputError';
    return e;
  }
  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function readPair(p, label) {
    if (!Array.isArray(p) || p.length !== 2 || !isInt(p[0]) || !isInt(p[1]) || p[0] < 0 || p[1] < 0) {
      throw inputError(label + ' 必须是由两个非负整数组成的 [左, 右] 比分');
    }
    return [p[0], p[1]];
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw inputError('数据必须是一个 JSON 对象');
    if (!Array.isArray(raw.teams)) throw inputError('缺少 teams 数组');
    if (raw.teams.length < 1 || raw.teams.length > MAX_TEAMS) {
      throw inputError('teams 需要 1–' + MAX_TEAMS + ' 支队伍');
    }
    var teamSet = new Set();
    var teamIds = [];
    for (var i = 0; i < raw.teams.length; i++) {
      var t = raw.teams[i];
      if (!isInt(t)) throw inputError('队号必须是整数');
      if (teamSet.has(t)) throw inputError('队号 ' + t + ' 重复');
      teamSet.add(t);
      teamIds.push(t);
    }
    teamIds.sort(function (a, b) { return a - b; });
    var n = teamIds.length;
    var indexOf = new Map();
    for (var j = 0; j < n; j++) indexOf.set(teamIds[j], j);

    if (!isInt(raw.qualifiers)) throw inputError('qualifiers 必须是整数');
    if (raw.qualifiers < 0 || raw.qualifiers > n) throw inputError('qualifiers 必须在 0–' + n + ' 之间');
    if (!Array.isArray(raw.matches)) throw inputError('缺少 matches 数组');

    var seenIds = new Set();
    var pairCount = new Map();
    var matches = [];
    var pendingCount = 0;
    for (var mi = 0; mi < raw.matches.length; mi++) {
      var m = raw.matches[mi];
      var at = '第 ' + (mi + 1) + ' 场比赛';
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw inputError(at + ' 不是对象');
      if (!isInt(m.id)) throw inputError(at + ' 的 id 必须是整数');
      if (seenIds.has(m.id)) throw inputError('比赛编号 ' + m.id + ' 重复');
      seenIds.add(m.id);
      if (!teamSet.has(m.left) || !teamSet.has(m.right)) throw inputError('比赛 ' + m.id + ' 的队伍不在 teams 中');
      if (m.left === m.right) throw inputError('比赛 ' + m.id + ' 的两支队伍相同');
      var key = m.left < m.right ? m.left + '-' + m.right : m.right + '-' + m.left;
      var cnt = (pairCount.get(key) || 0) + 1;
      if (cnt > 2) throw inputError('队伍 ' + Math.min(m.left, m.right) + ' 与 ' + Math.max(m.left, m.right) + ' 之间超过 2 场比赛');
      pairCount.set(key, cnt);

      var hasScore = hasOwn(m, 'score');
      var hasCands = hasOwn(m, 'candidates');
      if (hasScore === hasCands) throw inputError('比赛 ' + m.id + ' 必须且只能有 score 或 candidates 之一');

      var entry = { id: m.id, left: m.left, right: m.right, li: indexOf.get(m.left), ri: indexOf.get(m.right) };
      if (hasScore) {
        entry.kind = 'fixed';
        entry.score = readPair(m.score, '比赛 ' + m.id + ' 的 score');
        matches.push(entry);
      } else {
        pendingCount++;
        if (pendingCount > MAX_PENDING) throw inputError('待定比赛超过 ' + MAX_PENDING + ' 场');
        if (!Array.isArray(m.candidates) || m.candidates.length < 1 || m.candidates.length > MAX_CANDS) {
          throw inputError('比赛 ' + m.id + ' 的 candidates 需要 1–' + MAX_CANDS + ' 个候选比分');
        }
        var seen = new Set();
        var candidates = [];
        for (var ci = 0; ci < m.candidates.length; ci++) {
          var p = readPair(m.candidates[ci], '比赛 ' + m.id + ' 的第 ' + ci + ' 个候选比分');
          var ck = p[0] + ':' + p[1];
          if (seen.has(ck)) throw inputError('比赛 ' + m.id + ' 的候选比分 ' + ck + ' 重复');
          seen.add(ck);
          candidates.push(p);
        }
        entry.kind = 'pending';
        entry.candidates = candidates;
        matches.push(entry);
      }
    }

    var pending = matches.filter(function (x) { return x.kind === 'pending'; });
    pending.sort(function (a, b) { return a.id - b.id; });
    var fixed = matches.filter(function (x) { return x.kind === 'fixed'; });
    fixed.sort(function (a, b) { return a.id - b.id; });

    return {
      teamIds: teamIds, n: n, qualifiers: raw.qualifiers,
      rules: typeof raw.rules === 'string' ? raw.rules : '',
      matches: matches, pending: pending, fixed: fixed
    };
  }

  function readLocks(model, obj) {
    var out = new Map();
    if (!obj || typeof obj !== 'object') return out;
    for (var i = 0; i < model.pending.length; i++) {
      var m = model.pending[i];
      var v = obj[m.id];
      if (v === undefined || v === null) continue;
      if (!isInt(v) || v < 0 || v >= m.candidates.length) continue;
      out.set(m.id, v);
    }
    return out;
  }

  function create(raw, options) {
    options = options || {};
    var model = normalize(raw);
    var n = model.n;
    var teamIds = model.teamIds;
    var K = options.qualifiers === undefined || options.qualifiers === null ? model.qualifiers : options.qualifiers;
    if (!isInt(K)) K = model.qualifiers;
    K = Math.max(0, Math.min(n, K));
    var locks = readLocks(model, options.locks);

    var pending = model.pending;
    var lockedCand = new Int8Array(pending.length);
    var unlocked = [];
    for (var pi = 0; pi < pending.length; pi++) {
      if (locks.has(pending[pi].id)) lockedCand[pi] = locks.get(pending[pi].id);
      else { lockedCand[pi] = -1; unlocked.push(pi); }
    }

    // DFS visits pending matches by ascending match id and candidates by list
    // position, so the first leaf meeting a condition is the earliest
    // reproducible scenario: smallest match id, then smallest candidate index.
    var totalAll = 1, totalEff = 1;
    for (var q = 0; q < pending.length; q++) {
      totalAll *= pending[q].candidates.length;
      if (lockedCand[q] < 0) totalEff *= pending[q].candidates.length;
    }

    var cPL = new Int8Array(pending.length * MAX_CANDS);
    var cPR = new Int8Array(pending.length * MAX_CANDS);
    var cDL = new Int8Array(pending.length * MAX_CANDS);
    for (var cj = 0; cj < pending.length; cj++) {
      var mm = pending[cj];
      for (var kk = 0; kk < mm.candidates.length; kk++) {
        var sl = mm.candidates[kk][0], sr = mm.candidates[kk][1];
        var idx = cj * MAX_CANDS + kk;
        cPL[idx] = sl > sr ? 3 : sl === sr ? 1 : 0;
        cPR[idx] = sr > sl ? 3 : sl === sr ? 1 : 0;
        cDL[idx] = sl - sr;
      }
    }

    function buildBase(withLocks) {
      var P = new Int32Array(n), D = new Int32Array(n);
      var VP = new Int32Array(n * n), VD = new Int32Array(n * n);
      function add(li, ri, l, r) {
        var pl = l > r ? 3 : l === r ? 1 : 0;
        var pr = r > l ? 3 : l === r ? 1 : 0;
        var d = l - r;
        P[li] += pl; P[ri] += pr; D[li] += d; D[ri] -= d;
        var a = li * n + ri, b = ri * n + li;
        VP[a] += pl; VP[b] += pr; VD[a] += d; VD[b] -= d;
      }
      for (var i = 0; i < model.fixed.length; i++) {
        var f = model.fixed[i];
        add(f.li, f.ri, f.score[0], f.score[1]);
      }
      if (withLocks) {
        for (var j = 0; j < pending.length; j++) {
          if (lockedCand[j] < 0) continue;
          var c = pending[j].candidates[lockedCand[j]];
          add(pending[j].li, pending[j].ri, c[0], c[1]);
        }
      }
      return { P: P, D: D, VP: VP, VD: VD };
    }

    var base = buildBase(true);
    var P = base.P, D = base.D, VP = base.VP, VD = base.VD;

    var ordDepth = [], hpDepth = [], hdDepth = [];
    for (var dpt = 0; dpt <= n; dpt++) {
      ordDepth.push(new Int8Array(n));
      hpDepth.push(new Int32Array(n));
      hdDepth.push(new Int32Array(n));
    }
    var emitBuf = new Int8Array(n);
    var ordPts = new Int8Array(n);
    var order = new Int8Array(n);
    var rec = null; // active round recorder, null on the hot path
    var recStack = []; // recStack[level] = seq of the group being resolved at that level

    /* One implementation of the tie rules, with an optional round recorder. */
    function resolveGroup(src, start, len, depth, need, out, outPos, rankStart) {
      var ord = ordDepth[depth], hp = hpDepth[depth], hd = hdDepth[depth];
      var firstP = 0, firstD = 0, allEq = true;
      for (var ii = 0; ii < len; ii++) {
        var t = src[start + ii];
        var row = t * n;
        var p = 0, dd = 0;
        for (var jj = 0; jj < len; jj++) {
          if (jj === ii) continue;
          var u = src[start + jj];
          p += VP[row + u];
          dd += VD[row + u];
        }
        hp[t] = p; hd[t] = dd;
        if (ii === 0) { firstP = p; firstD = dd; }
        else if (p !== firstP || dd !== firstD) allEq = false;
        var k = ii - 1;
        while (k >= 0) {
          var v = ord[k];
          if (hp[v] > p || (hp[v] === p && (hd[v] > dd || (hd[v] === dd && v < t)))) break;
          ord[k + 1] = v;
          k--;
        }
        ord[k + 1] = t;
      }
      if (allEq) {
        for (var a = 0; a < len; a++) {
          var tt = src[start + a];
          var k2 = a - 1;
          while (k2 >= 0) {
            var w = ord[k2];
            if (D[w] > D[tt] || (D[w] === D[tt] && w < tt)) break;
            ord[k2 + 1] = w;
            k2--;
          }
          ord[k2 + 1] = tt;
        }
        if (rec) recordRound(depth, ord, len, hp, hd, rankStart, 'fallback');
        var take = 0;
        for (var b = 0; b < len && take < need; b++) { out[outPos++] = ord[b]; take++; }
        return outPos;
      }
      var runStart = 0, emitted = 0;
      if (rec) recordRound(depth, ord, len, hp, hd, rankStart, 'h2h');
      for (var e = 1; e <= len; e++) {
        var boundary = e === len || hp[ord[e]] !== hp[ord[runStart]] || hd[ord[e]] !== hd[ord[runStart]];
        if (!boundary) continue;
        var rlen = e - runStart;
        if (rlen === 1) {
          if (emitted < need) { out[outPos++] = ord[runStart]; emitted++; }
        } else {
          var remaining = need === Infinity ? Infinity : need - emitted;
          if (remaining > 0) {
            // resolveGroup appends exactly `remaining` entries (or the whole run
            // when it is smaller), and returns the new output position.
            var before = outPos;
            outPos = resolveGroup(ord, runStart, rlen, depth + 1, remaining, out, outPos, rankStart + runStart);
            emitted += outPos - before;
          }
        }
        if (emitted >= need) return outPos;
        runStart = e;
      }
      return outPos;
    }

    function recordRound(depth, ord, len, hp, hd, rankStart, kind) {
      var runs = [], rs = 0;
      for (var e = 1; e <= len; e++) {
        if (e === len || hp[ord[e]] !== hp[ord[rs]] || hd[ord[e]] !== hd[ord[rs]]) {
          runs.push({ start: rs, len: e - rs });
          rs = e;
        }
      }
      // A run of 2+ teams is only a position band here; a deeper round decides
      // which of them takes which place, so this round marks none of them as placed.
      var rows = [], members = [];
      for (var i = 0; i < len; i++) {
        var t = ord[i];
        var single = runs.length === 1 || runs.some(function (r) { return r.start <= i && i < r.start + r.len && r.len === 1; });
        var resolved = kind === 'fallback' || single;
        rows.push({
          id: teamIds[t], hp: hp[t], hd: hd[t], diff: D[t],
          rank: rankStart + i + 1, resolved: resolved,
          qualified: resolved ? (rankStart + i < K) : (rankStart >= K ? false : null)
        });
        members.push(teamIds[t]);
      }
      var seq = rec.length;
      rec.push({
        seq: seq, level: depth, kind: kind,
        points: P[ord[0]], rankStart: rankStart + 1, size: len,
        members: members, rows: rows, runs: runs,
        parentSeq: depth > 0 && recStack[depth - 1] !== undefined ? recStack[depth - 1] : null,
        usedMatches: internalMatchIds(members)
      });
      recStack[depth] = seq;
    }

    /* Matches whose two teams are both inside this group — the only ones a
       head-to-head recomputation is allowed to count. */
    function internalMatchIds(members) {
      var set = new Set(members);
      var ids = [];
      for (var i = 0; i < model.matches.length; i++) {
        var m = model.matches[i];
        if (set.has(m.left) && set.has(m.right)) ids.push(m.id);
      }
      ids.sort(function (a, b) { return a - b; });
      return ids;
    }

    function fullOrder(withRounds) {
      for (var i = 0; i < n; i++) {
        var k = i - 1;
        while (k >= 0) {
          var u = ordPts[k];
          if (P[u] > P[i] || (P[u] === P[i] && u < i)) break;
          ordPts[k + 1] = u;
          k--;
        }
        ordPts[k + 1] = i;
      }
      var rounds = withRounds ? [] : null;
      if (withRounds) { rec = rounds; recStack.length = 0; }
      var rank = 0, gs = 0;
      for (var e = 1; e <= n; e++) {
        if (e === n || P[ordPts[e]] !== P[ordPts[gs]]) {
          var glen = e - gs;
          if (glen === 1) {
            order[rank++] = ordPts[gs];
          } else {
            resolveGroup(ordPts, gs, glen, 0, Infinity, order, rank, rank);
            rank += glen;
          }
          gs = e;
        }
      }
      rec = null;
      return rounds;
    }

    /* Exact count of every complete scenario and, for every team and every
       finishing rank, the first (lexicographically smallest) assignment that
       produces it. Because finish rank is independent of how many places
       qualify, changing the qualifier count never needs a new enumeration. */
    function analyze(onProgress) {
      var t0 = nowMs();
      var hist = new Int32Array(n * n);
      var first = new Array(n * n);
      for (var i = 0; i < n * n; i++) first[i] = null;
      var assignment = new Array(pending.length);
      for (i = 0; i < pending.length; i++) assignment[i] = lockedCand[i] >= 0 ? lockedCand[i] : 0;
      var leaves = 0, lastReport = 0;

      function leaf() {
        fullOrder(false);
        leaves++;
        for (var r = 0; r < n; r++) {
          var t = order[r];
          var slot = t * n + r;
          hist[slot]++;
          if (first[slot] === null) first[slot] = assignment.slice();
        }
      }

      if (unlocked.length === 0) {
        leaf();
      } else {
        var U = unlocked.length;
        (function dfs(ui) {
          if (ui === U) {
            leaf();
            if (onProgress && leaves - lastReport >= 131072 && leaves < totalEff) {
              lastReport = leaves;
              onProgress(leaves, totalEff);
            }
            return;
          }
          var pi = unlocked[ui];
          var cnt = pending[pi].candidates.length;
          var bi = pi * MAX_CANDS;
          var li = pending[pi].li, ri = pending[pi].ri;
          var a = li * n + ri, b = ri * n + li;
          for (var ci = 0; ci < cnt; ci++) {
            var pl = cPL[bi + ci], pr = cPR[bi + ci], dd = cDL[bi + ci];
            P[li] += pl; P[ri] += pr; D[li] += dd; D[ri] -= dd;
            VP[a] += pl; VP[b] += pr; VD[a] += dd; VD[b] -= dd;
            assignment[pi] = ci;
            dfs(ui + 1);
            P[li] -= pl; P[ri] -= pr; D[li] -= dd; D[ri] += dd;
            VP[a] -= pl; VP[b] -= pr; VD[a] -= dd; VD[b] += dd;
          }
        })(0);
      }

      var elapsed = nowMs() - t0;
      var teams = [];
      for (i = 0; i < n; i++) {
        var h = [], fw = [];
        for (var r2 = 0; r2 < n; r2++) {
          h.push(hist[i * n + r2]);
          fw.push(first[i * n + r2]);
        }
        teams.push({ id: teamIds[i], rankHist: h, firstByRank: fw });
      }
      if (onProgress) onProgress(totalEff, totalEff);
      return {
        total: totalEff, totalAll: totalAll, leaves: leaves,
        elapsedMs: elapsed, teamIds: teamIds.slice(),
        teams: teams, pendingCount: pending.length, lockedCount: locks.size
      };
    }

    /* Replay one complete scenario and, on request, the small table of every
       recomputation round. Used by the UI only. */
    function scenario(assignment, recordRounds) {
      if (!Array.isArray(assignment) || assignment.length !== pending.length) {
        throw new Error('赛果的候选数量与待定比赛数量不一致');
      }
      var bb = buildBase(false);
      var SP = bb.P, SD = bb.D, SVP = bb.VP, SVD = bb.VD;
      for (var i = 0; i < pending.length; i++) {
        var m = pending[i];
        var ci = assignment[i];
        if (!isInt(ci) || ci < 0 || ci >= m.candidates.length) throw new Error('比赛 ' + m.id + ' 的候选位置无效');
        var c = m.candidates[ci];
        var l = c[0], r = c[1];
        var pl = l > r ? 3 : l === r ? 1 : 0;
        var pr = r > l ? 3 : l === r ? 1 : 0;
        var dd = l - r;
        SP[m.li] += pl; SP[m.ri] += pr; SD[m.li] += dd; SD[m.ri] -= dd;
        var a = m.li * n + m.ri, b = m.ri * n + m.li;
        SVP[a] += pl; SVP[b] += pr; SVD[a] += dd; SVD[b] -= dd;
      }
      var oP = P, oD = D, oVP = VP, oVD = VD;
      P = SP; D = SD; VP = SVP; VD = SVD;

      var rounds = fullOrder(!!recordRounds) || [];
      var standings = [];
      for (var r2 = 0; r2 < n; r2++) {
        var idx = order[r2];
        standings.push({
          id: teamIds[idx], points: P[idx], diff: D[idx],
          rank: r2 + 1, qualified: r2 < K
        });
      }
      var pointsArr = [], diffArr = [];
      for (var t3 = 0; t3 < n; t3++) { pointsArr.push(P[t3]); diffArr.push(D[t3]); }

      P = oP; D = oD; VP = oVP; VD = oVD;
      return { standings: standings, rounds: rounds, points: pointsArr, diff: diffArr };
    }

    function setQualifiers(next) {
      K = Math.max(0, Math.min(n, next));
      return K;
    }

    return {
      model: model, qualifiers: K, locks: locks,
      total: totalEff, totalAll: totalAll,
      pending: pending, teamIds: teamIds,
      analyze: analyze, scenario: scenario,
      setQualifiers: setQualifiers
    };
  }

  /* Turn an analysis into the report for a given number of qualifying places.
     `earliestQualifyRank` / `earliestEliminateRank` name the finishing rank the
     earliest witness lands on, so the UI can point at exactly that scenario. */
  function summarize(analysis, K) {
    var n = analysis.teamIds.length;
    var k = Math.max(0, Math.min(n, K));
    var teams = [];
    for (var i = 0; i < analysis.teams.length; i++) {
      var t = analysis.teams[i];
      var qualify = 0, bestQ = null, bestQRank = null, bestE = null, bestERank = null;
      for (var r = 0; r < n; r++) {
        var count = t.rankHist[r];
        if (r < k) {
          qualify += count;
          if (count > 0 && (!bestQ || lexLess(t.firstByRank[r], bestQ))) {
            bestQ = t.firstByRank[r];
            bestQRank = r;
          }
        } else if (count > 0 && (!bestE || lexLess(t.firstByRank[r], bestE))) {
          bestE = t.firstByRank[r];
          bestERank = r;
        }
      }
      teams.push({
        id: t.id, qualify: qualify, eliminate: analysis.total - qualify,
        earliestQualify: bestQ, earliestQualifyRank: bestQRank,
        earliestEliminate: bestE, earliestEliminateRank: bestERank,
        rankHist: t.rankHist
      });
    }
    teams.sort(function (a, b) {
      if (b.qualify !== a.qualify) return b.qualify - a.qualify;
      return a.id - b.id;
    });
    return { K: k, total: analysis.total, teams: teams };
  }

  function lexLess(a, b) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length < b.length;
  }

  return {
    normalize: normalize,
    readLocks: readLocks,
    create: create,
    summarize: summarize,
    lexLess: lexLess,
    MAX_TEAMS: MAX_TEAMS,
    MAX_PENDING: MAX_PENDING,
    MAX_CANDS: MAX_CANDS
  };
}

if (typeof module === 'object' && module.exports) module.exports = CutlineEngineFactory;
