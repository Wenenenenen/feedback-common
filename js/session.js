// 比赛会话：把引擎、键盘输入、固定步长驱动、记录器和幽灵粘在一起。
// 不含任何 DOM 代码；页面与自动化测试共用。
//
// 时间模型（这是“不同渲染帧率结果一致”的关键）：
//  - 逻辑永远以 120Hz 固定步推进；
//  - 真实时间用【整数微秒】累计，目标 tick = floor(累计微秒 * 120 / 1e6)；
//  - 渲染帧只决定“这一帧补几步”，帧率与切分方式不影响任何一次 tick 的状态；
//  - 暂停只是把时间基准前移，暂停时长不进入逻辑；
//  - 从头重放直接按 tick 读取稀疏输入，轨迹只由输入与参数决定。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./recorder.js'));
  } else {
    root.RallySession = factory(root.RallyEngine, root.RallyRecorder);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, R) {
  'use strict';

  var TICK_RATE = E.TICK_RATE;
  var MICROS_PER_SEC = 1000000;

  function toMicros(ms) {
    return Math.round(ms * 1000);
  }
  function copyInput(i) {
    return { throttle: i.throttle, steer: i.steer, brake: !!i.brake };
  }

  // 键盘输入：每个逻辑 tick 恰好采样一次；方向盘与油门按 tick 速率渐进，
  // 不依赖渲染帧率（渲染帧多快都不会多转一点）。
  function createKeyboardInput(hold, opts) {
    opts = opts || {};
    var steerRate = opts.steerRate != null ? opts.steerRate : 6.0; // 每秒满舵比例
    var throttleRate = opts.throttleRate != null ? opts.throttleRate : 5.0;
    var cur = { throttle: 0, steer: 0, brake: false };
    function approach(v, target, step) {
      if (v < target) return Math.min(target, v + step);
      if (v > target) return Math.max(target, v - step);
      return target;
    }
    return {
      sample: function () {
        var h = hold() || {};
        cur.throttle = approach(cur.throttle, h.throttle || 0, throttleRate * E.DT);
        cur.steer = approach(cur.steer, h.steer || 0, steerRate * E.DT);
        cur.brake = !!h.brake;
        return copyInput(cur);
      },
      reset: function () {
        cur = { throttle: 0, steer: 0, brake: false };
      },
      peek: function () {
        return copyInput(cur);
      },
    };
  }

  function createScriptInput(fn, opts) {
    opts = opts || {};
    return {
      sample: function (tick) {
        return E.clampInput(fn(tick));
      },
      reset: function () {
        if (opts.reset) opts.reset();
      },
    };
  }

  // opts:
  //   track          已准备赛道（engine.normalizeTrack().track）
  //   inputSource    {sample(tick), reset()}
  //   replay         回放对象（给定则进入回放模式，忽略 inputSource）
  //   ghost          幽灵（RallyRecorder.buildGhost 的结果）
  //   lapsToFinish   覆盖赛道 laps
  //   maxTicks       覆盖 10000
  //   clock          返回当前毫秒数（默认 performance.now / Date.now）
  function createSession(opts) {
    opts = opts || {};
    var mode = opts.replay ? 'replay' : 'drive';
    var track = null;
    var race = null;
    var reader = null;
    var recorder = null;
    var ghost = opts.ghost || null;
    var state = 'ready'; // ready | running | paused | finished
    var accMicros = 0; // 已完成的运行片段
    var anchorMicros = null; // 当前运行片段的起点
    var lapsToFinish = opts.lapsToFinish != null ? opts.lapsToFinish : null;
    var maxTicks = opts.maxTicks != null ? opts.maxTicks : null;
    var clock = opts.clock || function () {
      return typeof performance !== 'undefined' ? performance.now() : Date.now();
    };
    var inputSource =
      opts.inputSource ||
      createScriptInput(function () {
        return { throttle: 0, steer: 0, brake: false };
      });
    var listeners = {};
    var lastCrossTick = -1;
    var crossEvents = [];

    function emit(name, payload) {
      var arr = listeners[name];
      if (!arr) return;
      for (var i = 0; i < arr.length; i++) arr[i](payload);
    }

    function buildRace() {
      var raceOpts = {};
      if (lapsToFinish != null) raceOpts.lapsToFinish = lapsToFinish;
      else if (track.laps != null) raceOpts.lapsToFinish = track.laps;
      if (maxTicks != null) raceOpts.maxTicks = maxTicks;
      race = E.createRace(track, raceOpts);
    }

    function init() {
      if (mode === 'replay') {
        var prepared = E.normalizeTrack({
          name: opts.replay.name,
          params: opts.replay.params,
          initial: opts.replay.initial,
          gates: opts.replay.gates,
          laps: opts.replay.laps,
          waypoints: opts.replay.waypoints,
          roadHalfWidth: opts.replay.roadHalfWidth,
        });
        if (!prepared.ok) throw new Error('回放无法载入: ' + prepared.errors.join('; '));
        track = prepared.track;
        reader = E.createInputReader(opts.replay.inputs);
        buildRace();
      } else {
        track = opts.track;
        recorder = R.createRecorder(track);
        buildRace();
      }
    }
    init();

    function sampleInput() {
      if (mode === 'replay') return E.clampInput(reader.at(race.tick));
      return E.clampInput(inputSource.sample(race.tick));
    }

    function afterStep(out) {
      if (out.events && out.events.length) {
        lastCrossTick = out.tick;
        crossEvents = out.events;
        emit('cross', out.events);
      }
      if (race.finished && state !== 'finished') {
        state = 'finished';
        anchorMicros = null;
        emit('finish', race.getResult());
      } else if (race.done && state !== 'finished') {
        state = 'finished';
        anchorMicros = null;
        emit('timeout', race.getResult());
      }
    }

    function stepOnce() {
      if (race.done) return false;
      var input = sampleInput();
      if (mode === 'drive' && recorder) recorder.pushInput(race.tick, input);
      var out = race.step(input);
      afterStep(out);
      if (listeners.step && out.applied) {
        emit('step', { tick: race.tick, checksum: race.checksum, time: out.tick / TICK_RATE });
      }
      return true;
    }

    function elapsedMicros(nowMs) {
      var running = state === 'running' && anchorMicros != null;
      if (!running) return accMicros;
      return accMicros + (toMicros(nowMs) - anchorMicros);
    }

    var session = {
      get mode() {
        return mode;
      },
      get state() {
        return state;
      },
      get track() {
        return track;
      },
      get race() {
        return race;
      },
      get ghost() {
        return ghost;
      },
      get tick() {
        return race.tick;
      },
      get elapsedSeconds() {
        return elapsedMicros(clock()) / MICROS_PER_SEC;
      },
      get crossEvents() {
        return crossEvents;
      },
      get lastCrossTick() {
        return lastCrossTick;
      },

      on: function (name, fn) {
        (listeners[name] || (listeners[name] = [])).push(fn);
        return function () {
          var arr = listeners[name];
          var i = arr ? arr.indexOf(fn) : -1;
          if (i >= 0) arr.splice(i, 1);
        };
      },

      start: function (nowMs) {
        if (state === 'finished' || race.done) return;
        if (state === 'ready' || state === 'paused') {
          state = 'running';
          anchorMicros = toMicros(nowMs != null ? nowMs : clock());
        }
      },

      pause: function (nowMs) {
        if (state !== 'running') return;
        var now = toMicros(nowMs != null ? nowMs : clock());
        accMicros += now - anchorMicros;
        anchorMicros = null;
        state = 'paused';
      },

      resume: function (nowMs) {
        if (state !== 'paused') return;
        anchorMicros = toMicros(nowMs != null ? nowMs : clock());
        state = 'running';
      },

      togglePause: function (nowMs) {
        if (state === 'running') session.pause(nowMs);
        else if (state === 'paused') session.resume(nowMs);
        else if (state === 'ready') session.start(nowMs);
      },

      // 重新开始：清空比赛与记录，幽灵保留并从 tick 0 重放。
      restart: function (options) {
        options = options || {};
        var captured = null;
        // 只有真正起跑过（穿过 0 号门）才封存幽灵：原地不动的一段没有参考价值
        if (
          options.capture !== false &&
          mode === 'drive' &&
          recorder &&
          recorder.inputCount() > 0 &&
          race.tick > 0 &&
          race.started
        ) {
          captured = session.captureGhost();
        }
        if (mode === 'replay') reader.reset();
        else recorder.reset();
        if (inputSource.reset) inputSource.reset();
        buildRace();
        accMicros = 0;
        anchorMicros = null;
        lastCrossTick = -1;
        crossEvents = [];
        state = options.autoStart === false ? 'ready' : 'running';
        if (state === 'running') anchorMicros = toMicros(options.nowMs != null ? options.nowMs : clock());
        emit('restart', { ghost: ghost, captured: captured });
        return captured;
      },

      // 实时推进：nowMs 为绝对单调时钟毫秒。返回推进的逻辑步数。
      // 单帧最多补 maxStepsPerFrame 步（默认 240 = 2 秒逻辑），
      // 长时间卡顿/后台切回时逐帧追上，避免一次补上万步造成冻结。
      frame: function (nowMs) {
        if (state !== 'running' || race.done) return 0;
        var now = nowMs != null ? nowMs : clock();
        if (anchorMicros == null) anchorMicros = toMicros(now);
        var target = Math.floor((elapsedMicros(now) * TICK_RATE) / MICROS_PER_SEC);
        var steps = 0;
        var cap = opts.maxStepsPerFrame != null ? opts.maxStepsPerFrame : 240;
        while (race.tick < target && !race.done && steps < cap) {
          if (!stepOnce()) break;
          steps += 1;
        }
        return steps;
      },

      // 精确推进 n 个逻辑步（回放步进与测试用）
      stepTicks: function (n) {
        var steps = 0;
        for (var i = 0; i < n; i++) {
          if (!stepOnce()) break;
          steps += 1;
        }
        if (state === 'running' && anchorMicros != null) {
          // 手动步进时把时间基准对齐到已推进的 tick，避免下一步重复
          accMicros = Math.floor((race.tick * MICROS_PER_SEC) / TICK_RATE);
          anchorMicros = toMicros(clock());
        }
        return steps;
      },

      // 0..1 的渲染插值系数：当前 tick 与下一个 tick 之间的进度
      get alpha() {
        if (state !== 'running' || anchorMicros == null) return 0;
        var e = elapsedMicros(clock());
        var frac = (e * TICK_RATE) / MICROS_PER_SEC - race.tick;
        return E.clamp(frac, 0, 0.999999);
      },

      targetTick: function (nowMs) {
        if (state !== 'running') return race.tick;
        return Math.floor((elapsedMicros(nowMs != null ? nowMs : clock()) * TICK_RATE) / MICROS_PER_SEC);
      },

      // 把本次已跑部分封存为幽灵（稀疏输入 + 引擎重算轨迹）
      captureGhost: function (meta) {
        if (mode !== 'drive' || !recorder || recorder.inputCount() === 0) return null;
        var replay = recorder.toReplay(race.tick, track.laps);
        var built = R.buildGhost(replay, meta);
        if (!built.ok) return null;
        ghost = built;
        emit('ghost', ghost);
        return ghost;
      },

      setGhost: function (g) {
        ghost = g;
        emit('ghost', ghost);
      },

      clearGhost: function () {
        ghost = null;
        emit('ghost', null);
      },

      exportReplay: function () {
        if (mode === 'replay') return JSON.parse(JSON.stringify(opts.replay));
        return recorder.toReplay(race.tick, track.laps);
      },

      exportResult: function () {
        var result = race.getResult();
        return {
          format: 'rally-gate-steward/result-v1',
          exportedAt: new Date().toISOString(),
          track: {
            name: track.name,
            params: track.params,
            initial: track.initial,
            gates: track.gates.map(function (g) {
              return { a: [g.a[0], g.a[1]], b: [g.b[0], g.b[1]], normal: [g.normal[0], g.normal[1]] };
            }),
            laps: track.laps,
          },
          result: result,
          replay: session.exportReplay(),
        };
      },

      // 用当前回放从头重算，并与在线会话逐项对比
      verify: function (extraTicks) {
        var replay = session.exportReplay();
        var ticks = extraTicks != null ? extraTicks : race.tick;
        var sim = E.simulateReplay(replay, { ticks: ticks });
        if (!sim.ok) return { ok: false, errors: sim.errors };
        var expected = race.getResult();
        var sameTicks = sim.ticks === expected.ticks;
        var sameChecksum = sim.checksum === expected.checksum;
        var sameFinal =
          sim.final.x === expected.final.x &&
          sim.final.y === expected.final.y &&
          sim.final.yaw === expected.final.yaw &&
          sim.final.v === expected.final.v;
        var sameLaps = JSON.stringify(sim.laps) === JSON.stringify(expected.laps);
        var sameAccepted = JSON.stringify(sim.accepted) === JSON.stringify(expected.accepted);
        var sameViolations = JSON.stringify(sim.violations) === JSON.stringify(expected.violations);
        return {
          ok: sameTicks && sameChecksum && sameFinal && sameLaps && sameAccepted && sameViolations,
          sameTicks: sameTicks,
          sameChecksum: sameChecksum,
          sameFinal: sameFinal,
          sameLaps: sameLaps,
          sameAccepted: sameAccepted,
          sameViolations: sameViolations,
          expected: {
            ticks: expected.ticks,
            checksum: expected.checksum,
            laps: expected.laps.length,
            accepted: expected.accepted.length,
            violations: expected.violations.length,
          },
          recomputed: {
            ticks: sim.ticks,
            checksum: sim.checksum,
            laps: sim.laps.length,
            accepted: sim.accepted.length,
            violations: sim.violations.length,
          },
        };
      },

      // 渲染快照：只读，不改变逻辑
      getView: function (nowMs) {
        var now = nowMs != null ? nowMs : clock();
        var st = race.getState();
        var progress = race.progress();
        var ghostPos = null;
        if (ghost && ghost.trace && ghost.trace.length) {
          if (race.tick < ghost.ticks) {
            ghostPos = R.sampleTrace(ghost.trace, race.tick, state === 'running' ? session.alpha : 0);
          } else {
            var last = ghost.trace[ghost.trace.length - 1];
            ghostPos = { x: last.state.x, y: last.state.y, yaw: last.state.yaw, v: last.state.v };
          }
        }
        return {
          mode: mode,
          state: state,
          tick: race.tick,
          time: race.currentTime(),
          car: st,
          progress: progress,
          lapTime: race.currentLapTime(),
          splits: race.currentSplits.slice(),
          laps: race.laps.slice(),
          violations: race.violations.slice(),
          violationCounts: race.violationCounts,
          targetGate: progress.started ? progress.expectedGate : 0,
          lastEvents: crossEvents,
          lastCrossTick: lastCrossTick,
          ghost: ghost
            ? {
                pos: ghostPos,
                ticks: ghost.ticks,
                lapTime: ghost.lapTime,
                bestLapTime: ghost.bestLapTime,
                visible: true,
              }
            : null,
          alpha: state === 'running' ? session.alpha : 0,
          checksum: E.hex8(race.checksum),
        };
      },

      getResult: function () {
        return race.getResult();
      },
    };

    if (opts.autoStart) {
      state = 'running';
      anchorMicros = toMicros(opts.nowMs != null ? opts.nowMs : clock());
    }
    return session;
  }

  return {
    createSession: createSession,
    createKeyboardInput: createKeyboardInput,
    createScriptInput: createScriptInput,
    toMicros: toMicros,
  };
});
