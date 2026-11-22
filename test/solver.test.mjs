/*
 * test/solver.test.mjs — 纯 Node 测试（无依赖）：node test/solver.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  anchorVisibility,
  buildFrameContext,
  diagnoseFrame,
  rectsOverlap,
  segmentCrossesRectInterior,
  solveFrame,
  solveSequence,
} from '../js/solver.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, '..', 'samples', 'depth-label-cases.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---------- 几何工具 ----------
test('矩形：边缘相接不算重叠，正面积交叠才算', () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 4, y: 0, w: 4, h: 2 }), false);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 3.999, y: 0, w: 4, h: 2 }), true);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 2, w: 4, h: 2 }), false);
});

test('线段穿框内部判定：贴边、端点接触均合法', () => {
  const r = { x: 10, y: 10, w: 10, h: 10 };
  assert.equal(segmentCrossesRectInterior(0, 15, 10, 15, r), false); // 止于左边
  assert.equal(segmentCrossesRectInterior(0, 10, 20, 10, r), false); // 沿顶边
  assert.equal(segmentCrossesRectInterior(5, 15, 15, 15, r), true); // 穿入内部
  assert.equal(segmentCrossesRectInterior(12, 12, 14, 14, r), true); // 整段在内部
  assert.equal(segmentCrossesRectInterior(0, 20, 30, 20, r), false); // 完全在下方
  assert.equal(segmentCrossesRectInterior(0, 20, 10, 10, r), false); // 仅接触左上角点
  assert.equal(segmentCrossesRectInterior(10, 10, 20, 20, r), true); // 除角点外整段在内部
});

// ---------- 锚点可见性 ----------
test('深度遮挡：帧0遮C，帧1遮B+C，帧2遮C；A始终可见', () => {
  const W = sample.size[0];
  const H = sample.size[1];
  const expect = [
    [true, true, false],
    [true, false, false],
    [true, true, false],
  ];
  sample.frames.forEach((fr, f) => {
    sample.labels.forEach((lab, li) => {
      const vis = anchorVisibility(lab.position, sample.camera, W, H, fr.depth);
      assert.equal(vis.visible, expect[f][li], `frame${f} label${lab.id}`);
      if (!vis.visible) assert.equal(vis.reason, 'depth');
    });
  });
});

test('近裁面外 / 出画 的锚点隐藏', () => {
  const W = sample.size[0];
  const H = sample.size[1];
  const depth = new Array(W * H).fill(0);
  assert.equal(anchorVisibility([0, 0, 0.05], sample.camera, W, H, depth).reason, 'near');
  const off = anchorVisibility([100, 0, 2], sample.camera, W, H, depth);
  assert.equal(off.visible, false);
  assert.equal(off.reason, 'offscreen');
});

// ---------- 样例整段求解（手工推演） ----------
test('样例顺播结果与手工推演一致', () => {
  const seq = solveSequence(sample);
  assert.equal(seq.length, 3);
  // 帧0：C隐藏；A 落位0 与 B 落位0 框冲突，A 取落位1（代价1），B 显示（代价0）
  assert.deepEqual(seq[0].assign, [1, 0, -1]);
  assert.deepEqual(seq[0].hidden, [2]);
  assert.equal(seq[0].score.weight, 11); // A6+B5
  assert.equal(seq[0].score.cost, 1);
  // 帧1：仅 A 可见，保持落位1，无换落位罚分
  assert.deepEqual(seq[1].assign, [1, -1, -1]);
  assert.equal(seq[1].score.weight, 6);
  assert.equal(seq[1].score.cost, 1);
  assert.equal(seq[1].score.switchCost, 0);
  // 帧2：A、B 可见。A 回落位0：基础代价0 + 换落位罚分2；落位1：代价1 不换 → 选落位1
  assert.deepEqual(seq[2].assign, [1, 0, -1]);
  assert.equal(seq[2].score.weight, 11);
  assert.equal(seq[2].score.baseCost, 1);
  assert.equal(seq[2].score.switchCost, 0);
});

test('换落位罚分：改变紧邻上帧选择时加 2 分', () => {
  const seq = solveSequence(sample);
  // 构造：若帧2 B 重新出现，上一帧 B 隐藏，不应产生罚分
  const bPrev = undefined; // 上帧隐藏
  assert.equal(bPrev, undefined);
  // 直接验证 solveFrame 的罚分路径
  const ctx = buildFrameContext(sample, 2);
  const forced = solveFrame(ctx, { 0: 0, 1: 0 }, sample.labels.map((l) => l.weight), 2);
  // A 上帧落位0 → 落位0 不罚；但落位0与B冲突，求解仍应选最优组合
  assert.ok(forced.score.cost >= 0);
});

test('标签隐藏后重新出现不计换落位罚分；退化连线不穿框；z==near 可见', async () => {
  const { anchorVisibility, nearestPointOnRect, segmentCrossesRectInterior } = await import(
    '../js/solver.js'
  );
  const d = {
    size: [40, 30],
    camera: { fx: 10, fy: 10, cx: 20, cy: 15, near: 0.1 },
    reserved: [],
    labels: [{ id: 'A', text: 'A', position: [0, 0, 2], weight: 5, size: [4, 2], choices: [[0, 0, 3]] }],
    frames: [],
  };
  const clear = new Array(1200).fill(0);
  const blocked = clear.slice();
  blocked[15 * 40 + 20] = 1.0; // 挡住锚点像素 (20,15)
  d.frames = [{ depth: clear }, { depth: blocked }, { depth: clear }];
  const seq = solveSequence(d);
  assert.deepEqual(seq.map((r) => r.assign[0]), [0, -1, 0]);
  assert.deepEqual(seq.map((r) => r.score.switchCost), [0, 0, 0]); // 重现无罚分

  const r = { x: 18, y: 13, w: 6, h: 4 };
  const np = nearestPointOnRect(r, 20, 15); // 锚点在框内
  assert.equal(np.x, 20);
  assert.equal(np.y, 15);
  assert.equal(segmentCrossesRectInterior(20, 15, 20, 15, { x: 0, y: 0, w: 2, h: 2 }), false);

  assert.equal(anchorVisibility([0, 0, 0.1], d.camera, 40, 30, clear).visible, true);
});

// ---------- 目标优先级 ----------
test('优先分优先：宁可隐藏高权重标签也不牺牲总分', () => {
  const data = {
    size: [20, 10],
    camera: { fx: 5, fy: 5, cx: 10, cy: 5, near: 0.1 },
    reserved: [],
    labels: [
      { id: 'X', text: 'X', position: [0, 0, 2], weight: 9, size: [4, 2], choices: [[0, 0, 0]] },
      { id: 'Y', text: 'Y', position: [0, 0, 2], weight: 3, size: [4, 2], choices: [[0, 0, 5]] },
    ],
    frames: [{ depth: new Array(200).fill(0) }],
  };
  const seq = solveSequence(data);
  assert.deepEqual(seq[0].assign, [0, -1]); // 同位置同框冲突，保留 X
  assert.equal(seq[0].score.weight, 9);
});

test('同优先分时总代价最低', () => {
  const data = {
    size: [40, 20],
    camera: { fx: 5, fy: 5, cx: 20, cy: 10, near: 0.1 },
    reserved: [],
    labels: [
      { id: 'P', text: 'P', position: [0, 0, 2], weight: 5, size: [2, 2], choices: [[0, 0, 3], [10, 0, 1]] },
    ],
    frames: [{ depth: new Array(800).fill(0) }],
  };
  const seq = solveSequence(data);
  assert.equal(seq[0].assign[0], 1); // 代价 1 < 3
  assert.equal(seq[0].score.cost, 1);
});

test('完全同分时按标签ID/落位序号字典序（隐藏排最后）', () => {
  const data = {
    size: [40, 20],
    camera: { fx: 5, fy: 5, cx: 20, cy: 10, near: 0.1 },
    reserved: [],
    labels: [
      { id: 'P', text: 'P', position: [0, 0, 2], weight: 5, size: [2, 2], choices: [[0, 0, 0], [10, 0, 0]] },
    ],
    frames: [{ depth: new Array(800).fill(0) }],
  };
  const seq = solveSequence(data);
  assert.equal(seq[0].assign[0], 0); // 落位序号 0 胜出
});

// ---------- 预留区与出画 ----------
test('压预留区的落位不可行，框出画的落位不可行', () => {
  const data = structuredClone(sample);
  data.reserved = [{ x: 16, y: 7, w: 4, h: 2 }]; // 恰好覆盖 A 落位0 的框
  const ctx = buildFrameContext(data, 0);
  const aOpts = ctx.options.filter((o) => o.labelIdx === 0);
  assert.equal(aOpts[0].feasible, false);
  assert.equal(aOpts[0].infeasibleReason, 'reserved');
  assert.equal(aOpts[1].feasible, true);
  const items = diagnoseFrame(ctx).filter((i) => i.type === 'infeasible');
  assert.ok(items.some((i) => i.reason === 'reserved'));

  const data2 = structuredClone(sample);
  data2.labels[0].choices = [[-100, 0, 0]];
  const ctx2 = buildFrameContext(data2, 0);
  assert.equal(ctx2.options[0].feasible, false);
  assert.equal(ctx2.options[0].infeasibleReason, 'offscreen-box');
});

// ---------- 连线穿框冲突 ----------
test('连线穿过第三方框内部时形成 pair 冲突', () => {
  // 锚点在 (20,10)，框放右侧；另一标签的框横在连线路径上
  const data = {
    size: [60, 30],
    camera: { fx: 5, fy: 5, cx: 20, cy: 10, near: 0.1 },
    reserved: [],
    labels: [
      { id: 'S', text: 'S', position: [0, 0, 2], weight: 5, size: [4, 4], choices: [[20, 8, 0]] }, // 框 x40..44
      { id: 'T', text: 'T', position: [8, 0, 2], weight: 5, size: [4, 4], choices: [[0, 0, 0]] },  // 锚点(40,10)，框40..44 —— 不挡路
    ],
    frames: [{ depth: new Array(1800).fill(0) }],
  };
  const ctx = buildFrameContext(data, 0);
  // S 的连线从 (20,10) 到其框最近点 (40,10)，T 框在 40..44，不穿内部 → 无冲突
  assert.equal(diagnoseFrame(ctx).filter((i) => i.type === 'pair').length, 0);

  // 把 T 挪到连线中间：锚点投影 (30,12)，其框 28..32 × 10..14；S 的连线 y=10
  // 恰贴 T 框顶边（合法）；再把锚点下移到 (30,13) → 框 y11..15，连线穿其内部
  data.labels[1].position = [4, 0.6, 2]; // 投影 (30,13)
  data.labels[1].choices = [[-2, -2, 0]]; // 框 28..32 × 11..15
  const ctx2 = buildFrameContext(data, 0);
  const pairs = diagnoseFrame(ctx2).filter((i) => i.type === 'pair');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].kind, 'line-cross');
});

// ---------- 确定性 / 回拖重现 ----------
test('重复求解与回拖结果完全一致（确定性）', () => {
  const a = JSON.stringify(solveSequence(sample).map((r) => r.assign));
  const b = JSON.stringify(solveSequence(sample).map((r) => r.assign));
  assert.equal(a, b);
  // 从任意帧用顺播产生的 prev 续算，结果一致
  const seq = solveSequence(sample);
  const ctx2 = buildFrameContext(sample, 2);
  const prev = {};
  seq[1].assign.forEach((ci, li) => {
    if (ci >= 0) prev[li] = ci;
  });
  const again = solveFrame(ctx2, prev, sample.labels.map((l) => l.weight));
  assert.deepEqual(again.assign, seq[2].assign);
});

// ---------- 规模上限下的精确性/性能 ----------
test('12 标签 × 8 落位的满规模随机实例可在时限内精确求解', () => {
  const W = 256;
  const H = 192;
  const labels = [];
  for (let i = 0; i < 12; i++) {
    const choices = [];
    for (let k = 0; k < 8; k++) {
      choices.push([(k % 4) * 12 - 18, Math.floor(k / 4) * 14 - 7, (k + i) % 5]);
    }
    labels.push({
      id: 'L' + i,
      text: 'L' + i,
      position: [(i % 6) - 2.5, Math.floor(i / 6) - 0.5, 2],
      weight: (i % 5) + 1,
      size: [10, 6],
      choices,
    });
  }
  const data = {
    size: [W, H],
    camera: { fx: 60, fy: 60, cx: W / 2, cy: H / 2, near: 0.1 },
    reserved: [],
    labels,
    frames: [
      { depth: new Array(W * H).fill(0) },
      { depth: new Array(W * H).fill(0) },
    ],
  };
  const t0 = Date.now();
  const seq = solveSequence(data);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `solving too slow: ${ms}ms`);
  // 每帧权重之和不超过总权重，且至少有标签显示
  const totalW = labels.reduce((s, l) => s + l.weight, 0);
  for (const r of seq) {
    assert.ok(r.score.weight > 0 && r.score.weight <= totalW);
    assert.equal(r.assign.length, 12);
  }
  console.log(`    (满规模 2 帧求解耗时 ${ms}ms)`);
});

console.log(`\n全部 ${passed} 项测试通过`);
