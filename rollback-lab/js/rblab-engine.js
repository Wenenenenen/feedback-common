/*
 * rblab-engine.js — 确定性双人格斗逻辑引擎。
 * 规则全部来自 samples 内《格式说明.md》：整数状态、固定 60fps、三段式帧结算、
 * FNV-1a 32 位逐帧校验和。不使用浮点、随机数或任何非确定 API。
 */
(function (root, factory) {
  var mod = factory(
    (typeof module === 'object' && module.exports) ? require('./rblab-util.js')
      : root.RBLab.util
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.RBLab = root.RBLab || {};
    root.RBLab.engine = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var clampInt = util.clampInt;
  var abs = util.abs;

  /* 场地与角色常量（均为整数；坐标单位 1/100 像素） */
  var ARENA_MIN = 0;
  var ARENA_MAX = 60000;
  var WALK_SPEED = 300;
  var MAX_HP = 1000;
  var DEFAULT_P1_X = 20000;
  var DEFAULT_P2_X = 40000;

  /* 输入位掩码 */
  var IN_LEFT = 1;
  var IN_RIGHT = 2;
  var IN_A = 4;
  var IN_B = 8;

  /* 招式帧数据（moves.json，原样固化以保证确定性） */
  var MOVES = {
    A: { startup: 4, active: 3, recovery: 8, damage: 50, hitstun: 12, blockstun: 8, reach: 9000 },
    B: { startup: 10, active: 4, recovery: 18, damage: 120, hitstun: 20, blockstun: 14, reach: 12000 }
  };

  function makeFighter(x) {
    return {
      x: x | 0,
      hp: MAX_HP,
      act: 'idle',
      move: null,
      actFrame: 0,
      stun: 0,
      connected: false
    };
  }

  function initialState(start) {
    var p1x = (start && Number.isInteger(start.p1x)) ? start.p1x : DEFAULT_P1_X;
    var p2x = (start && Number.isInteger(start.p2x)) ? start.p2x : DEFAULT_P2_X;
    return {
      frame: -1,     // 当前帧号，帧号从 0 开始；-1 表示尚未结算任何帧
      over: false,
      fighters: [makeFighter(p1x), makeFighter(p2x)]
    };
  }

  /* 朝向：按帧开始位置，x 小的朝右（facing=+1）；相等时 P1 朝右、P2 朝左 */
  function facingsAtFrameStart(f1, f2) {
    if (f1.x < f2.x) {
      return [1, -1];
    }
    if (f1.x > f2.x) {
      return [-1, 1];
    }
    return [1, -1];
  }

  /*
   * 第 1 段：单人推进。基于帧开始状态，输入为本帧掩码。
   * 硬直减到 0 / 招式打完都在“本帧按 idle 继续处理”。
   */
  function advanceFighter(f, input) {
    if (f.act === 'hitstun' || f.act === 'blockstun') {
      f.stun -= 1;
      if (f.stun <= 0) {
        f.stun = 0;
        f.act = 'idle';
      } else {
        return; // 硬直中本帧不再处理
      }
    }

    if (f.act === 'attack') {
      f.actFrame += 1;
      var total = MOVES[f.move].startup + MOVES[f.move].active + MOVES[f.move].recovery;
      if (f.actFrame > total) {
        f.act = 'idle';
        f.move = null;
        f.actFrame = 0;
      } else {
        return; // 出招中本帧不再处理
      }
    }

    // 此处 f.act 必为 idle 或 walk
    if (input & IN_A) {
      f.act = 'attack';
      f.move = 'A';
      f.actFrame = 1;
      f.connected = false;
      return;
    }
    if (input & IN_B) {
      f.act = 'attack';
      f.move = 'B';
      f.actFrame = 1;
      f.connected = false;
      return;
    }

    var dir = 0;
    var left = (input & IN_LEFT) !== 0;
    var right = (input & IN_RIGHT) !== 0;
    if (left && !right) {
      dir = -1;
    } else if (right && !left) {
      dir = 1;
    } // 同时按左右（或都不按）视为没有方向

    if (dir !== 0) {
      f.x = clampInt(f.x + dir * WALK_SPEED, ARENA_MIN, ARENA_MAX);
      f.act = 'walk';
    } else {
      f.act = 'idle';
    }
  }

  /* 攻击方当前是否处于有效帧 */
  function isActive(f) {
    if (f.act !== 'attack' || f.connected) {
      return false;
    }
    var m = MOVES[f.move];
    return f.actFrame >= m.startup + 1 && f.actFrame <= m.startup + m.active;
  }

  /*
   * 第 2 段：命中结算，两人同时判定、同时生效。
   * 朝向与“帧开始是否 idle/walk”都取自帧开始快照。
   * 返回本帧产生的事件（hit / block），事件键为 帧号+攻击方标识。
   */
  function resolveHits(state, inputs, startSnap, facings) {
    var events = [];
    var f = state.fighters;
    var decisions = [];

    for (var attacker = 0; attacker < 2; attacker++) {
      var defender = attacker ^ 1;
      var atk = f[attacker];
      var def = f[defender];
      if (!isActive(atk)) {
        continue;
      }
      if (abs(atk.x - def.x) > MOVES[atk.move].reach) {
        continue;
      }

      var startDef = startSnap[defender];
      var holdingBack = (inputs[defender] & (facings[defender] === 1 ? IN_LEFT : IN_RIGHT)) !== 0;
      var blocks = (startDef.act === 'idle' || startDef.act === 'walk') && holdingBack;
      decisions.push({ attacker: attacker, defender: defender, blocks: blocks, move: atk.move });
    }

    for (var i = 0; i < decisions.length; i++) {
      var d = decisions[i];
      var a = f[d.attacker];
      var v = f[d.defender];
      var mv = MOVES[d.move];
      a.connected = true; // 无论命中还是格挡，本招都已结算，不再触发第二次

      if (d.blocks) {
        v.act = 'blockstun';
        v.stun = mv.blockstun;
        // 与“被打断”一致：格挡也清掉本帧可能刚起手的招，保持状态不变量
        v.move = null;
        v.actFrame = 0;
        events.push({
          key: state.frame + ':' + d.attacker,
          frame: state.frame,
          attacker: d.attacker,
          defender: d.defender,
          move: d.move,
          kind: 'block',
          damage: 0
        });
      } else {
        v.hp = clampInt(v.hp - mv.damage, 0, MAX_HP);
        v.act = 'hitstun';
        v.stun = mv.hitstun;
        v.move = null;
        v.actFrame = 0;
        events.push({
          key: state.frame + ':' + d.attacker,
          frame: state.frame,
          attacker: d.attacker,
          defender: d.defender,
          move: d.move,
          kind: 'hit',
          damage: mv.damage
        });
      }
    }
    return events;
  }

  /*
   * 推进一帧。state 原地修改，返回本帧事件数组（KO 后为空数组）。
   * inputs: [p1Mask, p2Mask]，取值 0..15 整数。
   * 帧号从 0 开始：进入函数时先把 frame 推到当前帧号。
   */
  function stepFrame(state, inputs) {
    state.frame += 1;
    if (state.over) {
      return []; // KO 后状态冻结，帧号照常增加
    }

    var f = state.fighters;
    // 帧开始快照：朝向、格挡资格、回滚对账都依赖它
    var startSnap = [util.clone(f[0]), util.clone(f[1])];
    var facings = facingsAtFrameStart(startSnap[0], startSnap[1]);

    // 第 1 段：两人各自推进（基于帧开始状态，互不影响）
    advanceFighter(f[0], inputs[0]);
    advanceFighter(f[1], inputs[1]);

    // 第 2 段：命中结算（同时）
    var events = resolveHits(state, inputs, startSnap, facings);

    // 第 3 段：KO 判定，之后冻结
    if (f[0].hp === 0 || f[1].hp === 0) {
      state.over = true;
    }

    return events;
  }

  /* 校验和输入串：f|x1|hp1|act1|actFrame1|stun1|x2|hp2|act2|actFrame2|stun2 */
  function checksumString(state) {
    var f = state.fighters;
    return [
      state.frame,
      f[0].x, f[0].hp, f[0].act, f[0].actFrame, f[0].stun,
      f[1].x, f[1].hp, f[1].act, f[1].actFrame, f[1].stun
    ].join('|');
  }

  function frameChecksum(state) {
    return util.checksum(checksumString(state));
  }

  /* 从头到尾跑一份日志，返回逐帧记录（供参考实现与导出使用） */
  function runLog(log) {
    var validation = validateLog(log);
    if (!validation.ok) {
      throw new Error('非法输入日志: ' + validation.errors.join('; '));
    }
    var state = initialState(log.start || null);
    var frames = [];
    for (var i = 0; i < log.frames.length; i++) {
      var events = stepFrame(state, log.frames[i]);
      frames.push({
        frame: state.frame,
        state: util.clone(state),
        checksum: frameChecksum(state),
        events: events
      });
    }
    return { state: state, frames: frames };
  }

  /* 日志合法性校验（invalid.json 应被拒绝） */
  function validateLog(log) {
    var errors = [];
    if (!log || typeof log !== 'object' || Array.isArray(log)) {
      return { ok: false, errors: ['根节点必须是对象'] };
    }
    if (!Array.isArray(log.frames)) {
      errors.push('frames 必须是数组');
      return { ok: false, errors: errors };
    }
    if (log.start !== undefined && log.start !== null) {
      if (typeof log.start !== 'object' || Array.isArray(log.start)) {
        errors.push('start 必须是对象');
      } else {
        ['p1x', 'p2x'].forEach(function (k) {
          if (log.start[k] !== undefined) {
            if (!Number.isInteger(log.start[k]) || log.start[k] < ARENA_MIN || log.start[k] > ARENA_MAX) {
              errors.push('start.' + k + ' 必须是 ' + ARENA_MIN + '..' + ARENA_MAX + ' 的整数');
            }
          }
        });
      }
    }
    log.frames.forEach(function (pair, i) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        errors.push('第 ' + i + ' 帧必须是长度 2 的数组');
        return;
      }
      pair.forEach(function (v, p) {
        if (!Number.isInteger(v) || v < 0 || v > 15) {
          errors.push('第 ' + i + ' 帧 P' + (p + 1) + ' 输入必须是 0..15 的整数，实际为 ' + JSON.stringify(v));
        }
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    ARENA_MIN: ARENA_MIN,
    ARENA_MAX: ARENA_MAX,
    WALK_SPEED: WALK_SPEED,
    MAX_HP: MAX_HP,
    MOVES: MOVES,
    IN_LEFT: IN_LEFT,
    IN_RIGHT: IN_RIGHT,
    IN_A: IN_A,
    IN_B: IN_B,
    makeFighter: makeFighter,
    initialState: initialState,
    facingsAtFrameStart: facingsAtFrameStart,
    advanceFighter: advanceFighter,
    isActive: isActive,
    stepFrame: stepFrame,
    checksumString: checksumString,
    frameChecksum: frameChecksum,
    runLog: runLog,
    validateLog: validateLog
  };
});
