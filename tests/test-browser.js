/* 浏览器端到端验证：起本地静态服务，用 Playwright 驱动真实页面 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0].replace(/\.\./g, '');
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(8753, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 980 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
    if (!cond) failures++;
  };

  try {
    await page.goto('http://localhost:8753/', { waitUntil: 'networkidle' });
    await sleep(800);
    check('Three.js CDN 加载', await page.evaluate(() => typeof window.THREE === 'function' || typeof window.THREE === 'object'));
    check('LODCore 加载', await page.evaluate(() => !!window.LODCore));
    check('LODView 加载', await page.evaluate(() => !!window.LODView));
    check('默认 torus 自动载入', (await page.textContent('#sourcePill')).includes('1024'));
    check('原网格 meta 显示', (await page.textContent('#origMeta')).includes('1024'));
    check('WebGL 画布存在', await page.locator('#origCanvas canvas').count() === 1);

    // 50% 比例简化
    await page.fill('#ratioInput', '50');
    await page.click('#runBtn');
    await page.waitForFunction(() => !document.getElementById('exportMeshBtn').disabled, null, { timeout: 15000 });
    await sleep(400);
    const dstF = await page.textContent('#stDstF');
    check('50% 简化到 512 面', dstF.startsWith('512'), dstF);
    check('状态药丸=达到目标', (await page.textContent('#simpStatusPill')).includes('达到目标'));
    const rms = await page.textContent('#stRms');
    const maxd = await page.textContent('#stMaxD');
    check('RMS/max 距离已显示', /^[\d.e+-]+$/i.test(rms.trim()) && /^[\d.e+-]+$/i.test(maxd.trim()), 'rms=' + rms + ' max=' + maxd);
    check('简化视图有画布', await page.locator('#simpCanvas canvas').count() === 1);
    check('无控制台错误', errors.length === 0, errors.join(' | '));

    // 热图
    await page.check('#heatToggle');
    await sleep(300);
    check('热图图例显示', await page.locator('#origLegend.show').count() === 1);
    await page.uncheck('#heatToggle');

    // 线框/锁定开关
    await page.uncheck('#origWire');
    await page.uncheck('#simpWire');
    check('线框开关可切换', true);
    await page.check('#origWire'); await page.check('#simpWire');

    // 极端目标 -> 约束停止
    await page.locator('.radio-row label').filter({ hasText: '目标面数' }).click();
    await page.fill('#countInput', '4');
    await page.click('#runBtn');
    await sleep(2500);
    const pill = await page.textContent('#simpStatusPill');
    check('极端目标触发约束停止', pill.includes('约束停止'), pill);
    const reason = await page.textContent('#stopReasonText');
    check('停止原因非空且诚实', reason.length > 10, reason);
    check('结果面数大于目标', parseInt((await page.textContent('#stDstF'))) > 4);

    // 取消：在同一个同步任务里点运行+取消，取消标志在 simplify 启动（30ms 延迟）前置位
    await page.fill('#countInput', '10');
    await page.evaluate(() => {
      document.getElementById('runBtn').click();
      document.getElementById('cancelBtn').click();
    });
    await sleep(600);
    const errText = await page.textContent('#errorBox');
    check('取消提示保留上次结果', errText.includes('取消') && errText.includes('上次完整结果'));
    check('上次结果仍可导出', (await page.locator('#exportMeshBtn').isEnabled()));

    // 非流形样例被拒绝
    await page.selectOption('#sampleSelect', 'data/invalid-nonmanifold.json');
    await sleep(500);
    const err2 = await page.textContent('#errorBox');
    check('非流形输入被拒绝', err2.includes('非流形'));
    check('错误带位置', err2.includes('边') || err2.includes('顶点'));
    check('开始按钮禁用', await page.locator('#runBtn').isDisabled());

    // 非法目标输入
    await page.selectOption('#sampleSelect', 'data/locked-quad.json');
    await sleep(400);
    await page.locator('.radio-row label').filter({ hasText: '目标面数' }).click();
    await page.fill('#countInput', '0');
    await page.click('#runBtn');
    await sleep(200);
    check('目标面数 0 被拒绝', (await page.textContent('#errorBox')).includes('目标面数'));

    // 导出内容结构
    await page.fill('#countInput', '2');
    await page.click('#runBtn');
    await sleep(800);
    await page.click('#exportMeshBtn');
    await sleep(200);
    const exportText = await page.inputValue('#modalText');
    const parsed = JSON.parse(exportText);
    check('导出网格含 materials/vertexMap',
      Array.isArray(parsed.materials) && Array.isArray(parsed.vertexMap) && Array.isArray(parsed.faces));
    check('locked-quad 导出仍为 2 面', parsed.faces.length === 2);
    await page.click('#modalClose');
    await page.click('#exportStatsBtn');
    await sleep(200);
    const stats = JSON.parse(await page.inputValue('#modalText'));
    check('统计含 stopReason/distance/collapseLog',
      !!stats.stopReason && typeof stats.distance.rms === 'number' && Array.isArray(stats.collapseLog));
    await page.click('#modalClose');

    // 截图（桌面）
    await page.selectOption('#sampleSelect', 'data/torus.json');
    await sleep(600);
    await page.locator('.radio-row label').filter({ hasText: '保留比例' }).click();
    await page.fill('#ratioInput', '40');
    await page.click('#runBtn');
    await page.waitForFunction(() => !document.getElementById('exportMeshBtn').disabled, null, { timeout: 15000 });
    await page.check('#heatToggle');
    await sleep(500);
    await page.screenshot({ path: path.join(__dirname, 'shot-desktop.png') });
    check('桌面截图已保存', true);

    // 手机宽度
    await page.setViewportSize({ width: 400, height: 860 });
    await sleep(400);
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check('手机宽度无横向滚动', noHScroll);
    await page.screenshot({ path: path.join(__dirname, 'shot-mobile.png') });

    check('全程无控制台错误', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures++;
    console.error('测试异常:', e);
  } finally {
    await browser.close();
    server.close();
    console.log('\n' + (failures ? failures + ' 项失败' : '浏览器端到端全部通过'));
    process.exit(failures ? 1 : 0);
  }
})();
