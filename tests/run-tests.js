'use strict';
/* live-tile-strokes 引擎测试：node tests/run-tests.js */
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

let passed = 0,
  failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}
function section(name) {
  console.log('\n[' + name + ']');
}

// 确定性随机数
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gridOf(doc) {
  return Array.from(doc.grid);
}

// ---------- 1. 样例语义 ----------
section('样例语义（samples/live-tile-strokes.json）');
{
  const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'live-tile-strokes.json'), 'utf8');
  const doc = E.createDoc(256, 256); // 空文档应采纳文件尺寸 8x6
  const r = E.importJSON(doc, text);
  ok(r.ok, '样例导入成功', r.error);
  ok(doc.width === 8 && doc.height === 6, '空文档采纳文件尺寸');
  ok(doc.grid[2 * 8 + 1] === 3, '(1,2)=3 只有 A#1');
  ok(doc.grid[2 * 8 + 2] === 5, '(2,2)=5 同钟取作者编号较大者 B');
  ok(doc.grid[2 * 8 + 3] === 4, '(3,2)=4 A#2 时钟更高');
  ok(doc.clock.get('A\n2') === 2, 'A#2 时钟 = max(A#1,B#1)+1 = 2');
  const info = E.cellInfo(doc, 2, 2);
  ok(info.winner && info.winner.by === 'B' && info.candidates.length === 2, '(2,2) 赢者为 B，候选 2 笔');
}

// ---------- 2. 撤销/重做与显露 ----------
section('撤销/重做与显露');
{
  const doc = E.createDoc(8, 6);
  E.importBatch(doc, [
    { by: 'A', n: 1, deps: [], paint: [[1, 2, 3], [2, 2, 3]] },
    { by: 'B', n: 1, deps: [], paint: [[2, 2, 5], [3, 2, 5]] },
    { by: 'A', n: 2, deps: [['B', 1]], paint: [[3, 2, 4]] },
  ]);
  const undo = E.makeUndoOp(doc, 'A'); // A 最近生效笔画是 A#2
  ok(undo && undo.set[0] === 2 && undo.set[1] === false, '撤销目标为 A#2');
  E.importBatch(doc, [undo]);
  ok(doc.grid[2 * 8 + 3] === 5, '撤销 A#2 后 (3,2) 显露 B#1 的 5');
  const undo2 = E.makeUndoOp(doc, 'A'); // 再撤销 A#1
  E.importBatch(doc, [undo2]);
  ok(doc.grid[2 * 8 + 1] === 0 && doc.grid[2 * 8 + 2] === 5, '撤销 A#1 后 (1,2) 清空，(2,2) 仍是 B');
  const redo = E.makeRedoOp(doc, 'A'); // 重做恢复 A#1（失效中序号最大）
  ok(redo && redo.set[0] === 1 && redo.set[1] === true, '重做目标为 A#1');
  E.importBatch(doc, [redo]);
  ok(doc.grid[2 * 8 + 1] === 3, '重做后 (1,2) 恢复 3');
  // 撤销/重做都是普通操作，可被对方同步合并
  const doc2 = E.createDoc(8, 6);
  const exp = E.exportJSON(doc);
  const r2 = E.importJSON(doc2, exp);
  ok(r2.ok && E.exportJSON(doc2) === exp, '含撤销操作的导出可再导入且逐字节一致');
}

// ---------- 3. 去重 / 冲突 / 成环 / set 指向非笔画 ----------
section('去重 / 冲突 / 成环 / set 校验');
{
  const doc = E.createDoc(8, 8);
  const op = { by: 'A', n: 1, deps: [], paint: [[0, 0, 1]] };
  const r1 = E.importBatch(doc, [op, op]); // 批内重复
  ok(r1.ok && r1.added === 1 && r1.duplicated === 1, '批内重复只记一次');
  const r2 = E.importBatch(doc, [op]); // 跨批重复
  ok(r2.ok && r2.added === 0 && r2.duplicated === 1, '跨批重复只记一次');

  const before = E.exportJSON(doc);
  const r3 = E.importBatch(doc, [{ by: 'A', n: 1, deps: [], paint: [[0, 0, 9]] }]);
  ok(!r3.ok && /冲突/.test(r3.error), '操作号冲突拒绝整批');
  ok(E.exportJSON(doc) === before, '冲突拒绝后保留原状态');

  const r4 = E.importBatch(doc, [
    { by: 'C', n: 1, deps: [['D', 1]], paint: [[1, 1, 1]] },
    { by: 'D', n: 1, deps: [['C', 1]], paint: [[2, 2, 1]] },
  ]);
  ok(!r4.ok && /成环/.test(r4.error), '双向依赖成环拒绝整批');
  ok(E.exportJSON(doc) === before, '成环拒绝后保留原状态');

  const r5 = E.importBatch(doc, [{ by: 'E', n: 1, deps: [['E', 1]], paint: [[3, 3, 1]] }]);
  ok(!r5.ok && /成环/.test(r5.error), '自依赖成环拒绝');

  // set 指向非笔画：F#2 是 set，F#3 再指向 F#2
  E.importBatch(doc, [
    { by: 'F', n: 1, deps: [], paint: [[4, 4, 1]] },
    { by: 'F', n: 2, deps: [], set: [1, false] },
  ]);
  const r6 = E.importBatch(doc, [{ by: 'F', n: 3, deps: [], set: [2, true] }]);
  ok(!r6.ok && /非笔画/.test(r6.error), 'set 指向非笔画报错拒绝');
  // set 目标序号不小于自身 n -> 结构非法
  const r7 = E.importBatch(doc, [{ by: 'F', n: 3, deps: [], set: [3, true] }]);
  ok(!r7.ok, 'set 目标序号不小于自身 n 拒绝');
  // 一笔重复写同一格
  const r8 = E.importBatch(doc, [{ by: 'G', n: 1, deps: [], paint: [[0, 0, 1], [0, 0, 2]] }]);
  ok(!r8.ok && /重复写同一格/.test(r8.error), '一笔重复写同一格拒绝');
  // deps 超过 16 个
  const r9 = E.importBatch(doc, [
    { by: 'G', n: 1, deps: Array.from({ length: 17 }, (_, i) => ['Z', i + 1]), paint: [[0, 0, 1]] },
  ]);
  ok(!r9.ok, 'deps 超过 16 个拒绝');
}

// ---------- 4. 挂起与唤醒、时钟 ----------
section('挂起与唤醒、时钟');
{
  const doc = E.createDoc(8, 8);
  let r = E.importBatch(doc, [{ by: 'B', n: 2, deps: [['C', 1]], paint: [[0, 0, 7]] }]);
  ok(r.ok && doc.pending.size === 1, '缺依赖（隐式 B#1 + 显式 C#1）先挂起');
  let pi = E.pendingInfo(doc);
  ok(
    pi.length === 1 && pi[0].missing.length === 2 && pi[0].missing.every((m) => m.status === '未到达'),
    '挂起原因列出全部缺失依赖'
  );
  r = E.importBatch(doc, [{ by: 'B', n: 1, deps: [], paint: [[1, 1, 2]] }]);
  ok(r.ok && doc.pending.size === 1, '隐式依赖到齐但仍缺 C#1，继续挂起');
  pi = E.pendingInfo(doc);
  ok(pi[0].missing.length === 1 && pi[0].missing[0].by === 'C', '挂起原因随依赖到齐而收窄');
  r = E.importBatch(doc, [{ by: 'C', n: 1, deps: [], paint: [[2, 2, 3]] }]);
  ok(r.ok && doc.pending.size === 0 && r.applied === 2, 'C#1 到达后 B#2 自动生效');
  ok(doc.clock.get('B\n2') === 2, 'B#2 时钟 = max(B#1=1, C#1=1)+1 = 2');
  ok(doc.grid[0] === 7, '挂起笔画生效后参与赢者计算');

  // 时钟沿依赖链累加
  const doc2 = E.createDoc(8, 8);
  E.importBatch(doc2, [
    { by: 'A', n: 1, deps: [], paint: [[0, 0, 1]] },
    { by: 'A', n: 2, deps: [], paint: [[1, 0, 1]] },
    { by: 'A', n: 3, deps: [], paint: [[2, 0, 1]] },
    { by: 'B', n: 1, deps: [['A', 3]], paint: [[3, 0, 1]] },
  ]);
  ok(doc2.clock.get('B\n1') === 4, 'B#1 时钟 = A#3(3)+1 = 4');
}

// ---------- 5. 分批/乱序不变性 ----------
section('同一操作集无论怎么分批送达，导出逐字节一致');
// 生成合法操作集：显式依赖只指向更早生成的操作（拓扑安全），set 指向同作者更早笔画
function genOps(seed, numOps, authors, width, height, maxCells) {
  const rnd = mulberry32(seed);
  const ops = [];
  const perAuthor = new Map(authors.map((a) => [a, { n: 0, paints: [] }]));
  let writes = 0;
  for (let i = 0; i < numOps; i++) {
    const by = authors[Math.floor(rnd() * authors.length)];
    const st = perAuthor.get(by);
    const n = ++st.n;
    const deps = [];
    if (rnd() < 0.3 && ops.length > 0) {
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const t = ops[Math.floor(rnd() * ops.length)];
        const pair = [t.by, t.n];
        if (!deps.some((d) => d[0] === pair[0] && d[1] === pair[1])) deps.push(pair);
      }
    }
    if (st.paints.length > 0 && rnd() < 0.06) {
      const t = st.paints[Math.floor(rnd() * st.paints.length)];
      ops.push({ by, n, deps, set: [t, rnd() < 0.5] });
    } else {
      const cells = [];
      const used = new Set();
      const cnt = 1 + Math.floor(rnd() * (maxCells || 7));
      for (let j = 0; j < cnt; j++) {
        const x = Math.floor(rnd() * width);
        const y = Math.floor(rnd() * height);
        const key = y * width + x;
        if (used.has(key)) continue;
        used.add(key);
        cells.push([x, y, 1 + Math.floor(rnd() * 15)]);
      }
      writes += cells.length;
      st.paints.push(n);
      ops.push({ by, n, deps, paint: cells });
    }
  }
  return { ops, writes };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function importInBatches(doc, ops, rnd, maxChunk) {
  const shuffled = shuffle(ops, rnd);
  let i = 0;
  while (i < shuffled.length) {
    const size = 1 + Math.floor(rnd() * maxChunk);
    const r = E.importBatch(doc, shuffled.slice(i, i + size));
    if (!r.ok) return r;
    i += size;
  }
  return { ok: true };
}

{
  const authors = ['A', 'B', 'C', 'D'];
  for (const seed of [1, 2, 3]) {
    const { ops } = genOps(seed * 1000 + 7, 400, authors, 32, 32);
    const whole = E.createDoc(32, 32);
    const r0 = E.importBatch(whole, ops);
    ok(r0.ok, '整批导入成功 (seed=' + seed + ')', r0.error);
    const expWhole = E.exportJSON(whole);

    const rnd = mulberry32(seed * 77 + 1);
    const d1 = E.createDoc(32, 32);
    const r1 = importInBatches(d1, ops, rnd, 9); // 随机乱序小批
    ok(r1.ok, '随机分批导入成功 (seed=' + seed + ')', r1.error);
    ok(E.exportJSON(d1) === expWhole, '随机分批导出逐字节一致 (seed=' + seed + ')');
    ok(JSON.stringify(gridOf(d1)) === JSON.stringify(gridOf(whole)), '随机分批格子一致 (seed=' + seed + ')');

    const d2 = E.createDoc(32, 32);
    for (const op of shuffle(ops, rnd)) {
      const r = E.importBatch(d2, [op]); // 逐条乱序
      if (!r.ok) {
        ok(false, '逐条导入成功 (seed=' + seed + ')', r.error);
        break;
      }
    }
    ok(E.exportJSON(d2) === expWhole, '逐条乱序导出逐字节一致 (seed=' + seed + ')');
  }
}

// ---------- 6. 导出 -> 导入 -> 继续合并 ----------
section('导出后可再导入并继续合并');
{
  const { ops } = genOps(42, 300, ['A', 'B', 'C'], 32, 32);
  const d1 = E.createDoc(32, 32);
  E.importBatch(d1, ops.slice(0, 200));
  const exp1 = E.exportJSON(d1);

  const d2 = E.createDoc(32, 32);
  const r = E.importJSON(d2, exp1);
  ok(r.ok && E.exportJSON(d2) === exp1, '导出再导入逐字节一致');

  // 双方继续合入同一批新操作（乱序送达）
  const rest = ops.slice(200);
  const rnd = mulberry32(9);
  E.importBatch(d1, rest);
  importInBatches(d2, rest, rnd, 5);
  ok(E.exportJSON(d1) === E.exportJSON(d2), '继续合并后导出仍逐字节一致');
  // 重复导入整份导出 = 全部去重
  const r2 = E.importJSON(d1, E.exportJSON(d2));
  ok(r2.ok && r2.added === 0 && r2.duplicated === d2.ops.size, '重复导入全部去重');
}

// ---------- 7. 满额性能 ----------
section('满额性能：256×256 / 8 作者 / 3 万操作 / 约 20 万写格');
{
  const AUTHORS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const { ops, writes } = genOps(2026, 30000, AUTHORS, 256, 256, 13);
  console.log('  生成操作 ' + ops.length + ' 条，写格 ' + writes + ' 次');
  ok(ops.length === 30000, '操作数达到 3 万');
  ok(writes >= 150000, '写格数达到约 20 万（实际 ' + writes + '）');

  const doc = E.createDoc(256, 256);
  const rnd = mulberry32(5);
  const t0 = process.hrtime.bigint();
  const r = importInBatches(doc, ops, rnd, 400); // 乱序、约 120 批
  const t1 = process.hrtime.bigint();
  ok(r.ok, '满额导入全部批次成功', r.error);
  const exp = E.exportJSON(doc);
  const t2 = process.hrtime.bigint();
  const importMs = Number(t1 - t0) / 1e6;
  const exportMs = Number(t2 - t1) / 1e6;
  console.log('  导入 ' + importMs.toFixed(0) + 'ms，导出 ' + exportMs.toFixed(0) + 'ms');
  ok(importMs + exportMs < 8000, '满额导入到可导出 < 8 秒（实际 ' + (importMs + exportMs).toFixed(0) + 'ms）');
  ok(doc.ops.size === 30000, '3 万条操作全部记录');
  ok(doc.pending.size === 0, '全部依赖到齐，无残留挂起');

  // 满额状态下再验证分批等价
  const doc2 = E.createDoc(256, 256);
  const r2 = E.importJSON(doc2, exp);
  ok(r2.ok && E.exportJSON(doc2) === exp, '满额导出再导入逐字节一致');
}

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + ': ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
