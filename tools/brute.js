'use strict';
/*
 * Brute-force reference solver, used only by the fuzz test.
 * Enumerates every candidate combination per shot.  Exponential, so it is
 * only applied to tiny random projects.
 */

function normalizeCandidates(project, frameIndex, locks) {
  var cw = project.crop[0], ch = project.crop[1];
  var W = project.width, H = project.height;
  var maxX = W - cw, maxY = H - ch;
  var fr = project.frames[frameIndex];
  var lock = Object.prototype.hasOwnProperty.call(locks, frameIndex) ? locks[frameIndex] : null;
  var out = [];
  var seen = {};
  function mustOK(x, y) {
    var must = fr.must || [];
    for (var i = 0; i < must.length; i++) {
      var b = must[i];
      if (!(x <= b[0] && y <= b[1] && x + cw >= b[2] && y + ch >= b[3])) return false;
    }
    return true;
  }
  function push(x, y) {
    if (x < 0 || y < 0 || x > maxX || y > maxY) return;
    if (!mustOK(x, y)) return;
    var key = x + ':' + y;
    if (seen[key]) return;
    seen[key] = 1;
    var score = 0;
    var soft = fr.soft || [];
    for (var qi = 0; qi < soft.length; qi++) {
      var s = soft[qi];
      var ox = Math.min(x + cw, s.box[2]) - Math.max(x, s.box[0]);
      if (ox <= 0) continue;
      var oy = Math.min(y + ch, s.box[3]) - Math.max(y, s.box[1]);
      if (oy <= 0) continue;
      score += ox * oy * s.weight;
    }
    out.push({ x: x, y: y, score: score });
  }
  if (lock) {
    push(lock[0], lock[1]);
  } else {
    var cs = fr.candidates || [];
    for (var ci = 0; ci < cs.length; ci++) push(cs[ci][0], cs[ci][1]);
  }
  return out;
}

function lexLess(a, b) {
  for (var i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x) return a[i].x < b[i].x;
    if (a[i].y !== b[i].y) return a[i].y < b[i].y;
  }
  return false;
}

function solveBrute(project, locksOverride) {
  var locks = locksOverride || project.locks || {};
  var n = project.frames.length;
  var speed = project.speed || [0, 0];
  var accel = project.accel || [0, 0];
  var sx = Math.abs(speed[0]), sy = Math.abs(speed[1]);
  var ax = Math.abs(accel[0]), ay = Math.abs(accel[1]);

  var cands = [];
  for (var i = 0; i < n; i++) cands.push(normalizeCandidates(project, i, locks));

  // global enumeration, shot by shot
  var best = null; // {score, accel, path}

  function consider(path) {
    var score = 0, accelSum = 0;
    for (var i2 = 0; i2 < n; i2++) score += path[i2].score;
    for (var i3 = 2; i3 < n; i3++) {
      if (project.frames[i3].cut) continue;
      // triple spans a cut if any of the two preceding boundaries is a cut
      if (project.frames[i3 - 1].cut) continue;
      accelSum += Math.abs(path[i3].x - 2 * path[i3 - 1].x + path[i3 - 2].x) +
                  Math.abs(path[i3].y - 2 * path[i3 - 1].y + path[i3 - 2].y);
    }
    if (!best ||
        score > best.score ||
        (score === best.score && accelSum < best.accel) ||
        (score === best.score && accelSum === best.accel && lexLess(path, best.path))) {
      best = { score: score, accel: accelSum, path: path.slice() };
    }
  }

  function ok(i, path) {
    if (i === 0) return true;
    var cur = path[i], prev = path[i - 1];
    if (project.frames[i].cut) return true;
    if (Math.abs(cur.x - prev.x) > sx || Math.abs(cur.y - prev.y) > sy) return false;
    if (i >= 2 && !project.frames[i - 1].cut) {
      var pp = path[i - 2];
      if (Math.abs(cur.x - 2 * prev.x + pp.x) > ax) return false;
      if (Math.abs(cur.y - 2 * prev.y + pp.y) > ay) return false;
    }
    return true;
  }

  function rec(i, path) {
    if (i === n) { consider(path); return; }
    var list = cands[i];
    for (var j = 0; j < list.length; j++) {
      path[i] = list[j];
      if (!ok(i, path)) continue;
      rec(i + 1, path);
    }
  }
  for (var i = 0; i < n; i++) if (cands[i].length === 0) {
    // still locate first infeasible prefix by brute
    return { ok: false, failFrame: firstInfeasible(project, cands), brute: true };
  }
  rec(0, new Array(n));
  if (!best) return { ok: false, failFrame: firstInfeasible(project, cands), brute: true };
  return {
    ok: true,
    positions: best.path.map(function (p) { return [p.x, p.y]; }),
    totalScore: best.score,
    totalAccel: best.accel,
    failFrame: -1
  };
}

function firstInfeasible(project, cands) {
  var n = project.frames.length;
  var speed = project.speed || [0, 0];
  var accel = project.accel || [0, 0];
  var sx = Math.abs(speed[0]), sy = Math.abs(speed[1]);
  var ax = Math.abs(accel[0]), ay = Math.abs(accel[1]);
  for (var t = 0; t < n; t++) {
    // does a feasible prefix of 0..t exist?
    var found = false;
    (function () {
      var path = new Array(t + 1);
      function ok2(i) {
        if (i === 0) return true;
        var cur = path[i], prev = path[i - 1];
        if (project.frames[i].cut) return true;
        if (Math.abs(cur.x - prev.x) > sx || Math.abs(cur.y - prev.y) > sy) return false;
        if (i >= 2 && !project.frames[i - 1].cut) {
          var pp = path[i - 2];
          if (Math.abs(cur.x - 2 * prev.x + pp.x) > ax) return false;
          if (Math.abs(cur.y - 2 * prev.y + pp.y) > ay) return false;
        }
        return true;
      }
      function rec2(i) {
        if (found) return;
        if (i === t + 1) { found = true; return; }
        var list = cands[i];
        for (var j = 0; j < list.length && !found; j++) {
          path[i] = list[j];
          if (ok2(i)) rec2(i + 1);
        }
      }
      rec2(0);
    })();
    if (!found) return t;
  }
  return -1;
}

module.exports = { solveBrute: solveBrute, normalizeCandidates: normalizeCandidates };
