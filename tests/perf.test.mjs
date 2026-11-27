import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fullCase } from './case.mjs';

const require = createRequire(import.meta.url);
const PM = require('../src/core.js');

/* 满规模：256×256、2 种波长、6 个面、12 轮。
 * 预算 35 秒（4 逻辑核 CPU）。这里测的是纯计算路径：
 * 载入校验 + 建传播核 + 初始第 0 轮 + 12 次回退试步。
 */
test('full scale 12 rounds fits the 35 s budget', { timeout: 60000 }, () => {
  const proj = fullCase(12);
  const t0 = performance.now();
  const r = PM.createProject(proj);
  assert.ok(r.ok, 'project validates');
  const engine = r.engine;
  const s = PM.createSession(engine, { eta: proj.eta, steps: 12 });
  s.init();
  for (let k = 0; k < 12; k++) s.step();
  const ms = performance.now() - t0;
  assert.equal(s.round, 12);
  assert.equal(s.done, true);
  assert.ok(Number.isFinite(s.loss));
  // 允许测试机比目标 4 逻辑核更慢：给 2 倍余量，仍在 35 秒的硬指标内
  assert.ok(ms < 35000, `12 轮用时 ${ms.toFixed(0)} ms，超出 35 s`);
  assert.ok(s.loss < PM.createSession(engine).init().loss, 'loss decreased');
});
