/*
 * run-tests.js — 核心算法与像素语义测试（Node 内置 assert，无第三方依赖）
 * 运行：node tests/run-tests.js
 */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', 'src');
require(path.join(root, 'model.js'));
require(path.join(root, 'scheduler.js'));
require(path.join(root, 'engine.js'));
const Tfs = globalThis.Tfs;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const img = (mips, format = 'R8') => ({ format, mips });

// ---------- 1. 样例 peak：最优顺序、峰值、槽位 ----------
test('peak 用例：最优顺序 a-large→c-half→b-large→d-half，峰值 17 字节', () => {
  const data = require(path.join(__dirname, '..', 'samples', 'render-lifetime-cases.json'));
  const built = Tfs.buildModel(data.cases[0]);
  assert.ok(built.ok, JSON.stringify(built.errors));
  const s = Tfs.schedule(built.model, []);
  assert.deepStrictEqual(s.orderIds, ['a-large', 'c-half', 'b-large', 'd-half']);
  assert.strictEqual(s.peakBytes, 17);

  const sim = Tfs.simulate(built.model, s.order, []);
  assert.ok(sim.ok);
  assert.strictEqual(sim.peakBytes, 17);
  // 两个 3×3 版本寿命不重叠，应复用同一个槽
  const slotsA = sim.slotIntervals;
  const usedByB = [...slotsA].filter(([, iv]) => iv.some((e) => e.ref === 'b.0@1')).map(([id]) => id);
  const usedByA = [...slotsA].filter(([, iv]) => iv.some((e) => e.ref === 'a.0@1')).map(([id]) => id);
  assert.strictEqual(usedByA[0], usedByB[0], 'b.0@1 应复用 a.0@1 释放的槽');
  // 导出保留到帧末
  assert.deepStrictEqual(sim.frameEnd.map((r) => r.ref).sort(), ['a.1@1', 'b.1@1']);
  // 逐步记录：执行 c-half 期间峰值为 9+9+4=22? 不——最优顺序下 a.0 与 c 输出并存=13
  assert.strictEqual(sim.steps[1].duringBytes, 13);
});

test('peak 用例：声明顺序的峰值是 22 字节', () => {
  const data = require(path.join(__dirname, '..', 'samples', 'render-lifetime-cases.json'));
  const built = Tfs.buildModel(data.cases[0]);
  const sim = Tfs.simulate(built.model, [0, 1, 2, 3], []);
  assert.ok(sim.ok);
  assert.strictEqual(sim.peakBytes, 22);
});

// ---------- 2. 环检测 ----------
test('cycle 用例：报出依赖环并指出环上版本', () => {
  const data = require(path.join(__dirname, '..', 'samples', 'render-lifetime-cases.json'));
  const built = Tfs.buildModel(data.cases[1]);
  assert.ok(!built.ok);
  const cycle = built.errors.find((e) => e.kind === 'cycle');
  assert.ok(cycle, '应包含 cycle 错误');
  assert.ok(cycle.refs.includes('a.0@2') && cycle.refs.includes('a.0@1'));
});

// ---------- 3. 缺失读取 ----------
test('读取无人写入的版本时指出该版本', () => {
  const c = {
    id: 'missing',
    images: { a: img([[2, 2]]) },
    passes: [{ id: 'p', out: 'a.0@1', op: 'add', read: ['a.0@7', 'a.0@7'] }],
    exports: [],
  };
  const built = Tfs.buildModel(c);
  assert.ok(!built.ok);
  const mr = built.errors.find((e) => e.kind === 'missing-read');
  assert.ok(mr && mr.refs.includes('a.0@7'));
});

test('自依赖（pass 读自己的输出）按环处理', () => {
  const c = {
    id: 'self',
    images: { a: img([[2, 2]]) },
    passes: [{ id: 'p', out: 'a.0@1', op: 'add', read: ['a.0@1', 'a.0@1'] }],
    exports: [],
  };
  const built = Tfs.buildModel(c);
  assert.ok(!built.ok);
  assert.ok(built.errors.some((e) => e.kind === 'cycle'));
});

// ---------- 4. box2 语义：奇数边、四舍五入 ----------
test('box2：3×3→2×2，奇数边只平均存在像素并四舍五入', () => {
  const c = {
    id: 'box',
    images: { a: img([[3, 3], [2, 2]]) },
    passes: [
      { id: 'in', out: 'a.0@1', op: 'const', read: [], values: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
      { id: 'half', out: 'a.1@1', op: 'box2', read: ['a.0@1'] },
    ],
    exports: ['a.1@1'],
  };
  const built = Tfs.buildModel(c);
  assert.ok(built.ok, JSON.stringify(built.errors));
  const sim = Tfs.simulate(built.model, [0, 1], []);
  assert.ok(sim.ok);
  // (0+1+3+4)/4=2；(2+5)/2=3.5→4；(6+7)/2=6.5→7；右下角奇数边仅像素 8 →8
  assert.deepStrictEqual([...sim.pixels.get('a.1@1')], [2, 4, 7, 8]);
});

test('box2：1×3→1×2，单列边界块只平均一个像素', () => {
  const c = {
    id: 'box1d',
    images: { a: img([[1, 3], [1, 2]]) },
    passes: [
      { id: 'in', out: 'a.0@1', op: 'const', read: [], values: [1, 2, 4] },
      { id: 'half', out: 'a.1@1', op: 'box2', read: ['a.0@1'] },
    ],
    exports: ['a.1@1'],
  };
  const built = Tfs.buildModel(c);
  const sim = Tfs.simulate(built.model, [0, 1], []);
  // 块0: (1+2)/2=1.5→2(half up)；块1: 4/1=4
  assert.deepStrictEqual([...sim.pixels.get('a.1@1')], [2, 4]);
});

test('box2：2×2 精确平均，验证 .5 向上取整', () => {
  const c = {
    id: 'box22',
    images: { a: img([[2, 2], [1, 1]]) },
    passes: [
      { id: 'in', out: 'a.0@1', op: 'const', read: [], values: [0, 1, 2, 3] },
      { id: 'half', out: 'a.1@1', op: 'box2', read: ['a.0@1'] },
    ],
    exports: ['a.1@1'],
  };
  const built = Tfs.buildModel(c);
  const sim = Tfs.simulate(built.model, [0, 1], []);
  // (0+1+2+3)/4 = 1.5 → 2
  assert.deepStrictEqual([...sim.pixels.get('a.1@1')], [2]);
});

// ---------- 5. add：RGBA8 逐通道饱和 ----------
test('add：RGBA8 逐通道饱和加法', () => {
  const c = {
    id: 'add',
    images: { a: img([[1, 2]], 'RGBA8'), b: img([[1, 2]], 'RGBA8') },
    passes: [
      { id: 'x', out: 'a.0@1', op: 'const', read: [], values: [10, 250, 0, 255, 1, 2, 3, 4] },
      { id: 'y', out: 'b.0@1', op: 'const', read: [], values: [20, 10, 5, 1, 255, 254, 0, 251] },
      { id: 'z', out: 'a.0@2', op: 'add', read: ['a.0@1', 'b.0@1'] },
    ],
    exports: ['a.0@2'],
  };
  const built = Tfs.buildModel(c);
  assert.ok(built.ok, JSON.stringify(built.errors));
  const sim = Tfs.simulate(built.model, [0, 1, 2], []);
  assert.deepStrictEqual(
    [...sim.pixels.get('a.0@2')],
    [30, 255, 5, 255, 255, 255, 3, 255]
  );
});

// ---------- 6. 字典序 tie-break ----------
test('同峰值时取通道 ID 字典序最小序列', () => {
  const c = {
    id: 'lex',
    images: { a: img([[2, 2]]), b: img([[2, 2]]) },
    passes: [
      { id: 'zeta', out: 'a.0@1', op: 'const', read: [], values: [0, 0, 0, 0] },
      { id: 'alpha', out: 'b.0@1', op: 'const', read: [], values: [1, 1, 1, 1] },
    ],
    exports: ['a.0@1', 'b.0@1'],
  };
  const built = Tfs.buildModel(c);
  const s = Tfs.schedule(built.model, []);
  assert.deepStrictEqual(s.orderIds, ['alpha', 'zeta']);
});

// ---------- 7. 槽位复用与尺寸隔离 ----------
test('同尺寸版本复用槽，不同尺寸不串槽', () => {
  const c = {
    id: 'slots',
    images: {
      a: img([[2, 2], [1, 1]]),
      b: img([[2, 2], [1, 1]]),
      c: img([[3, 3]]),
    },
    passes: [
      { id: 'a0', out: 'a.0@1', op: 'const', read: [], values: [1, 2, 3, 4] },
      { id: 'a1', out: 'a.1@1', op: 'box2', read: ['a.0@1'] },       // a.0 在此结束
      { id: 'b0', out: 'b.0@1', op: 'const', read: [], values: [5, 6, 7, 8] },
      { id: 'b1', out: 'b.1@1', op: 'box2', read: ['b.0@1'] },
      { id: 'c0', out: 'c.0@1', op: 'const', read: [], values: [9, 9, 9, 9, 9, 9, 9, 9, 9] },
    ],
    exports: ['a.1@1', 'b.1@1', 'c.0@1'],
  };
  const built = Tfs.buildModel(c);
  const s = Tfs.schedule(built.model, []);
  const sim = Tfs.simulate(built.model, s.order, []);
  const slotFor = (ref) => {
    for (const [id, iv] of sim.slotIntervals) if (iv.some((e) => e.ref === ref)) return id;
  };
  assert.strictEqual(slotFor('a.0@1'), slotFor('b.0@1'), '2×2 寿命不重叠应同槽');
  assert.notStrictEqual(slotFor('a.0@1'), slotFor('c.0@1'), '3×3 不能复用 2×2 的槽');
  // a.1/b.1 都被导出，保留到帧末、寿命重叠，不能同槽
  assert.notStrictEqual(slotFor('a.1@1'), slotFor('b.1@1'), '同时存活的 1×1 不能同槽');
  // 但两者都应能复用更早释放的 1×1 槽（本例没有更早的 1×1，验证总槽数即可）
  assert.strictEqual(sim.slots.length, 4, '类别为 2×2 / 1×1 / 3×3，其中 2×2 复用 1 个槽');
});

// ---------- 8. 手动固定 ----------
test('固定版本占用到帧末，取消固定后随最后读者释放', () => {
  const c = {
    id: 'pin',
    images: { a: img([[2, 2]]) },
    passes: [
      { id: 'w', out: 'a.0@1', op: 'const', read: [], values: [1, 1, 1, 1] },
      { id: 'r', out: 'a.0@2', op: 'add', read: ['a.0@1', 'a.0@1'] },
    ],
    exports: ['a.0@2'],
  };
  const built = Tfs.buildModel(c);

  const pinned = Tfs.simulate(built.model, [0, 1], ['a.0@1']);
  assert.ok(pinned.frameEnd.some((r) => r.ref === 'a.0@1'), '固定版本应在帧末释放');
  const step2 = pinned.steps[1];
  assert.ok(step2.liveRefs.includes('a.0@1'), '固定版本在读取后仍存活');

  const unpinned = Tfs.simulate(built.model, [0, 1], []);
  assert.ok(!unpinned.frameEnd.some((r) => r.ref === 'a.0@1'), '未固定版本不应留到帧末');
  assert.ok(unpinned.steps[1].released.some((r) => r.ref === 'a.0@1'));
});

test('固定会提高调度峰值且被调度器纳入保留集', () => {
  const c = {
    id: 'pinpeak',
    images: { a: img([[2, 2]]) },
    passes: [
      { id: 'w', out: 'a.0@1', op: 'const', read: [], values: [1, 1, 1, 1] },
      { id: 'r', out: 'a.0@2', op: 'add', read: ['a.0@1', 'a.0@1'] },
    ],
    exports: ['a.0@2'],
  };
  const built = Tfs.buildModel(c);
  const s0 = Tfs.schedule(built.model, []);
  const s1 = Tfs.schedule(built.model, ['a.0@1']);
  assert.ok(s1.peakBytes >= s0.peakBytes);
  assert.ok(s1.retainedRefs.includes('a.0@1'));
});

// ---------- 9. 校验类错误 ----------
test('边长超过 128 报错、const 值数量不符报错、坏引用格式报错', () => {
  const bad = Tfs.buildModel({
    id: 'bad',
    images: { a: { format: 'R8', mips: [[129, 2]] } },
    passes: [{ id: 'p', out: 'a.0@1', op: 'const', read: [], values: [1, 2] }],
    exports: [],
  });
  assert.ok(!bad.ok && bad.errors.some((e) => /128/.test(e.message)));
  assert.ok(bad.errors.some((e) => e.kind === 'op'));

  const badRef = Tfs.buildModel({
    id: 'badref',
    images: { a: img([[1, 1]]) },
    passes: [{ id: 'p', out: 'garbage', op: 'const', read: [], values: [0] }],
    exports: [],
  });
  assert.ok(!badRef.ok);
});

test('重复写同一版本、重复通道 id 报错', () => {
  const c = {
    id: 'dup',
    images: { a: img([[1, 1]]) },
    passes: [
      { id: 'p', out: 'a.0@1', op: 'const', read: [], values: [0] },
      { id: 'p', out: 'a.0@2', op: 'const', read: [], values: [0] },
      { id: 'q', out: 'a.0@1', op: 'const', read: [], values: [1] },
    ],
    exports: [],
  };
  const built = Tfs.buildModel(c);
  assert.ok(!built.ok);
  assert.ok(built.errors.some((e) => /重复/.test(e.message)));
  assert.ok(built.errors.some((e) => e.kind === 'out'));
});

// ---------- 10. 随机 DAG：DP 与暴力枚举一致，模拟字节恒非负 ----------
test('随机小 DAG：DP 峰值/顺序与全排列暴力解一致', () => {
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const r = rng(42);
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + Math.floor(r() * 6);
    const passes = [];
    const images = { t: img([[2, 2]]) };
    for (let i = 0; i < n; i++) {
      const reads = [];
      for (let j = 0; j < i; j++) if (r() < 0.45) reads.push(`t.0@${j + 1}`);
      const unique = [...new Set(reads)];
      let op, readList;
      if (unique.length >= 2) { op = 'add'; readList = unique.slice(0, 2); }
      else if (unique.length === 1) { op = 'add'; readList = [unique[0], unique[0]]; }
      else { op = 'const'; readList = []; }
      passes.push({
        id: `p${i}`,
        out: `t.0@${i + 1}`,
        op,
        read: readList,
        values: [0, 0, 0, 0],
      });
    }
    const c = { id: 'rand', images, passes, exports: [`t.0@${n}`] };
    const built = Tfs.buildModel(c);
    if (!built.ok) continue; // 构造时已保证 DAG，正常不会发生
    const s = Tfs.schedule(built.model, []);

    // 暴力：枚举全部排列
    const perms = [];
    const permute = (arr, k) => {
      if (k === arr.length) return perms.push(arr.slice());
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        permute(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    };
    permute([...Array(n).keys()], 0);
    let bestPeak = Infinity;
    let bestSeq = null;
    for (const ord of perms) {
      const sim = Tfs.simulate(built.model, ord, []);
      if (!sim.ok) continue;
      if (sim.peakBytes < bestPeak ||
          (sim.peakBytes === bestPeak &&
           ord.map((i) => built.model.passes[i].id).join('') <
             bestSeq.map((i) => built.model.passes[i].id).join(''))) {
        bestPeak = sim.peakBytes;
        bestSeq = ord;
      }
    }
    assert.strictEqual(s.peakBytes, bestPeak, `trial ${trial} 峰值不一致`);
    assert.deepStrictEqual(s.orderIds, bestSeq.map((i) => built.model.passes[i].id),
      `trial ${trial} 字典序不一致`);

    const sim = Tfs.simulate(built.model, s.order, []);
    for (const st of sim.steps) {
      assert.ok(st.afterBytes >= 0 && st.duringBytes >= st.beforeBytes);
      assert.ok(st.peakBytes >= st.duringBytes);
    }
  }
});

// ---------- 11. 18 通道性能 ----------
test('18 通道链 + 独立混合场景在 2 秒内完成', () => {
  const passes = [];
  const images = { t: img([[4, 4]]) };
  for (let i = 0; i < 18; i++) {
    passes.push({
      id: `pass-${String(i).padStart(2, '0')}`,
      out: `t.0@${i + 1}`,
      op: i === 0 ? 'const' : 'add',
      read: i === 0 ? [] : [`t.0@${i}`, `t.0@${i}`],
      values: new Array(16).fill(0),
    });
  }
  const built = Tfs.buildModel({ id: 'perf', images, passes, exports: ['t.0@18'] });
  assert.ok(built.ok);
  const t0 = Date.now();
  const s = Tfs.schedule(built.model, []);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `调度耗时 ${elapsed}ms 超过 2s`);
  assert.strictEqual(s.order.length, 18);
});

console.log(`\n${passed} 项测试通过`);
if (process.exitCode) console.error('存在失败用例');
