/* workgroup-barrier-reel — 计算着色器工作组回放解释器
 *
 * 语义约定:
 * - 寄存器 r0..r31、每组独享的共享区(shared)与输出区(output)全部从零开始。
 * - 阶段(phase) = 两次提交之间的执行段。线程读自己的最新写入,
 *   否则读阶段开始时(即上次提交后)的值。
 * - 同一阶段内, 同地址跨线程读写、或由多个线程写入(即使写入值一样) => 冲突。
 * - 全组到达同一条屏障指令才一起提交; 或全组结束(halt/走出程序末尾)才提交末阶段。
 * - 跳转或访存越界、屏障不一致、指令数超限都会定位到组、阶段和相关指令;
 *   失败后保留上次成功提交的输出。
 *
 * 浏览器与 Node 双端可用: 浏览器挂 window.Reel, Node 用 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_GROUPS = 2048;
  var MAX_LANES = 32;
  var MAX_INSTRUCTIONS = 2000000; // 累计指令执行上限(跨所有组)
  var NUM_REGS = 32;
  var MAX_WORDS = 1 << 20; // 单区字数上限, 防止恶意文件吃光内存

  var REGION_SHARED = 0;
  var REGION_OUTPUT = 1;
  var REGION_NAMES = ['shared', 'output'];

  // 线程停点状态
  var ST_BARRIER = 0; // 停在屏障
  var ST_HALT = 1;    // 已结束
  var ST_ERROR = 2;   // 出错
  var ST_NOTRUN = 3;  // 本阶段未运行(排在前面的线程先出错了)

  function ReelError(kind, info) {
    var e = new Error((info && info.message) || kind);
    e.name = 'ReelError';
    e.kind = kind;
    if (info) for (var k in info) e[k] = info[k];
    return e;
  }
  ReelError.prototype = Object.create(Error.prototype);

  // ---------- 程序解析与静态校验 ----------

  function parseRegister(tok, pc) {
    if (typeof tok !== 'string') return -1;
    var m = /^r(\d+)$/.exec(tok);
    if (!m) return -1;
    var idx = +m[1];
    if (idx >= NUM_REGS) {
      throw ReelError('invalid-program', {
        message: '指令 ' + pc + ': 寄存器 r' + idx + ' 超出范围(最大 r' + (NUM_REGS - 1) + ')',
        pc: pc
      });
    }
    return idx;
  }

  // 操作数: u32 字面量 | "rN" | "group" | "lane"
  // 解析为 {k:0 lit,v} {k:1 reg,v} {k:2 group} {k:3 lane}
  function parseOperand(tok, pc) {
    if (typeof tok === 'number') {
      if (!isFinite(tok)) throw ReelError('invalid-program', { message: '指令 ' + pc + ': 字面量不是有限数', pc: pc });
      return { k: 0, v: tok >>> 0 };
    }
    if (tok === 'group') return { k: 2, v: 0 };
    if (tok === 'lane') return { k: 3, v: 0 };
    var r = parseRegister(tok, pc);
    if (r >= 0) return { k: 1, v: r };
    throw ReelError('invalid-program', {
      message: '指令 ' + pc + ': 无法识别的操作数 ' + JSON.stringify(tok),
      pc: pc
    });
  }

  function parseDstReg(tok, pc) {
    var r = parseRegister(tok, pc);
    if (r < 0) {
      throw ReelError('invalid-program', {
        message: '指令 ' + pc + ': 目标必须是寄存器(r0..r' + (NUM_REGS - 1) + '), 收到 ' + JSON.stringify(tok),
        pc: pc
      });
    }
    return r;
  }

  function parseRegion(tok, pc) {
    if (tok === 'shared') return REGION_SHARED;
    if (tok === 'output') return REGION_OUTPUT;
    throw ReelError('invalid-program', {
      message: '指令 ' + pc + ': 存储区必须是 "shared" 或 "output", 收到 ' + JSON.stringify(tok),
      pc: pc
    });
  }

  function checkUint(name, v, min, max) {
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < min || v > max) {
      throw ReelError('invalid-program', {
        message: name + ' 必须是 ' + min + '..' + max + ' 的整数, 收到 ' + JSON.stringify(v)
      });
    }
    return v;
  }

  function parseSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw ReelError('invalid-program', { message: '文件内容不是 JSON 对象' });
    }
    var groups = checkUint('groups(组数)', spec.groups, 1, MAX_GROUPS);
    var lanes = checkUint('lanes(每组线程数)', spec.lanes, 1, MAX_LANES);
    var sharedWords = checkUint('sharedWords(共享区字数)', spec.sharedWords, 0, MAX_WORDS);
    var outputWords = checkUint('outputWords(输出区字数)', spec.outputWords, 0, MAX_WORDS);
    if (!Array.isArray(spec.program) || spec.program.length === 0) {
      throw ReelError('invalid-program', { message: 'program 必须是非空指令数组' });
    }
    var raw = spec.program;
    var program = new Array(raw.length);
    var texts = new Array(raw.length);
    for (var pc = 0; pc < raw.length; pc++) {
      var ins = raw[pc];
      if (!Array.isArray(ins) || ins.length === 0 || typeof ins[0] !== 'string') {
        throw ReelError('invalid-program', { message: '指令 ' + pc + ': 不是以操作码开头的数组', pc: pc });
      }
      texts[pc] = ins.map(String).join(' ');
      var op = ins[0];
      var arity = { set: 3, add: 4, xor: 4, jz: 3, load: 4, store: 4, barrier: 1, halt: 1 }[op];
      if (arity === undefined) {
        throw ReelError('invalid-program', { message: '指令 ' + pc + ': 未知操作码 ' + JSON.stringify(op), pc: pc });
      }
      if (ins.length !== arity) {
        throw ReelError('invalid-program', {
          message: '指令 ' + pc + ': ' + op + ' 需要 ' + (arity - 1) + ' 个参数, 收到 ' + (ins.length - 1) + ' 个',
          pc: pc
        });
      }
      switch (op) {
        case 'set':
          program[pc] = { op: op, d: parseDstReg(ins[1], pc), a: parseOperand(ins[2], pc) };
          break;
        case 'add':
        case 'xor':
          program[pc] = { op: op, d: parseDstReg(ins[1], pc), a: parseOperand(ins[2], pc), b: parseOperand(ins[3], pc) };
          break;
        case 'jz': {
          var t = ins[2];
          if (typeof t !== 'number' || !isFinite(t) || Math.floor(t) !== t || t < 0) {
            throw ReelError('invalid-program', { message: '指令 ' + pc + ': jz 目标必须是非负整数的绝对指令号', pc: pc });
          }
          program[pc] = { op: op, a: parseOperand(ins[1], pc), target: t };
          break;
        }
        case 'load':
          program[pc] = { op: op, d: parseDstReg(ins[1], pc), region: parseRegion(ins[2], pc), addr: parseOperand(ins[3], pc) };
          break;
        case 'store':
          program[pc] = { op: op, region: parseRegion(ins[1], pc), addr: parseOperand(ins[2], pc), v: parseOperand(ins[3], pc) };
          break;
        default: // barrier / halt
          program[pc] = { op: op };
      }
    }
    return {
      groups: groups, lanes: lanes,
      sharedWords: sharedWords, outputWords: outputWords,
      program: program, programTexts: texts
    };
  }

  // ---------- 执行 ----------

  function evOperand(o, reg, group, lane) {
    switch (o.k) {
      case 0: return o.v;
      case 1: return reg[o.v];
      case 2: return group;
      default: return lane;
    }
  }

  // 执行一个组; counter = {n, max} 跨组共享。出错时把错误挂在返回值上, 不抛出。
  function runGroup(cfg, g, counter) {
    var L = cfg.lanes, prog = cfg.program, plen = prog.length;
    var shared = new Uint32Array(cfg.sharedWords);
    var output = new Uint32Array(cfg.outputWords);
    var mem = [shared, output];
    var memSize = [cfg.sharedWords, cfg.outputWords];
    var regs = new Array(L);
    for (var i = 0; i < L; i++) regs[i] = new Uint32Array(NUM_REGS);
    var pcs = new Uint32Array(L);
    var halted = new Uint8Array(L);
    var haltCount = 0;
    var phases = [];       // 已提交阶段
    var failedPhase = null;
    var error = null;

    while (haltCount < L) {
      var phaseIndex = phases.length;
      var stopPCs = new Uint32Array(L);
      var stopStates = new Uint8Array(L);
      // 本阶段访存记录: 每区 addr -> Map(lane -> {pc, value}) / Map(lane -> pc)
      var writeMap = [new Map(), new Map()];
      var readMap = [new Map(), new Map()];
      // 每线程私有写缓冲(读自己的最新写入): own[lane][region] = Map(addr -> value)
      var own = new Array(L);
      for (i = 0; i < L; i++) own[i] = [new Map(), new Map()];

      var laneError = null;
      var instrThisPhase = 0;

      for (var lane = 0; lane < L; lane++) {
        if (halted[lane]) { stopStates[lane] = ST_HALT; stopPCs[lane] = pcs[lane]; continue; }
        var reg = regs[lane];
        var pc = pcs[lane];
        var stopped = false;
        while (!stopped) {
          if (counter.n >= counter.max) {
            laneError = ReelError('limit', {
              message: '累计指令数超过上限 ' + counter.max,
              lane: lane, pc: pc
            });
            break;
          }
          counter.n++;
          instrThisPhase++;
          if (pc >= plen) { // 走出程序末尾视为结束
            halted[lane] = 1; haltCount++;
            stopStates[lane] = ST_HALT; stopPCs[lane] = pc;
            break;
          }
          var ins = prog[pc];
          var next = pc + 1;
          switch (ins.op) {
            case 'set':
              reg[ins.d] = evOperand(ins.a, reg, g, lane);
              break;
            case 'add':
              reg[ins.d] = (evOperand(ins.a, reg, g, lane) + evOperand(ins.b, reg, g, lane)) >>> 0;
              break;
            case 'xor':
              reg[ins.d] = (evOperand(ins.a, reg, g, lane) ^ evOperand(ins.b, reg, g, lane)) >>> 0;
              break;
            case 'jz':
              if (evOperand(ins.a, reg, g, lane) === 0) {
                if (ins.target >= plen) {
                  laneError = ReelError('jump-oob', {
                    message: '跳转目标 ' + ins.target + ' 超出程序长度 ' + plen,
                    lane: lane, pc: pc, target: ins.target
                  });
                } else {
                  next = ins.target;
                }
              }
              break;
            case 'load': {
              var la = evOperand(ins.addr, reg, g, lane);
              if (la >= memSize[ins.region]) {
                laneError = ReelError('mem-oob', {
                  message: 'load ' + REGION_NAMES[ins.region] + ' 地址 ' + la + ' 越界(区大小 ' + memSize[ins.region] + ')',
                  lane: lane, pc: pc, region: ins.region, addr: la
                });
                break;
              }
              var ow = own[lane][ins.region];
              var val = ow.has(la) ? ow.get(la) : mem[ins.region][la];
              var rm = readMap[ins.region].get(la);
              if (!rm) { rm = new Map(); readMap[ins.region].set(la, rm); }
              if (!rm.has(lane)) rm.set(lane, pc);
              reg[ins.d] = val;
              break;
            }
            case 'store': {
              var sa = evOperand(ins.addr, reg, g, lane);
              if (sa >= memSize[ins.region]) {
                laneError = ReelError('mem-oob', {
                  message: 'store ' + REGION_NAMES[ins.region] + ' 地址 ' + sa + ' 越界(区大小 ' + memSize[ins.region] + ')',
                  lane: lane, pc: pc, region: ins.region, addr: sa
                });
                break;
              }
              var sv = evOperand(ins.v, reg, g, lane);
              own[lane][ins.region].set(sa, sv);
              var wm = writeMap[ins.region].get(sa);
              if (!wm) { wm = new Map(); writeMap[ins.region].set(sa, wm); }
              wm.set(lane, { pc: pc, value: sv });
              break;
            }
            case 'barrier':
              stopStates[lane] = ST_BARRIER; stopPCs[lane] = pc;
              stopped = true;
              break;
            case 'halt':
              halted[lane] = 1; haltCount++;
              stopStates[lane] = ST_HALT; stopPCs[lane] = pc;
              stopped = true;
              break;
          }
          if (laneError) break;
          if (!stopped) pc = next; // barrier/halt 停在原指令上, 不前进
        }
        pcs[lane] = pc;
        if (laneError) {
          stopStates[lane] = ST_ERROR; stopPCs[lane] = pc;
          for (var r2 = lane + 1; r2 < L; r2++) {
            if (!halted[r2]) { stopStates[r2] = ST_NOTRUN; stopPCs[r2] = pcs[r2]; }
            else { stopStates[r2] = ST_HALT; stopPCs[r2] = pcs[r2]; }
          }
          break;
        }
      }

      if (laneError) {
        laneError.group = g;
        laneError.phase = phaseIndex;
        failedPhase = { index: phaseIndex, stopPCs: stopPCs, stopStates: stopStates, conflicts: [], committed: false };
        error = laneError;
        break;
      }

      // 屏障一致性: 全部结束, 或全部停在同一 pc 的屏障
      var allHalt = haltCount === L;
      var divergent = false;
      var barrierPC = -1;
      if (!allHalt) {
        for (lane = 0; lane < L; lane++) {
          if (stopStates[lane] !== ST_BARRIER) { divergent = true; break; }
          if (barrierPC === -1) barrierPC = stopPCs[lane];
          else if (stopPCs[lane] !== barrierPC) { divergent = true; break; }
        }
      }
      if (divergent) {
        var locMap = new Map(); // "state:pc" -> {state, pc, lanes:[]}
        for (lane = 0; lane < L; lane++) {
          var key = stopStates[lane] + ':' + stopPCs[lane];
          var loc = locMap.get(key);
          if (!loc) { loc = { state: stopStates[lane], pc: stopPCs[lane], lanes: [] }; locMap.set(key, loc); }
          loc.lanes.push(lane);
        }
        error = ReelError('barrier-diverge', {
          message: '组内线程未到达同一条屏障',
          group: g, phase: phaseIndex, locations: Array.from(locMap.values())
        });
        failedPhase = { index: phaseIndex, stopPCs: stopPCs, stopStates: stopStates, conflicts: [], committed: false };
        break;
      }

      // 冲突检测: 同地址多线程写, 或跨线程读写(即使写入值一样)
      var conflicts = [];
      for (var rg = 0; rg < 2; rg++) {
        writeMap[rg].forEach(function (writers, addr) {
          var readers = readMap[rg].get(addr);
          var writerLanes = [];
          writers.forEach(function (w, ln) { writerLanes.push({ lane: ln, pc: w.pc, value: w.value }); });
          var readerLanes = [];
          var cross = false;
          if (readers) readers.forEach(function (rpc, ln) {
            readerLanes.push({ lane: ln, pc: rpc });
            if (!writers.has(ln)) cross = true;
          });
          if (writerLanes.length > 1 || cross) {
            conflicts.push({ region: rg, addr: addr, writers: writerLanes, readers: readerLanes });
          }
        });
      }
      conflicts.sort(function (a, b) { return a.region - b.region || a.addr - b.addr; });
      if (conflicts.length > 0) {
        error = ReelError('conflict', {
          message: '同一阶段内存在 ' + conflicts.length + ' 个冲突地址',
          group: g, phase: phaseIndex, conflicts: conflicts
        });
        failedPhase = { index: phaseIndex, stopPCs: stopPCs, stopStates: stopStates, conflicts: conflicts, committed: false };
        break;
      }

      // 提交: 单写者, 直接落盘; 记录本阶段提交的写入
      var commits = [{ addr: [], value: [] }, { addr: [], value: [] }];
      for (rg = 0; rg < 2; rg++) {
        writeMap[rg].forEach(function (writers, addr) {
          var w = writers.values().next().value;
          mem[rg][addr] = w.value;
          commits[rg].addr.push(addr);
          commits[rg].value.push(w.value);
        });
      }
      // 全结束且本阶段没有任何指令(走出末尾的空阶段)则不记录
      if (!(allHalt && instrThisPhase === 0)) {
        phases.push({
          index: phaseIndex,
          stopPCs: stopPCs,
          stopStates: stopStates,
          commits: [
            { addr: Uint32Array.from(commits[0].addr), value: Uint32Array.from(commits[0].value) },
            { addr: Uint32Array.from(commits[1].addr), value: Uint32Array.from(commits[1].value) }
          ]
        });
      }
      if (allHalt) break;
      // 一起越过屏障, 进入下一阶段
      for (lane = 0; lane < L; lane++) if (!halted[lane]) pcs[lane] = pcs[lane] + 1;
    }

    return {
      index: g, lanes: L,
      shared: shared, output: output, // 最后一次成功提交后的内存
      phases: phases,
      failedPhase: failedPhase,
      error: error,
      completed: !error
    };
  }

  // opts.maxInstructions 可覆盖上限(测试用)
  function run(spec, opts) {
    var cfg;
    try {
      cfg = parseSpec(spec);
    } catch (e) {
      return {
        ok: false, error: e, config: null, groups: [],
        instructionsExecuted: 0, groupsCompleted: 0, elapsedMs: 0
      };
    }
    var maxInstr = (opts && opts.maxInstructions) || MAX_INSTRUCTIONS;
    var counter = { n: 0, max: maxInstr };
    var groups = [];
    var error = null;
    var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : Date.now;
    var t0 = now();
    for (var g = 0; g < cfg.groups; g++) {
      var gr = runGroup(cfg, g, counter);
      groups.push(gr);
      if (gr.error) { error = gr.error; break; }
    }
    var t1 = now();
    var completed = 0;
    for (var i = 0; i < groups.length; i++) if (groups[i].completed) completed++;
    return {
      ok: !error,
      error: error,
      config: {
        groups: cfg.groups, lanes: cfg.lanes,
        sharedWords: cfg.sharedWords, outputWords: cfg.outputWords,
        programLength: cfg.program.length,
        programTexts: cfg.programTexts,
        maxInstructions: maxInstr
      },
      groups: groups,
      instructionsExecuted: counter.n,
      groupsCompleted: completed,
      elapsedMs: t1 - t0
    };
  }

  // 重建某组在某已提交阶段之后的内存 (phaseIndex = -1 表示初始全零)
  function memoryAt(cfgLike, groupResult, phaseIndex) {
    var shared = new Uint32Array(cfgLike.sharedWords);
    var output = new Uint32Array(cfgLike.outputWords);
    var mem = [shared, output];
    var n = Math.min(phaseIndex + 1, groupResult.phases.length);
    for (var i = 0; i < n; i++) {
      var c = groupResult.phases[i].commits;
      for (var r = 0; r < 2; r++) {
        var addr = c[r].addr, val = c[r].value;
        for (var j = 0; j < addr.length; j++) mem[r][addr[j]] = val[j];
      }
    }
    return { shared: shared, output: output };
  }

  return {
    run: run,
    parseSpec: parseSpec,
    memoryAt: memoryAt,
    ReelError: ReelError,
    LIMITS: {
      MAX_GROUPS: MAX_GROUPS,
      MAX_LANES: MAX_LANES,
      MAX_INSTRUCTIONS: MAX_INSTRUCTIONS,
      NUM_REGS: NUM_REGS
    },
    ST: { BARRIER: ST_BARRIER, HALT: ST_HALT, ERROR: ST_ERROR, NOTRUN: ST_NOTRUN },
    REGION_NAMES: REGION_NAMES
  };
});
