// 端到端测试：真实 Chromium 加载 index.html，覆盖导入/渲染/切帧/选像素/导出/坏输入
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n  ', e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file://' + path.join(ROOT, 'index.html'));

  await test('初始状态导出按钮禁用', async () => {
    await page.waitForSelector('#export-btn[disabled]');
  });

  // 导入样例 ZIP
  await page.setInputFiles('#file-input', path.join(ROOT, 'samples/polarimetric-stokes-cases.zip'));
  await page.waitForFunction(() => window.StokesApp.state.result !== null, null, { timeout: 8000 });

  await test('导入后渲染帧清单与项目信息', async () => {
    const info = await page.textContent('#project-info');
    if (!/72×56/.test(info)) throw new Error('项目信息错误: ' + info);
    const frames = await page.$$eval('.frame-item', (els) => els.length);
    if (frames !== 6) throw new Error('应有 6 个帧项，实际 ' + frames);
  });

  await test('三张图都能渲染且画布有非空像素', async () => {
    for (const view of ['intensity', 'dolp', 'angle']) {
      await page.click('button[data-view="' + view + '"]');
      await page.waitForTimeout(120);
      const nonEmpty = await page.evaluate(() => {
        const c = document.getElementById('view');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) n++;
        return n;
      });
      if (nonEmpty < 1000) throw new Error(view + ' 画布几乎为空: ' + nonEmpty);
    }
  });

  await test('灰度模式可切换', async () => {
    await page.click('button[data-mode="gray"]');
    await page.waitForTimeout(100);
    const gray = await page.evaluate(() => {
      const c = document.getElementById('view');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // 采样若干非品红像素，检查 R=G=B
      let checked = 0;
      for (let i = 0; i < d.length; i += 4) {
        const isMagenta = d[i] > 150 && d[i + 1] < 60 && d[i + 2] > 150;
        if (isMagenta) continue;
        if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) return false;
        if (++checked > 500) break;
      }
      return true;
    });
    if (!gray) throw new Error('灰度模式存在彩色像素');
    await page.click('button[data-mode="color"]');
  });

  await test('点击像素出现明细表，含各帧读数/预测/残差', async () => {
    await page.click('button[data-view="intensity"]');
    const box = await page.locator('#view').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForSelector('table.detail tr');
    const rows = await page.$$eval('table.detail tbody tr', (els) => els.length);
    if (rows !== 6) throw new Error('明细表应有 6 行，实际 ' + rows);
    const headers = await page.$$eval('table.detail th', (els) => els.map((e) => e.textContent));
    for (const need of ['实测码值', '未截断预测', '残差']) {
      if (!headers.includes(need)) throw new Error('缺少列 ' + need);
    }
    // 至少一个普通帧有残差值
    const residualCells = await page.$$eval('table.detail tbody td:nth-child(5)', (els) =>
      els.map((e) => e.textContent).filter((t) => t.trim() !== '—' && t.trim() !== ''));
    if (residualCells.length === 0) throw new Error('没有任何残差值');
  });

  await test('切换帧触发重算且导出 enabled 更新', async () => {
    const cb = page.locator('.frame-item input[data-i="0"]');
    await cb.uncheck({ force: true });
    await page.waitForFunction(() => {
      const r = window.StokesApp.state.result;
      return r && !r.enabled.includes(0);
    }, null, { timeout: 8000 });
    const ex = await page.evaluate(() => window.StokesApp.buildExportJSON());
    if (ex.enabled.includes(0)) throw new Error('导出仍含已禁用帧 0');
  });

  await test('重算中快速切换两次，最终结果与最新设置一致', async () => {
    async function clickSwitch(i) {
      const item = page.locator('.frame-item').nth(i);
      await item.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await item.locator('.switch .track').click();
    }
    await clickSwitch(0); // 重新启用帧0
    await clickSwitch(1); // 关
    await clickSwitch(1); // 立刻还原
    await page.waitForFunction(() => !window.StokesApp.state.running, null, { timeout: 8000 });
    const enabled = await page.evaluate(() => window.StokesApp.state.result.enabled);
    if (enabled.includes(1) === false) throw new Error('帧1 应重新启用');
  });

  await test('导出按钮可点击并产出 JSON 下载', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-btn'),
    ]);
    const tmp = '/tmp/e2e-export.json';
    await download.saveAs(tmp);
    const d = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (d.width !== 72 || d.height !== 56) throw new Error('导出尺寸错');
    if (d.pixels.length !== 72 * 56) throw new Error('导出像素数错');
  });

  await test('坏输入报错且保留当前项目', async () => {
    const before = await page.evaluate(() => window.StokesApp.state.project.width);
    fs.writeFileSync('/tmp/bad.zip', Buffer.from([1, 2, 3, 4]));
    await page.setInputFiles('#file-input', '/tmp/bad.zip');
    await page.waitForSelector('#error-box.show');
    const errText = await page.textContent('#error-text');
    if (!errText || errText.length < 3) throw new Error('错误信息为空');
    const after = await page.evaluate(() => window.StokesApp.state.project.width);
    if (after !== before) throw new Error('坏输入破坏了当前项目');
  });

  await test('字段级错误能指出具体字段', async () => {
    // 构造缺 weight 的 case.json ZIP
    const good = JSON.parse(fs.readFileSync('/tmp/stokes-cases-extract/case.json', 'utf8'));
    delete good.frames[0].weight;
    // 复用已有 pgm，打包
    const { execSync } = require('child_process');
    fs.mkdirSync('/tmp/badcase/frames', { recursive: true });
    fs.writeFileSync('/tmp/badcase/case.json', JSON.stringify(good));
    for (let i = 0; i < 6; i++) {
      fs.copyFileSync('/tmp/stokes-cases-extract/frames/' + String(i).padStart(2, '0') + '.pgm',
        '/tmp/badcase/frames/' + String(i).padStart(2, '0') + '.pgm');
    }
    execSync('cd /tmp/badcase && zip -r -X /tmp/badcase.zip case.json frames >/dev/null');
    await page.setInputFiles('#file-input', '/tmp/badcase.zip');
    await page.waitForSelector('#error-box.show');
    const t = await page.textContent('#error-text');
    if (!/weight/.test(t) || !/frames\[0\]/.test(t)) throw new Error('未指出字段，实际: ' + t);
  });

  await test('无解像素在图上用品红标出', async () => {
    // 经 App API 只保留 2 帧 -> 全图无解（UI 切换路径已由前序用例覆盖）
    await page.evaluate(() => {
      const App = window.StokesApp;
      App.state.enabled = App.state.enabled.map((_, i) => i < 2);
      App.scheduleRecompute();
    });
    await page.waitForFunction(() => {
      const r = window.StokesApp.state.result;
      return r && r.enabled.length === 2 && !window.StokesApp.state.running;
    }, null, { timeout: 8000 });
    const magentaRatio = await page.evaluate(() => {
      const c = document.getElementById('view');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let mag = 0, tot = 0;
      for (let i = 0; i < d.length; i += 4) {
        tot++;
        if (d[i] > 150 && d[i + 1] < 60 && d[i + 2] > 150) mag++;
      }
      return mag / tot;
    });
    if (magentaRatio < 0.95) throw new Error('无解品红占比过低: ' + magentaRatio);
  });

  if (errors.length) {
    console.error('浏览器运行时错误:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('  ok - 无浏览器运行时错误');
    passed++;
  }
  await browser.close();
  console.log('\n' + passed + ' e2e tests passed');
})();
