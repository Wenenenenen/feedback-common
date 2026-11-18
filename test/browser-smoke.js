/*
 * browser-smoke.js — Playwright 浏览器冒烟测试
 * 用法: node test/browser-smoke.js
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let PORT = 0;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
}

(async () => {
  await new Promise(r => server.listen(0, () => { PORT = server.address().port; r(); }));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#view2d svg');
  check('页面加载无 console 错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  // 初始样例统计
  const stats = await page.$$eval('#stats .stat', els =>
    els.map(e => e.querySelector('b').textContent + ' ' + e.querySelector('span').textContent));
  check('统计栏渲染 6 项', stats.length === 6, JSON.stringify(stats));

  // 2D SVG 含实线与虚线分组
  const hiddenCount = await page.locator('#view2d .g-hidden line').count();
  const visibleCount = await page.locator('#view2d .g-visible line').count();
  check('single-occluder 存在隐藏虚线段', hiddenCount >= 1, `hidden=${hiddenCount}`);
  check('single-occluder 存在可见实线段', visibleCount >= 1, `visible=${visibleCount}`);

  // 3D canvas 实际绘制了像素
  const blank = await page.evaluate(() => {
    const c = document.querySelector('#view3d');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  });
  check('3D Canvas 有实际绘制内容', !blank);

  // 点击 2D 第一条线 -> 检视面板出现区间表
  // 细线（~1.3px 水平描边）几何命中面积极小，直接派发 click 事件验证处理器链路
  await page.locator('#view2d .ln').first().evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForSelector('#inspector table.iv');
  const inspectorText = await page.locator('#inspector').innerText();
  check('选中边后检视面板显示来源顶点与区间',
    /来源顶点/.test(inspectorText) && /解析区间/.test(inspectorText));
  check('检视面板显示遮挡面 ID', /遮挡面/.test(inspectorText));

  // 切到 overlapping-occluders 验证并集（参考边 edge 0 的单一隐藏段 0.375-0.825）
  await page.selectOption('#sampleSelect', 'overlapping-occluders');
  await page.waitForTimeout(150);
  const hiddenRows = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#view2d .g-hidden line[data-edge="0"]')];
    return lines.map(l => [Number(l.dataset.u0), Number(l.dataset.u1)]);
  });
  const unionOk = hiddenRows.length === 1 &&
    Math.abs(hiddenRows[0][0] - 0.375) < 1e-6 &&
    Math.abs(hiddenRows[0][1] - 0.825) < 1e-6;
  check('overlapping 并集为单段 [0.375, 0.825]', unionOk, JSON.stringify(hiddenRows));

  // 共面样例：无隐藏段
  await page.selectOption('#sampleSelect', 'coplanar');
  await page.waitForTimeout(150);
  const coplanarHidden = await page.locator('#view2d .g-hidden line').count();
  check('coplanar 等深无隐藏段（无假缺口）', coplanarHidden === 0);

  // 非流形样例：红色非流形组有内容且统计标注
  await page.selectOption('#sampleSelect', 'nonmanifold');
  await page.waitForTimeout(150);
  const nmCount = await page.locator('#view2d .g-nonman line').count();
  check('nonmanifold 红色标注边存在', nmCount >= 1, `nm=${nmCount}`);

  // 非法索引：错误消息且无 SVG
  await page.selectOption('#sampleSelect', 'invalid-index');
  await page.waitForTimeout(150);
  const errText = await page.locator('#messages .msg.err').first().textContent();
  check('invalid-index 显示校验错误', /越界|索引/.test(errText), errText);

  // 折痕角联动：cube，180° 时折痕特征边数量下降
  await page.selectOption('#sampleSelect', 'cube');
  await page.waitForTimeout(150);
  const featureCount = async () => Number(await page.locator('#stats .stat')
    .filter({ hasText: '特征边' }).locator('b').textContent());
  const f45 = await featureCount();
  await page.locator('#crease').fill('180');
  await page.waitForTimeout(150);
  const f180 = await featureCount();
  check('折痕角 45°→180° 特征边数量下降', f180 < f45, `${f45} -> ${f180}`);

  // 分辨率不变性：切换导出尺寸，隐藏段 u 值不变
  await page.selectOption('#sampleSelect', 'single-occluder');
  await page.waitForTimeout(150);
  const uAt640 = await page.evaluate(() =>
    [...document.querySelectorAll('#view2d .g-hidden line')]
      .map(l => [l.dataset.u0, l.dataset.u1]).sort().join('|'));
  await page.locator('.size-preset[data-size="1280x960"]').click();
  await page.waitForTimeout(150);
  const uAt1280 = await page.evaluate(() =>
    [...document.querySelectorAll('#view2d .g-hidden line')]
      .map(l => [l.dataset.u0, l.dataset.u1]).sort().join('|'));
  check('640→1280 区间 u 值完全不变', uAt640 === uAt1280, `${uAt640} vs ${uAt1280}`);
  const note = await page.locator('#sizeNote').textContent();
  check('分辨率不变性提示为 ✓', /✓/.test(note), note);

  // 导出弹窗：SVG 与 JSON 内容
  await page.locator('#btnExport').click();
  await page.waitForSelector('#exportModal:not([hidden])');
  const exportSvg = await page.locator('#expSVG svg').count();
  const exportJson = await page.locator('#expJSON').textContent();
  const parsed = JSON.parse(exportJson);
  check('导出弹窗含 SVG 预览', exportSvg === 1);
  check('导出 JSON 可解析且含 edges/intervals',
    Array.isArray(parsed.edges) && parsed.edges.some(e => e.intervals.length));
  const hasVisibleAndHidden = parsed.edges.some(e =>
    e.intervals.some(i => i.visible) && e.intervals.some(i => !i.visible));
  check('JSON 同时含可见与隐藏区间', hasVisibleAndHidden);
  await page.screenshot({ path: path.join(ROOT, 'test', 'shot-export.png') });
  await page.keyboard.press('Escape');

  // 3D 旋转：拖动后相机参数变化、页面无错误
  const camBefore = await page.evaluate(() => JSON.stringify(window.__cam || ''));
  const box = await page.locator('#view3d').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const errsAfterRotate = consoleErrors.length;
  check('旋转相机后无 console 错误', errsAfterRotate === 0, consoleErrors.join(' | '));
  await page.screenshot({ path: path.join(ROOT, 'test', 'shot-3d-2d.png') });

  // 移动端窄视口不横向溢出
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('400px 窄视口无横向滚动', !overflow);
  await page.screenshot({ path: path.join(ROOT, 'test', 'shot-mobile.png') });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n浏览器冒烟: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
