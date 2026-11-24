// tests/timeline.test.js — 拼接/拆分/倒序/静音/列统计/定位/撤销
import { Timeline, makeSegment, MAX_COLUMNS } from '../js/timeline.js';
import { History } from '../js/history.js';
import { buildExport } from '../js/exporter.js';
import { makeSource, bruteStat, assert, assertEq, assertStat } from './helpers.js';

const A = makeSource(5000, 'A.wav', 11);
const srcB = makeSource(3000, 'B.wav', 22);
const sources = new Map([
  ['A', { name: 'A.wav', frameCount: A.frameCount, pyramid: A.pyramid }],
  ['B', { name: 'B.wav', frameCount: srcB.frameCount, pyramid: srcB.pyramid }],
]);

// 拼接轨逐帧参照：返回每个拼接帧的 {ch 值数组} 或 null（静音）
function materialize(timeline) {
  const n = timeline.totalFrames();
  const out = [new Int16Array(n), new Int16Array(n)];
  const mutedAt = new Uint8Array(n);
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const base = timeline.offsets[i];
    const len = seg.srcEnd - seg.srcStart;
    for (let d = 0; d < len; d++) {
      const sf = seg.reverse ? seg.srcEnd - 1 - d : seg.srcStart + d;
      const f = base + d;
      if (seg.muted) { mutedAt[f] = 1; out[0][f] = 0; out[1][f] = 0; }
      else {
        out[0][f] = sources.get(seg.sourceId).pyramid.sample(0, sf);
        out[1][f] = sources.get(seg.sourceId).pyramid.sample(1, sf);
      }
    }
  }
  return { out, mutedAt };
}

function bruteTimelineStat(tl, ch, start, end, mat) {
  if (end <= start) return null;
  let min = 32767, max = -32768, count = 0, sumSq = 0n;
  for (let f = start; f < end; f++) {
    const v = mat.out[ch][f]; // 静音位已为 0
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
    sumSq += BigInt(v) * BigInt(v);
  }
  return { min, max, count, sumSq };
}

let tl = new Timeline(sources);
tl.append(makeSegment('A', 0, 5000));
tl.append(makeSegment('B', 100, 1100));
assertEq(tl.totalFrames(), 6000, '拼接总长');
assertEq(tl.offsets[1], 5000, '第二段偏移');

// 1. 拆分不改声音（含倒序镜像拆分）
let mat = materialize(tl);
tl.splitAt(2500); // 段 A 正中
assertEq(tl.segments.length, 3, '拆分后段数');
assertEq(tl.segments[0].srcStart, 0, 'tl.segments[0].srcStart = 0')
assertEq(tl.segments[0].srcEnd, 2500, 'tl.segments[0].srcEnd = 2500')
assertEq(tl.segments[1].srcStart, 2500, 'tl.segments[1].srcStart = 2500')
assertEq(tl.segments[1].srcEnd, 5000, 'tl.segments[1].srcEnd = 5000')
let mat2 = materialize(tl);
assertEq(mat2.out.length, mat.out.length, '拆分后声道数不变');
let same = true;
for (let f = 0; f < 6000; f++) if (mat2.out[0][f] !== mat.out[0][f] || mat2.out[1][f] !== mat.out[1][f]) same = false;
assert(same, '拆分逐帧声音不变');

// 2. 倒序：源位置映射正确且不交换声道
tl.toggleReverse(1); // 段 [2500,5000) → A[2500,5000) 倒序
const loc0 = tl.locate(2500);
assertEq(loc0.srcFrame, 4999, '倒序段首帧 → 源尾帧');
const loc1 = tl.locate(4999);
assertEq(loc1.srcFrame, 2500, '倒序段尾帧 → 源首帧');
assertEq(tl.inspectFrame(2500).values[0], A.pcm[0][4999], '倒序帧左声道值');
assertEq(tl.inspectFrame(2500).values[1], A.pcm[1][4999], '倒序帧右声道值（声道不交换）');
// 倒序段拆分声音不变
const before = materialize(tl);
tl.splitAt(3000);
const after = materialize(tl);
let revSame = true;
for (let f = 0; f < 6000; f++) if (after.out[0][f] !== before.out[0][f] || after.out[1][f] !== before.out[1][f]) revSame = false;
assert(revSame, '倒序段拆分逐帧声音不变');
assertEq(tl.segments[1].srcStart, 4500, 'tl.segments[1].srcStart = 4500')
assertEq(tl.segments[1].srcEnd, 5000, 'tl.segments[1].srcEnd = 5000')
assertEq(tl.segments[2].srcStart, 2500, 'tl.segments[2].srcStart = 2500')
assertEq(tl.segments[2].srcEnd, 4500, 'tl.segments[2].srcEnd = 4500')
assert(tl.segments[1].reverse && tl.segments[2].reverse, '拆出的两段都保持倒序');

// 3. 静音：零样本语义
tl.toggleMute(0);
const matM = materialize(tl);
const stM = tl.rangeStats(0, 2500);
assertStat(stM[0], bruteTimelineStat(tl, 0, 0, 2500, matM), '全静音段左声道（零样本）');
assertEq(stM[0].min, 0, 'stM[0].min = 0');
assertEq(stM[0].max, 0, 'stM[0].max = 0');
assertEq(stM[0].count, 2500, 'stM[0].count = 2500');
assert(stM[0].sumSq === 0n, '静音段平方和为 0');
// 跨静音/非静音边界的区间统计（参照实现需用静音后的物化结果）
const cross = tl.rangeStats(2000, 3000);
assertStat(cross[1], bruteTimelineStat(tl, 1, 2000, 3000, matM), '跨静音边界右声道');
tl.toggleMute(0);

// 4. 移动
const firstId = tl.segments[0].id;
tl.move(0, 2);
assertEq(tl.segments[2].id, firstId, 'move 后段位置');
assertEq(tl.totalFrames(), 6000, 'move 不改总长');
tl.move(2, 0); // 还原

// 5. 列统计：边界 floor(jn/B)、空列、逐列对照暴力
const fresh = new Timeline(sources);
fresh.append(makeSegment('A', 0, 5000));
fresh.append(makeSegment('B', 100, 1100));
fresh.toggleReverse(1);
const matF = materialize(fresh);
const selStart = 123, n = 5555, B = 128;
const cols = fresh.columnStats(selStart, n, B);
assertEq(cols.length, B, '列数 = B');
let emptyCount = 0;
for (let j = 0; j < B; j++) {
  const cs = selStart + Math.floor((j * n) / B);
  const ce = selStart + Math.floor(((j + 1) * n) / B);
  assertEq(cols[j].start, cs, `列 ${j} 起点边界`);
  assertEq(cols[j].end, ce, `列 ${j} 终点边界`);
  for (let ch = 0; ch < 2; ch++) {
    const want = bruteTimelineStat(fresh, ch, cs, ce, matF);
    assertStat(cols[j].stats[ch], want, `列 ${j} 声道 ${ch} 统计`);
  }
  if (ce === cs) {
    emptyCount++;
    assert(cols[j].stats[0] === null && cols[j].stats[1] === null, `空列 ${j} 最值为空`);
  }
}
assert(emptyCount === 0, 'n>B 时无空列');
// n < B：必然出现空列
const cols2 = fresh.columnStats(0, 3, 10);
let ec = 0;
for (const c of cols2) if (c.end === c.start) {
  ec++;
  assert(c.stats[0] === null && c.stats[1] === null, '空列 min/max 空');
  assertEq(c.stats[0], null, '空列统计为 null');
}
assertEq(ec, 7, 'n=3,B=10 时有 7 个空列');
// 非空列恰好每列 1 帧，共 3 帧，且边界符合 floor 公式
const nonEmpty = cols2.filter((c) => c.end > c.start);
assertEq(nonEmpty.length, 3, '3 个非空列');
for (const c of nonEmpty) assertEq(c.end - c.start, 1, '非空列各 1 帧');

// 6. B 边界 1 与 2048
assertEq(fresh.columnStats(0, 6000, 1).length, 1, 'B=1');
assertEq(fresh.columnStats(0, 6000, MAX_COLUMNS).length, 2048, 'B=2048');
let threw = false;
try { fresh.columnStats(0, 6000, 2049); } catch { threw = true; }
assert(threw, 'B=2049 被拒绝');

// 7. 整段区间聚合与逐帧定位
const whole = fresh.rangeStats(0, 6000);
assertStat(whole[0], bruteTimelineStat(fresh, 0, 0, 6000, matF), '整段左声道聚合');
assert(fresh.locate(-1) === null && fresh.locate(6000) === null, '越界 locate 返回 null');
const insp = fresh.inspectFrame(5000);
assertEq(insp.sourceId, 'B', '定位到源 B');
assertEq(insp.srcFrame, 1099, '倒序 B 段首帧源位置');

// 8. 撤销/重做：编辑前 push 当前状态；撤销后再编辑清掉旧重做
const hist = new History();
const t2 = new Timeline(sources);
// 初始空状态入栈
hist.push(t2.segments);
t2.append(makeSegment('A', 0, 100));
hist.push(t2.segments);            // S1：1 段 100 帧
t2.append(makeSegment('B', 0, 100));
// 当前为 S2：2 段 200 帧（不再 push，模拟“正在编辑”）
assertEq(200, t2.totalFrames(), '编辑后总长 200');
let undone = hist.undo(t2.segments);
t2.segments = undone; t2.rebuild();
assertEq(100, t2.totalFrames(), '撤销一次回到 100 帧');
assert(hist.canRedo(), '撤销后可重做');
undone = hist.undo(t2.segments);
t2.segments = undone; t2.rebuild();
assertEq(0, t2.totalFrames(), '再撤销回到空轨 0 帧');
// 重做恢复
let redone = hist.redo(t2.segments);
t2.segments = redone; t2.rebuild();
assertEq(100, t2.totalFrames(), '重做恢复 100 帧');
// 撤销后做新编辑 → 旧重做被清空
undone = hist.undo(t2.segments);
t2.segments = undone; t2.rebuild();
assertEq(0, t2.totalFrames(), '再次撤销到 0 帧');
assert(hist.canRedo(), '此刻仍可重做');
t2.append(makeSegment('A', 0, 50));
hist.push(t2.segments);            // 新编辑前提交快照，内部截断重做栈
assert(hist.canRedo() === false, '新编辑清空重做栈');
assert(hist.redo(t2.segments) === null, 'redo 栈空返回 null');

// 9. 导出：平方和十进制字符串 + 空列零值
const exp = buildExport(fresh, { start: 0, end: 10 }, fresh.columnStats(0, 10, 16), 16);
assertEq(typeof exp.columns.list[0].left.sumSq, 'string', 'sumSq 为字符串');
const empties = exp.columns.list.filter((c) => c.frameCount === 0);
assert(empties.length > 0, '导出含空列');
for (const c of empties) {
  assert(c.left.min === null && c.right.max === null, '空列最值 null');
  assertEq(c.left.count, 0, 'c.left.count = 0');
  assertEq(c.right.sumSq, '0', '空列平方和 "0"');
}
assertEq(exp.interval.frameCount, 10, '导出区间帧数');
assertEq(exp.segments.length, 2, '导出含段清单');

console.log('timeline tests done');
