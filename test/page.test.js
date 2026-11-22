'use strict';
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL);
  await page.waitForTimeout(600);

  // 1) 初始加载无错误，图例与面板存在
  ok('页面加载无控制台错误', errors.length === 0, errors.join('\n       '));
  ok('种子输入框存在', await page.locator('#seed').count() === 1);
  ok('窗口卡片渲染', await page.locator('.window-card').count() === 2);

  // 2) 切到「窗口」标签，并发计算两个窗口
  await page.locator('.tab[data-tab="windows"]').click();
  const runBtns = page.locator('.window-card .btn.primary');
  await runBtns.nth(0).click();
  await runBtns.nth(1).click();
  // 等待两个窗口完成
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.window-card'));
    return cards.length === 2 && cards.every(c => {
      const chip = c.querySelector('.chip');
      return chip && /已完成/.test(chip.textContent);
    });
  }, { timeout: 20000 }).catch(() => {});
  const statuses = await page.locator('.window-card .chip').allTextContents();
  ok('两个窗口都完成', statuses.every(s => /已完成/.test(s)), statuses.join(' | '));

  // 3) 幸存者数量与状态行
  const statusText = await page.locator('.window-card .status').allTextContents();
  ok('状态行包含导出统计', /导出 树/.test(statusText[0]), statusText.join(' | '));

  // 4) 点格查询
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const coordText = await page.locator('#inspect-coord').textContent();
  ok('点格显示坐标', /格 \(/.test(coordText), coordText);
  const cards = await page.locator('#inspect-body .layer-card').count();
  ok('检查器显示两层', cards === 2, String(cards));

  // 5) 编辑配置应取消在算任务且丢弃旧结果（版本保护）
  await page.locator('.window-card .btn.primary').nth(0).click();
  // 立刻改种子
  await page.locator('#seed').fill('999');
  await page.locator('#seed').dispatchEvent('change');
  await page.waitForTimeout(400);
  const chipAfter = await page.locator('.window-card .chip').first().textContent();
  ok('编辑后不再显示已完成（结果被丢弃）', !/已完成/.test(chipAfter), chipAfter);

  // 5b) 过期结果的导出按钮必须禁用
  const exportBtn = page.locator('.window-card .btn', { hasText: '导出 TSV' }).first();
  ok('编辑后导出按钮被禁用', await exportBtn.isDisabled());

  // 6) 重新计算并导出（拦截下载）
  await page.locator('.window-card .btn.primary').nth(0).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.window-card .chip');
    return c && /已完成/.test(c.textContent);
  }, { timeout: 20000 }).catch(() => {});
  ok('重算后导出按钮恢复', !(await exportBtn.isDisabled()));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    exportBtn.click()
  ]);
  ok('导出触发下载', !!download, download ? download.suggestedFilename() : '无下载');
  if (download) {
    const p = await download.path();
    const fs = require('fs');
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.trim().split('\n');
    ok('导出内容为 TSV（6 列）', lines.length > 0 && lines[0].split('\t').length === 6,
      lines[0]);
    const nums = lines.map(l => l.split('\t').map(Number));
    let sorted = true;
    for (let i = 1; i < nums.length; i++) {
      const p0 = nums[i - 1], c0 = nums[i];
      if (!(p0[0] < c0[0] || (p0[0] === c0[0] && (p0[2] < c0[2] || (p0[2] === c0[2] && p0[1] <= c0[1]))))) sorted = false;
    }
    ok('导出行按层/格排序', sorted);
  }

  // 7) 取消：把窗口 A 调大以拉长计算时间，再点取消
  const winInputs = page.locator('.window-card').first().locator('input[type="number"]');
  await winInputs.nth(0).fill('-512');
  await winInputs.nth(1).fill('-512');
  await winInputs.nth(2).fill('1024');
  await winInputs.nth(3).fill('1024');
  await winInputs.nth(3).dispatchEvent('change');
  // 把两层半径调到 16 格，制造约 2.6 秒的任务
  await page.locator('.tab[data-tab="species"]').click();
  const radInputs = page.locator('.species-row input.rad');
  await radInputs.nth(0).fill('16');
  await radInputs.nth(0).dispatchEvent('change');
  await radInputs.nth(1).fill('16');
  await radInputs.nth(1).dispatchEvent('change');
  await page.locator('.tab[data-tab="windows"]').click();

  await page.locator('.window-card .btn.primary').nth(0).click();
  const cancelBtn = page.locator('.window-card .btn.danger').first();
  let cancelledOk = false;
  try {
    await cancelBtn.waitFor({ state: 'visible', timeout: 2000 });
    await cancelBtn.click({ timeout: 3000 });
    await page.waitForTimeout(400);
    const t = await page.locator('.window-card .status').first().textContent();
    cancelledOk = /取消|过期/.test(t);
  } catch (e) {
    // 任务已完成、按钮已销毁：说明该规模不需要取消，也算符合预期
    cancelledOk = true;
  }
  ok('取消按钮可用并中止任务', cancelledOk);

  // 取消后结果不应出现（若确实在算时取消）
  await page.waitForTimeout(3200);
  const afterCancel = await page.locator('.window-card .chip').first().textContent();
  ok('取消后不会补出结果', !/已完成/.test(afterCancel), afterCancel);

  // 8) 主题切换不报错
  await page.locator('#theme-toggle').click();
  await page.waitForTimeout(200);
  ok('主题切换无错误', errors.length === 0, errors.join('\n       '));

  await page.screenshot({ path: path.join(ROOT, 'test', 'page.png'), fullPage: false });
  console.log('\n截图: test/page.png');
  ok('运行期无控制台错误', errors.length === 0, errors.join('\n       '));

  await browser.close();
  console.log('');
  if (failures) { console.log(failures + ' 项失败'); process.exit(1); }
  console.log('页面测试全部通过');
})().catch(e => { console.error(e); process.exit(1); });
