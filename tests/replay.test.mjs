// 回放与历史栈测试
import assert from 'node:assert/strict';
import { makeImage, runOperation } from '../js/seam-engine.js';
import { History, buildReplayFrames } from '../js/history.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.error('  ✗', name, '\n   ', err.message); process.exitCode = 1; }
}

function flat(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set([100, 120, 140], i * 3);
  return makeImage(w, h, rgb, new Uint8Array(w * h));
}

test('History：undo/redo 以整次操作为单位，新操作截断重做分支', () => {
  const h = new History(flat(6, 5));
  h.push({ kind: 'transform', label: 'a', image: flat(5, 5) });
  h.push({ kind: 'transform', label: 'b', image: flat(4, 5) });
  assert.equal(h.current.label, 'b');
  h.undo();
  assert.equal(h.current.label, 'a');
  h.push({ kind: 'brush', label: 'c', image: flat(5, 5) });
  assert.equal(h.canRedo, false);
  assert.equal(h.stack.length, 3);
  h.undo(); h.undo();
  assert.equal(h.canUndo, false);
  assert.equal(h.current.kind, 'load');
});

test('回放：缩图轨迹首帧为原图、末帧为结果，尺寸逐帧 -1', () => {
  const src = flat(6, 4);
  const r = runOperation(src, 3, 4, 'width-first');
  const frames = buildReplayFrames(src, r.trace);
  assert.equal(frames[0].stage, 'start');
  assert.equal(frames.at(-1).stage, 'end');
  assert.equal(frames[0].image.width, 6);
  assert.equal(frames.at(-1).image.width, 3);
  const widths = frames.map((f) => f.image.width);
  assert.deepEqual(widths, [6, 6, 5, 4, 3]);
  // 每个 shrink 帧都带单缝覆盖层
  const shrinkFrames = frames.filter((f) => f.stage === 'shrink');
  assert.equal(shrinkFrames.length, 3);
  for (const f of shrinkFrames) assert.ok(f.overlay.seam.length === 4);
  // 末帧像素与引擎结果一致
  assert.deepEqual(frames.at(-1).image.rgb, r.image.rgb);
});

test('回放：扩图发现帧工作副本逐帧收窄，应用帧带批次多缝', () => {
  const src = flat(6, 4);
  const r = runOperation(src, 10, 4, 'width-first'); // +4 一批
  const frames = buildReplayFrames(src, r.trace);
  const discover = frames.filter((f) => f.stage === 'discover');
  assert.deepEqual(discover.map((f) => f.image.width), [6, 5, 4, 3]);
  const apply = frames.filter((f) => f.stage === 'apply');
  assert.equal(apply.length, 1);
  assert.equal(apply[0].overlay.seams.length, 4);
  assert.equal(frames.at(-1).image.width, 10);
  assert.deepEqual(frames.at(-1).image.rgb, r.image.rgb);
});

test('回放：多批扩图（6→13）每批独立应用', () => {
  const src = flat(6, 3);
  const r = runOperation(src, 13, 3, 'width-first');
  const frames = buildReplayFrames(src, r.trace);
  const applies = frames.filter((f) => f.stage === 'apply');
  assert.equal(applies.length, 2);
  assert.equal(applies[0].image.width, 6);   // 批次1原图
  assert.equal(applies[1].image.width, 11);  // 批次2原图
  assert.equal(frames.at(-1).image.width, 13);
});

test('回放：水平轴（先高后宽）点坐标为原方向 [x,y]', () => {
  const src = flat(5, 6);
  const r = runOperation(src, 5, 3, 'height-first');
  const frames = buildReplayFrames(src, r.trace);
  for (const f of frames.filter((x) => x.stage === 'shrink')) {
    for (const [x, y] of f.overlay.seam) {
      assert.ok(x >= 0 && x < 5 && y >= 0 && y < 6);
    }
  }
  assert.equal(frames.at(-1).image.height, 3);
});

test('回放：无操作（目标=原尺寸）只有首尾两帧', () => {
  const src = flat(4, 4);
  const r = runOperation(src, 4, 4, 'width-first');
  const frames = buildReplayFrames(src, r.trace);
  assert.equal(frames.length, 2);
});

console.log(`\n${passed} 项通过`);
if (process.exitCode) console.error('存在失败项');
