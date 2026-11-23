'use strict';
/* 模拟器语义测试: node test/run-tests.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Sim = require('../simulator.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
function pocs(result) { return result.pics.map(p => p.poc); }
function outPocs(result) {
  const out = [];
  result.steps.forEach(s => s.ev.forEach(e => { if (e.t === 'out') out.push(result.pics[e.id].poc); }));
  return out;
}
function drops(result) {
  const d = [];
  result.steps.forEach(s => s.ev.forEach(e => { if (e.t === 'drop') d.push({ poc: result.pics[e.id].poc, reason: e.reason }); }));
  return d;
}

// ---- 样例文件 ----
t('样例: 出图序 0,1,2,3, 无丢弃, 无错误', () => {
  const trace = JSON.parse(fs.readFileSync(path.join(__dirname, '../samples/picture-buffer.json'), 'utf8'));
  const r = Sim.simulate(trace);
  assert.strictEqual(r.headerError, null);
  assert.deepStrictEqual(pocs(r), [0, 2, 1, 3]);
  assert.deepStrictEqual(outPocs(r), [0, 1, 2, 3]);
  assert.deepStrictEqual(drops(r), []);
  assert.strictEqual(r.firstError, null);
  const rep = Sim.buildReport(r);
  assert.deepStrictEqual(rep.finalRefs.short.map(x => x.poc), [2]);
  assert.deepStrictEqual(rep.finalRefs.long.map(x => [x.slot, x.poc]), [[1, 0]]);
});

// ---- 回绕 ----
t('回绕: 以最近 keep 为基准加减 M', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 2,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },  // poc 0, 基准(0,0)
      { lsb: 6, keep: true, refs: [], ops: [] },   // poc 6, 基准(0,6)
      { lsb: 14, keep: true, refs: [], ops: [] },  // 14-6=8 不越界 -> poc 14, 基准(0,14)
      { lsb: 1, keep: true, refs: [], ops: [] },   // 14-1>=8 -> h+16 -> poc 17, 基准(16,1)
      { lsb: 15, keep: false, refs: [], ops: [] }, // 15-1>8 -> h-16 -> poc 15
      { lsb: 0, keep: false, refs: [], ops: [] },  // 基准(16,1): 不越界 -> poc 16
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.deepStrictEqual(pocs(r), [0, 6, 14, 17, 15, 16]);
});

// ---- 周期内 POC 重复 ----
t('重复POC: 整行不生效并停止, 保留行前状态', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 2,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: true, refs: [], ops: [] },
      { lsb: 0, keep: false, refs: [], ops: [] }, // 基准(0,1): 1-0<8, poc=0 重复
      { lsb: 2, keep: false, refs: [], ops: [] },
    ]
  });
  assert.deepStrictEqual(r.firstError, { line: 2, reason: '周期内POC重复: 0' });
  assert.strictEqual(r.pics.length, 2); // 错误行未生效
  const last = r.steps[r.steps.length - 1];
  assert.strictEqual(last.line, 2);
  assert.deepStrictEqual(last.s, [0, 0, 1, 1]); // 短参考仍是行首状态
});

// ---- 坏标记操作 ----
t('坏操作: 删除空引用停止; move缺失引用停止', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 2,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: false, refs: [], ops: [['erase', 5]] },
    ]
  });
  assert.strictEqual(r.firstError.line, 1);
  assert.match(r.firstError.reason, /删除空引用/);
  const r2 = Sim.simulate({
    M: 16, capacity: 6, reorder: 2,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: false, refs: [], ops: [['move', 9, 0]] },
    ]
  });
  assert.match(r2.firstError.reason, /移动缺失引用/);
});

// ---- move 覆盖长期槽, 已排队图保留 ----
t('move: 短参考迁入长期槽覆盖旧参考, 待显成员不受影响', () => {
  const r = Sim.simulate({
    M: 16, capacity: 8, reorder: 4,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: true, refs: [], ops: [['move', 0, 3]] },        // 0 -> slot3
      { lsb: 2, keep: true, refs: [{ slot: 3 }], ops: [] },          // 引用 slot3(图0)
      { lsb: 3, keep: true, refs: [], ops: [['move', 2, 3]] },       // 2 覆盖 slot3
      { lsb: 4, keep: false, refs: [{ slot: 3 }, { poc: 0 }], ops: [] }, // slot3=图2; poc0已迁出短参考->缺失
    ]
  });
  assert.strictEqual(r.firstError, null);
  const last = r.steps[r.steps.length - 2]; // EOF 前
  // slot3 是图2(poc=2)
  const slot3 = last.l.find((v, i) => i % 2 === 0 && v === 3);
  assert.strictEqual(r.pics[last.l[last.l.indexOf(3) + 1]].poc, 2);
  // 行4: slot3 命中图2, poc0 缺失 -> 污染
  const pic4 = r.pics[4];
  assert.strictEqual(pic4.polluted, true);
  assert.deepStrictEqual(pic4.reasons.map(x => x.k), ['missing']);
  // 待显队列仍含全部 5 图(迁移/删除不影响待显成员)
  assert.strictEqual(last.q.length + last.s.length / 2 >= 5 || last.q.length === 5, true);
});

// ---- 迟到丢弃 ----
t('迟到: 小于本周期最后出图POC的图标丢弃', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 0,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' }, // 出 0
      { lsb: 3, keep: false, refs: [], ops: [] },                // 出 3
      { lsb: 1, keep: false, refs: [], ops: [] },                // 1 < 3 -> 迟到丢弃
      { lsb: 2, keep: false, refs: [], ops: [] },                // 2 < 3 -> 迟到丢弃
      { lsb: 4, keep: false, refs: [], ops: [] },                // 出 4
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.deepStrictEqual(outPocs(r), [0, 3, 4]);
  assert.deepStrictEqual(drops(r), [{ poc: 1, reason: 'late' }, { poc: 2, reason: 'late' }]);
});

// ---- reset=drop ----
t('reset=drop: 丢弃旧队列并记录, 新周期基准清零', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 5,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 2, keep: true, refs: [], ops: [] },
      { lsb: 1, keep: false, refs: [], ops: [] },
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drop' }, // 丢弃 0,1,2; 新周期 poc 0
      { lsb: 1, keep: false, refs: [], ops: [] },               // 新周期 poc 1(不与前周期冲突)
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.deepStrictEqual(drops(r), [
    { poc: 0, reason: 'reset-drop' }, { poc: 1, reason: 'reset-drop' }, { poc: 2, reason: 'reset-drop' },
  ]);
  assert.deepStrictEqual(outPocs(r), [0, 1]); // 文件尾排空新周期
});

// ---- reset=drain 中途排空 ----
t('reset=drain: 排空旧周期后再开始新周期', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 5,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 2, keep: false, refs: [], ops: [] },
      { lsb: 1, keep: false, refs: [], ops: [] },
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' }, // 排空 0,1,2
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.deepStrictEqual(outPocs(r), [0, 1, 2, 0]); // 最后一个是新周期图0在文件尾排空
});

// ---- 容量超限且待显已空 ----
t('容量错误: 超限且待显已空时停止并回滚整行', () => {
  const r = Sim.simulate({
    M: 16, capacity: 1, reorder: 0,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' }, // 入队->出0, 短参考{0}
      { lsb: 1, keep: true, refs: [], ops: [] }, // 短参考{0,1} 并集=2>1, 出1后仍超限且空 -> 停止
      { lsb: 2, keep: false, refs: [], ops: [] },
    ]
  });
  assert.strictEqual(r.firstError.line, 1);
  assert.match(r.firstError.reason, /容量超限且待显已空/);
  assert.strictEqual(r.pics.length, 1); // 行1回滚
  const last = r.steps[r.steps.length - 1];
  assert.deepStrictEqual(last.s, [0, 0]); // 保留行首状态
  assert.strictEqual(last.ev.length, 0);  // 不能额外排空
});

// ---- 污染传播与原因链 ----
t('污染: bad/缺失/引用污染传播, 原因按refs顺序且可追溯', () => {
  const r = Sim.simulate({
    M: 16, capacity: 8, reorder: 4,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: true, bad: true, refs: [], ops: [] },                 // 自身bad
      { lsb: 2, keep: true, refs: [{ poc: 1 }], ops: [] },                  // 引用污染图1
      { lsb: 3, keep: false, refs: [{ poc: 9 }, { poc: 2 }], ops: [] },     // 缺失 + 链式污染
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.strictEqual(r.pics[1].polluted, true);
  assert.strictEqual(r.pics[2].polluted, true);
  assert.deepStrictEqual(r.pics[2].reasons.map(x => x.k), ['ref']);
  assert.deepStrictEqual(r.pics[3].reasons.map(x => x.k), ['missing', 'ref']); // 按refs顺序
  const rep = Sim.buildReport(r);
  const d3 = rep.decoded[3];
  assert.strictEqual(d3.reasons[0].type, '缺失引用');
  assert.strictEqual(d3.reasons[1].root.cause, 'bad标记'); // 追至图1的bad
  assert.strictEqual(d3.reasons[1].root.line, 1);
});

// ---- 引用解析基于步首(ops 不影响本行解析) ----
t('引用解析在ops之前: 本行erase后refs仍按步首解析', () => {
  const r = Sim.simulate({
    M: 16, capacity: 6, reorder: 3,
    records: [
      { lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' },
      { lsb: 1, keep: false, refs: [{ poc: 0 }], ops: [['erase', 0]] }, // 解析命中, 随后删除
      { lsb: 2, keep: false, refs: [{ poc: 0 }], ops: [] },             // 已删除 -> 缺失污染
    ]
  });
  assert.strictEqual(r.firstError, null);
  assert.strictEqual(r.pics[1].polluted, false);
  assert.strictEqual(r.pics[2].polluted, true);
});

// ---- 首行必须是reset ----
t('首行非reset为错误', () => {
  const r = Sim.simulate({ M: 16, capacity: 6, reorder: 2, records: [{ lsb: 0, keep: false, refs: [], ops: [] }] });
  assert.match(r.firstError.reason, /首行必须是reset行/);
});

// ---- 头校验 ----
t('头部校验: M/capacity/reorder', () => {
  assert.match(Sim.simulate({ M: 7, capacity: 6, reorder: 2, records: [] }).headerError, /M/);
  assert.match(Sim.simulate({ M: 16, capacity: 33, reorder: 2, records: [] }).headerError, /capacity/);
  assert.match(Sim.simulate({ M: 16, capacity: 2, reorder: 3, records: [] }).headerError, /reorder/);
});

// ---- 性能: 10万条 < 5秒 ----
t('性能: 10万条记录模拟+报告 < 5秒', () => {
  // 生成合法长跟踪: 每行 keep, 滑动 erase 窗口限制参考数, 周期性 reset,
  // 部分行 bad 制造污染链, 部分行引用前图
  const records = [];
  let j = 0; // 周期内行号(= 周期内 POC)
  for (let i = 0; i < 100000; i++) {
    if (i % 20000 === 0) {
      records.push({ lsb: 0, keep: true, refs: [], ops: [], reset: 'drain' });
      j = 0;
      continue;
    }
    j++;
    const rec = { lsb: j % 16, keep: true, refs: [], ops: [] };
    if (j >= 20) rec.ops.push(['erase', j - 20]); // 短参考窗口 ~20
    if (j % 3 === 0) rec.refs.push({ poc: j - 1 });
    if (j % 997 === 0) rec.bad = true;
    records.push(rec);
  }
  const t0 = Date.now();
  const r = Sim.simulate({ M: 16, capacity: 32, reorder: 8, records });
  const rep = Sim.buildReport(r);
  const ms = Date.now() - t0;
  console.log('  模拟+报告耗时 ' + ms + 'ms, 解码 ' + rep.counts.decoded +
    ' 出图 ' + rep.counts.outputs + ' 污染 ' + rep.counts.polluted);
  assert.strictEqual(r.firstError, null);
  assert.strictEqual(r.steps.length, 100001); // 10万行 + EOF
  assert.ok(ms < 5000, '耗时 ' + ms + 'ms 超过 5 秒');
});

console.log(passed + ' 项测试通过');
