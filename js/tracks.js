// 内置赛道。检查门 = 有向线段 + 指向正侧的单位 normal。
// 门的位置与朝向由作者显式给出；waypoints 只是路面中心线，用于渲染与自动驾驶参考。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RallyTracks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PARAMS = {
    wheelbase: 2,
    maxSteer: 0.6,
    accel: 6,
    drag: 0.1,
    maxSpeed: 30,
    brakeAccel: 10,
  };

  function norm(v) {
    var l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  }

  // 闭合路点 -> 门：每道门放在一段路点的中点，门线横跨路面，normal 指向车流。
  function gatesFromWaypoints(points, halfWidth) {
    var n = points.length;
    var gates = [];
    for (var i = 0; i < n; i++) {
      var cur = points[i];
      var next = points[(i + 1) % n];
      var dx = next[0] - cur[0];
      var dy = next[1] - cur[1];
      var len = Math.hypot(dx, dy) || 1;
      var normal = [dx / len, dy / len];
      var perp = [-normal[1], normal[0]];
      var hw = typeof halfWidth === 'function' ? halfWidth(i) : halfWidth;
      var mx = (cur[0] + next[0]) / 2;
      var my = (cur[1] + next[1]) / 2;
      gates.push({
        a: [mx + perp[0] * hw, my + perp[1] * hw],
        b: [mx - perp[0] * hw, my - perp[1] * hw],
        normal: normal,
      });
    }
    return gates;
  }

  // 手写门：给出中心点、法向（车流方向）与半宽
  function gateAt(cx, cy, nx, ny, halfWidth) {
    var n = norm([nx, ny]);
    var perp = [-n[1], n[0]];
    return {
      a: [cx + perp[0] * halfWidth, cy + perp[1] * halfWidth],
      b: [cx - perp[0] * halfWidth, cy - perp[1] * halfWidth],
      normal: n,
    };
  }

  function startBehind(gates, distance) {
    var g = gates[0];
    var mx = (g.a[0] + g.b[0]) / 2;
    var my = (g.a[1] + g.b[1]) / 2;
    var n = g.normal;
    return {
      x: mx - n[0] * distance,
      y: my - n[1] * distance,
      yaw: Math.atan2(n[1], n[0]),
      v: 0,
    };
  }

  function makeTrack(name, gates, waypoints, halfWidth, opts) {
    opts = opts || {};
    var params = {
      wheelbase: PARAMS.wheelbase,
      maxSteer: PARAMS.maxSteer,
      accel: PARAMS.accel,
      drag: PARAMS.drag,
      maxSpeed: PARAMS.maxSpeed,
      brakeAccel: PARAMS.brakeAccel,
    };
    if (opts.params) for (var k in opts.params) params[k] = opts.params[k];
    return {
      name: name,
      params: params,
      initial: opts.initial || startBehind(gates, opts.startDistance || 10),
      gates: gates,
      laps: opts.laps != null ? opts.laps : null,
      waypoints: waypoints.map(function (p) {
        return [p[0], p[1]];
      }),
      roadHalfWidth: halfWidth,
      note: opts.note || '',
    };
  }

  // ---------------------------------------------------------------- 1. 环线

  var LOOP_WAYPOINTS = [
    [-52, -30],
    [-16, -34],
    [18, -32],
    [40, -18],
    [48, 2],
    [38, 22],
    [14, 30],
    [-12, 28],
    [-32, 18],
    [-46, 2],
    [-52, -14],
  ];

  var loopTrack = makeTrack(
    '青石环线',
    gatesFromWaypoints(LOOP_WAYPOINTS, 8.5),
    LOOP_WAYPOINTS,
    8.5,
    { laps: 3, startDistance: 11, note: '11 道门的闭合环线，弯道多，适合练走线。' }
  );

  // ---------------------------------------------------------------- 2. 窄门

  var NARROW_WAYPOINTS = [
    [26, -14],
    [10, -19],
    [-8, -17],
    [-22, -8],
    [-24, 6],
    [-12, 15],
    [4, 17],
    [18, 11],
    [26, 0],
  ];

  var narrowTrack = makeTrack(
    '窄门练习场',
    gatesFromWaypoints(NARROW_WAYPOINTS, 5.2),
    NARROW_WAYPOINTS,
    5.2,
    { laps: 3, startDistance: 9, note: '门更窄，要求贴线；倒车回来会撞出违规记录。' }
  );

  // ---------------------------------------------------------------- 3. 直道多门

  var STRAIGHT_WAYPOINTS = [
    [-74, -9],
    [74, -9],
    [78, 0],
    [74, 9],
    [-74, 9],
    [-78, 0],
  ];

  // 底部直道沿 +x 行驶：门线竖直，normal=(1,0)
  // x=0 附近放三道相距 5 cm 的门，正常车速一步即可跨过 3 道，演示“一步跨多门”。
  var straightGates = [];
  var straightXs = [-60, -40, -22, 0, 0.05, 0.1, 20, 40, 60];
  straightXs.forEach(function (x) {
    straightGates.push(gateAt(x, -9, 1, 0, 8));
  });
  // 右端：沿 +y 穿过
  straightGates.push(gateAt(76, 0, 0, 1, 8));
  // 顶部直道沿 -x 行驶
  [60, 20, -20, -60].forEach(function (x) {
    straightGates.push(gateAt(x, 9, -1, 0, 8));
  });
  // 左端：沿 -y 穿过，回到起点
  straightGates.push(gateAt(-76, 0, 0, -1, 8));

  var straightTrack = makeTrack(
    '直道多门',
    straightGates,
    STRAIGHT_WAYPOINTS,
    9,
    {
      laps: 2,
      startDistance: 12,
      note: '长直道在 x=0 附近有三道相距 5 cm 的门，同一步跨过时按交点顺序结算。',
    }
  );
  straightTrack.clusterGates = [3, 4, 5];

  var TRACKS = [loopTrack, narrowTrack, straightTrack];

  function byName(name) {
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].name === name) return TRACKS[i];
    return TRACKS[0];
  }

  function toExport(track) {
    return {
      name: track.name,
      params: {
        wheelbase: track.params.wheelbase,
        maxSteer: track.params.maxSteer,
        accel: track.params.accel,
        drag: track.params.drag,
        maxSpeed: track.params.maxSpeed,
        brakeAccel: track.params.brakeAccel,
      },
      initial: {
        x: track.initial.x,
        y: track.initial.y,
        yaw: track.initial.yaw,
        v: track.initial.v,
      },
      gates: track.gates.map(function (g) {
        return { a: [g.a[0], g.a[1]], b: [g.b[0], g.b[1]], normal: [g.normal[0], g.normal[1]] };
      }),
      laps: track.laps,
      // 路面中心线是可选的显示/驾驶辅助；核心判定只用 gates
      waypoints: track.waypoints ? track.waypoints.map(function (p) { return [p[0], p[1]]; }) : undefined,
      roadHalfWidth: track.roadHalfWidth,
    };
  }

  return {
    TRACKS: TRACKS,
    PARAMS: PARAMS,
    byName: byName,
    toExport: toExport,
    gatesFromWaypoints: gatesFromWaypoints,
    gateAt: gateAt,
  };
});
