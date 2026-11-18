/*
 * rblab-selftest.js — 确定性自测。
 * 覆盖：FNV-1a 测试向量、trade/block/ko 参考值、非法日志拒绝、
 * 同日志重跑校验和一致、网络丢包/抖动下双客户端最终收敛到参考实现、
 * 回滚事件对账（撤销/不重复）、状态字段全部为整数。
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
    root.RBLab.selftest = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (util, engine, net) {
  'use strict';

  function assert(cond, message) {
    if (!cond) {
      throw new Error(message);
    }
  }

  function eq(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
    }
  }

  /* 找参考实现中第一个命中/格挡事件帧 */
  function firstEventFrame(records, kind, attacker) {
    for (var i = 0; i < records.length; i++) {
      var evs = records[i].events;
      for (var j = 0; j < evs.length; j++) {
        if (evs[j].kind === kind && (attacker === undefined || evs[j].attacker === attacker)) {
          return records[i].frame;
        }
      }
    }
    return -1;
  }

  /* 把两份客户端跑到日志耗尽并收敛，返回逐帧统计 */
  function runDualClients(log, netConfig) {
    var cfg = netConfig || { delayMs: 120, jitterMs: 60, lossPct: 20, seed: 20261119, rollbackMax: 8 };
    var link = new net.NetworkLink({
      delayMs: cfg.delayMs, jitterMs: cfg.jitterMs, lossPct: cfg.lossPct, seed: cfg.seed
    });
    var c1 = new net.RollbackClient(0, cfg.rollbackMax, link);
    var c2 = new net.RollbackClient(1, cfg.rollbackMax, link);
    c1.setStart(log.start || null);
    c2.setStart(log.start || null);

    var guard = 0;
    // 等待帧不推进帧号，深度受限 + 高丢包时需要充足的网络重传时间
    var maxGuard = log.frames.length * 3 + 2000;
    var bothDone = false;
    while (!bothDone && guard < maxGuard) {
      guard += 1;
      // 链路每帧统一计时一次，两个方向都只推进一帧
      link.tick();
      // 每个客户端各自从自己的帧号取“本地输入”：c1 取 P1 轨、c2 取 P2 轨
      var f1 = c1.frameCount;
      var f2 = c2.frameCount;
      var m1 = f1 < log.frames.length ? log.frames[f1][0] : 0;
      var m2 = f2 < log.frames.length ? log.frames[f2][1] : 0;
      c1.tick(m1, f1 >= log.frames.length);
      c2.tick(m2, f2 >= log.frames.length);
      bothDone = c1.frameCount >= log.frames.length && c2.frameCount >= log.frames.length &&
        c1.confirmedFrame >= log.frames.length - 1 &&
        c2.confirmedFrame >= log.frames.length - 1;
    }
    return { c1: c1, c2: c2, link: link, converged: bothDone, guard: guard };
  }

  function runAll(cases) {
    var results = [];
    cases.forEach(function (c) {
      var entry = { name: c.name };
      try {
        c.fn();
        entry.ok = true;
      } catch (e) {
        entry.ok = false;
        entry.error = e.message;
      }
      results.push(entry);
    });
    return results;
  }

  function buildCases(samples) {
    var s = samples;
    return [
      {
        name: 'FNV-1a 32 位测试向量（空串与 "foobar"）',
        fn: function () {
          eq(util.toHex8(util.fnv1a32('')), '811c9dc5', '空串 FNV 初值错误');
          eq(util.toHex8(util.fnv1a32('foobar')), 'bf9cf968', 'foobar 哈希错误');
        }
      },
      {
        name: '毫秒转帧：ceil(60·ms/1000) 整数折算',
        fn: function () {
          eq(util.msToFrames(0), 0, '0ms 应为 0 帧');
          eq(util.msToFrames(16), 1, '16ms 应为 1 帧');
          eq(util.msToFrames(17), 2, '17ms 应向上取整为 2 帧');
          eq(util.msToFrames(100), 6, '100ms 应为 6 帧');
          eq(util.msToFrames(1000), 60, '1000ms 应为 60 帧');
        }
      },
      {
        name: 'trade.json：同帧互击帧号、扣血、硬直与恢复帧',
        fn: function () {
          var ref = s.reference.trade;
          var out = engine.runLog(s.trade);
          var hitFrame = firstEventFrame(out.frames, 'hit', 0);
          eq(hitFrame, ref.hitFrame, '互击帧号错误');
          var at = out.frames[hitFrame]; // 帧号从 0 开始，数组下标即帧号
          eq(at.state.fighters[0].hp, ref.hp[0], 'P1 扣血错误');
          eq(at.state.fighters[1].hp, ref.hp[1], 'P2 扣血错误');
          eq(at.state.fighters[0].act, ref.act[0], 'P1 应为 hitstun');
          eq(at.state.fighters[1].act, ref.act[1], 'P2 应为 hitstun');
          eq(at.state.fighters[0].stun, ref.stun[0], 'P1 硬直帧数错误');
          eq(out.frames[ref.idleAgainFrame].state.fighters[0].act, 'idle', 'idle 恢复帧错误');
          eq(out.frames[ref.idleAgainFrame].state.fighters[0].stun, 0, '恢复后 stun 应归零');
        }
      },
      {
        name: 'block.json：第 10 帧格挡成立、不掉血、blockstun 与位置',
        fn: function () {
          var ref = s.reference.block;
          var out = engine.runLog(s.block);
          var blockFrame = firstEventFrame(out.frames, 'block', 0);
          eq(blockFrame, ref.blockFrame, '格挡帧号错误');
          var at = out.frames[blockFrame];
          var p2 = at.state.fighters[1];
          eq(p2.act, ref.p2.act, 'P2 应为 blockstun');
          eq(p2.hp, ref.p2.hp, '格挡不应扣血');
          eq(p2.x, ref.p2.x, 'P2 位置错误');
          eq(p2.stun, ref.p2.stun, 'blockstun 帧数错误');
          eq(p2.move, null, '格挡后不应残留出招状态');
        }
      },
      {
        name: 'ko.json：第 266 帧 KO、累计 9 次命中、P2 血量归零',
        fn: function () {
          var ref = s.reference.ko;
          var out = engine.runLog(s.ko);
          var hits = 0;
          var koFrame = -1;
          out.frames.forEach(function (rec) {
            rec.events.forEach(function (ev) {
              if (ev.kind === 'hit') {
                hits += 1;
              }
            });
            if (koFrame < 0 && rec.state.over) {
              koFrame = rec.frame;
            }
          });
          eq(koFrame, ref.koFrame, 'KO 帧号错误');
          eq(hits, ref.hits, '累计命中次数错误');
          eq(out.state.fighters[1].hp, ref.p2hp, 'P2 最终血量错误');
          // KO 后冻结：帧号照常增加，但角色状态字段（去掉帧号后）完全一致
          var n = out.frames.length;
          function body(cs) {
            return cs.split('|').slice(1).join('|');
          }
          eq(body(engine.checksumString(out.frames[n - 1].state)),
            body(engine.checksumString(out.frames[n - 2].state)), 'KO 后角色状态应冻结');
        }
      },
      {
        name: '同一份日志跑两次，逐帧校验和完全一致',
        fn: function () {
          var a = engine.runLog(s.randomLong);
          var b = engine.runLog(s.randomLong);
          eq(a.frames.length, b.frames.length, '帧数不一致');
          for (var i = 0; i < a.frames.length; i++) {
            eq(b.frames[i].checksum, a.frames[i].checksum, '第 ' + (i + 1) + ' 帧校验和不一致');
          }
        }
      },
      {
        name: 'invalid.json 被拒绝，且错误定位到具体帧与玩家',
        fn: function () {
          var v = engine.validateLog(s.invalid);
          assert(v.ok === false, '非法日志应当校验失败');
          assert(v.errors.some(function (e) { return e.indexOf('5') >= 0; }), '应报出第 5 帧的 32');
          assert(v.errors.some(function (e) { return e.indexOf('6') >= 0; }), '应报出第 6 帧长度错误');
        }
      },
      {
        name: '合法日志全部通过校验',
        fn: function () {
          ['basic', 'block', 'ko', 'trade', 'randomLong'].forEach(function (k) {
            assert(engine.validateLog(s[k]).ok, k + '.json 应当合法');
          });
        }
      },
      {
        name: '高延迟+抖动+丢包下双客户端收敛，已确认帧校验和与参考实现逐帧一致',
        fn: function () {
          var ref = engine.runLog(s.basic);
          var r = runDualClients(s.basic);
          assert(r.converged, '客户端未能在保护步数内收敛');
          for (var i = 0; i < ref.frames.length; i++) {
            // 收敛后所有远端输入都已确认；预测态中间分歧不算错误，只比对最终确认结果
            assert(r.c1.remoteKnown[i] === true && r.c2.remoteKnown[i] === true,
              '第 ' + i + ' 帧收敛后应全部确认');
            eq(r.c1.checksums[i], ref.frames[i].checksum, 'P1 客户端第 ' + i + ' 帧校验和偏离参考实现');
            eq(r.c2.checksums[i], ref.frames[i].checksum, 'P2 客户端第 ' + i + ' 帧校验和偏离参考实现');
          }
          // 已确认帧不再保留预测标记（确认边界内的帧都被真实输入重算过）
          for (var j = 0; j <= r.c1.confirmedFrame; j++) {
            assert(r.c1.predictedFrames[j] === false, '已确认帧 ' + j + ' 不应残留预测标记');
          }
          assert(r.c1.rollbackCount > 0 || r.c2.rollbackCount > 0, '该网络条件下应至少发生一次回滚');
        }
      },
      {
        name: '零延迟零丢包：无等待、回滚深度仅 1（首帧默认预测被证实），最终一致',
        fn: function () {
          var ref = engine.runLog(s.trade);
          var r = runDualClients(s.trade, { delayMs: 0, jitterMs: 0, lossPct: 0, seed: 7, rollbackMax: 8 });
          assert(r.converged, '理想网络也应收敛');
          eq(r.c1.waitTicks, 0, '理想网络不应触发深度上限等待');
          eq(r.c2.waitTicks, 0, '理想网络不应触发深度上限等待');
          // 零延迟仍是 1 帧传输：帧 0 用默认 0 预测，次帧证实，回滚深度最多 1
          assert(r.c1.maxRollbackDepth <= 1, '零延迟回滚深度不应超过 1，实际 ' + r.c1.maxRollbackDepth);
          assert(r.c2.maxRollbackDepth <= 1, '零延迟回滚深度不应超过 1，实际 ' + r.c2.maxRollbackDepth);
          for (var i = 0; i < ref.frames.length; i++) {
            eq(r.c1.checksums[i], ref.frames[i].checksum, '理想网络 P1 第 ' + i + ' 帧校验和错误');
            eq(r.c2.checksums[i], ref.frames[i].checksum, '理想网络 P2 第 ' + i + ' 帧校验和错误');
          }
        }
      },
      {
        name: '回滚事件对账：撤销事件被标记、重放事件不重复、同招只命中一次',
        fn: function () {
          var r = runDualClients(s.randomLong, { delayMs: 150, jitterMs: 80, lossPct: 30, seed: 4242, rollbackMax: 8 });
          assert(r.converged, '随机长日志应收敛');
          var list = r.c1.eventList();
          var keys = {};
          list.forEach(function (ev) {
            assert(!keys[ev.key], '事件键重复：' + ev.key);
            keys[ev.key] = true;
          });
          // 与参考实现的最终生效事件集合一致（撤销的不算）
          var ref = engine.runLog(s.randomLong);
          var refKeys = {};
          ref.frames.forEach(function (rec) {
            rec.events.forEach(function (ev) { refKeys[ev.key] = ev; });
          });
          list.forEach(function (ev) {
            if (ev.revoked) {
              assert(!refKeys[ev.key], '被撤销的事件不应出现在参考结果中：' + ev.key);
            } else {
              assert(refKeys[ev.key], '生效事件应与参考实现一致：' + ev.key);
              eq(ev.kind, refKeys[ev.key].kind, '事件类型不一致 ' + ev.key);
            }
          });
          // 同一招 connected 保证只命中一次：生效命中事件数等于参考实现
          var liveCount = list.filter(function (ev) { return !ev.revoked; }).length;
          eq(liveCount, Object.keys(refKeys).length, '生效事件总数与参考实现不符');
        }
      },
      {
        name: '回滚上限生效：小 rollbackMax + 高延迟出现等待帧',
        fn: function () {
          var r = runDualClients(s.basic, { delayMs: 300, jitterMs: 0, lossPct: 0, seed: 99, rollbackMax: 4 });
          assert(r.c1.waitTicks + r.c2.waitTicks > 0, '深度受限时客户端必须暂停等待');
          assert(r.converged, '等待后仍应收敛');
        }
      },
      {
        name: '网络随机源确定性：同种子两次运行丢包/送达统计一致',
        fn: function () {
          function drive() {
            var n = new net.Network({ delayMs: 80, jitterMs: 40, lossPct: 25, seed: 1234567 });
            for (var i = 0; i < 200; i++) {
              n.send({ i: i });
              n.tick();
            }
            return n.stats();
          }
          var a = drive();
          var b = drive();
          eq(JSON.stringify(b), JSON.stringify(a), '同种子网络统计应逐位复现');
        }
      },
      {
        name: '引擎状态只含整数数值字段（无浮点渗入）',
        fn: function () {
          var out = engine.runLog(s.randomLong);
          function checkNum(v, path) {
            if (typeof v === 'number') {
              assert(Number.isInteger(v), path + ' 不是整数: ' + v);
            }
          }
          out.frames.forEach(function (rec) {
            rec.state.fighters.forEach(function (fd, p) {
              checkNum(fd.x, 'f' + p + '.x');
              checkNum(fd.hp, 'f' + p + '.hp');
              checkNum(fd.actFrame, 'f' + p + '.actFrame');
              checkNum(fd.stun, 'f' + p + '.stun');
            });
            checkNum(rec.state.frame, 'frame');
          });
        }
      }
    ];
  }

  return {
    runAll: runAll,
    buildCases: buildCases,
    runDualClients: runDualClients
  };
});
