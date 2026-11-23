/*
 * 视频参考图缓冲回放模拟器
 * 按 samples/picture-buffer.json 内 spec 实现:
 *  - 图序号(POC)以最近成功 keep 的参考图为回绕基准
 *  - 每条记录: 先解析引用(refs) -> 执行标记操作(ops) -> 当前图入待显队列 -> keep 存短参考并更新基准
 *  - 污染: bad 标记 / 缺失引用 / 引用受污染图, 原因按 refs 顺序保留并可追溯
 *  - 出图: 待显数 > reorder 或 (短参考 ∪ 长期参考 ∪ 待显) > capacity 时弹最小 POC;
 *    小于本周期最后出图 POC 的标迟到丢弃
 *  - 整行不生效并停止: 容量超限且待显已空 / 周期内 POC 重复 / 坏标记操作
 *  - reset: drain 排空或 drop 丢弃旧队列, 清参考, 回绕基准与最后出图号清零
 * 浏览器与 Node 共用(无依赖)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PicBufferSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_RECORDS = 100000; // 导入上限
  var DROP_LATE = 'late';        // 迟到的低序号图
  var DROP_RESET = 'reset-drop'; // reset=drop 丢弃旧队列

  function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }

  function validateHeader(trace) {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return '顶层必须是对象';
    var M = trace.M, capacity = trace.capacity, reorder = trace.reorder;
    if (!isInt(M) || M < 8 || M > 65536 || (M & (M - 1)) !== 0) return 'M必须是8至65536的二次幂';
    if (!isInt(capacity) || capacity < 1 || capacity > 32) return 'capacity必须是1至32的整数';
    if (!isInt(reorder) || reorder < 0 || reorder > capacity) return 'reorder必须是0至capacity的整数';
    if (!Array.isArray(trace.records)) return 'records必须是数组';
    return null;
  }

  // 校验单条记录结构; 返回错误串或 null
  function validateRecord(rec, M, isFirst) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '行必须是对象';
    if (!isInt(rec.lsb) || rec.lsb < 0 || rec.lsb >= M) return 'lsb必须是[0,M)内整数';
    if (rec.keep !== undefined && typeof rec.keep !== 'boolean') return 'keep必须是布尔值';
    if (rec.bad !== undefined && typeof rec.bad !== 'boolean') return 'bad必须是布尔值';
    var refs = rec.refs === undefined ? [] : rec.refs;
    if (!Array.isArray(refs)) return 'refs必须是数组';
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) return 'refs元素必须是单字段对象';
      var keys = Object.keys(r);
      if (keys.length !== 1 || (keys[0] !== 'poc' && keys[0] !== 'slot')) return 'refs元素必须只含poc或slot';
      if (keys[0] === 'poc' && !isInt(r.poc)) return 'refs.poc必须是整数';
      if (keys[0] === 'slot' && (!isInt(r.slot) || r.slot < 0 || r.slot > 31)) return 'refs.slot必须是0至31的整数';
    }
    var ops = rec.ops === undefined ? [] : rec.ops;
    if (!Array.isArray(ops)) return 'ops必须是数组';
    for (i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!Array.isArray(op) || op.length < 1) return 'ops元素必须是数组';
      if (op[0] === 'erase') {
        if (op.length !== 2 || !isInt(op[1])) return 'erase格式为[erase,poc]';
      } else if (op[0] === 'clear') {
        if (op.length !== 2 || !isInt(op[1]) || op[1] < 0 || op[1] > 31) return 'clear格式为[clear,slot],slot为0至31';
      } else if (op[0] === 'move') {
        if (op.length !== 3 || !isInt(op[1]) || !isInt(op[2]) || op[2] < 0 || op[2] > 31) return 'move格式为[move,poc,slot],slot为0至31';
      } else return '未知操作:' + String(op[0]);
    }
    if (rec.reset !== undefined) {
      if (rec.reset !== 'drain' && rec.reset !== 'drop') return 'reset必须取drain或drop';
      if (rec.lsb !== 0 || refs.length !== 0 || ops.length !== 0) return 'reset行lsb必须为0且refs、ops为空';
    } else if (isFirst) {
      return '首行必须是reset行';
    }
    return null;
  }

  /*
   * 模拟整个跟踪文件, 返回:
   * {
   *   headerError, truncated,
   *   pics:   [{id,line,poc,lsb,keep,bad,polluted,reasons:[{k:'self'}|{k:'missing',via}|{k:'ref',via,t}]}],
   *   steps:  [{line,eof?,reset,poc,wrap,refsR,opsR,err,ev:[{t:'out'|'drop',id,reason?}],
   *             s:[poc,id,...], l:[slot,id,...], q:[id...], h,p,lo}],  // 每行后的完整状态快照
   *   firstError: {line, reason} | null
   * }
   */
  function simulate(trace) {
    var result = {
      headerError: validateHeader(trace),
      truncated: false,
      M: trace && trace.M, capacity: trace && trace.capacity, reorder: trace && trace.reorder,
      pics: [], steps: [], firstError: null
    };
    if (result.headerError) return result;

    var M = trace.M, capacity = trace.capacity, reorder = trace.reorder;
    var records = trace.records;
    var n = records.length;
    if (n > MAX_RECORDS) { n = MAX_RECORDS; result.truncated = true; }

    var shortRef = new Map();          // poc -> picId
    var longRef = new Array(32).fill(null); // slot -> picId
    var queue = [];                    // 待显队列 picId(按到达序)
    var baseH = 0, baseP = 0;          // 回绕基准(最近成功 keep 行的高位/低位)
    var lastOut = null;                // 本周期最后出图 POC
    var periodPocs = new Set();        // 本周期已出现 POC
    var pics = result.pics;
    var steps = result.steps;

    function unionSize() {
      var set = new Set(queue);
      shortRef.forEach(function (v) { set.add(v); });
      for (var i = 0; i < 32; i++) if (longRef[i] !== null) set.add(longRef[i]);
      return set.size;
    }

    function popMin(ev) {
      var mi = 0;
      for (var i = 1; i < queue.length; i++) if (pics[queue[i]].poc < pics[queue[mi]].poc) mi = i;
      var id = queue.splice(mi, 1)[0];
      if (lastOut !== null && pics[id].poc < lastOut) {
        ev.push({ t: 'drop', id: id, reason: DROP_LATE });
      } else {
        ev.push({ t: 'out', id: id });
        lastOut = pics[id].poc;
      }
    }

    function snapInto(step) {
      var s = [];
      shortRef.forEach(function (id, poc) { s.push(poc, id); });
      var l = [];
      for (var i = 0; i < 32; i++) if (longRef[i] !== null) l.push(i, longRef[i]);
      step.s = s; step.l = l; step.q = queue.slice();
      step.h = baseH; step.p = baseP; step.lo = lastOut;
    }

    var stopped = false;

    for (var line = 0; line < n && !stopped; line++) {
      var rec = records[line];
      var step = {
        line: line, reset: (rec && rec.reset) || null,
        poc: null, wrap: null, refsR: [], opsR: [], err: null, ev: []
      };

      function fail(reason) { // 整行不生效: 快照为行首状态
        step.err = reason;
        snapInto(step);
        steps.push(step);
        result.firstError = { line: line, reason: reason };
        stopped = true;
      }

      var verr = validateRecord(rec, M, line === 0);
      if (verr) { fail(verr); break; }

      var keep = rec.keep === true;
      var badflag = rec.bad === true;
      var refs = rec.refs || [];
      var ops = rec.ops || [];

      // ---- reset: 先处理旧周期 ----
      if (rec.reset !== undefined) {
        if (rec.reset === 'drain') {
          while (queue.length > 0) popMin(step.ev); // 排空, 迟到规则仍适用
        } else { // drop: 丢弃旧队列(按 POC 序记录)
          var sorted = queue.slice().sort(function (a, b) { return pics[a].poc - pics[b].poc; });
          for (var i = 0; i < sorted.length; i++) step.ev.push({ t: 'drop', id: sorted[i], reason: DROP_RESET });
          queue = [];
        }
        shortRef.clear();
        longRef.fill(null);
        periodPocs.clear();
        baseH = 0; baseP = 0; lastOut = null; // 高位低位清零, 清最后显示号
      }

      // ---- 行首状态保存(供容量错误回滚; reset 部分已生效不回滚) ----
      var preShort = shortRef, preLong = longRef;
      var preQueue = queue.slice();
      var preBaseH = baseH, preBaseP = baseP, preLast = lastOut;
      var prePicLen = pics.length;

      // ---- POC 计算(回绕) ----
      var q = rec.lsb;
      var h = baseH, adj = 0;
      if (baseP - q >= M / 2) { h += M; adj = M; }
      else if (q - baseP > M / 2) { h -= M; adj = -M; }
      var poc = h + q;
      step.poc = poc;
      step.wrap = { h: baseH, p: baseP, q: q, adj: adj, poc: poc };

      if (periodPocs.has(poc)) { fail('周期内POC重复: ' + poc); break; }

      // ---- 1) 按步首参考解析 refs ----
      var reasons = [];
      if (badflag) reasons.push({ k: 'self' });
      for (i = 0; i < refs.length; i++) {
        var r = refs[i], rr;
        if (r.poc !== undefined) {
          rr = shortRef.has(r.poc)
            ? { ref: r, status: 'ok', target: shortRef.get(r.poc) }
            : { ref: r, status: 'missing', target: null };
        } else {
          rr = longRef[r.slot] !== null
            ? { ref: r, status: 'ok', target: longRef[r.slot] }
            : { ref: r, status: 'missing', target: null };
        }
        step.refsR.push(rr);
        if (rr.status === 'missing') reasons.push({ k: 'missing', via: r });
        else if (pics[rr.target].polluted) reasons.push({ k: 'ref', via: r, t: rr.target });
      }

      // ---- 2) 依次执行 ops(先克隆, 坏操作整行回滚) ----
      var cShort = new Map(shortRef), cLong = longRef.slice();
      var opErr = null;
      for (i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op[0] === 'erase') {
          if (!cShort.has(op[1])) { opErr = '删除空引用: poc ' + op[1]; break; }
          cShort.delete(op[1]);
          step.opsR.push({ op: op, ok: true });
        } else if (op[0] === 'clear') {
          if (cLong[op[1]] === null) { opErr = '清空长期槽: slot ' + op[1]; break; }
          cLong[op[1]] = null;
          step.opsR.push({ op: op, ok: true });
        } else { // move
          if (!cShort.has(op[1])) { opErr = '移动缺失引用: poc ' + op[1]; break; }
          cLong[op[2]] = cShort.get(op[1]); // 覆盖槽中旧参考
          cShort.delete(op[1]);
          step.opsR.push({ op: op, ok: true });
        }
      }
      if (opErr) { fail(opErr); break; }
      shortRef = cShort; longRef = cLong;

      // ---- 3) 当前图入待显队列, keep 存短参考并更新回绕基准 ----
      var pic = {
        id: pics.length, line: line, poc: poc, lsb: q,
        keep: keep, bad: badflag,
        polluted: reasons.length > 0, reasons: reasons
      };
      pics.push(pic);
      queue.push(pic.id);
      periodPocs.add(poc);
      if (keep) { shortRef.set(poc, pic.id); baseH = h; baseP = q; }

      // ---- 4) 按重排深度与容量规则出图 ----
      var capErr = false;
      while (queue.length > reorder || unionSize() > capacity) {
        if (queue.length === 0) { capErr = true; break; }
        popMin(step.ev);
      }
      if (capErr) {
        // 整行不生效: 回滚到行首状态
        shortRef = preShort; longRef = preLong; queue = preQueue;
        baseH = preBaseH; baseP = preBaseP; lastOut = preLast;
        pics.length = prePicLen;
        periodPocs.delete(poc);
        step.ev = [];
        fail('容量超限且待显已空');
        break;
      }

      snapInto(step);
      steps.push(step);
    }

    if (!stopped) {
      if (n === 0) {
        result.firstError = { line: 0, reason: '记录为空,首行必须是reset行' };
      } else {
        // ---- 合法文件尾排空 ----
        var eofStep = { line: n, eof: true, reset: null, poc: null, wrap: null, refsR: [], opsR: [], err: null, ev: [] };
        while (queue.length > 0) popMin(eofStep.ev);
        snapInto(eofStep);
        steps.push(eofStep);
      }
    }

    return result;
  }

  // 追溯污染根源(带记忆化, 链长 O(n) 总复杂度 O(n))
  function buildRootFinder(pics) {
    var memo = new Array(pics.length);
    function rootOf(id, guard) {
      if (memo[id] !== undefined) return memo[id];
      if (guard === undefined) guard = new Set();
      if (guard.has(id)) return null;
      guard.add(id);
      var pic = pics[id];
      var root = null;
      for (var i = 0; i < pic.reasons.length; i++) {
        var r = pic.reasons[i];
        if (r.k === 'self') { root = { line: pic.line, poc: pic.poc, cause: 'bad标记' }; break; }
        if (r.k === 'missing') { root = { line: pic.line, poc: pic.poc, cause: '缺失引用', via: r.via }; break; }
        var sub = rootOf(r.t, guard);
        if (sub) { root = sub; break; }
      }
      memo[id] = root;
      return root;
    }
    return rootOf;
  }

  function viaText(via) {
    return via.poc !== undefined ? 'poc=' + via.poc : 'slot=' + via.slot;
  }

  // 生成回放报告: 解码行及POC、出图行、丢弃行和原因、最终参考状态、首个错误行
  function buildReport(result) {
    var pics = result.pics;
    var rootOf = buildRootFinder(pics);

    var decoded = pics.map(function (pic) {
      return {
        line: pic.line, poc: pic.poc, keep: pic.keep, bad: pic.bad, polluted: pic.polluted,
        reasons: pic.reasons.map(function (r) {
          if (r.k === 'self') return { type: 'bad标记' };
          if (r.k === 'missing') return { type: '缺失引用', via: viaText(r.via) };
          var t = pics[r.t];
          return { type: '引用污染', via: viaText(r.via), targetLine: t.line, targetPoc: t.poc, root: rootOf(r.t) };
        })
      };
    });

    var outputs = [], drops = [];
    result.steps.forEach(function (step) {
      step.ev.forEach(function (e) {
        var pic = pics[e.id];
        var rec = { line: pic.line, poc: pic.poc, at: step.eof ? 'eof' : step.line };
        if (e.t === 'out') outputs.push(rec);
        else drops.push(Object.assign({ reason: e.reason === DROP_LATE ? '迟到的低序号图' : '重置丢弃旧队列' }, rec));
      });
    });

    var last = result.steps[result.steps.length - 1];
    var finalRefs = { short: [], long: [] };
    if (last) {
      for (var i = 0; i < last.s.length; i += 2) {
        finalRefs.short.push({ poc: last.s[i], line: pics[last.s[i + 1]].line });
      }
      for (i = 0; i < last.l.length; i += 2) {
        finalRefs.long.push({ slot: last.l[i], poc: pics[last.l[i + 1]].poc, line: pics[last.l[i + 1]].line });
      }
      finalRefs.short.sort(function (a, b) { return a.poc - b.poc; });
      finalRefs.long.sort(function (a, b) { return a.slot - b.slot; });
    }

    return {
      header: { M: result.M, capacity: result.capacity, reorder: result.reorder },
      truncated: result.truncated,
      counts: {
        decoded: pics.length,
        polluted: pics.filter(function (p) { return p.polluted; }).length,
        outputs: outputs.length,
        drops: drops.length
      },
      decoded: decoded,
      outputs: outputs,
      drops: drops,
      finalRefs: finalRefs,
      firstError: result.firstError
    };
  }

  return {
    MAX_RECORDS: MAX_RECORDS,
    DROP_LATE: DROP_LATE,
    DROP_RESET: DROP_RESET,
    simulate: simulate,
    buildReport: buildReport,
    buildRootFinder: buildRootFinder
  };
});
