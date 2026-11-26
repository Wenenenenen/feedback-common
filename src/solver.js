/*
 * velocity-crop-conformer — exact global solver
 *
 * solveProject() is deliberately one self-contained function: it is
 * stringified into a Web Worker at runtime and also loaded by the Node
 * test harness.  Do not reference anything outside this function.
 *
 * Objective, lexicographic:
 *   1. maximise total soft-overlap score over the whole film
 *   2. minimise sum of |second difference| over every in-shot triple
 *   3. lexicographically minimise the crop coordinate sequence
 *      (frame 0 x, frame 0 y, frame 1 x, frame 1 y, ...)
 *
 * Hard constraints:
 *   - crop fully inside the image
 *   - every must-box fully inside the crop
 *   - a locked frame may only use the locked rectangle
 *   - in one shot: |dx|<=speed[0], |dy|<=speed[1] between neighbours
 *   - in one shot: |ddx|<=accel[0], |ddy|<=accel[1] per consecutive triple
 *   - a hard cut starts a fresh shot (no continuity across it)
 *
 * Shots are independent: score and accel-sum add, and once those two
 * additive objectives are fixed the lexicographically smallest whole-film
 * coordinate sequence is the concatenation of each shot's own smallest
 * sequence.  So per-shot exact DP yields the exact film optimum.
 *
 * solveProject(project, locksOverride?) -> result
 *   override, when supplied, replaces project.locks entirely (frame index ->
 *   [x, y]); pass {} to clear every lock.
 */
function solveProject(project, locksOverride) {
  'use strict';
  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  var started = now();

  function fail(msg) {
    return { ok: false, error: msg, failFrame: -1, solveMs: now() - started };
  }

  if (!project || typeof project !== 'object') return fail('缺少项目数据');
  var W = Math.round(Number(project.width));
  var H = Math.round(Number(project.height));
  var crop = project.crop || [];
  var cw = Math.round(Number(crop[0]));
  var ch = Math.round(Number(crop[1]));
  var speed = project.speed || [0, 0];
  var accel = project.accel || [0, 0];
  var sx = Math.abs(Math.round(Number(speed[0])) || 0);
  var sy = Math.abs(Math.round(Number(speed[1])) || 0);
  var ax = Math.abs(Math.round(Number(accel[0])) || 0);
  var ay = Math.abs(Math.round(Number(accel[1])) || 0);
  var frames = project.frames;
  if (!(W > 0) || !(H > 0) || !(cw > 0) || !(ch > 0)) return fail('尺寸参数无效');
  if (!Array.isArray(frames)) return fail('缺少帧数据');
  var n = frames.length;
  if (n === 0) {
    return { ok: true, positions: [], totalScore: 0, totalAccel: 0, failFrame: -1, solveMs: now() - started };
  }

  // ---- effective locks --------------------------------------------------
  var locks;
  if (locksOverride && typeof locksOverride === 'object') {
    locks = Object.create(null);
    for (var lk in locksOverride) {
      if (!Object.prototype.hasOwnProperty.call(locksOverride, lk)) continue;
      var li = parseInt(lk, 10);
      var lv = locksOverride[lk];
      if (!isFinite(li) || li < 0 || li >= n || !lv || lv.length < 2) continue;
      locks[li] = [Math.round(Number(lv[0])), Math.round(Number(lv[1]))];
    }
  } else {
    locks = project.locks || {};
  }

  var maxX = W - cw;
  var maxY = H - ch;

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x <= maxX && y <= maxY;
  }
  function mustOK(fr, x, y) {
    var must = Array.isArray(fr.must) ? fr.must : [];
    for (var mi = 0; mi < must.length; mi++) {
      var mb = must[mi];
      if (!mb || mb.length < 4) continue;
      if (!(x <= mb[0] && y <= mb[1] && x + cw >= mb[2] && y + ch >= mb[3])) return false;
    }
    return true;
  }

  // ---- per-frame decision tables ---------------------------------------
  // Candidates survive when in-bounds, must-satisfying and, on a locked
  // frame, equal to the lock.  Each table is sorted by (x, y) ascending,
  // so "smallest index" is exactly "lexicographically smallest coordinate".
  var tables = new Array(n);
  for (var fi = 0; fi < n; fi++) {
    var fr = frames[fi] || {};
    var pts = [];
    var seen = Object.create(null);
    var lock = Object.prototype.hasOwnProperty.call(locks, fi) ? locks[fi] : null;
    if (lock) {
      if (inBounds(lock[0], lock[1]) && mustOK(fr, lock[0], lock[1])) {
        pts.push([lock[0], lock[1]]);
      }
    } else {
      var raw = Array.isArray(fr.candidates) ? fr.candidates : [];
      for (var ci = 0; ci < raw.length; ci++) {
        var c = raw[ci];
        if (!c || c.length < 2) continue;
        var x = Math.round(Number(c[0]));
        var y = Math.round(Number(c[1]));
        if (!inBounds(x, y)) continue;
        var key = x + ':' + y;
        if (seen[key]) continue;
        if (!mustOK(fr, x, y)) continue;
        seen[key] = 1;
        pts.push([x, y]);
      }
    }
    pts.sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
    var k = pts.length;
    var xs = new Int32Array(k);
    var ys = new Int32Array(k);
    for (var pi = 0; pi < k; pi++) { xs[pi] = pts[pi][0]; ys[pi] = pts[pi][1]; }
    var scores = new Float64Array(k);
    var soft = Array.isArray(fr.soft) ? fr.soft : [];
    for (var si = 0; si < k; si++) {
      var cx0 = xs[si], cy0 = ys[si], cx1 = cx0 + cw, cy1 = cy0 + ch;
      var sc = 0;
      for (var qi = 0; qi < soft.length; qi++) {
        var sobj = soft[qi];
        if (!sobj || !sobj.box || sobj.box.length < 4) continue;
        var b = sobj.box;
        var ox = Math.min(cx1, b[2]) - Math.max(cx0, b[0]);
        if (ox <= 0) continue;
        var oy = Math.min(cy1, b[3]) - Math.max(cy0, b[1]);
        if (oy <= 0) continue;
        sc += ox * oy * (Math.round(Number(sobj.weight)) || 0);
      }
      scores[si] = sc;
    }
    tables[fi] = {
      x: xs,
      y: ys,
      score: scores,
      k: k,
      cut: !!fr.cut,
      locked: !!lock
    };
  }

  // lower bound index of the first sorted x >= value
  function lb(arr, len, value) {
    var lo = 0, hi = len;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // first index with x > value
  function ub(arr, len, value) {
    var lo = 0, hi = len;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] <= value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // ---- shots ------------------------------------------------------------
  var shotStarts = [0];
  for (var sj = 1; sj < n; sj++) if (tables[sj].cut) shotStarts.push(sj);
  shotStarts.push(n);
  var shotCount = shotStarts.length - 1;

  var positions = new Array(n);
  var totalScore = 0;
  var totalAccel = 0;

  for (var shot = 0; shot < shotCount; shot++) {
    var s = shotStarts[shot];
    var m = shotStarts[shot + 1] - s;

    if (m === 1) {
      var T0 = tables[s];
      if (T0.k === 0) return infeasible();
      var best0 = 0; // sorted order → first of equal-score is lexicographically smallest
      for (var i0 = 1; i0 < T0.k; i0++) if (T0.score[i0] > T0.score[best0]) best0 = i0;
      positions[s] = [T0.x[best0], T0.y[best0]];
      totalScore += T0.score[best0];
      continue;
    }

    var shotPositions = solveShot(s, m);
    if (!shotPositions) return infeasible();
    for (var pt = 0; pt < m; pt++) {
      var T = tables[s + pt];
      var sp = shotPositions[pt];
      positions[s + pt] = [T.x[sp], T.y[sp]];
      totalScore += T.score[sp];
    }
    for (var at = 2; at < m; at++) {
      var P0 = positions[s + at - 2], P1 = positions[s + at - 1], P2 = positions[s + at];
      totalAccel += Math.abs(P2[0] - 2 * P1[0] + P0[0]) + Math.abs(P2[1] - 2 * P1[1] + P0[1]);
    }
  }

  return {
    ok: true,
    positions: positions,
    totalScore: totalScore,
    totalAccel: totalAccel,
    failFrame: -1,
    solveMs: now() - started
  };

  function infeasible() {
    var ff = findFirstInfeasible();
    return {
      ok: false,
      failFrame: ff,
      reason: ff >= 0 ? '第 ' + ff + ' 帧起失去可行前缀' : '无可行方案',
      solveMs: now() - started
    };
  }

  // ---------------------------------------------------------------------
  // Exact DP for one shot of m >= 2 frames.  Returns candidate indices
  // (into each frame's sorted table), or null when the shot is infeasible.
  //
  // State at layer t is the pair (b, a) = crops of frames t-2, t-1.
  //   V_t(b,a) = best (score, accel) achievable for frames t..m-1
  //              given those two crops.
  // Recurrence:
  //   V_t(b,a) = max over c allowed by speed(a,c) & accel(b,a,c) of
  //              ( score_t[c] + V_{t+1}(a,c),
  //                accel(b,a,c) + A_{t+1}(a,c) )
  // compared by score desc, then accel asc, then c index asc.
  // The constraints on c's x form one interval and so do its y, so the
  // candidate scan is a windowed range over the x-sorted table.
  // ---------------------------------------------------------------------
  function solveShot(s, m) {
    for (var q0 = 0; q0 < m; q0++) if (tables[s + q0].k === 0) return null;

    var bp = new Array(m);      // bp[t][b*Ka + a] = chosen c index
    var vNextScore = null;      // V_{t+1}, laid out [a * Kc + c]
    var vNextAccel = null;
    var vNextKc = 0;

    for (var t = m - 1; t >= 2; t--) {
      var Tb = tables[s + t - 2], Ta = tables[s + t - 1], Tc = tables[s + t];
      var Kb = Tb.k, Ka = Ta.k, Kc = Tc.k;
      var bx = Tb.x, by = Tb.y;
      var axx = Ta.x, ayy = Ta.y;
      var cx = Tc.x, cy = Tc.y, cscore = Tc.score;
      var hasNext = (t < m - 1);
      var ns = vNextScore, na = vNextAccel, nKc = vNextKc;
      var curScore = new Float64Array(Kb * Ka);
      var curAccel = new Int32Array(Kb * Ka);
      var curBp = new Uint16Array(Kb * Ka);
      curScore.fill(-Infinity);

      for (var a = 0; a < Ka; a++) {
        var pax = axx[a], pay = ayy[a];
        var rowBase = hasNext ? a * nKc : 0;
        // b must be within speed of a: x window in the sorted table
        var bLo = lb(bx, Kb, pax - sx);
        var bHi = ub(bx, Kb, pax + sx);
        for (var b = bLo; b < bHi; b++) {
          var pby = by[b];
          if (pby - pay > sy || pby - pay < -sy) continue;
          var targetX = 2 * pax - bx[b];
          var targetY = 2 * pay - pby;
          // c must satisfy |cx - pax| <= sx and |cx - targetX| <= ax
          var loX = pax - sx > targetX - ax ? pax - sx : targetX - ax;
          var hiX = pax + sx < targetX + ax ? pax + sx : targetX + ax;
          var loY = pay - sy > targetY - ay ? pay - sy : targetY - ay;
          var hiY = pay + sy < targetY + ay ? pay + sy : targetY + ay;
          var cLo = lb(cx, Kc, loX);
          var cHi = ub(cx, Kc, hiX);
          var bestS = -Infinity, bestA = 0, bestC = -1;
          for (var cc = cLo; cc < cHi; cc++) {
            var ccy = cy[cc];
            if (ccy < loY || ccy > hiY) continue;
            var totS, totA;
            if (hasNext) {
              var idx = rowBase + cc;
              var vv = ns[idx];
              if (vv === -Infinity) continue;
              var ex = cx[cc] - targetX, ey = ccy - targetY;
              totA = na[idx] + (ex < 0 ? -ex : ex) + (ey < 0 ? -ey : ey);
              totS = vv + cscore[cc];
            } else {
              var ex2 = cx[cc] - targetX, ey2 = ccy - targetY;
              totA = (ex2 < 0 ? -ex2 : ex2) + (ey2 < 0 ? -ey2 : ey2);
              totS = cscore[cc];
            }
            // cc ascending == lexicographic ascending, so strict improvements only
            if (totS > bestS || (totS === bestS && totA < bestA)) {
              bestS = totS; bestA = totA; bestC = cc;
            }
          }
          if (bestC >= 0) {
            var pos = b * Ka + a;
            curScore[pos] = bestS;
            curAccel[pos] = bestA;
            curBp[pos] = bestC;
          }
        }
      }
      bp[t] = curBp;
      vNextScore = curScore;
      vNextAccel = curAccel;
      vNextKc = Ka;
    }

    var F0 = tables[s], F1 = tables[s + 1];
    var K0 = F0.k, K1 = F1.k;
    var f0x = F0.x, f0y = F0.y, f0s = F0.score;
    var f1x = F1.x, f1y = F1.y, f1s = F1.score;
    var hasV2 = (m >= 3);

    // V_1(a): best over c with speed(a,c) of score_1[c] + V_2(a,c)
    var v1Score = new Float64Array(K0);
    var v1Accel = new Int32Array(K0);
    var v1Bp = new Uint16Array(K0);
    v1Score.fill(-Infinity);
    for (var a1 = 0; a1 < K0; a1++) {
      var qx = f0x[a1], qy = f0y[a1];
      var rowBase2 = hasV2 ? a1 * K1 : 0;
      var cLo1 = lb(f1x, K1, qx - sx);
      var cHi1 = ub(f1x, K1, qx + sx);
      var bS = -Infinity, bA = 0, bC = -1;
      for (var c1 = cLo1; c1 < cHi1; c1++) {
        var c1y = f1y[c1];
        if (c1y - qy > sy || c1y - qy < -sy) continue;
        var s1, a1v;
        if (hasV2) {
          var i1 = rowBase2 + c1;
          s1 = vNextScore[i1];
          if (s1 === -Infinity) continue;
          s1 += f1s[c1];
          a1v = vNextAccel[i1];
        } else {
          s1 = f1s[c1];
          a1v = 0;
        }
        if (s1 > bS || (s1 === bS && a1v < bA)) { bS = s1; bA = a1v; bC = c1; }
      }
      if (bC >= 0) { v1Score[a1] = bS; v1Accel[a1] = bA; v1Bp[a1] = bC; }
    }

    // V_0 over frame-0 candidates
    var rS = -Infinity, rA = 0, rC = -1;
    for (var c0 = 0; c0 < K0; c0++) {
      var sv = v1Score[c0];
      if (sv === -Infinity) continue;
      sv += f0s[c0];
      var av = v1Accel[c0];
      if (sv > rS || (sv === rS && av < rA)) { rS = sv; rA = av; rC = c0; }
    }
    if (rC < 0) return null;

    var out = new Array(m);
    out[0] = rC;
    out[1] = v1Bp[rC];
    for (var tt = 2; tt < m; tt++) {
      var Ka2 = tables[s + tt - 1].k;
      out[tt] = bp[tt][out[tt - 2] * Ka2 + out[tt - 1]];
    }
    return out;
  }

  // Forward reachability, only used to report the earliest frame at which
  // the feasible prefix is lost.  Mirrors the real constraints exactly.
  function findFirstInfeasible() {
    function speedOK(px, py, qx, qy) {
      var dx = qx - px, dy = qy - py;
      return dx <= sx && dx >= -sx && dy <= sy && dy >= -sy;
    }
    var prevT = null;
    var pairA = null;       // encoded (b,a) as b*Ka+a
    var pairTb = null;      // table of frame t-2
    for (var t2 = 0; t2 < n; t2++) {
      var T = tables[t2];
      if (t2 === 0 || T.cut) {
        if (T.k === 0) return t2;
        prevT = T;
        pairA = null;
        pairTb = null;
        continue;
      }
      var TP = prevT;
      if (TP.k === 0 || T.k === 0) return t2;
      if (pairA === null) {
        // second frame of the shot: pairs over (prev, cur)
        var Kp = TP.k, Kc0 = T.k, arr0 = [];
        for (var ip = 0; ip < Kp; ip++) {
          for (var ic = 0; ic < Kc0; ic++) {
            if (speedOK(TP.x[ip], TP.y[ip], T.x[ic], T.y[ic])) arr0.push(ip * Kc0 + ic);
          }
        }
        if (arr0.length === 0) return t2;
        pairA = Int32Array.from(arr0);
        pairTb = TP;
        prevT = T;
        continue;
      }
      var Tb2 = pairTb, Ta2 = TP, Tc2 = T;
      var Ka2 = Ta2.k, Kc2 = Tc2.k;
      var nextArr = [];
      for (var pj = 0; pj < pairA.length; pj++) {
        var code = pairA[pj];
        var bIdx = (code / Ka2) | 0;
        var aIdx = code - bIdx * Ka2;
        var pbx = Tb2.x[bIdx], pby = Tb2.y[bIdx];
        var pax = Ta2.x[aIdx], pay = Ta2.y[aIdx];
        var tX = 2 * pax - pbx, tY = 2 * pay - pby;
        for (var ci2 = 0; ci2 < Kc2; ci2++) {
          if (!speedOK(pax, pay, Tc2.x[ci2], Tc2.y[ci2])) continue;
          var ex = Tc2.x[ci2] - tX, ey = Tc2.y[ci2] - tY;
          if (ex > ax || ex < -ax || ey > ay || ey < -ay) continue;
          nextArr.push(aIdx * Kc2 + ci2);
        }
      }
      if (nextArr.length === 0) return t2;
      pairA = Int32Array.from(nextArr);
      pairTb = Ta2;
      prevT = T;
    }
    return -1;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { solveProject: solveProject };
}
