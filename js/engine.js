/*
 * swept-contact-lab 核心引擎
 * 连续分离轴检测（continuous SAT），匀速平移二维凸多边形
 * 同一套代码供浏览器（classic script）与 Node（require）使用
 */
(function (global) {
  'use strict';

  // 并列判定容差：规范数据为干净数值，1e-12 仅用于吸收浮点误差
  var EPS = 1e-12;

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function len(a) { return Math.hypot(a[0], a[1]); }

  function bodyCenter(b) {
    // 中心取顶点均值（局部顶点均值 + 平移）
    var sx = 0, sy = 0;
    for (var i = 0; i < b.vertices.length; i++) {
      sx += b.vertices[i][0];
      sy += b.vertices[i][1];
    }
    var n = b.vertices.length;
    return [b.position[0] + sx / n, b.position[1] + sy / n];
  }

  // t 时刻世界顶点
  function worldVertsAt(b, t) {
    var px = b.position[0] + b.velocity[0] * t;
    var py = b.position[1] + b.velocity[1] * t;
    return b.vertices.map(function (v) { return [v[0] + px, v[1] + py]; });
  }

  // 多边形在单位轴 u 上的投影区间（给定世界顶点）
  function projectVerts(verts, u) {
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < verts.length; i++) {
      var d = verts[i][0] * u[0] + verts[i][1] * u[1];
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    return [mn, mx];
  }

  // 一条边的轴向量：CCW 多边形边 (p1-p0) 的 (ey, -ex)，再归一化
  function edgeAxis(p0, p1) {
    var ex = p1[0] - p0[0];
    var ey = p1[1] - p0[1];
    var u = [ey, -ex];
    var l = Math.hypot(u[0], u[1]);
    return [u[0] / l, u[1] / l];
  }

  function buildAxes(bodyA, bodyB) {
    // 轴按物体 id（A 先 B 后）、原始边号排列
    var axes = [];
    [bodyA, bodyB].forEach(function (body, bi) {
      var owner = bi === 0 ? bodyA.id : bodyB.id;
      var vs = body.vertices;
      for (var i = 0; i < vs.length; i++) {
        var p0 = vs[i];
        var p1 = vs[(i + 1) % vs.length];
        var u = edgeAxis(p0, p1);
        axes.push({ owner: owner, edge: i, u: u });
      }
    });
    return axes;
  }

  // 相对速度在轴上的投影（两区间端点同斜率）
  function relativeSlope(bodyA, bodyB, u) {
    var rx = bodyB.velocity[0] - bodyA.velocity[0];
    var ry = bodyB.velocity[1] - bodyA.velocity[1];
    return rx * u[0] + ry * u[1];
  }

  /*
   * 单对物体的连续 SAT 分析。
   * 返回 null 表示整段时间轴上都不存在闭集接触；
   * 否则返回接触区间（尚未与 [0,dt] 求交）及逐轴数据。
   */
  function analyzePairRaw(bodyA, bodyB) {
    var axes = buildAxes(bodyA, bodyB);
    var wA0 = worldVertsAt(bodyA, 0);
    var wB0 = worldVertsAt(bodyB, 0);
    var sRel = [bodyB.velocity[0] - bodyA.velocity[0],
                bodyB.velocity[1] - bodyA.velocity[1]];

    var L = -Infinity, H = Infinity;
    var overlapAtZero = true;

    for (var k = 0; k < axes.length; k++) {
      var ax = axes[k];
      var u = ax.u;
      var pa = projectVerts(wA0, u); // [minA, maxA]
      var pb = projectVerts(wB0, u); // [minB, maxB]
      var l0 = pb[0] - pa[1];        // B 近端 - A 远端
      var h0 = pb[1] - pa[0];        // B 远端 - A 近端
      var s = sRel[0] * u[0] + sRel[1] * u[1];

      ax.projA0 = pa;
      ax.projB0 = pb;
      ax.l0 = l0;
      ax.h0 = h0;
      ax.slope = s;
      // t=0 沿该轴的闭集重叠深度（相切为 0）
      ax.depth0 = Math.min(-l0, h0);
      if (!(l0 <= EPS && h0 >= -EPS)) overlapAtZero = false;

      if (Math.abs(s) <= EPS) {
        // 静止轴：投影不随时间变化，闭集重叠条件 l0<=0 且 h0>=0
        if (l0 > EPS || h0 < -EPS) {
          ax.empty = true; // 严格分离，永不接触
          return null;
        }
        if (Math.abs(l0) <= EPS && Math.abs(h0) <= EPS) {
          // 两投影区间退化为同一点（顶点对顶点相切）：仅 t=0 允许
          ax.lo = 0;
          ax.hi = 0;
        } else {
          // 严格重叠或单侧点-边相切（l0=0 或 h0=0 且另一区间有厚度）：
          // 沿该轴在整个时间轴上都满足闭集重叠，不构成时间限制
          ax.lo = -Infinity;
          ax.hi = Infinity;
        }
      } else if (s > 0) {
        // lo(t)=l0+s t <=0 → t <= -l0/s ; hi(t)=h0+s t >=0 → t >= -h0/s
        ax.lo = -h0 / s;
        ax.hi = -l0 / s;
      } else {
        // s<0，不等式反向
        ax.lo = -l0 / s;
        ax.hi = -h0 / s;
      }
      if (ax.lo > L) L = ax.lo;
      if (ax.hi < H) H = ax.hi;
    }

    if (L > H + EPS) return null;
    if (L > H) {
      // 仅浮点误差造成的极小反转，按零面积点接触处理
      var mid = (L + H) / 2;
      L = H = mid;
    }

    return { axes: axes, L: L, H: H, startOverlap: overlapAtZero };
  }

  // 按规范定向法线：朝 B 中心 → A 中心方向；点积为零取首个非零分量为正
  function orientNormal(u, cA, cB) {
    var dx = cA[0] - cB[0];
    var dy = cA[1] - cB[1];
    var s = dx * u[0] + dy * u[1];
    var sign;
    if (Math.abs(s) <= EPS) {
      if (Math.abs(u[0]) > EPS) sign = u[0] > 0 ? 1 : -1;
      else sign = u[1] > 0 ? 1 : -1;
    } else {
      sign = s > 0 ? 1 : -1;
    }
    return [u[0] * sign, u[1] * sign];
  }

  function approxEqual(a, b) {
    return Math.abs(a - b) <= EPS;
  }

  /*
   * 完整单对检测：层/掩码过滤在外部完成。
   * 返回结果记录（含逐轴分析），帧内无接触返回 null。
   */
  function detectPair(bodyA, bodyB, dt) {
    var raw = analyzePairRaw(bodyA, bodyB);
    if (!raw) return null;

    var tEnter = Math.max(raw.L, 0);
    var tExit = Math.min(raw.H, dt);
    if (tEnter > tExit + EPS) return null;
    if (tEnter > tExit) {
      var mid2 = (tEnter + tExit) / 2;
      tEnter = tExit = mid2;
    }

    var axes = raw.axes;
    var enterIdx = -1, exitIdx = -1;

    if (raw.startOverlap) {
      // 初始重叠：t=0 最小重叠深度轴，并列取排序先者
      var bestDepth = Infinity;
      for (var i = 0; i < axes.length; i++) {
        if (axes[i].depth0 < bestDepth - EPS) {
          bestDepth = axes[i].depth0;
          enterIdx = i;
        }
      }
    } else {
      // 进入时刻：达到最大下界的轴，并列取排序先者
      for (var j = 0; j < axes.length; j++) {
        if (isFinite(axes[j].lo) && approxEqual(axes[j].lo, raw.L)) {
          enterIdx = j;
          break;
        }
      }
    }
    // 离开时刻：达到最小上界的轴；无有限上界则无离开轴（裁到 dt）
    if (isFinite(raw.H)) {
      for (var k = 0; k < axes.length; k++) {
        if (isFinite(axes[k].hi) && approxEqual(axes[k].hi, raw.H)) {
          exitIdx = k;
          break;
        }
      }
    }

    axes.forEach(function (ax, idx) {
      ax.limitsEnter = idx === enterIdx;
      ax.limitsExit = idx === exitIdx;
    });

    var cA = bodyCenter(bodyA);
    var cB = bodyCenter(bodyB);
    var normal = orientNormal(axes[enterIdx].u, cA, cB);

    return {
      a: bodyA.id,
      b: bodyB.id,
      tEnter: tEnter,
      tExit: tExit,
      startOverlap: raw.startOverlap,
      normal: normal,
      sensor: !!(bodyA.sensor || bodyB.sensor),
      // 调试附加字段（导出时剥离）
      _axes: axes,
      _enterAxis: enterIdx,
      _exitAxis: exitIdx,
      _rawL: raw.L,
      _rawH: raw.H
    };
  }

  function maskPairOk(bodyA, bodyB) {
    // 双方 mask 都包含对方 layer 才参与检测
    return ((bodyA.mask >> bodyB.layer) & 1) === 1 &&
           ((bodyB.mask >> bodyA.layer) & 1) === 1;
  }

  // 全场景检测。bodies 不必预排序，内部按 id 字符串排序确定 A、B
  function detectScene(scene) {
    var bodies = scene.bodies.slice().sort(function (x, y) {
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    var records = [];
    for (var i = 0; i < bodies.length; i++) {
      for (var j = i + 1; j < bodies.length; j++) {
        var A = bodies[i], B = bodies[j];
        if (!maskPairOk(A, B)) continue;
        var rec = detectPair(A, B, scene.dt);
        if (rec) records.push(rec);
      }
    }
    return records;
  }

  // 导出用干净记录（去掉调试字段）
  function publicRecord(rec) {
    return {
      a: rec.a,
      b: rec.b,
      tEnter: rec.tEnter,
      tExit: rec.tExit,
      startOverlap: rec.startOverlap,
      normal: rec.normal,
      sensor: rec.sensor
    };
  }

  // 给定轴与时刻，返回两物体的投影区间（供 UI 投影条）
  function projectionAt(bodyA, bodyB, u, t) {
    var wa = worldVertsAt(bodyA, t);
    var wb = worldVertsAt(bodyB, t);
    return { a: projectVerts(wa, u), b: projectVerts(wb, u) };
  }

  var API = {
    EPS: EPS,
    bodyCenter: bodyCenter,
    worldVertsAt: worldVertsAt,
    projectVerts: projectVerts,
    edgeAxis: edgeAxis,
    analyzePairRaw: analyzePairRaw,
    detectPair: detectPair,
    detectScene: detectScene,
    maskPairOk: maskPairOk,
    orientNormal: orientNormal,
    publicRecord: publicRecord,
    projectionAt: projectionAt
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
  global.SCL = global.SCL || {};
  global.SCL.engine = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
