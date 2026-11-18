/*
 * rblab-net.js — 确定性网络模拟器 + 回滚联机客户端。
 *
 * 网络：每个传输方向一条独立通道，延迟/抖动/丢包全部用整数帧表达，
 *   随机源是 rblab-util 的确定性 LCG（同种子逐位复现，绝不用 Math.random）。
 *   每个数据包携带发送方全部已确认输入（冗余重发），丢包只丢副本，
 *   后续包仍会把同一输入送达——输入不会永久丢失。
 *
 * 客户端：本地输入立即生效；远端输入未到时沿用最近一次已确认输入预测；
 *   收到与预测不一致的远端输入时，从该帧载入快照回滚重算；
 *   本地帧领先最早未确认帧达到 rollbackMax 时暂停等待。
 *   命中事件按“帧号+攻击方”建键，重算后对账：保留/确认/撤销，不重复触发。
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? { util: require('./rblab-util.js'), engine: require('./rblab-engine.js') }
    : { util: root.RBLab.util, engine: root.RBLab.engine };
  var mod = factory(deps.util, deps.engine);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.RBLab = root.RBLab || {};
    root.RBLab.net = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (util, engine) {
  'use strict';

  var clone = util.clone;

  /*
   * 单向网络通道。
   * config: { delayMs:整数毫秒, jitterMs:整数毫秒, lossPct:0..100 整数, seed:整数 }
   */
  function Network(config) {
    this.baseFrames = util.msToFrames(config.delayMs | 0);
    this.jitterFrames = util.msToFrames(config.jitterMs | 0);
    this.lossPct = config.lossPct | 0;
    this.seed = config.seed | 0;
    this.fullReset(this.seed);
  }

  /* 用初始种子完整重置，保证每次跑同一份配置逐位复现 */
  Network.prototype.fullReset = function (seed) {
    if (seed !== undefined) {
      this.seed = seed | 0;
    }
    this.rng = new util.Rng(this.seed);
    this.queue = [];
    this.tickIndex = 0;
    this.sent = 0;
    this.dropped = 0;
    this.delivered = 0;
  };

  /* 发送一个数据包；丢包判定与抖动各消耗一次确定性随机数。
   * arriveAt = 当前帧号 + 延迟帧数：当前帧发送的包，最早在 delay 帧后的那一帧可被取走。 */
  Network.prototype.send = function (payload) {
    this.sent += 1;
    var jitter = this.jitterFrames > 0 ? this.rng.nextInt(0, this.jitterFrames) : 0;
    var lost = this.rng.chance(this.lossPct);
    if (lost) {
      this.dropped += 1;
      return;
    }
    this.queue.push({ arriveAt: this.tickIndex + this.baseFrames + jitter, payload: clone(payload) });
  };

  /* 每个逻辑帧调用一次：进入下一帧（帧号 +1），到达判定交给 drain */
  Network.prototype.tick = function () {
    this.tickIndex += 1;
  };

  Network.prototype.stats = function () {
    return {
      sent: this.sent,
      dropped: this.dropped,
      delivered: this.delivered,
      inFlight: this.queue.length,
      dropRate: this.sent === 0 ? 0 : ((this.dropped * 100) / this.sent) | 0
    };
  };

  /*
   * 一条双向链路：内部两条独立单向通道，各自独立计时、独立随机源。
   * Lab 每个逻辑帧对整条链路 tick 一次，保证两个方向都只推进一帧，
   * 不会因为两个客户端各自调用而让同一通道的帧号被加两次。
   */
  function NetworkLink(config) {
    this.config = {
      delayMs: config.delayMs | 0,
      jitterMs: config.jitterMs | 0,
      lossPct: config.lossPct | 0,
      seed: config.seed | 0
    };
    // a->b 用 seed；b->a 用派生种子，两方向随机序列不同但都可复现
    this.chAB = new Network({
      delayMs: this.config.delayMs, jitterMs: this.config.jitterMs,
      lossPct: this.config.lossPct, seed: this.config.seed
    });
    this.chBA = new Network({
      delayMs: this.config.delayMs, jitterMs: this.config.jitterMs,
      lossPct: this.config.lossPct, seed: (this.config.seed ^ 0x5BD1E9) | 0
    });
  }

  /* sender=0 表示 P1->P2，sender=1 表示 P2->P1 */
  NetworkLink.prototype.send = function (sender, payload) {
    (sender === 0 ? this.chAB : this.chBA).send(payload);
  };

  /* 整条链路推进一个逻辑帧（两个方向各推进一次） */
  NetworkLink.prototype.tick = function () {
    this.chAB.tick();
    this.chBA.tick();
  };

  /* receiver=0 取发给 P1 的包（P2->P1 通道），receiver=1 反之 */
  NetworkLink.prototype.drain = function (receiver) {
    var ch = receiver === 0 ? this.chBA : this.chAB;
    var arrived = [];
    var remaining = [];
    for (var i = 0; i < ch.queue.length; i++) {
      if (ch.queue[i].arriveAt <= ch.tickIndex) {
        arrived.push(ch.queue[i].payload);
      } else {
        remaining.push(ch.queue[i]);
      }
    }
    ch.queue = remaining;
    ch.delivered += arrived.length;
    return arrived;
  };

  NetworkLink.prototype.fullReset = function () {
    this.chAB.fullReset(this.config.seed);
    this.chBA.fullReset((this.config.seed ^ 0x5BD1E9) | 0);
  };

  NetworkLink.prototype.channelStats = function () {
    return { p1ToP2: this.chAB.stats(), p2ToP1: this.chBA.stats() };
  };

  /*
   * 回滚客户端。
   *   localPlayer: 0（P1 视角）或 1（P2 视角）
   *   link: NetworkLink，客户端只负责收/发，链路计时由 Lab 统一驱动
   */
  function RollbackClient(localPlayer, rollbackMax, link) {
    this.localPlayer = localPlayer | 0;
    this.remotePlayer = this.localPlayer ^ 1;
    this.rollbackMax = rollbackMax | 0;
    this.link = link;
    this.reset();
  }

  RollbackClient.prototype.reset = function (rollbackMax) {
    if (rollbackMax !== undefined) {
      this.rollbackMax = rollbackMax | 0;
    }
    this.frameCount = 0;          // 已结算帧数（帧号 0..frameCount-1，下一帧编号即 frameCount）
    this.state = engine.initialState(this.startOverride || null);
    this.localInputs = [];        // 本地真实输入，按帧号
    this.remoteInputs = [];       // 已收到的远端输入，按帧号（空洞表示未到）
    this.remoteKnown = [];        // 对应帧远端输入是否已确认
    this.lastConfirmedRemote = 0; // 远端输入未到时的预测值（最近一次确认输入）
    this.confirmedFrame = -1;     // 远端连续确认到的最大帧号
    this.snapshots = {};          // 帧号 -> 该帧结算前状态快照
    this.states = {};             // 帧号 -> 该帧结算后状态快照（逐帧 diff 用）
    this.checksums = {};          // 帧号 -> 该帧结算后校验和
    this.predictedFrames = {};    // 帧号 -> 该帧结算时远端输入是否为预测
    this.usedInputs = {};         // 帧号 -> 该帧结算时实际使用的远端输入值
    this.events = {};             // 事件键 -> 事件记录（含状态生命周期）
    this.rollbackCount = 0;
    this.maxRollbackDepth = 0;
    this.waitTicks = 0;
    this.lastTickWaited = false;
  };

  RollbackClient.prototype.setStart = function (start) {
    this.startOverride = start ? clone(start) : null;
    this.state = engine.initialState(this.startOverride);
  };

  /* 本地玩家压入一帧真实输入（输入日志驱动） */
  RollbackClient.prototype.pushLocalInput = function (mask) {
    this.localInputs[this.frameCount] = mask | 0;
  };

  /* 吸收一个到达的网络包：冗余历史输入，只接受包里实际携带且尚未确认的帧。
   * 注意包可能短于当前已结算帧数（对端当时还没跑到），空洞不能当成输入 0。 */
  RollbackClient.prototype.absorbPacket = function (packet) {
    var changed = false;
    for (var f = 0; f < packet.inputs.length; f++) {
      if (this.remoteKnown[f]) {
        continue;
      }
      this.remoteInputs[f] = packet.inputs[f] | 0;
      this.remoteKnown[f] = true;
      this.lastConfirmedRemote = packet.inputs[f] | 0;
      changed = true;
    }
    if (changed) {
      // 重新计算连续确认边界（中间出现空洞即停止）
      var cf = -1;
      while (this.remoteKnown[cf + 1]) {
        cf += 1;
      }
      this.confirmedFrame = cf;
    }
    return changed;
  };

  RollbackClient.prototype.isWaiting = function () {
    // 本地帧领先“最早未确认帧”达到 rollbackMax 即暂停
    var earliestUnconfirmed = this.confirmedFrame + 1;
    return (this.frameCount - earliestUnconfirmed) >= this.rollbackMax;
  };

  /*
   * 推进一个逻辑帧。
   * localMask: 本帧本地输入（来自日志）；logEnded 表示日志已无后续帧。
   * 返回 { waited, rolledBack:深度或0, events:[...] }
   * 即使日志结束也继续收包与冗余重发，保证丢包后远端最终补全、双方收敛。
   */
  RollbackClient.prototype.tick = function (localMask, logEnded) {
    this.lastTickWaited = false;
    // 1. 收取本帧到达的远端数据包（链路计时已由 Lab 在本帧统一推进）
    var packets = this.link.drain(this.localPlayer);
    var anyChange = false;
    for (var i = 0; i < packets.length; i++) {
      if (this.absorbPacket(packets[i])) {
        anyChange = true;
      }
    }

    // 2. 远端输入到达：先把“猜对了”的帧提升为确认（无需回滚），再找第一个猜错的帧回滚
    var rollbackTo = -1;
    if (anyChange) {
      for (var f = 0; f < this.frameCount; f++) {
        if (this.predictedFrames[f] && this.remoteKnown[f]) {
          if (this.usedInputs[f] === this.remoteInputs[f]) {
            // 预测值与真实输入一致：状态本就正确，仅把该帧标记为确认
            this.predictedFrames[f] = false;
            if (this.events) {
              Object.keys(this.events).forEach(function (key) {
                var ev = this.events[key];
                if (ev.frame === f && !ev.revoked) {
                  ev.predicted = false;
                  ev.confirmed = true;
                }
              }, this);
            }
          } else if (rollbackTo < 0) {
            rollbackTo = f; // 第一个猜错的帧
          }
        }
      }
    }
    var depth = 0;
    if (rollbackTo >= 0) {
      depth = this.frameCount - rollbackTo;
      this.rollbackTo(rollbackTo);
      this.rollbackCount += 1;
      if (depth > this.maxRollbackDepth) {
        this.maxRollbackDepth = depth;
      }
    }

    // 3. 回滚深度上限：领先最早未确认帧达到上限则暂停等待
    if (this.isWaiting()) {
      this.waitTicks += 1;
      this.lastTickWaited = true;
      this.link.send(this.localPlayer, { from: this.localPlayer, inputs: this.localInputs.slice(0) });
      return { waited: true, rolledBack: depth, events: [] };
    }

    // 4. 日志结束：只收包、继续重发，等待对端追平，不再推进
    if (logEnded) {
      this.link.send(this.localPlayer, { from: this.localPlayer, inputs: this.localInputs.slice(0) });
      return { waited: true, rolledBack: depth, events: [] };
    }

    // 5. 本地输入立即生效并结算一帧
    this.pushLocalInput(localMask);
    var ev = this.advanceOne(this.frameCount);
    // 6. 冗余发送全部本地已知输入
    this.link.send(this.localPlayer, { from: this.localPlayer, inputs: this.localInputs.slice(0) });
    return { waited: false, rolledBack: depth, events: ev };
  };

  /* 取某帧远端输入：未确认则沿用最近一次已确认输入（预测）。
   * 注意输入 0 是合法值，必须用 undefined 判空而不能用真值判断。 */
  RollbackClient.prototype.remoteInputFor = function (f) {
    if (this.remoteKnown[f] === true) {
      return { mask: this.remoteInputs[f], predicted: false };
    }
    return { mask: this.lastConfirmedRemote, predicted: true };
  };

  RollbackClient.prototype.localInputFor = function (f) {
    // 回滚重算时本地输入一定已存在
    return this.localInputs[f] | 0;
  };

  /* 结算第 f 帧（f 必须等于当前 frameCount，重算时由 rollbackTo 保证） */
  RollbackClient.prototype.advanceOne = function (f) {
    this.snapshots[f] = clone(this.state);
    var remote = this.remoteInputFor(f);
    var inputs = this.localPlayer === 0
      ? [this.localInputFor(f), remote.mask]
      : [remote.mask, this.localInputFor(f)];

    var events = engine.stepFrame(this.state, inputs);
    this.frameCount = f + 1;
    this.checksums[f] = engine.frameChecksum(this.state);
    this.states[f] = clone(this.state);
    this.predictedFrames[f] = remote.predicted;
    this.usedInputs[f] = remote.mask;

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      // 同一事件键已存在（重算后仍发生）则保留，不重复触发特效
      if (!this.events[ev.key]) {
        this.events[ev.key] = {
          key: ev.key,
          frame: ev.frame,
          attacker: ev.attacker,
          defender: ev.defender,
          move: ev.move,
          kind: ev.kind,
          damage: ev.damage,
          predicted: remote.predicted,
          confirmed: !remote.predicted,
          revoked: false,
          bornTick: f
        };
      }
    }
    return events;
  };

  /* 回滚到帧 f：载入 f 结算前快照，重算到旧帧号，并对事件对账 */
  RollbackClient.prototype.rollbackTo = function (f) {
    var before = this.events;
    var oldFrameCount = this.frameCount;
    this.state = clone(this.snapshots[f]);
    this.frameCount = f;
    this.events = {};

    // 清掉重算区间内的逐帧记录，advanceOne 会重新写入，避免旧键残留
    for (var k = f; k < oldFrameCount; k++) {
      delete this.snapshots[k];
      delete this.states[k];
      delete this.checksums[k];
      delete this.predictedFrames[k];
      delete this.usedInputs[k];
    }

    // 回滚点之前的事件原样保留（不受重算影响）
    Object.keys(before).forEach(function (key) {
      if (before[key].frame < f) {
        this.events[key] = before[key];
      }
    }, this);

    // 重算 f..oldFrameCount-1（advanceOne 内按键去重，特效不重复触发）
    for (var t = f; t < oldFrameCount; t++) {
      this.advanceOne(t);
    }

    // 对账：重算后不再发生的事件标记撤销（特效撤掉），仍发生的提升确认状态
    var after = this.events;
    Object.keys(before).forEach(function (key) {
      var old = before[key];
      if (old.frame < f) {
        return;
      }
      if (!after[key]) {
        old.revoked = true; // 撤销事件保留在列表里供调试
        this.events[key] = old;
      } else {
        after[key].predicted = this.predictedFrames[old.frame];
        after[key].confirmed = !this.predictedFrames[old.frame];
      }
    }, this);
  };

  /* 事件列表（按帧号排序），附带生命周期状态 */
  RollbackClient.prototype.eventList = function () {
    return Object.keys(this.events).map(function (k) {
      return this.events[k];
    }, this).sort(function (a, b) {
      return (a.frame - b.frame) || (a.attacker - b.attacker);
    });
  };

  RollbackClient.prototype.stats = function () {
    return {
      frameCount: this.frameCount,
      confirmedFrame: this.confirmedFrame,
      rollbackCount: this.rollbackCount,
      maxRollbackDepth: this.maxRollbackDepth,
      waitTicks: this.waitTicks,
      waiting: this.lastTickWaited,
      predictedLead: this.frameCount - (this.confirmedFrame + 1)
    };
  };

  return {
    Network: Network,
    NetworkLink: NetworkLink,
    RollbackClient: RollbackClient
  };
});
