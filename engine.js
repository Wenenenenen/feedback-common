/*
 * 游戏任务链演算引擎（纯逻辑，无 DOM 依赖）
 *
 * 语义约定（与 samples 内 说明.txt 对齐）：
 *  - 任务状态：locked | active | ready | claimed | failed
 *  - 无前置任务立即 active；其余任务仅当前置满足“仅 claimed 计数”时才激活
 *  - 玩法事件只结算“事件开始时已 active”的任务，同事件内新解锁者不追认
 *  - eventId 相同：载荷一致幂等忽略；载荷不一致拒绝并记录位置
 *  - claim 仅对 ready 有效；claimed 再 claim 记忽略；其余状态记业务拒绝
 *  - 互斥组领取一项后，同组未领取项全部 failed，再迭代传播失效与重新激活
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QREngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { MAX_QUESTS: 200, MAX_LOG: 5000, MAX_OBJECTIVES: 16 };
  var CHECKPOINT_EVERY = 250;

  function isPosInt(v) { return Number.isInteger(v) && v > 0; }
  function isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }
  function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

  /* ---------- 规范化序列化（去重判定用，键排序保证稳定） ---------- */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }

  /* ---------- 任务定义校验 ---------- */
  function validateQuests(quests) {
    var errors = [];
    if (!Array.isArray(quests)) return { ok: false, errors: ['任务定义必须是数组'] };
    if (quests.length === 0) errors.push('至少需要 1 个任务');
    if (quests.length > LIMITS.MAX_QUESTS) {
      errors.push('任务数 ' + quests.length + ' 超过上限 ' + LIMITS.MAX_QUESTS);
    }

    var byId = {};
    quests.forEach(function (q, i) {
      var where = '第 ' + i + ' 个任务';
      if (!q || typeof q !== 'object' || Array.isArray(q)) {
        errors.push(where + '不是对象'); return;
      }
      if (!isNonEmptyString(q.id)) { errors.push(where + '缺少非空字符串 id'); return; }
      if (Object.prototype.hasOwnProperty.call(byId, q.id)) {
        errors.push('任务 id 重复：' + q.id);
      }
      byId[q.id] = q;

      if (!Array.isArray(q.requires)) errors.push('任务 ' + q.id + ' 的 requires 必须是数组');
      if (q.requireMode !== 'all' && q.requireMode !== 'any') {
        errors.push('任务 ' + q.id + ' 的 requireMode 必须是 all 或 any');
      }
      if (typeof q.choiceGroup !== 'string') errors.push('任务 ' + q.id + ' 的 choiceGroup 必须是字符串');
      if (!q.objectives || !Array.isArray(q.objectives) ||
          q.objectives.length < 1 || q.objectives.length > LIMITS.MAX_OBJECTIVES) {
        errors.push('任务 ' + q.id + ' 必须含 1~' + LIMITS.MAX_OBJECTIVES + ' 个目标');
      } else {
        var oids = {};
        q.objectives.forEach(function (o, j) {
          var tag = '任务 ' + q.id + ' 的第 ' + j + ' 个目标';
          if (!o || typeof o !== 'object') { errors.push(tag + '不是对象'); return; }
          if (!isNonEmptyString(o.id)) { errors.push(tag + '缺少非空字符串 id'); }
          else if (oids[o.id]) errors.push('任务 ' + q.id + ' 内目标 id 重复：' + o.id);
          oids[o.id] = true;
          if (o.kind !== 'count' && o.kind !== 'unique') errors.push(tag + ' kind 必须是 count 或 unique');
          if (!isNonEmptyString(o.eventType)) errors.push(tag + '缺少非空字符串 eventType');
          if (o.match !== undefined && (typeof o.match !== 'object' || o.match === null || Array.isArray(o.match))) {
            errors.push(tag + '的 match 必须是字典');
          }
          if (!isPosInt(o.target)) errors.push(tag + '的 target 必须是正整数');
        });
      }
      if (!q.reward || typeof q.reward !== 'object' || Array.isArray(q.reward)) {
        errors.push('任务 ' + q.id + ' 的 reward 必须是字典');
      } else {
        Object.keys(q.reward).forEach(function (k) {
          if (!isNonNegInt(q.reward[k])) errors.push('任务 ' + q.id + ' 奖励 ' + k + ' 必须是非负整数');
        });
      }
    });

    // 未知前置
    quests.forEach(function (q) {
      if (!q || !Array.isArray(q.requires)) return;
      q.requires.forEach(function (r) {
        if (!isNonEmptyString(r) || !Object.prototype.hasOwnProperty.call(byId, r)) {
          errors.push('任务 ' + (q.id || '?') + ' 引用了未知前置：' + JSON.stringify(r));
        }
      });
    });

    // 依赖环（DFS 三色标记，局部调用栈）
    var GRAY = 1, BLACK = 2;
    var color = {};
    function dfs(startId) {
      var callStack = [startId];
      color[startId] = GRAY;
      while (callStack.length) {
        var id = callStack[callStack.length - 1];
        var q = byId[id];
        var advanced = false;
        if (q && Array.isArray(q.requires)) {
          for (var i = 0; i < q.requires.length; i++) {
            var r = q.requires[i];
            if (!byId[r]) continue; // 未知前置已单独报错
            if (color[r] === GRAY) {
              var cyc = callStack.slice(callStack.indexOf(r)).concat(r).join(' -> ');
              errors.push('检测到依赖环：' + cyc);
              return true;
            }
            if (color[r] === undefined) {
              color[r] = GRAY;
              callStack.push(r);
              advanced = true;
              break;
            }
          }
        }
        if (!advanced) { color[id] = BLACK; callStack.pop(); }
      }
      return false;
    }
    Object.keys(byId).forEach(function (id) {
      if (color[id] === undefined && dfs(id)) return;
    });

    return { ok: errors.length === 0, errors: errors, questById: byId };
  }

  /* ---------- 运行时上下文 ---------- */
  function createContext(quests) {
    var ctx = {
      state: {},
      progress: {},   // [qid][oid] 整数进度
      collected: {},  // [qid][oid] objectId 数组（unique 去重集合）
      balances: {},
      seen: {},       // eventId -> 规范化载荷
      issues: []      // {index, eventId, kind, reason, event}
    };
    quests.forEach(function (q) {
      ctx.progress[q.id] = {};
      ctx.collected[q.id] = {};
      q.objectives.forEach(function (o) {
        ctx.progress[q.id][o.id] = 0;
        ctx.collected[q.id][o.id] = [];
      });
      // 无前置立即激活（all/any 同理）
      ctx.state[q.id] = (!q.requires || q.requires.length === 0) ? 'active' : 'locked';
    });
    return ctx;
  }

  function cloneBundle(ctx) {
    return JSON.parse(JSON.stringify({
      state: ctx.state,
      progress: ctx.progress,
      collected: ctx.collected,
      balances: ctx.balances,
      seen: ctx.seen,
      issues: ctx.issues
    }));
  }

  function objectiveMatches(o, ev) {
    if (o.eventType !== ev.type) return false;
    var match = o.match || {};
    var keys = Object.keys(match);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (ev[k] !== match[k]) return false; // 严格匹配
    }
    return true;
  }

  function questComplete(ctx, q) {
    for (var i = 0; i < q.objectives.length; i++) {
      var o = q.objectives[i];
      if (ctx.progress[q.id][o.id] < o.target) return false;
    }
    return true;
  }

  /* 领取后的固定点传播：互斥失效 -> 迭代（失效传播 / claimed 满足激活） */
  function refreshAfterClaim(ctx, quests, byId, trace) {
    function transition(id, to, reason) {
      var from = ctx.state[id];
      if (from === to) return;
      ctx.state[id] = to;
      trace.transitions.push({ questId: id, from: from, to: to, reason: reason });
    }

    // 1. 互斥组：同组所有未领取项 failed（不论原状态）
    var claimed = quests.filter(function (q) { return ctx.state[q.id] === 'claimed'; });
    claimed.forEach(function (cq) {
      var g = cq.choiceGroup;
      if (!g) return;
      quests.forEach(function (q2) {
        if (q2.choiceGroup === g && q2.id !== cq.id && ctx.state[q2.id] !== 'claimed') {
          transition(q2.id, 'failed', '互斥分支：同组「' + g + '」的 ' + cq.id + ' 已领取');
        }
      });
    });

    // 2. 迭代至固定点
    var changed = true, guard = 0;
    while (changed) {
      changed = false;
      if (++guard > quests.length + 2) throw new Error('状态传播未收敛');
      for (var i = 0; i < quests.length; i++) {
        var q = quests[i];
        if (ctx.state[q.id] !== 'locked') continue;
        var reqs = q.requires || [];
        var states = reqs.map(function (r) { return ctx.state[r]; });
        if (q.requireMode === 'all') {
          var failedReq = reqs.find(function (r) { return ctx.state[r] === 'failed'; });
          if (failedReq) {
            transition(q.id, 'failed', '前置 ' + failedReq + ' 已失效（all：任一前置失效即失效）');
            changed = true; continue;
          }
          if (reqs.length > 0 && reqs.every(function (r) { return ctx.state[r] === 'claimed'; })) {
            transition(q.id, 'active', '前置全部已领取（all 满足），任务激活');
            changed = true; continue;
          }
        } else { // any
          if (reqs.length > 0 && states.every(function (s) { return s === 'failed'; })) {
            transition(q.id, 'failed', '全部前置已失效（any：无一可满足）');
            changed = true; continue;
          }
          var claimedReq = reqs.find(function (r) { return ctx.state[r] === 'claimed'; });
          if (claimedReq) {
            transition(q.id, 'active', '前置 ' + claimedReq + ' 已领取（any 满足），任务激活');
            changed = true; continue;
          }
        }
      }
    }
  }

  function makeTrace(index, ev) {
    return { index: index, event: ev, status: 'applied', reasons: [], changes: [], transitions: [] };
  }

  /* ---------- 单条事件结算（核心） ---------- */
  function applyEvent(ctx, quests, byId, rawEvent, index) {
    var trace = makeTrace(index, rawEvent);
    function reject(reason, kind) {
      trace.status = 'rejected';
      trace.reasons.push(reason);
      ctx.issues.push({ index: index, eventId: rawEvent && rawEvent.eventId, kind: kind || 'invalid', reason: reason, event: rawEvent });
      return trace;
    }

    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      return reject('事件必须是对象');
    }
    if (!isNonEmptyString(rawEvent.eventId)) return reject('缺少非空字符串 eventId');
    if (!isNonEmptyString(rawEvent.type)) return reject('缺少非空字符串 type');

    var canon = stableStringify(rawEvent);

    // 重传判定（claim 与玩法事件一视同仁）
    if (Object.prototype.hasOwnProperty.call(ctx.seen, rawEvent.eventId)) {
      if (ctx.seen[rawEvent.eventId] === canon) {
        trace.status = 'ignored';
        trace.reasons.push('eventId「' + rawEvent.eventId + '」已存在且载荷一致：幂等忽略，不重复计数或发奖');
        return trace;
      }
      trace.status = 'rejected';
      var msg = 'eventId「' + rawEvent.eventId + '」已存在但载荷不一致：拒绝该事件（冲突重放）';
      trace.reasons.push(msg);
      ctx.issues.push({ index: index, eventId: rawEvent.eventId, kind: 'conflict', reason: msg, event: rawEvent });
      return trace;
    }

    if (rawEvent.type === 'claim') return applyClaim(ctx, quests, byId, rawEvent, trace, canon, reject);

    // ---- 玩法事件 ----
    if (rawEvent.amount !== undefined && !isPosInt(rawEvent.amount)) {
      return reject('amount 缺省为 1，若提供必须是正整数');
    }

    // 事件开始时的 active 快照：本事件只结算这批任务
    var activeQuests = quests.filter(function (q) { return ctx.state[q.id] === 'active'; });

    // 预检：匹配的 unique 目标缺 objectId —— 明确报错，整条事件拒绝
    for (var i = 0; i < activeQuests.length; i++) {
      var q0 = activeQuests[i];
      for (var j = 0; j < q0.objectives.length; j++) {
        var o0 = q0.objectives[j];
        if (o0.kind === 'unique' && objectiveMatches(o0, rawEvent)) {
          if (!isNonEmptyString(rawEvent.objectId)) {
            return reject('事件匹配 unique 目标 ' + q0.id + '/' + o0.id + '，但缺少非空字符串 objectId');
          }
        }
      }
    }

    // 通过全部校验，登记已见事件
    ctx.seen[rawEvent.eventId] = canon;
    var amount = rawEvent.amount !== undefined ? rawEvent.amount : 1;

    activeQuests.forEach(function (q) {
      q.objectives.forEach(function (o) {
        if (!objectiveMatches(o, rawEvent)) return;
        var before = ctx.progress[q.id][o.id];
        if (o.kind === 'count') {
          var after = Math.min(o.target, before + amount);
          ctx.progress[q.id][o.id] = after;
          if (after !== before) {
            trace.changes.push({ questId: q.id, objectiveId: o.id, kind: 'count', from: before, to: after, target: o.target, amount: amount });
          }
        } else {
          var set = ctx.collected[q.id][o.id];
          if (set.indexOf(rawEvent.objectId) === -1) {
            set.push(rawEvent.objectId);
            var na = Math.min(o.target, set.length);
            ctx.progress[q.id][o.id] = na;
            trace.changes.push({ questId: q.id, objectiveId: o.id, kind: 'unique', from: before, to: na, target: o.target, objectId: rawEvent.objectId });
          } else {
            trace.reasons.push('任务 ' + q.id + ' 目标 ' + o.id + ' 已收集过 objectId「' + rawEvent.objectId + '」，去重不重复计数');
          }
        }
      });
      // 全部目标完成 -> ready（事件内不传播激活）
      if (ctx.state[q.id] === 'active' && questComplete(ctx, q)) {
        ctx.state[q.id] = 'ready';
        trace.transitions.push({ questId: q.id, from: 'active', to: 'ready', reason: '全部目标完成，可领取奖励' });
      }
    });

    if (trace.changes.length === 0 && trace.transitions.length === 0 && trace.reasons.length === 0) {
      trace.reasons.push('没有进行中的任务匹配该事件');
    }
    return trace;
  }

  function applyClaim(ctx, quests, byId, rawEvent, trace, canon, reject) {
    if (!isNonEmptyString(rawEvent.questId)) return reject('claim 事件缺少非空字符串 questId');
    // 结构合法即登记已见，业务拒绝不影响幂等判定
    ctx.seen[rawEvent.eventId] = canon;

    var q = byId[rawEvent.questId];
    if (!q) {
      return reject('claim 目标任务不存在：' + rawEvent.questId, 'claim-reject');
    }
    var st = ctx.state[q.id];
    if (st === 'claimed') {
      trace.status = 'ignored';
      trace.reasons.push('任务 ' + q.id + ' 已领取，重复 claim 忽略，不重复发奖');
      return trace;
    }
    if (st !== 'ready') {
      var label = { locked: '锁定', active: '进行中', failed: '已失效' }[st] || st;
      return reject('任务 ' + q.id + ' 当前为「' + label + '」，仅 ready（可领取）状态允许 claim', 'claim-reject');
    }

    // 原子领取：状态翻转 + 奖励入账
    ctx.state[q.id] = 'claimed';
    trace.transitions.push({ questId: q.id, from: 'ready', to: 'claimed', reason: '领取奖励' });
    trace.reward = {};
    Object.keys(q.reward).forEach(function (k) {
      ctx.balances[k] = (ctx.balances[k] || 0) + q.reward[k];
      trace.reward[k] = q.reward[k];
    });

    refreshAfterClaim(ctx, quests, byId, trace);
    return trace;
  }

  /* ---------- 全量重放（带检查点，供时间轴定位） ---------- */
  function replay(quests, rawEvents) {
    var check = validateQuests(quests);
    if (!check.ok) throw new Error('任务定义非法：' + check.errors.join('；'));
    var byId = check.questById;
    var ctx = createContext(quests);
    var rt = {
      quests: quests, byId: byId, ctx: ctx,
      log: [], traces: [], checkpoints: [{ index: 0, bundle: cloneBundle(ctx) }]
    };
    var list = Array.isArray(rawEvents) ? rawEvents : [];
    if (list.length > LIMITS.MAX_LOG) {
      throw new Error('日志项 ' + list.length + ' 超过上限 ' + LIMITS.MAX_LOG);
    }
    for (var i = 0; i < list.length; i++) {
      var trace = applyEvent(ctx, quests, byId, list[i], i);
      rt.log.push(list[i]);
      rt.traces.push(trace);
      if ((i + 1) % CHECKPOINT_EVERY === 0 && i + 1 < list.length) {
        rt.checkpoints.push({ index: i + 1, bundle: cloneBundle(ctx) });
      }
    }
    return rt;
  }

  /* 取日志前 k 项结算后的上下文（时间轴定位，不破坏完整运行时） */
  function viewAt(rt, k) {
    var total = rt.log.length;
    k = Math.max(0, Math.min(total, k | 0));
    var cp = rt.checkpoints[0];
    for (var i = 0; i < rt.checkpoints.length; i++) {
      if (rt.checkpoints[i].index <= k) cp = rt.checkpoints[i]; else break;
    }
    var ctx = JSON.parse(JSON.stringify(cp.bundle));
    for (var j = cp.index; j < k; j++) {
      applyEvent(ctx, rt.quests, rt.byId, rt.log[j], j);
    }
    return ctx;
  }

  /* ---------- 存档 ---------- */
  function exportSave(rt, cursor) {
    var k = Math.max(0, Math.min(rt.log.length, cursor == null ? rt.log.length : cursor));
    // bundle 必须与 cursor 对齐：取“前 k 条日志”结算后的上下文快照
    return {
      format: 'quest-branch-replayer-save/v1',
      savedAt: new Date().toISOString(),
      quests: rt.quests,
      log: rt.log,
      cursor: k,
      bundle: cloneBundle(viewAt(rt, k))
    };
  }

  function normalizeCollected(ctx) {
    var out = {};
    Object.keys(ctx.collected).forEach(function (qid) {
      out[qid] = {};
      Object.keys(ctx.collected[qid]).forEach(function (oid) {
        out[qid][oid] = ctx.collected[qid][oid].slice().sort();
      });
    });
    return out;
  }

  /* 重放存档日志并与存档内状态比对，验证“恢复后继续执行 == 连续执行” */
  function verifySave(save) {
    var problems = [];
    if (!save || save.format !== 'quest-branch-replayer-save/v1') {
      return { ok: false, problems: ['存档格式标识缺失或不受支持'] };
    }
    var check = validateQuests(save.quests);
    if (!check.ok) return { ok: false, problems: check.errors };
    if (!Array.isArray(save.log)) return { ok: false, problems: ['存档 log 不是数组'] };
    var cursor = Number.isInteger(save.cursor) ? Math.max(0, Math.min(save.log.length, save.cursor)) : save.log.length;

    var rt = replay(save.quests, save.log.slice(0, cursor));
    var expect = save.bundle || {};
    var actual = rt.ctx;

    function diffMap(name, a, b) {
      var keys = {};
      Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
        if (stableStringify(va) !== stableStringify(vb)) {
          problems.push(name + ' 不一致：' + k + '（存档=' + stableStringify(va) + '，重放=' + stableStringify(vb) + '）');
        }
      });
    }

    diffMap('任务状态', expect.state, actual.state);
    diffMap('计数进度', expect.progress, actual.progress);
    var expCol = expect.collected || {};
    var actColNorm = normalizeCollected(actual);
    var expColNorm = {};
    Object.keys(expCol).forEach(function (qid) {
      expColNorm[qid] = {};
      Object.keys(expCol[qid]).forEach(function (oid) {
        expColNorm[qid][oid] = (expCol[qid][oid] || []).slice().sort();
      });
    });
    diffMap('unique 集合', expColNorm, actColNorm);
    diffMap('奖励余额', expect.balances, actual.balances);
    diffMap('已见事件', expect.seen, actual.seen);
    if (stableStringify((expect.issues || []).map(function (x) {
      return { index: x.index, eventId: x.eventId, kind: x.kind, reason: x.reason };
    })) !== stableStringify(actual.issues.map(function (x) {
      return { index: x.index, eventId: x.eventId, kind: x.kind, reason: x.reason };
    }))) {
      problems.push('拒绝/冲突记录（issues）与重放结果不一致');
    }
    return { ok: problems.length === 0, problems: problems, cursor: cursor, runtime: rt, fullLogLength: save.log.length };
  }

  /* ---------- 锁定原因解释 ---------- */
  function explainLock(ctx, q) {
    var st = ctx.state[q.id];
    if (st !== 'locked' && st !== 'failed') return [];
    var reasons = [];
    var reqs = q.requires || [];
    if (q.requireMode === 'all') {
      reqs.forEach(function (r) {
        var s = ctx.state[r];
        if (s === 'claimed') return;
        var label = { locked: '锁定', active: '进行中', ready: '可领取但未领取', failed: '已失效' }[s] || s;
        reasons.push('前置 ' + r + '：' + label + '（all 要求全部前置均已领取）');
      });
    } else {
      var anyClaimed = reqs.some(function (r) { return ctx.state[r] === 'claimed'; });
      if (!anyClaimed) {
        reqs.forEach(function (r) {
          var s = ctx.state[r];
          var label = { locked: '锁定', active: '进行中', ready: '可领取但未领取', failed: '已失效' }[s] || s;
          reasons.push('前置 ' + r + '：' + label);
        });
        reasons.push('any 要求至少一个前置被领取（ready 不计入满足）');
      }
    }
    if (st === 'failed') {
      var failedRelated = reasons.filter(function (x) { return x.indexOf('已失效') !== -1; });
      if (failedRelated.length === 0 && q.choiceGroup) {
        reasons.unshift('互斥组「' + q.choiceGroup + '」中已有其他任务被领取');
      }
    }
    return reasons;
  }

  /* ---------- 任务图布局（连通分量 + 最长路径分层 + 重心排序，瘦高自动转置） ---------- */
  function layoutGraph(quests) {
    var NODE_W = 172, NODE_H = 66, GAP_X = 84, GAP_Y = 26, COMP_GAP = 56;
    var TARGET_ASPECT = 1.35; // 画布宽高比目标，避免极端长条
    var byId = {};
    quests.forEach(function (q) { byId[q.id] = q; });

    // 无向连通分量（依赖边两端属于同一分量）
    var adj = {};
    quests.forEach(function (q) { adj[q.id] = []; });
    quests.forEach(function (q) {
      (q.requires || []).forEach(function (r) {
        if (!byId[r]) return;
        adj[q.id].push(r);
        adj[r].push(q.id);
      });
    });
    var seenComp = {}, components = [];
    quests.forEach(function (q) {
      if (seenComp[q.id]) return;
      var stack = [q.id], members = [];
      seenComp[q.id] = true;
      while (stack.length) {
        var id = stack.pop();
        members.push(id);
        (adj[id] || []).forEach(function (nb) {
          if (!seenComp[nb]) { seenComp[nb] = true; stack.push(nb); }
        });
      }
      members.sort();
      components.push(members);
    });
    components.sort(function (a, b) { return b.length - a.length || a[0].localeCompare(b[0]); });

    var edges = [];
    quests.forEach(function (q) {
      (q.requires || []).forEach(function (r) {
        if (byId[r]) edges.push({ from: r, to: q.id, mode: q.requireMode });
      });
    });

    var nodes = [];
    var cursorX = 0, maxBottom = 0;

    components.forEach(function (members) {
      var memberSet = {};
      members.forEach(function (id) { memberSet[id] = 1; });

      // 分量内最长路径分层
      var layerOf = {};
      function layer(id) {
        if (layerOf[id] !== undefined) return layerOf[id];
        var reqs = (byId[id].requires || []).filter(function (r) { return memberSet[r]; });
        layerOf[id] = reqs.length === 0 ? 0 : 1 + Math.max.apply(null, reqs.map(layer));
        return layerOf[id];
      }
      members.forEach(function (id) { layer(id); });

      var layers = {};
      members.forEach(function (id) {
        (layers[layerOf[id]] = layers[layerOf[id]] || []).push(id);
      });
      var layerIdxs = Object.keys(layers).map(Number).sort(function (a, b) { return a - b; });
      var position = {};
      function indexPositions() {
        layerIdxs.forEach(function (l) {
          layers[l].forEach(function (id, i) { position[id] = i; });
        });
      }
      function bary(ids, neighbours) {
        return ids.slice().sort(function (a, b) {
          var na = neighbours(a), nb = neighbours(b);
          if (na.length === 0 && nb.length === 0) return position[a] - position[b];
          if (na.length === 0) return 1;
          if (nb.length === 0) return -1;
          var ma = na.reduce(function (s, x) { return s + position[x]; }, 0) / na.length;
          var mb = nb.reduce(function (s, x) { return s + position[x]; }, 0) / nb.length;
          return ma - mb;
        });
      }
      layerIdxs.forEach(function (l) { layers[l].sort(); });
      indexPositions();
      for (var pass = 0; pass < 3; pass++) {
        layerIdxs.forEach(function (l) {
          if (l === 0) return;
          layers[l] = bary(layers[l], function (id) {
            return (byId[id].requires || []).filter(function (r) { return memberSet[r]; });
          });
        });
        indexPositions();
        layerIdxs.slice().reverse().forEach(function (l) {
          layers[l] = bary(layers[l], function (id) {
            return (adj[id] || []).filter(function (nb) { return memberSet[nb] && (byId[nb].requires || []).indexOf(id) !== -1; });
          });
        });
        indexPositions();
      }

      var colCount = layerIdxs.length;
      var maxRows = Math.max.apply(null, layerIdxs.map(function (l) { return layers[l].length; }));
      var naturalW = colCount * (NODE_W + GAP_X) - GAP_X;
      var naturalH = maxRows * (NODE_H + GAP_Y) - GAP_Y;
      // 分量自身瘦高（如超长单链）时在分量内转置
      var transposed = naturalH > naturalW * 2.2 && colCount <= 2 && members.length > 6;
      var perRow = transposed
        ? Math.max(1, Math.ceil(Math.sqrt(members.length * TARGET_ASPECT * (NODE_H + GAP_Y) / (NODE_W + GAP_X))))
        : 0;

      var compW = 0, compH = 0;
      layerIdxs.forEach(function (l) {
        layers[l].forEach(function (id, i) {
          var x, y;
          if (transposed) {
            var idx = position[id];
            var row = Math.floor(idx / perRow), col = idx % perRow;
            x = col * (NODE_W + GAP_X);
            y = row * (NODE_H + GAP_Y);
            compW = Math.max(compW, x + NODE_W);
            compH = Math.max(compH, y + NODE_H);
          } else {
            x = l * (NODE_W + GAP_X);
            y = i * (NODE_H + GAP_Y);
            compW = Math.max(compW, x + NODE_W);
            compH = Math.max(compH, y + NODE_H);
          }
          nodes.push({ id: id, x: cursorX + x, y: y, layer: l, order: i });
        });
      });
      cursorX += compW + COMP_GAP;
      maxBottom = Math.max(maxBottom, compH);
    });

    // 后置规整：整体宽高比极端（典型：大量无边孤立节点铺成超长横带）时重排为网格
    var totalW = Math.max(1, cursorX - COMP_GAP);
    var totalH = Math.max(1, maxBottom);
    if (totalW > totalH * 2.2 && nodes.length > 6) {
      var stepX = NODE_W + GAP_X, stepY = NODE_H + GAP_Y;
      var cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length * TARGET_ASPECT * stepY / stepX)));
      var order = nodes.slice().sort(function (a, b) {
        return (a.layer - b.layer) || a.order - b.order || a.id.localeCompare(b.id);
      });
      var gridW = 0, gridH = 0;
      order.forEach(function (n, idx) {
        var r = Math.floor(idx / cols), c = idx % cols;
        n.x = c * stepX; n.y = r * stepY;
        gridW = Math.max(gridW, n.x + NODE_W);
        gridH = Math.max(gridH, n.y + NODE_H);
      });
      totalW = gridW; totalH = gridH;
    }

    return {
      nodes: nodes, edges: edges,
      width: totalW,
      height: totalH,
      nodeW: NODE_W, nodeH: NODE_H
    };
  }

  return {
    LIMITS: LIMITS,
    stableStringify: stableStringify,
    validateQuests: validateQuests,
    createContext: createContext,
    applyEvent: applyEvent,
    replay: replay,
    viewAt: viewAt,
    exportSave: exportSave,
    verifySave: verifySave,
    explainLock: explainLock,
    layoutGraph: layoutGraph,
    objectiveMatches: objectiveMatches
  };
});
