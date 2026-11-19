// 记录、回放与幽灵数据层。依赖 engine.js（RallyEngine）。
// - Recorder：逐步记录稠密输入，导出为“稀疏变化表”回放
// - Ghost：回放轨迹（逐 tick 位置），渲染时可插值，但绝不推进逻辑
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.RallyRecorder = factory(root.RallyEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  function inputsEqual(a, b) {
    return a.throttle === b.throttle && a.steer === b.steer && a.brake === b.brake;
  }

  // 新记录器。track 需为已准备赛道（engine.normalizeTrack 的产物）。
  function createRecorder(track) {
    var inputs = [];
    var last = { throttle: 0, steer: 0, brake: false };
    var rec = {
      track: track,
      inputs: inputs,
      // 每 tick 调用一次；只在输入变化时落一条，未变化沿用
      pushInput: function (tick, raw) {
        var input = E.clampInput(raw);
        if (inputs.length === 0 || !inputsEqual(input, last)) {
          inputs.push({ tick: tick, throttle: input.throttle, steer: input.steer, brake: input.brake });
        }
        last = { throttle: input.throttle, steer: input.steer, brake: input.brake };
        return input;
      },
      isEmpty: function () {
        return inputs.length === 0;
      },
      inputCount: function () {
        return inputs.length;
      },
      lastInput: function () {
        return { throttle: last.throttle, steer: last.steer, brake: last.brake };
      },
      reset: function () {
        inputs.length = 0;
        last = { throttle: 0, steer: 0, brake: false };
      },
      // 生成回放对象；ticks 为本次实际运行的逻辑步数。
      // 还没有任何输入时补一条 tick 0 的空输入，保证导出的回放永远合法（首项必须 tick 0）。
      toReplay: function (ticks, laps) {
        var source = inputs.length
          ? inputs
          : [{ tick: 0, throttle: 0, steer: 0, brake: false }];
        return {
          format: 'rally-gate-steward/replay-v1',
          initial: {
            x: track.initial.x,
            y: track.initial.y,
            yaw: track.initial.yaw,
            v: track.initial.v,
          },
          params: {
            wheelbase: track.params.wheelbase,
            maxSteer: track.params.maxSteer,
            accel: track.params.accel,
            drag: track.params.drag,
            maxSpeed: track.params.maxSpeed,
            brakeAccel: track.params.brakeAccel,
          },
          gates: track.gates.map(function (g) {
            return { a: [g.a[0], g.a[1]], b: [g.b[0], g.b[1]], normal: [g.normal[0], g.normal[1]] };
          }),
          inputs: source.map(function (e) {
            return { tick: e.tick, throttle: e.throttle, steer: e.steer, brake: e.brake };
          }),
          ticks: ticks,
          laps: laps != null ? laps : track.laps != null ? track.laps : null,
          // 显示/驾驶辅助，判定不使用；带上它回放时路面视图保持一致
          waypoints: track.waypoints
            ? track.waypoints.map(function (p) {
                return [p[0], p[1]];
              })
            : undefined,
          roadHalfWidth: track.roadHalfWidth,
        };
      },
    };
    return rec;
  }

  // 从回放构造幽灵：完整预演，只取每 tick 的状态。
  function buildGhost(replay, meta) {
    var res = E.simulateReplay(replay, { includeTrace: true });
    if (!res.ok) return { ok: false, errors: res.errors };
    var trace = res.trace;
    var firstLap = res.laps && res.laps.length ? res.laps[0] : null;
    return {
      ok: true,
      replay: replay,
      trace: trace,
      ticks: res.ticks,
      result: res,
      meta: meta || {},
      fromTick: 0,
      toTick: res.ticks,
      lapTime: firstLap ? firstLap.time : null,
      bestLapTime: res.laps && res.laps.length
        ? res.laps.reduce(function (m, l) { return m == null || l.time < m ? l.time : m; }, null)
        : null,
      started: res.started,
      finished: res.finished,
      startTick: res.start ? res.start.tick : null,
    };
  }

  // 从一段 run 的 trace 中截取某一圈作为幽灵（按 tick 区间）
  function extractLapGhost(ghost, lap) {
    if (!ghost || !ghost.trace || !lap) return null;
    var from = lap.startTick;
    var to = lap.endTick + 1;
    var slice = ghost.trace.slice(from, Math.min(to, ghost.trace.length));
    return {
      trace: slice,
      fromTick: from,
      toTick: to,
      lapTime: lap.time,
      ticks: to - from,
    };
  }

  // 在 tick 处取样（t ∈ [traceStartTick, ...]），alpha 用于渲染插值
  function sampleTrace(trace, tick, alpha) {
    if (!trace || trace.length === 0) return null;
    if (tick < 0) tick = 0;
    if (tick >= trace.length) {
      var last = trace[trace.length - 1];
      return { x: last.state.x, y: last.state.y, yaw: last.state.yaw, v: last.state.v };
    }
    var a = trace[tick];
    var b = trace[Math.min(tick + 1, trace.length - 1)];
    if (!(alpha > 0) || a === b) {
      return { x: a.state.x, y: a.state.y, yaw: a.state.yaw, v: a.state.v };
    }
    var dyaw = E.normAngle(b.state.yaw - a.state.yaw);
    return {
      x: a.state.x + (b.state.x - a.state.x) * alpha,
      y: a.state.y + (b.state.y - a.state.y) * alpha,
      yaw: E.normAngle(a.state.yaw + dyaw * alpha),
      v: a.state.v + (b.state.v - a.state.v) * alpha,
    };
  }

  return {
    createRecorder: createRecorder,
    buildGhost: buildGhost,
    extractLapGhost: extractLapGhost,
    sampleTrace: sampleTrace,
  };
});
