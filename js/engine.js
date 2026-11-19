// 俯视拉力计时 · 核心逻辑
// 说明.txt 的逐条实现：120Hz 固定步长简化自行车模型、有向检查门相交、
// 顺序状态机、步内交点时刻、稀疏输入回放。
//
// 本文件不依赖 DOM、时钟或随机数，浏览器与 Node 共用，保证确定性。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./detmath.js'));
  else root.RallyEngine = factory(root.RallyMath);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DET) {
  'use strict';

  // 逻辑里的三角函数一律走确定性实现（见 detmath.js），保证跨引擎逐位复现。
  var MATH_SIN = DET.sin;
  var MATH_COS = DET.cos;
  var MATH_TAN = DET.tan;
  var MATH_HYPOT = DET.hypot;

  var TICK_RATE = 120;
  var DT = 1 / TICK_RATE;
  var MAX_TICKS = 10000;
  var MIN_GATES = 2;
  var MAX_GATES = 64;

  // 几何误差上限（说明允许 1e-9）。只吸收浮点噪声：
  //  - 起点离门面 1e-9 以内视为“恰在门上”，不产生跨门；
  //  - 交点落在门端点外 1e-9 以内仍算在门线段内，绝不会把门当作无限长直线。
  var EPS = 1e-9;

  // 导入赛道时对法向的宽容度：必须是近似单位向量且与门线段近似垂直。
  var UNIT_TOL = 1e-3;

  // 与包内样例 race.json 一致；仅用于“导入赛道缺少 params”时补全
  var DEFAULT_PARAMS = Object.freeze({
    wheelbase: 2,
    maxSteer: 0.6,
    accel: 6,
    drag: 0.1,
    maxSpeed: 30,
    brakeAccel: 10,
  });

  // ---------------------------------------------------------------- 工具

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }
  function isVec2(v) {
    return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }
  function normAngle(a) {
    var twoPi = Math.PI * 2;
    a = a % twoPi;
    if (a <= -Math.PI) a += twoPi;
    else if (a > Math.PI) a -= twoPi;
    return a;
  }
  function copyVec(v) {
    return [v[0], v[1]];
  }

  // 32 位 FNV-1a，用于判定两次运行是否逐位一致
  function fnv1a(str, seed) {
    var h = seed === undefined ? 2166136261 : seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h ^= c & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
      var hi = c >>> 8;
      if (hi) {
        h ^= hi;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return h >>> 0;
  }
  function hex8(n) {
    return ('00000000' + (n >>> 0).toString(16)).slice(-8);
  }
  function stateKey(s) {
    return s.x + '|' + s.y + '|' + s.yaw + '|' + s.v;
  }

  // ---------------------------------------------------------------- 校验

  function validateParams(p, prefix) {
    prefix = prefix || 'params';
    if (!isObj(p)) return [prefix + ': 必须是对象'];
    var errs = [];
    var keys = ['wheelbase', 'maxSteer', 'accel', 'drag', 'maxSpeed', 'brakeAccel'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in p)) errs.push(prefix + '.' + k + ': 缺失');
      else if (!isNum(p[k])) errs.push(prefix + '.' + k + ': 必须是有限数值');
    }
    if (errs.length) return errs;
    if (!(p.wheelbase > 0)) errs.push(prefix + '.wheelbase: 必须为正数');
    if (!(p.maxSteer > 0)) errs.push(prefix + '.maxSteer: 必须为正数');
    if (!(p.maxSteer < Math.PI / 2)) errs.push(prefix + '.maxSteer: 必须小于 π/2');
    if (!(p.accel > 0)) errs.push(prefix + '.accel: 必须为正数');
    if (!(p.drag >= 0)) errs.push(prefix + '.drag: 不能为负数');
    if (!(p.maxSpeed > 0)) errs.push(prefix + '.maxSpeed: 必须为正数');
    if (!(p.brakeAccel > 0)) errs.push(prefix + '.brakeAccel: 必须为正数');
    return errs;
  }

  function validateInitial(init, prefix) {
    prefix = prefix || 'initial';
    if (!isObj(init)) return [prefix + ': 必须是对象'];
    var errs = [];
    var keys = ['x', 'y', 'yaw', 'v'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in init)) errs.push(prefix + '.' + k + ': 缺失');
      else if (!isNum(init[k])) errs.push(prefix + '.' + k + ': 必须是有限数值');
    }
    return errs;
  }

  function validateGates(gates, prefix) {
    prefix = prefix || 'gates';
    if (!Array.isArray(gates)) return [prefix + ': 必须是数组'];
    var errs = [];
    if (gates.length < MIN_GATES) errs.push(prefix + ': 至少需要 ' + MIN_GATES + ' 道门');
    if (gates.length > MAX_GATES) errs.push(prefix + ': 最多 ' + MAX_GATES + ' 道门');
    for (var i = 0; i < gates.length; i++) {
      var p = prefix + '[' + i + ']';
      var g = gates[i];
      if (!isObj(g)) {
        errs.push(p + ': 必须是对象');
        continue;
      }
      var ok = true;
      if (!isVec2(g.a)) {
        errs.push(p + '.a: 必须是 [x, y] 两个有限数');
        ok = false;
      }
      if (!isVec2(g.b)) {
        errs.push(p + '.b: 必须是 [x, y] 两个有限数');
        ok = false;
      }
      if (!isVec2(g.normal)) {
        errs.push(p + '.normal: 必须是 [x, y] 两个有限数');
        ok = false;
      }
      if (!ok) continue;
      var dx = g.b[0] - g.a[0];
      var dy = g.b[1] - g.a[1];
      var len = MATH_HYPOT(dx, dy);
      if (!(len > 0)) {
        errs.push(p + ': 门线段长度必须大于 0');
        continue;
      }
      var nl = MATH_HYPOT(g.normal[0], g.normal[1]);
      if (!(nl > 0)) {
        errs.push(p + '.normal: 长度必须大于 0');
        continue;
      }
      if (Math.abs(nl - 1) > UNIT_TOL) {
        errs.push(p + '.normal: 必须是单位向量（长度 ' + nl.toFixed(6) + '）');
        continue;
      }
      var dot = (g.normal[0] * dx + g.normal[1] * dy) / len;
      if (Math.abs(dot) > UNIT_TOL) {
        errs.push(p + '.normal: 必须垂直于 b-a（单位点积 ' + dot.toFixed(6) + '）');
      }
    }
    return errs;
  }

  function validateTrack(track, opts) {
    opts = opts || {};
    if (!isObj(track)) return ['赛道: 必须是对象 {params, initial, gates}'];
    var errs = [];
    if (!('params' in track)) {
      if (!opts.allowDefaults) errs.push('params: 缺失');
    } else {
      errs = errs.concat(validateParams(track.params));
    }
    if (!('initial' in track)) {
      if (!opts.allowDefaults) errs.push('initial: 缺失');
    } else {
      errs = errs.concat(validateInitial(track.initial));
    }
    if (!('gates' in track)) errs.push('gates: 缺失');
    else errs = errs.concat(validateGates(track.gates));
    if ('laps' in track && track.laps !== null && track.laps !== undefined) {
      if (!isInt(track.laps) || track.laps < 1 || track.laps > 999) {
        errs.push('laps: 必须是 1..999 的整数');
      }
    }
    return errs;
  }

  // 规范化门：缓存沿门方向的单位向量，线段范围判定用它
  function prepareGates(gates) {
    var out = [];
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      var dx = g.b[0] - g.a[0];
      var dy = g.b[1] - g.a[1];
      var len = MATH_HYPOT(dx, dy);
      var nl = MATH_HYPOT(g.normal[0], g.normal[1]) || 1;
      out.push({
        a: [g.a[0], g.a[1]],
        b: [g.b[0], g.b[1]],
        normal: [g.normal[0] / nl, g.normal[1] / nl],
        ux: dx / len,
        uy: dy / len,
        len: len,
        len2: len * len,
      });
    }
    return out;
  }

  function autoInitial(gates) {
    var g = gates[0];
    var mx = (g.a[0] + g.b[0]) / 2;
    var my = (g.a[1] + g.b[1]) / 2;
    var n = g.normal;
    return {
      x: mx - n[0] * 8,
      y: my - n[1] * 8,
      yaw: DET.atan2(n[1], n[0]),
      v: 0,
    };
  }

  // 导入赛道：补默认值（只用于“导入赛道”，回放校验不会放宽）
  function normalizeTrack(raw) {
    var errors = validateTrack(raw, { allowDefaults: true });
    if (errors.length) return { ok: false, errors: errors, track: null, warnings: [] };
    var warnings = [];
    var params = {};
    var src = isObj(raw.params) ? raw.params : null;
    if (!src) warnings.push('未提供 params，使用默认车辆参数');
    for (var k in DEFAULT_PARAMS) {
      params[k] = src && isNum(src[k]) ? src[k] : DEFAULT_PARAMS[k];
    }
    var gates = prepareGates(raw.gates);
    var initial;
    if (isObj(raw.initial)) {
      initial = { x: raw.initial.x, y: raw.initial.y, yaw: raw.initial.yaw, v: raw.initial.v };
    } else {
      initial = autoInitial(gates);
      warnings.push('未提供 initial，已把车放在 0 号门负侧 8 米处');
    }
    var laps = isInt(raw.laps) && raw.laps >= 1 ? raw.laps : null;
    var track = {
      name: typeof raw.name === 'string' && raw.name ? raw.name : '导入赛道',
      params: params,
      initial: initial,
      gates: gates,
      laps: laps,
    };
    // 内置赛道带闭合路点，供自动驾驶与画路面参考；导入数据不带就留空
    if (Array.isArray(raw.waypoints)) {
      track.waypoints = raw.waypoints
        .filter(isVec2)
        .map(function (p) {
          return [p[0], p[1]];
        });
    }
    if (isNum(raw.roadHalfWidth) && raw.roadHalfWidth > 0) track.roadHalfWidth = raw.roadHalfWidth;
    return { ok: true, errors: [], warnings: warnings, track: track };
  }

  // ---------------------------------------------------------------- 判门

  // 位置段 p->q 与所有门的相交，按 (t, 门序号) 排序。
  // s0/s1 是两端点到门面的有符号距离（沿 normal）。
  function gateCrossings(p, q, gates) {
    var out = [];
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      var nx = g.normal[0];
      var ny = g.normal[1];
      var s0 = (p.x - g.a[0]) * nx + (p.y - g.a[1]) * ny;
      var s1 = (q.x - g.a[0]) * nx + (q.y - g.a[1]) * ny;

      // 起点恰在门上：不产生跨门（含 1e-9 浮点噪声）
      if (Math.abs(s0) <= EPS) continue;

      var dir;
      if (s0 < 0) {
        if (s1 < -EPS) continue;
        dir = 'forward';
      } else {
        if (s1 > EPS) continue;
        dir = 'reverse';
      }

      // s1 在容差内时按 0 处理，使 t 落在 [0,1] 闭区间
      var s1c = Math.abs(s1) <= EPS ? 0 : s1;
      var t = -s0 / (s1c - s0);
      if (!(t >= 0 && t <= 1)) continue;
      if (t < 0) t = 0;
      if (t > 1) t = 1;

      var px = p.x + (q.x - p.x) * t;
      var py = p.y + (q.y - p.y) * t;
      // 交点到门线段的投影参数 u；容差换算成沿门方向的距离 1e-9
      var u = ((px - g.a[0]) * g.ux + (py - g.a[1]) * g.uy) / g.len;
      var tol = EPS / g.len;
      if (u < -tol || u > 1 + tol) continue;
      u = clamp(u, 0, 1);

      out.push({ gate: i, direction: dir, t: t, u: u, point: [px, py] });
    }
    out.sort(function (a, b) {
      return a.t - b.t || a.gate - b.gate;
    });
    return out;
  }

  // 顺序仲裁器：只保留“是否已开始 + 期望门”，圈速由比赛外层记录
  function createArbiter(gateCount) {
    return { gateCount: gateCount, started: false, expectedGate: 0 };
  }

  // outcome: start | advance | lap | outOfOrder | reverse
  function arbitrate(arb, gateIndex, direction) {
    var expectedBefore = arb.expectedGate;
    if (direction === 'reverse') {
      return { outcome: 'reverse', expectedBefore: expectedBefore };
    }
    if (!arb.started) {
      if (gateIndex !== 0) return { outcome: 'outOfOrder', expectedBefore: expectedBefore };
      arb.started = true;
      arb.expectedGate = 1 % arb.gateCount;
      return { outcome: 'start', expectedBefore: expectedBefore };
    }
    if (gateIndex !== arb.expectedGate) {
      return { outcome: 'outOfOrder', expectedBefore: expectedBefore };
    }
    if (arb.expectedGate === 0) {
      arb.expectedGate = 1 % arb.gateCount;
      return { outcome: 'lap', expectedBefore: expectedBefore };
    }
    arb.expectedGate = (arb.expectedGate + 1) % arb.gateCount;
    return { outcome: 'advance', expectedBefore: expectedBefore };
  }

  // ---------------------------------------------------------------- 物理

  function clampInput(input) {
    input = input || {};
    return {
      throttle: isNum(input.throttle) ? clamp(input.throttle, -1, 1) : 0,
      steer: isNum(input.steer) ? clamp(input.steer, -1, 1) : 0,
      brake: !!input.brake,
    };
  }

  // 单步物理。顺序严格按说明：
  //  1) 速度积分（油门/阻力），钳位，刹车向 0 靠近不跨 0
  //  2) 用新速度更新偏航
  //  3) 用新偏航更新位置
  function stepVehicle(state, input, params) {
    var v = state.v + (params.accel * input.throttle - params.drag * state.v) * DT;
    v = clamp(v, -params.maxSpeed / 2, params.maxSpeed);
    if (input.brake) {
      if (v > 0) v = Math.max(0, v - params.brakeAccel * DT);
      else if (v < 0) v = Math.min(0, v + params.brakeAccel * DT);
    }
    var yaw = state.yaw + ((v / params.wheelbase) * MATH_TAN(input.steer * params.maxSteer)) * DT;
    return {
      x: state.x + v * MATH_COS(yaw) * DT,
      y: state.y + v * MATH_SIN(yaw) * DT,
      yaw: yaw,
      v: v,
    };
  }

  // ---------------------------------------------------------------- 比赛

  function createRace(track, options) {
    options = options || {};
    if (!track || !track.gates) throw new Error('createRace 需要已准备的赛道');
    var params = track.params;
    var gates = track.gates;
    var lapTarget =
      options.lapsToFinish != null ? options.lapsToFinish : track.laps != null ? track.laps : null;
    if (lapTarget != null && (!isInt(lapTarget) || lapTarget < 1)) lapTarget = null;
    var maxTicks = options.maxTicks != null ? options.maxTicks : MAX_TICKS;

    var state = {
      x: track.initial.x,
      y: track.initial.y,
      yaw: track.initial.yaw,
      v: track.initial.v,
    };
    var arb = createArbiter(gates.length);

    var sim = {
      track: track,
      params: params,
      gates: gates,
      state: state,
      tick: 0,
      arbiter: arb,
      started: false,
      finished: false,
      done: false,
      doneReason: null,
      start: null,
      finish: null,
      lapNumber: 0,
      laps: [],
      accepted: [],
      violations: [],
      violationCounts: { outOfOrder: 0, reverse: 0 },
      currentSplits: [],
      currentTopSpeed: Math.abs(track.initial.v),
      lapStart: null,
      checksum: 2166136261 >>> 0,
      lastEvents: [],
      maxTicks: maxTicks,
      lapTarget: lapTarget,
    };

    function applyCrossing(c, prevState) {
      var time = (sim.tick + c.t) / TICK_RATE;
      var expectedBefore = arb.expectedGate;
      var verdict = arbitrate(arb, c.gate, c.direction);
      var ev = {
        gate: c.gate,
        direction: c.direction,
        t: c.t,
        u: c.u,
        tick: sim.tick,
        time: time,
        point: [c.point[0], c.point[1]],
        outcome: verdict.outcome,
        expectedBefore: expectedBefore,
      };

      if (verdict.outcome === 'reverse' || verdict.outcome === 'outOfOrder') {
        var kind = verdict.outcome;
        if (kind === 'reverse') sim.violationCounts.reverse += 1;
        else sim.violationCounts.outOfOrder += 1;
        if (sim.violations.length < 5000) {
          sim.violations.push({
            kind: kind,
            gate: c.gate,
            expected: expectedBefore,
            tick: sim.tick,
            t: c.t,
            time: time,
            point: [c.point[0], c.point[1]],
          });
        }
        return ev;
      }

      // 正向且符合顺序
      sim.accepted.push({
        gate: c.gate,
        tick: sim.tick,
        t: c.t,
        time: time,
        point: [c.point[0], c.point[1]],
      });

      if (verdict.outcome === 'start') {
        sim.started = true;
        sim.lapNumber = 1;
        sim.start = { tick: sim.tick, t: c.t, time: time };
        sim.lapStart = { tick: sim.tick, t: c.t, time: time };
        sim.currentSplits = [];
        sim.currentTopSpeed = Math.abs(prevState.v);
        return ev;
      }

      var split = { gate: c.gate, tick: sim.tick, t: c.t, time: time, split: time - sim.lapStart.time };
      sim.currentSplits.push(split);

      if (verdict.outcome === 'advance') return ev;

      // 收圈，同时开始下一圈
      var lap = {
        index: sim.lapNumber,
        startTick: sim.lapStart.tick,
        startT: sim.lapStart.t,
        startTime: sim.lapStart.time,
        endTick: sim.tick,
        endT: c.t,
        endTime: time,
        time: time - sim.lapStart.time,
        splits: sim.currentSplits.map(function (s) {
          return { gate: s.gate, tick: s.tick, t: s.t, time: s.time, split: s.split };
        }),
        topSpeed: sim.currentTopSpeed,
      };
      sim.laps.push(lap);
      sim.currentSplits = [];
      sim.currentTopSpeed = Math.abs(prevState.v);
      sim.lapStart = { tick: sim.tick, t: c.t, time: time };
      sim.lapNumber += 1;
      if (sim.lapTarget != null && sim.laps.length >= sim.lapTarget) {
        sim.finished = true;
        sim.done = true;
        sim.doneReason = 'finished';
        sim.finish = { tick: sim.tick, t: c.t, time: time };
      }
      return ev;
    }

    sim.step = function (rawInput) {
      if (sim.done) {
        return { tick: sim.tick, applied: false, events: [], crossings: [] };
      }
      var input = clampInput(rawInput);
      var prev = { x: state.x, y: state.y, yaw: state.yaw, v: state.v };
      var next = stepVehicle(state, input, params);
      var crossings = gateCrossings(prev, next, gates);
      var events = [];
      for (var i = 0; i < crossings.length; i++) {
        events.push(applyCrossing(crossings[i], prev));
        if (sim.done) break;
      }
      var stepTick = sim.tick;
      state.x = next.x;
      state.y = next.y;
      state.yaw = next.yaw;
      state.v = next.v;
      var speed = Math.abs(next.v);
      if (speed > sim.currentTopSpeed) sim.currentTopSpeed = speed;
      sim.tick += 1;
      sim.checksum = fnv1a(stateKey(next) + '|' + sim.tick, sim.checksum);
      sim.lastEvents = events;
      if (!sim.done && sim.tick >= maxTicks) {
        sim.done = true;
        sim.doneReason = 'tick-limit';
      }
      return { tick: stepTick, applied: true, events: events, crossings: crossings, prev: prev, next: next };
    };

    sim.getState = function () {
      return { x: state.x, y: state.y, yaw: state.yaw, v: state.v };
    };

    sim.currentTime = function () {
      return sim.tick / TICK_RATE;
    };

    sim.currentLapTime = function () {
      if (!sim.started || !sim.lapStart) return 0;
      return sim.tick / TICK_RATE - sim.lapStart.time;
    };

    // 本圈已通过的正向门数（含起步的 0 号门）；完赛后即为整圈门数
    sim.gatesThisLap = function () {
      if (!sim.started) return 0;
      if (sim.finished) return gates.length;
      return Math.min(gates.length, 1 + sim.currentSplits.length);
    };

    sim.progress = function () {
      return {
        started: sim.started,
        finished: sim.finished,
        done: sim.done,
        doneReason: sim.doneReason,
        currentLap: sim.lapNumber,
        lapTarget: sim.lapTarget,
        expectedGate: arb.expectedGate,
        gatesPerLap: gates.length,
        gatesThisLap: sim.gatesThisLap(),
        acceptedCount: sim.accepted.length,
        violationCount: sim.violationCounts.outOfOrder + sim.violationCounts.reverse,
      };
    };

    sim.getResult = function () {
      return {
        started: sim.started,
        finished: sim.finished,
        doneReason: sim.doneReason,
        ticks: sim.tick,
        tickRate: TICK_RATE,
        start: sim.start ? { tick: sim.start.tick, t: sim.start.t, time: sim.start.time } : null,
        finish: sim.finish ? { tick: sim.finish.tick, t: sim.finish.t, time: sim.finish.time } : null,
        final: sim.getState(),
        laps: JSON.parse(JSON.stringify(sim.laps)),
        accepted: JSON.parse(JSON.stringify(sim.accepted)),
        violations: JSON.parse(JSON.stringify(sim.violations)),
        violationCounts: {
          outOfOrder: sim.violationCounts.outOfOrder,
          reverse: sim.violationCounts.reverse,
        },
        progress: sim.progress(),
        checksum: hex8(sim.checksum),
      };
    };

    return sim;
  }

  // ---------------------------------------------------------------- 回放

  function validateInputs(inputs) {
    if (!Array.isArray(inputs)) return ['inputs: 必须是数组'];
    if (inputs.length === 0) return ['inputs: 至少需要一个 tick 0 的输入'];
    var errs = [];
    if (inputs.length > MAX_TICKS + 1) errs.push('inputs: 条目过多（最多 ' + (MAX_TICKS + 1) + '）');
    var prev = -1;
    for (var i = 0; i < inputs.length; i++) {
      var e = inputs[i];
      var p = 'inputs[' + i + ']';
      if (!isObj(e)) {
        errs.push(p + ': 必须是对象');
        continue;
      }
      if (!isInt(e.tick)) errs.push(p + '.tick: 必须是整数');
      else {
        if (e.tick < 0) errs.push(p + '.tick: 不能为负');
        if (e.tick > MAX_TICKS) errs.push(p + '.tick: 不能超过 ' + MAX_TICKS);
        if (e.tick <= prev) errs.push(p + '.tick: 必须严格递增（前一项 ' + prev + '）');
        prev = e.tick;
      }
      if (!isNum(e.throttle) || e.throttle < -1 || e.throttle > 1) errs.push(p + '.throttle: 必须是 -1..1 的数值');
      if (!isNum(e.steer) || e.steer < -1 || e.steer > 1) errs.push(p + '.steer: 必须是 -1..1 的数值');
      if (typeof e.brake !== 'boolean') errs.push(p + '.brake: 必须是布尔值');
    }
    if (isObj(inputs[0]) && inputs[0].tick !== 0) errs.push('inputs[0].tick: 首项必须为 0');
    return errs;
  }

  function validateReplay(replay) {
    if (!isObj(replay)) return ['回放: 必须是对象 {initial, params, gates, inputs}'];
    var errs = validateTrack(replay, { allowDefaults: false });
    errs = errs.concat(validateInputs(replay.inputs));
    if ('ticks' in replay && replay.ticks !== null) {
      if (!isInt(replay.ticks) || replay.ticks < 0 || replay.ticks > MAX_TICKS) {
        errs.push('ticks: 必须是 0..' + MAX_TICKS + ' 的整数');
      }
    }
    return errs;
  }

  function prepareFromReplay(replay) {
    var params = {};
    for (var k in DEFAULT_PARAMS) params[k] = replay.params[k];
    return {
      name: typeof replay.name === 'string' && replay.name ? replay.name : '回放',
      params: params,
      initial: {
        x: replay.initial.x,
        y: replay.initial.y,
        yaw: replay.initial.yaw,
        v: replay.initial.v,
      },
      gates: prepareGates(replay.gates),
      laps: isInt(replay.laps) ? replay.laps : null,
    };
  }

  // 稀疏输入游标：未变化的 tick 沿用上一输入
  function createInputReader(inputs) {
    var idx = 0;
    var fallback = { throttle: 0, steer: 0, brake: false };
    var cur = inputs.length ? inputs[0] : fallback;
    return {
      at: function (tick) {
        while (idx + 1 < inputs.length && inputs[idx + 1].tick <= tick) {
          idx += 1;
          cur = inputs[idx];
        }
        return cur;
      },
      reset: function () {
        idx = 0;
        cur = inputs.length ? inputs[0] : fallback;
      },
      get index() {
        return idx;
      },
      get length() {
        return inputs.length;
      },
    };
  }

  function simulateReplay(replay, options) {
    options = options || {};
    var errs = validateReplay(replay);
    if (errs.length) return { ok: false, errors: errs };
    var track = prepareFromReplay(replay);
    var total = isInt(replay.ticks) ? replay.ticks : options.ticks != null ? options.ticks : MAX_TICKS;
    total = clamp(total, 0, MAX_TICKS);
    var race = createRace(track, {
      lapsToFinish: replay.laps != null ? replay.laps : options.lapsToFinish === undefined ? null : options.lapsToFinish,
      maxTicks: options.maxTicks != null ? options.maxTicks : MAX_TICKS,
    });
    var reader = createInputReader(replay.inputs);
    var trace = options.includeTrace ? [{ tick: 0, state: race.getState() }] : null;
    while (race.tick < total && !race.done) {
      race.step(reader.at(race.tick));
      if (trace) trace.push({ tick: race.tick, state: race.getState() });
    }
    var result = race.getResult();
    result.ok = true;
    result.errors = [];
    result.replayTicks = total;
    result.track = {
      name: track.name,
      params: track.params,
      initial: track.initial,
      gates: replay.gates.map(function (g) {
        return { a: copyVec(g.a), b: copyVec(g.b), normal: copyVec(g.normal) };
      }),
      laps: track.laps,
    };
    if (trace) result.trace = trace;
    return result;
  }

  function simulateTicks(track, inputAt, ticks, options) {
    options = options || {};
    var race = createRace(track, options);
    var total = clamp(ticks, 0, MAX_TICKS);
    var trace = options.includeTrace ? [{ tick: 0, state: race.getState() }] : null;
    while (race.tick < total && !race.done) {
      race.step(inputAt(race.tick));
      if (trace) trace.push({ tick: race.tick, state: race.getState() });
    }
    var res = race.getResult();
    res.ok = true;
    if (trace) res.trace = trace;
    return res;
  }

  // ---------------------------------------------------------------- 固定步长驱动

  // 以“已流逝的总秒数”为准推进固定 120Hz 逻辑步：
  //   target = floor(totalSeconds * 120 + 1e-6)
  // 这样无论渲染帧如何切分时间，同一时刻的 tick 数一致；
  // 1e-6 只吸收秒数累加的浮点误差（约 8 纳秒）。
  function createDriver(race, opts) {
    opts = opts || {};
    var total = 0;
    var maxChunk = opts.maxChunkSeconds != null ? opts.maxChunkSeconds : 0.5;
    var maxSteps = opts.maxStepsPerAdvance != null ? opts.maxStepsPerAdvance : 600;
    var driver = {
      race: race,
      advance: function (seconds) {
        if (!(seconds > 0)) return 0;
        if (seconds > maxChunk) seconds = maxChunk;
        if (race.done) return 0;
        total += seconds;
        var target = Math.floor(total * TICK_RATE + 1e-6);
        var n = 0;
        while (race.tick < target && n < maxSteps && !race.done) {
          race.step(opts.inputAt ? opts.inputAt(race.tick) : opts.input);
          n += 1;
        }
        return n;
      },
      reset: function () {
        total = 0;
      },
      get elapsed() {
        return total;
      },
      get alpha() {
        return clamp(total * TICK_RATE - race.tick, 0, 1);
      },
      targetTick: function () {
        return Math.floor(total * TICK_RATE + 1e-6);
      },
    };
    return driver;
  }

  // ---------------------------------------------------------------- 样例核对

  // segment-cases：只验证判门内核。
  // independentSegments=true（默认）时每个用例独立初始化期望门；
  // 为 false 时期望门在用例之间延续，像同一场比赛的连续位置段。
  function runSegmentCases(file) {
    var gateErrs = validateGates(file && file.gates);
    if (gateErrs.length) return { ok: false, errors: gateErrs, results: [] };
    var gates = prepareGates(file.gates);
    var cases = Array.isArray(file.cases) ? file.cases : [];
    var independent = !file || file.independentSegments !== false;
    var shared = createArbiter(gates.length);
    var results = [];
    var ok = true;
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var errs = [];
      if (!isObj(c) || !isVec2(c.p) || !isVec2(c.q)) {
        results.push({ index: i, ok: false, errors: ['用例缺少 p/q'] });
        ok = false;
        continue;
      }
      var crossings = gateCrossings({ x: c.p[0], y: c.p[1] }, { x: c.q[0], y: c.q[1] }, gates);
      var arb = independent ? createArbiter(gates.length) : shared;
      var order = [];
      var fractions = [];
      var reverse = [];
      for (var k = 0; k < crossings.length; k++) {
        var cr = crossings[k];
        var verdict = arbitrate(arb, cr.gate, cr.direction);
        if (verdict.outcome === 'reverse') reverse.push(cr.gate);
        else if (verdict.outcome !== 'outOfOrder') {
          order.push(cr.gate);
          fractions.push(cr.t);
        }
      }
      if (Array.isArray(c.expectedOrder)) {
        if (JSON.stringify(order) !== JSON.stringify(c.expectedOrder)) {
          errs.push('expectedOrder ' + JSON.stringify(c.expectedOrder) + ' ≠ ' + JSON.stringify(order));
        }
      }
      if (Array.isArray(c.expectedFractions)) {
        if (fractions.length !== c.expectedFractions.length) {
          errs.push('expectedFractions 数量不匹配');
        } else {
          for (var j = 0; j < fractions.length; j++) {
            if (Math.abs(fractions[j] - c.expectedFractions[j]) > 1e-9) {
              errs.push('fraction[' + j + '] ' + fractions[j] + ' ≠ ' + c.expectedFractions[j]);
            }
          }
        }
      }
      if (Array.isArray(c.expectedReverse)) {
        if (JSON.stringify(reverse) !== JSON.stringify(c.expectedReverse)) {
          errs.push('expectedReverse ' + JSON.stringify(c.expectedReverse) + ' ≠ ' + JSON.stringify(reverse));
        }
      }
      if (errs.length) ok = false;
      results.push({
        index: i,
        ok: errs.length === 0,
        order: order,
        fractions: fractions,
        reverse: reverse,
        errors: errs,
      });
    }
    return { ok: ok, errors: [], results: results };
  }

  // straight-reference：120 tick 直线，验证物理积分
  function runStraightReference(ref, tolerance) {
    tolerance = tolerance == null ? 1e-9 : tolerance;
    var errs = validateTrack(ref, { allowDefaults: false });
    errs = errs.concat(validateInputs(ref.inputs));
    if (!isInt(ref.ticks) || ref.ticks < 0 || ref.ticks > MAX_TICKS) errs.push('ticks: 非法');
    if (errs.length) return { ok: false, errors: errs };
    var track = normalizeTrack(ref).track;
    var res = simulateReplay(
      {
        initial: ref.initial,
        params: ref.params,
        gates: ref.gates,
        inputs: ref.inputs,
        ticks: ref.ticks,
      },
      { includeTrace: true }
    );
    if (!res.ok) return { ok: false, errors: res.errors };
    var exp = ref.expected;
    var got = res.final;
    var diffs = {};
    var ok = true;
    ['x', 'y', 'yaw', 'v'].forEach(function (k) {
      if (!isNum(exp[k])) {
        errs.push('expected.' + k + ': 缺失');
        ok = false;
        return;
      }
      diffs[k] = got[k] - exp[k];
      if (Math.abs(diffs[k]) > tolerance) ok = false;
    });
    return { ok: ok && errs.length === 0, errors: errs, final: got, expected: exp, diffs: diffs, result: res };
  }

  return {
    TICK_RATE: TICK_RATE,
    DT: DT,
    MAX_TICKS: MAX_TICKS,
    MIN_GATES: MIN_GATES,
    MAX_GATES: MAX_GATES,
    EPS: EPS,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    validateParams: validateParams,
    validateInitial: validateInitial,
    validateGates: validateGates,
    validateTrack: validateTrack,
    validateReplay: validateReplay,
    validateInputs: validateInputs,
    normalizeTrack: normalizeTrack,
    prepareGates: prepareGates,
    autoInitial: autoInitial,
    gateCrossings: gateCrossings,
    createArbiter: createArbiter,
    arbitrate: arbitrate,
    stepVehicle: stepVehicle,
    clampInput: clampInput,
    createRace: createRace,
    createInputReader: createInputReader,
    simulateReplay: simulateReplay,
    simulateTicks: simulateTicks,
    createDriver: createDriver,
    runSegmentCases: runSegmentCases,
    runStraightReference: runStraightReference,
    fnv1a: fnv1a,
    hex8: hex8,
    normAngle: normAngle,
    clamp: clamp,
    isNum: isNum,
    isInt: isInt,
  };
});
