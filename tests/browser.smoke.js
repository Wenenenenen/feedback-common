// tests/browser.smoke.js — Playwright 端到端冒烟（node tests/browser.smoke.js）
// 验证：页面加载、注入样例 zip、三维 canvas 渲染、面片/增益表、帧联动、导出按钮可用
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.wav': 'audio/wav' };

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const exe = path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:' + port + '/index.html');
  await page.waitForFunction(() => window.SimplexEngine && window.View3D);

  // 注入样例 zip 到文件输入
  const zipPath = path.join(ROOT, 'samples', 'speaker-simplex-cases.zip');
  await page.setInputFiles('#fileInput', zipPath);
  await page.waitForSelector('#exportBtn:not([disabled])');

  const status = await page.textContent('#status');
  if (!status.includes('几何校验通过')) throw new Error('未通过几何校验：' + status);
  console.log('状态：', status.trim());

  // 增益表有 6 行，首帧激活 id 1/3/5
  await page.waitForFunction(() => document.querySelectorAll('#gainBody tr').length === 6);
  const activeRows = await page.$$eval('#gainBody tr.active', (trs) =>
    trs.map((t) => t.firstElementChild.textContent));
  if (JSON.stringify(activeRows) !== JSON.stringify(['1', '3', '5'])) {
    throw new Error('首帧激活声道错误：' + activeRows);
  }
  console.log('首帧激活声道 id：', activeRows.join(', '));

  // canvas 实际绘制了内容（非全透明）
  const painted = await page.evaluate(() => {
    const c = document.getElementById('view3d');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonEmpty = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonEmpty++;
    return nonEmpty > 500;
  });
  if (!painted) throw new Error('三维 canvas 未绘制内容');
  console.log('三维 canvas 已渲染');

  // 拖动帧到中间，面片文字应更新
  await page.fill('#frameSlider', '24000');
  await page.dispatchEvent('#frameSlider', 'input');
  await page.waitForFunction(() => document.getElementById('frameNum').textContent === '24000');
  const face = await page.textContent('#faceVal');
  console.log('frame 24000 面片：', face.trim());

  // 截图存档
  await page.screenshot({ path: path.join(__dirname, 'browser-smoke.png'), fullPage: false });

  // 监听导出下载
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#exportBtn'),
  ]);
  const dlPath = path.join(__dirname, 'export-smoke.wav');
  await download.saveAs(dlPath);
  const stat = fs.statSync(dlPath);
  // 6 声道 float32：44 + 48000*6*4 = 1152044
  if (stat.size !== 44 + 48000 * 6 * 4) throw new Error('导出大小错误：' + stat.size);
  console.log('导出 WAV：', stat.size, '字节，路径', download.suggestedFilename());

  if (errors.length) throw new Error('控制台错误：\n' + errors.join('\n'));
  console.log('\n浏览器冒烟测试通过（无控制台错误）');
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
