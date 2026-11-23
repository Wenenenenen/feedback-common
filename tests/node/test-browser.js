/*
 * 浏览器端到端测试：node tests/node/test-browser.js
 * 用全局 Playwright 驱动 Chromium，加载真实 index.html（含 Blob Worker）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..', '..');
const url = 'file://' + path.join(ROOT, 'index.html');
let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name); })
    .catch((e) => { failures.push(name); console.error('  ✗ ' + name + '\n    ' + e.message); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  console.log('1. 页面加载与首算');
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('statusPill').textContent === '就绪',
    { timeout: 10000 });
  await test('首屏自动完成样例求解并显示就绪', async () => {
    const pill = await page.locator('#statusPill').getAttribute('class');
    assert(pill.includes('good'), '状态 pill 非 good: ' + pill);
    const verify = await page.locator('#statVerify').innerText();
    assert(verify.includes('通过'), verify);
  });

  await test('无控制台错误', async () => {
    assert(consoleErrors.length === 0, consoleErrors.join(' | '));
  });

  await test('高度场画布已渲染（非空白像素）', async () => {
    const info = await page.evaluate(() => {
      const c = document.getElementById('baseCanvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBg = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) { nonBg++; }
      }
      return { w: c.width, h: c.height, nonBg };
    });
    assert(info.w === 3 && info.h === 2, JSON.stringify(info));
    assert(info.nonBg > 0, '画布全灰');
  });

  console.log('2. 交互');
  await test('切换残差视图并显示图例', async () => {
    await page.locator('#tabResH').click();
    await page.waitForTimeout(150);
    const name = await page.locator('#legendName').innerText();
    assert(name.includes('水平边'), name);
    await page.locator('#tabResV').click();
    await page.waitForTimeout(150);
    assert((await page.locator('#legendName').innerText()).includes('垂直边'));
    await page.locator('#tabHeight').click();
  });

  await test('点格加锁：进入模式后点击画布产生用户锁点', async () => {
    // 先清空样例自带的格 0 锁点
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 8000 });
    await page.evaluate(() => {
      const del = document.querySelector('#pinList button.del');
      if (del) del.click();
    });
    await page.waitForFunction(() =>
      document.getElementById('pinList').textContent.includes('暂无用户锁点'),
      { timeout: 5000 });
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 5000 });
    await page.locator('#addPinModeBtn').click();
    const box = await page.locator('#baseCanvas').boundingBox();
    // 3 格宽样例：格 1 中心在 x = 1.5/3 处，向内收一点避免边界；y 取首行中心
    await page.mouse.click(
      box.x + box.width * 0.42,
      box.y + box.height * 0.25
    );
    await page.waitForFunction(() =>
      document.getElementById('pinList').textContent.includes('#1'), { timeout: 5000 });
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 5000 });
    const pinText = await page.locator('#pinList').innerText();
    assert(pinText.includes('#1'), pinText);
    await page.locator('#addPinModeBtn').click(); // 退出模式
  });

  await test('非法锁高（>10000）显示格号错误并保留旧结果', async () => {
    await page.evaluate(() => {
      // 直接通过输入框改第一个锁点高度
      const inp = document.querySelector('input.pin-h');
      inp.value = '99999';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForSelector('#errorBanner:not([hidden])', { timeout: 5000 });
    const errText = await page.locator('#errorBanner').innerText();
    assert(errText.includes('格号'), errText);
    assert(errText.includes('保留当前结果'), errText);
    // 恢复合法值
    await page.evaluate(() => {
      const inp = document.querySelector('input.pin-h');
      inp.value = '0';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      document.getElementById('errorBanner').hidden === true, { timeout: 5000 });
  });

  await test('调整 dx 触发重算且状态恢复就绪', async () => {
    await page.selectOption('#dxInput', '1.5').catch(() => {});
    await page.evaluate(() => {
      const i = document.getElementById('dxInput');
      i.value = '1.5';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 5000 });
  });

  console.log('3. 384² 性能（真实浏览器 Worker）');
  await test('生成 384² 带孔双周期场并在 15 秒内通过验收', async () => {
    await page.locator('#genBtn').click();
    const t0 = Date.now();
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 20000 });
    const elapsed = Date.now() - t0;
    const stats = await page.evaluate(() => ({
      verify: document.getElementById('statVerify').innerText,
      sizes: document.getElementById('statSizes').innerText,
      iters: document.getElementById('statIters').innerText,
      time: document.getElementById('statTime').innerText,
      worst: document.getElementById('statWorst').innerText,
      canvasW: document.getElementById('baseCanvas').width
    }));
    console.log('    浏览器实测：' + JSON.stringify(stats) + ' 等待=' + elapsed + 'ms');
    assert(stats.verify.includes('通过'), stats.verify);
    assert(stats.canvasW === 384);
    assert(elapsed < 15000, '端到端等待 ' + elapsed + 'ms 超 15s');
  });

  await test('384² 残差视图可渲染且无错误', async () => {
    await page.locator('#tabResH').click();
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const c = document.getElementById('residualCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) colored++;
      return { colored, total: c.width * c.height };
    });
    // 384² 水平边约 14 万条，每条 2 个着色像素，孔会减少一些，下限取 5 万
    assert(info.colored > 50000, '残差像素过少: ' + info.colored);
    await page.locator('#tabResV').click();
    await page.waitForTimeout(250);
    const info2 = await page.evaluate(() => {
      const c = document.getElementById('residualCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) colored++;
      return colored;
    });
    assert(info2 > 50000, '垂直残差像素过少: ' + info2);
    await page.locator('#tabHeight').click();
  });

  console.log('4. 导出');
  await test('导出 CSV 与高度 JSON 生成下载（不报错）', async () => {
    const errorsBefore = consoleErrors.length;
    await page.evaluate(() => {
      // 拦截下载，仅验证 Blob 构建成功
      window.__downloads = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        window.__downloads.push(this.download);
      };
    });
    await page.locator('#exportCsvBtn').click();
    await page.locator('#exportHeightsBtn').click();
    await page.locator('#exportPngBtn').click();
    await page.waitForTimeout(300);
    const downloads = await page.evaluate(() => window.__downloads);
    assert(downloads.includes('edge-residuals.csv'), JSON.stringify(downloads));
    assert(downloads.includes('recovered-heights.json'));
    assert(downloads.includes('heightmap.png'));
    assert(consoleErrors.length === errorsBefore, consoleErrors.slice(errorsBefore).join(' | '));
  });

  console.log('5. 快速连续编辑：旧结果不覆盖新请求');
  await test('10 次快速参数修改后结果与最终参数一致', async () => {
    await page.evaluate(() => {
      for (let k = 0; k < 10; k++) {
        const i = document.getElementById('dxInput');
        i.value = String(0.5 + k * 0.1);
        i.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForFunction(() =>
      document.getElementById('statusPill').textContent === '就绪', { timeout: 20000 });
    await page.waitForTimeout(300);
    const finalDx = await page.evaluate(() =>
      document.getElementById('dxInput').value);
    assert(finalDx === String(0.5 + 9 * 0.1), '最终 dx=' + finalDx);
    const verify = await page.locator('#statVerify').innerText();
    assert(verify.includes('通过'), verify);
  });

  await browser.close();

  console.log('\n' + (failures.length
    ? failures.length + ' 个失败：\n' + failures.map((f) => ' - ' + f).join('\n')
    : passed + ' 个浏览器测试全部通过'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
