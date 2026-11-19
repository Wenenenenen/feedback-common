#!/usr/bin/env node
/* UI 端到端冒烟测试：用真实浏览器验证 加载/播放/改地形/导出/自检/响应式。
 * 前置：node tools/serve.js 8123
 * 用法：node test/ui.js [http://localhost:8123/] */
'use strict';

const path = require('path');

function loadPlaywright() {
  const candidates = [
    'playwright',
    path.join(process.env.HOME || '', '.nvm/versions/node', process.version, 'lib/node_modules/playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 继续尝试 */ }
  }
  throw new Error('未找到 playwright，请先 npm i -g playwright');
}

const { chromium } = loadPlaywright();
const BASE = process.argv[2] || process.env.FF_URL || 'http://localhost:8123/';

let failures = 0, checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (!cond) { failures++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
  else console.log(`  ✓ ${label}`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const boot = await page.evaluate(() => {
    const st = window.__ff.state;
    return { hasEngine: !!st.engine, caseName: st.caseName, units: st.engine ? st.engine.initialUnits.length : 0 };
  });
  ok(boot.hasEngine && boot.units === 20, '默认载入 doorway 样例（20 个单位）', JSON.stringify(boot));

  // 跑到结束
  await page.click('#btnRunAll');
  await page.waitForTimeout(400);
  const run = await page.evaluate(() => {
    const sim = window.__ff.state.engine.sim;
    return { frames: sim.frames.length - 1, finished: sim.finished, arrivals: sim.arrivals.length, blocked: sim.blockedIds.length, unreach: sim.unreachableIds.length };
  });
  ok(run.finished && run.arrivals === 20, '“跑到结束”后 20 个单位全部到达', JSON.stringify(run));

  // 时间轴回看
  await page.evaluate(() => { const st = window.__ff.state; st.cursor = 10; window.__ff.renderAll(); });
  await page.waitForTimeout(150);
  const scrubbed = await page.evaluate(() => document.querySelector('#frameNow').textContent);
  ok(Number(scrubbed) <= run.frames, '拖动时间轴可回看历史帧', `frameNow=${scrubbed}`);

  // 逐帧按钮
  await page.evaluate(() => { window.__ff.state.cursor = 0; window.__ff.renderAll(); });
  await page.click('#btnStep');
  await page.waitForTimeout(150);
  const afterStep = await page.evaluate(() => Number(document.querySelector('#frameNow').textContent));
  ok(afterStep >= 1, '“下一帧”推进一帧', `frame=${afterStep}`);

  // 尺寸切换
  await page.click('.seg-btn[data-size="3"]');
  await page.waitForTimeout(200);
  const size3 = await page.evaluate(() => window.__ff.state.size);
  ok(size3 === 3, '尺寸切换生效');

  // 点格子看数值
  const cellInfo = await page.evaluate(() => {
    window.__ff.state.selected = { x: 10, y: 7 };
    window.__ff.renderAll();
    return document.querySelector('#inspector').innerText;
  });
  ok(/尺寸 1/.test(cellInfo) && /尺寸 2/.test(cellInfo) && /尺寸 3/.test(cellInfo), '点击格子显示三种尺寸的数值');
  ok(/积分值/.test(cellInfo), '详情面板含积分值');

  // 改地形 → 增量重算 + 全量校验
  await page.evaluate(() => { window.__ff.state.cursor = 0; window.__ff.runAll(); });
  const edit = await page.evaluate(() => {
    for (let y = 5; y <= 6; y++) window.__ff.applyEdit(20, y, '#');
    const st = window.__ff.state;
    return {
      changed: st.lastRecompute && st.lastRecompute.changed,
      identical: st.verify && [1, 2, 3].map(k => st.verify[k].identical),
      invalidated: st.lastRecompute && [1, 2, 3].map(k => st.lastRecompute.perSize[k].invalidated),
    };
  });
  ok(edit.changed === 1, '改地形报告实际改动格数', JSON.stringify(edit));
  ok(edit.identical && edit.identical.every(Boolean), '增量重算与全量重算逐位一致');
  ok(edit.invalidated && edit.invalidated.every(n => n > 0 && n < 1200), '只重算受影响的锚点（非全图）', JSON.stringify(edit.invalidated));

  // 改地形后模拟仍然有效
  const afterEdit = await page.evaluate(() => {
    window.__ff.state.cursor = 0;
    window.__ff.runAll();
    const sim = window.__ff.state.engine.sim;
    let overlap = 0;
    for (let i = 0; i < sim.units.length; i++) {
      for (let j = i + 1; j < sim.units.length; j++) {
        const a = sim.units[i], b = sim.units[j];
        if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) overlap++;
      }
    }
    return { finished: sim.finished, arrivals: sim.arrivals.length, overlap };
  });
  ok(afterEdit.finished && afterEdit.overlap === 0, '改地形后可重新跑完且无重叠', JSON.stringify(afterEdit));

  // 导出
  const [dl1] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('[data-export="integration-2"]')]);
  ok(/integration-size2\.json$/.test(dl1.suggestedFilename()), '导出积分场 JSON', dl1.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('[data-export="trajectory"]')]);
  ok(/trajectory\.json$/.test(dl2.suggestedFilename()), '导出轨迹 JSON', dl2.suggestedFilename());

  // 自检
  await page.click('#btnSelfCheck');
  await page.waitForTimeout(2500);
  const selfCheck = await page.evaluate(() => document.querySelector('#selfCheckResult').innerText);
  ok(/全部通过/.test(selfCheck), '页面内自检通过');
  ok(/无违规/.test(selfCheck), '模拟不变量自检无违规');

  // 窄屏无横向溢出
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok(!overflow, '420px 窄屏无横向滚动');

  ok(errors.length === 0, '无控制台错误', errors.join(' | '));

  await browser.close();
  console.log(`\nUI 冒烟测试：${checks} 项检查，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})();
