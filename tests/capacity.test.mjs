// 容量与尾段完整性：满额基准 240 拍 / 4096 样本 / 60000 边
// 运行：node tests/capacity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../site/engine.js');
const L = require('../site/large-case.js');

test('满额基准：规模精确为 240 / 4096 / 60000', () => {
  const raw = L.buildLargeCase();
  assert.equal(raw.ticks.length, 240);
  assert.equal(raw.samples.length, 4096);
  assert.equal(raw.edges.length, 60000);
  const input = E.normalizeInput(raw); // 不超上限
  assert.equal(input.ticks.length, 240);
  assert.equal(input.samples.length, 4096);
  assert.equal(input.edges.length, 60000);
});

test('满额基准：全过程有选段，尾段完整不截断', () => {
  const raw = L.buildLargeCase();
  const input = E.normalizeInput(raw);
  const t0 = Date.now();
  const r = E.solve(input);
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, '满额基准应有解');
  assert.equal(r.sequenceIds.length, 240, '应覆盖全部 240 拍');
  assert.equal(r.details.length, 240);
  // 尾段：末拍必须是骨干样本 240，且末两拍左脚锁成立
  assert.equal(r.sequenceIds[239], 240);
  assert.equal(r.details[239].footlockLeft, 'locked');
  // 费用可追溯：累计逐拍递增到 totalCost
  assert.equal(r.details[239].cumulative, r.totalCostString);
  // 独立复核合法
  const ev = E.evaluateSequence(input, r.sequenceIds);
  assert.equal(ev.ok, true, ev.error);
  assert.equal(ev.totalCostString, r.totalCostString);
  // 性能：本机应在合理时间内（宽松上限 20 秒）
  assert.ok(ms < 20000, '求解耗时应低于 20s，实际 ' + ms + 'ms');
  console.log('满额求解: ' + ms + 'ms, 总价 ' + r.totalCostString + ', 最大状态 ' + Math.max(...r.stats.states));
});

test('满额基准导出 → 重导核算：尾拍与总价一致', () => {
  const input = E.normalizeInput(L.buildLargeCase());
  const r = E.solve(input);
  const doc = E.buildReplay(input, r);
  assert.equal(doc.ticks.length, 240);
  assert.equal(doc.totalCost, r.totalCostString);
  const v = E.verifyReplay(doc);
  assert.equal(v.ok, true, v.errors.slice(0, 5).join('；'));
  assert.equal(v.result.sequenceIds[239], 240);
});

test('满额基准：删掉唯一的尾段出口边 -> 标出首个不可达拍（末拍）', () => {
  const raw = L.buildLargeCase();
  // 找到骨干链上进入末拍（样本 240）的那条边并删除
  const idx = raw.edges.findIndex(e => e.from === 239 && e.to === 240);
  assert.ok(idx >= 0, '应存在骨干边 239 -> 240');
  raw.edges.splice(idx, 1);
  // 再删掉其它任何指向 240 的边，确保 240 完全不可达
  for (let i = raw.edges.length - 1; i >= 0; i--) {
    if (raw.edges[i].to === 240) raw.edges.splice(i, 1);
  }
  const r = E.solve(E.normalizeInput(raw));
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleTick, 239, '应标末拍（索引 239）不可达');
});
