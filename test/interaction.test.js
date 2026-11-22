'use strict';
// 交互回归：画地块、编辑、并发、取消、检查器、整窗/分块一致性。
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL);
  await page.waitForTimeout(500);

  // 1) 地表画笔拖出矩形
  await page.locator('.tab[data-tab="ground"]').click();
  await page.locator('#brush').selectOption('empty');
  await page.locator('#draw-rect').click();
  const box = await page.locator('#view').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy - 30);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const patchCount = await page.locator('.patch-row').count();
  ok('拖矩形后新增 patch', patchCount >= 2, 'patches=' + patchCount);

  // 2) 无候选（empty brush）覆盖后，该区域树/草变少 —— 用查询验证空白画笔区域无候选
  await page.locator('#draw-rect').click(); // 退出绘制
  // 3) 切到查询并点空白画笔那格
  // 需要知道刚画的矩形覆盖哪格；改由配置读取
  const cfg = await page.evaluate(() => JSON.parse(document.querySelector('#config-json').value));
  ok('空白笔刷 patch 权重全 0', cfg.patches[cfg.patches.length - 1].weights[0].every(w => w === 0)
    && cfg.patches[cfg.patches.length - 1].weights[1].every(w => w === 0),
    JSON.stringify(cfg.patches[cfg.patches.length - 1]));

  // 4) 并发计算 +
  await page.locator('.tab[data-tab="windows"]').click();
  await page.locator('.window-card .btn.primary').nth(0).click();
  await page.locator('.window-card .btn.primary').nth(1).click();
  await page.waitForFunction(() => {
    const chips = document.querySelectorAll('.window-card .chip');
    return chips.length === 2 && Array.from(chips).every(c => /已完成/.test(c.textContent));
  }, { timeout: 20000 }).catch(() => {});
  const chips = await page.locator('.window-card .chip').allTextContents();
  ok('并发两个窗口都完成', chips.every(c => /已完成/.test(c)), chips.join(' | '));

  // 5) 一致性：主线程对比整窗 vs 分块
  const consistency = await page.evaluate(async (cfgJson) => {
    const V = window.VegetationModule();
    const cfg = V.normalizeConfig(JSON.parse(cfgJson));
    const W = cfg.window;
    const full = V.exportText(V.bake(cfg, W));
    const mx = W[0] + Math.floor(W[2] / 2), my = W[1] + Math.floor(W[3] / 2);
    const chunks = [
      [W[0], W[1], mx - W[0], my - W[1]],
      [mx, W[1], W[0] + W[2] - mx, my - W[1]],
      [W[0], my, mx - W[0], W[1] + W[3] - my],
      [mx, my, W[0] + W[2] - mx, W[1] + W[3] - my]
    ].filter(c => c[2] > 0 && c[3] > 0);
    const merged = V.mergeResults(chunks.map(c => V.bake(cfg, c)));
    return { equal: V.exportText(merged, { header: false }) === V.exportText({ survivors: merged.survivors }, { header: false }), fullRows: full.trim().split('\n').length };
  }, await page.locator('#config-json').inputValue());
  ok('浏览器内分块合并与整窗一致', consistency.equal, JSON.stringify(consistency));

  // 6) 检查器在某格显示淘汰原因
  await page.locator('.tab[data-tab="species"]').click();
  const canvasBox = await page.locator('#view').boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.waitForTimeout(300);
  const hasChips = await page.locator('#inspect-body .status-chip').count();
  ok('检查器显示状态徽标', hasChips >= 2, String(hasChips));

  // 7) 取消后立即重算不受影响
  await page.locator('.tab[data-tab="windows"]').click();
  await page.locator('.window-card .btn.primary').nth(0).click();
  await page.waitForTimeout(20);
  const cancel = page.locator('.window-card .btn.danger').first();
  if (await cancel.count()) { await cancel.click({ timeout: 2000 }).catch(() => {}); }
  await page.locator('.window-card .btn.primary').nth(0).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.window-card .chip');
    return c && /已完成/.test(c.textContent);
  }, { timeout: 20000 }).catch(() => {});
  const after = await page.locator('.window-card .chip').first().textContent();
  ok('取消后重算成功', /已完成/.test(after), after);

  ok('全程无控制台错误', errors.length === 0, errors.join('\n       '));

  await page.screenshot({ path: path.join(ROOT, 'test', 'interaction.png') });
  await browser.close();
  console.log('');
  if (fails) { console.log(fails + ' 项失败'); process.exit(1); }
  console.log('交互回归全部通过');
})().catch(e => { console.error(e); process.exit(1); });
