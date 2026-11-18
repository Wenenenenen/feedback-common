/*
 * rblab-lab.js — 调试台编排层。
 * 负责：逐帧驱动两个回滚客户端、记录逐帧轨迹、检测两边校验和首处分歧、
 * 汇总事件生命周期、导出逐帧状态 JSON。所有数值仍走整数引擎，本身不做物理计算。
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? {
      util: require('./rblab-util.js'),
      engine: require('./rblab-engine.js'),
      net: require('./rblab-net.js')
    }
    : { util: root.RBLab.util, engine: root.RBLab.engine, net: root.RBLab.net };
  var mod = factory(deps.util, deps.engine, deps.net);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.RBLab = root.RBLab || {};
    root.RBLab.lab = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (util, engine, net) {
  'use strict';

  var clone = util.clone;

  /*
   * 一次完整实验。
   * opts: { log, net:{delayMs,jitterMs,lossPct,seed}, rollbackMax }
   */
  function Experiment(opts) {
    this.log = opts.log;
    this.rollbackMax = opts.rollbackMax | 0;
    this.link = new net.NetworkLink(opts.net);
    this.c1 = new net.RollbackClient(0, this.rollbackMax, this.link);
    this.c2 = new net.RollbackClient(1, this.rollbackMax, this.link);
    this.c1.setStart(this.log.start || null);
    this.c2.setStart(this.log.start || null);
    this.ref = engine.runLog(this.log); // 参考实现：权威逐帧结果
    this.tickCount = 0;
    this.trace = [];        // 每个驱动帧一条轨迹
    this.firstDivergence = null;
    this.finished = false;
  }

  /* 单个角色的可显示状态（纯数据，整数） */
  function fighterView(f) {
    return {
      x: f.x, hp: f.hp, act: f.act, move: f.move,
      actFrame: f.actFrame, stun: f.stun, connected: f.connected
    };
  }

  /* 推进一个驱动帧；返回本帧轨迹记录 */
  Experiment.prototype.step = function () {
    if (this.finished) {
      return null;
    }
    this.tickCount += 1;
    this.link.tick();

    var f1 = this.c1.frameCount;
    var f2 = this.c2.frameCount;
    var m1 = f1 < this.log.frames.length ? this.log.frames[f1][0] : 0;
    var m2 = f2 < this.log.frames.length ? this.log.frames[f2][1] : 0;
    var r1 = this.c1.tick(m1, f1 >= this.log.frames.length);
    var r2 = this.c2.tick(m2, f2 >= this.log.frames.length);

    var n = this.log.frames.length;
    var bothCaughtUp = this.c1.frameCount >= n && this.c2.frameCount >= n &&
      this.c1.confirmedFrame >= n - 1 && this.c2.confirmedFrame >= n - 1;

    // 两边都结算过的帧里，找第一处校验和分歧
    var divergence = this.detectDivergence();
    if (divergence && !this.firstDivergence) {
      this.firstDivergence = divergence;
    }

    var rec = {
      tick: this.tickCount,
      c1: this.snapshotClient(this.c1, r1),
      c2: this.snapshotClient(this.c2, r2),
      divergence: divergence,
      bothCaughtUp: bothCaughtUp
    };
    this.trace.push(rec);

    if (bothCaughtUp || this.tickCount >= n * 3 + 2000) {
      this.finished = true;
    }
    return rec;
  };

  Experiment.prototype.snapshotClient = function (c, result) {
    return {
      frameCount: c.frameCount,
      confirmedFrame: c.confirmedFrame,
      waiting: c.lastTickWaited,
      rolledBack: result.rolledBack,
      state: clone(c.state),
      checksum: c.frameCount > 0 ? c.checksums[c.frameCount - 1] : null,
      stats: c.stats()
    };
  };

  /* 比较两边共同已结算帧的校验和。
   * 真分歧的判据：两边都已确认该帧的远端输入（预测态已结算完），校验和却仍不同。
   * 只要还有任一边在预测，该帧的不一致都可能在输入到达后自愈，不算真分歧。 */
  Experiment.prototype.detectDivergence = function () {
    var common = Math.min(this.c1.frameCount, this.c2.frameCount);
    for (var f = 0; f < common; f++) {
      var a = this.c1.checksums[f];
      var b = this.c2.checksums[f];
      if (a === undefined || b === undefined || a === b) {
        continue;
      }
      var bothConfirmed = (this.c1.remoteKnown[f] === true) && (this.c2.remoteKnown[f] === true);
      if (!bothConfirmed) {
        continue; // 至少一边仍在预测，等其输入到达后再判定
      }
      return {
        frame: f,
        checksum1: a,
        checksum2: b,
        diff: this.stateDiffAt(f)
      };
    }
    return null;
  };

  /* 字段级对比两边在帧 f 结算后的角色状态 */
  Experiment.prototype.stateDiffAt = function (f) {
    var s1 = this.c1.states[f];
    var s2 = this.c2.states[f];
    var fields = ['x', 'hp', 'act', 'move', 'actFrame', 'stun', 'connected'];
    var diff = { frame: f, fighters: [] };
    if (!s1 || !s2) {
      diff.note = '该帧某一边缺少状态快照';
      return diff;
    }
    for (var p = 0; p < 2; p++) {
      var entry = { player: 'P' + (p + 1), fields: {} };
      var a = s1.fighters[p];
      var b = s2.fighters[p];
      fields.forEach(function (k) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          entry.fields[k] = { c1: a[k], c2: b[k] };
        }
      });
      diff.fighters.push(entry);
    }
    diff.context = {
      c1UsedRemote: this.c1.usedInputs[f],
      c2UsedRemote: this.c2.usedInputs[f],
      c1Predicted: this.c1.predictedFrames[f],
      c2Predicted: this.c2.predictedFrames[f],
      c1RemoteKnown: this.c1.remoteKnown[f] === true,
      c2RemoteKnown: this.c2.remoteKnown[f] === true
    };
    return diff;
  };

  Experiment.prototype.runToEnd = function () {
    while (!this.finished) {
      this.step();
    }
    return this;
  };

  /* 事件生命周期合并视图（两边各自的预测/确认/撤销事件） */
  Experiment.prototype.eventView = function () {
    return {
      c1: this.c1.eventList(),
      c2: this.c2.eventList()
    };
  };

  /* 导出逐帧状态 JSON（参考实现权威结果 + 两边客户端轨迹摘要） */
  Experiment.prototype.exportFramesJSON = function () {
    var self = this;
    return {
      meta: {
        net: this.link.config,
        rollbackMax: this.rollbackMax,
        totalFrames: this.log.frames.length,
        ticks: this.tickCount,
        firstDivergence: this.firstDivergence,
        channelStats: this.link.channelStats()
      },
      reference: this.ref.frames.map(function (rec) {
        return {
          frame: rec.frame,
          checksum: rec.checksum,
          state: rec.state,
          events: rec.events
        };
      }),
      clients: {
        c1: {
          checksums: self.c1.checksums,
          predicted: self.c1.predictedFrames,
          remoteKnown: self.c1.remoteKnown,
          stats: self.c1.stats(),
          events: self.c1.eventList()
        },
        c2: {
          checksums: self.c2.checksums,
          predicted: self.c2.predictedFrames,
          remoteKnown: self.c2.remoteKnown,
          stats: self.c2.stats(),
          events: self.c2.eventList()
        }
      }
    };
  };

  return {
    Experiment: Experiment,
    fighterView: fighterView
  };
});
