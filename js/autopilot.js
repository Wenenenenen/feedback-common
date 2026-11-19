// 自动驾驶（纯函数式，无 DOM）：用于自测“赛道可完整跑完”并生成示例幽灵记录。
// 纯追踪（pure pursuit）：瞄准路径上前视距离处的一点，
//   δ = atan(2·L·sin(α) / Ld)，steer = δ / maxSteer，
// 弯前按前方夹角降速。所有输入都在 [-1,1] 内取整到 1e-4，便于导出。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.RallyAutopilot = factory(root.RallyEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  function normAng(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a <= -Math.PI) a += Math.PI * 2;
    return a;
  }
  function q(v) {
    return Math.round(v * 10000) / 10000;
  }

  // 闭合路点重复 repeat 圈，并在最前面插入起跑位置，保证第一段就在车前。
  function pathFromWaypoints(waypoints, repeat, start) {
    var pts = [];
    if (start) pts.push([start[0], start[1]]);
    for (var r = 0; r < repeat; r++) {
      for (var i = 0; i < waypoints.length; i++) pts.push([waypoints[i][0], waypoints[i][1]]);
    }
    // 收尾回到第一个路点，闭合
    if (waypoints.length) pts.push([waypoints[0][0], waypoints[0][1]]);
    return pts;
  }

  // 在 path 上从 windowStart 起、限定 +windowLen 段内找最近点
  function locate(path, x, y, windowStart, windowLen) {
    var last = path.length - 1;
    var from = E.clamp(windowStart | 0, 0, last - 1);
    var to = Math.min(last - 1, from + (windowLen || 12));
    var best = { idx: from, dist: Infinity, segT: 0 };
    for (var i = from; i <= to; i++) {
      var ax = path[i][0];
      var ay = path[i][1];
      var dx = path[i + 1][0] - ax;
      var dy = path[i + 1][1] - ay;
      var len2 = dx * dx + dy * dy || 1e-9;
      var t = E.clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
      var px = ax + dx * t;
      var py = ay + dy * t;
      var d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best.dist) best = { idx: i, dist: d, segT: t };
    }
    return best;
  }

  // 从最近点沿路前进 dist 米取点
  function pointAhead(path, loc, dist) {
    var last = path.length - 1;
    var i = E.clamp(loc.idx, 0, last - 1);
    var segT = E.clamp(loc.segT, 0, 1);
    // 先扣掉最近段剩余的 (1-segT) 段长
    var ax = path[i][0];
    var ay = path[i][1];
    var bx = path[i + 1][0];
    var by = path[i + 1][1];
    var segLen = Math.hypot(bx - ax, by - ay) || 1e-9;
    var remain = dist;
    var left = segLen * (1 - segT);
    if (remain <= left) {
      var t = segT + remain / segLen;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    remain -= left;
    var guard = 0;
    while (guard++ < path.length + 2) {
      i += 1;
      if (i >= last) return [path[last][0], path[last][1]];
      ax = path[i][0];
      ay = path[i][1];
      bx = path[i + 1][0];
      by = path[i + 1][1];
      segLen = Math.hypot(bx - ax, by - ay) || 1e-9;
      if (remain <= segLen) {
        var tt = remain / segLen;
        return [ax + (bx - ax) * tt, ay + (by - ay) * tt];
      }
      remain -= segLen;
    }
    return [path[last][0], path[last][1]];
  }

  // 路径在 loc 处的切线方向（弧度）
  function tangentAt(path, loc) {
    var i = E.clamp(loc.idx, 0, path.length - 2);
    return Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]);
  }

  // 前方 meters 米处路径相对当前切线的转角（弯道强度），用于降速
  function headingSpread(path, loc, meters) {
    var base = tangentAt(path, loc);
    var i = E.clamp(loc.idx, 0, path.length - 2);
    var p = pointAhead(path, { idx: i, segT: loc.segT }, meters);
    var ahead = Math.atan2(p[1] - path[i][1], p[0] - path[i][0]);
    var now = Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]);
    return Math.abs(normAng(ahead - now));
  }

  // 赛道没有闭合路点时（例如从导出文件重算），用门中心点串成路径
  function waypointsFromGates(gates) {
    return gates.map(function (g) {
      return [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
    });
  }

  function createAutopilot(track, opts) {
    opts = opts || {};
    var waypoints = track.waypoints && track.waypoints.length >= 3 ? track.waypoints : waypointsFromGates(track.gates);
    var laps = opts.laps != null ? opts.laps : track.laps || 1;
    var path = pathFromWaypoints(waypoints, laps + 1, [track.initial.x, track.initial.y]);
    var L = track.params.wheelbase;
    var lookahead = opts.lookahead != null ? opts.lookahead : 9;
    var cruise = opts.cruise != null ? opts.cruise : 25;
    var windowStart = 0;
    var ctrl = {
      race: null,
      sample: function () {
        var race = ctrl.race;
        if (!race) return { throttle: 0, steer: 0, brake: false };
        var st = race.getState();
        var loc = locate(path, st.x, st.y, windowStart, 16);
        windowStart = loc.idx;
        var la = pointAhead(path, loc, lookahead);
        var dx = la[0] - st.x;
        var dy = la[1] - st.y;
        var Ld = Math.hypot(dx, dy) || 1e-6;
        var alpha = normAng(Math.atan2(dy, dx) - st.yaw);
        // 纯追踪曲率 -> 前轮转角
        var delta = Math.atan2(2 * L * Math.sin(alpha), Ld);
        var steer = q(E.clamp(delta / track.params.maxSteer, -1, 1));

        var curve = headingSpread(path, loc, 18);
        var targetSpeed = E.clamp(cruise - curve * 30, 8, cruise);
        var speed = Math.abs(st.v);
        var throttle = 0;
        var brake = false;
        if (speed < targetSpeed - 0.8) throttle = q(E.clamp((targetSpeed - speed) / 3.5, 0.35, 1));
        else if (speed > targetSpeed + 1.5) {
          throttle = 0;
          brake = true;
        } else {
          // 维持速度：抵消阻力所需的油门
          throttle = q(E.clamp((track.params.drag * speed) / track.params.accel + 0.15, 0.15, 1));
        }
        return { throttle: throttle, steer: steer, brake: brake };
      },
      reset: function () {
        windowStart = 0;
      },
      path: path,
    };
    return ctrl;
  }

  // 用自动驾驶跑完整场，返回 {result, inputs}（inputs 为稠密逐 tick 记录）
  function driveRace(track, opts) {
    opts = opts || {};
    var race = E.createRace(track, opts.raceOptions || {});
    var ap = createAutopilot(track, opts);
    ap.race = race;
    var inputs = [];
    var guard = 0;
    while (!race.done && guard++ < E.MAX_TICKS) {
      var inp = ap.sample();
      inputs.push({ tick: race.tick, throttle: inp.throttle, steer: inp.steer, brake: !!inp.brake });
      race.step(inp);
    }
    return { result: race.getResult(), inputs: inputs, race: race };
  }

  return {
    createAutopilot: createAutopilot,
    driveRace: driveRace,
    pathFromWaypoints: pathFromWaypoints,
    waypointsFromGates: waypointsFromGates,
    locate: locate,
    pointAhead: pointAhead,
    normAng: normAng,
  };
});
