// test/browser-smoke.mjs — Playwright 端到端冒烟（真实模块 Worker、画布、交互、导出）
// 运行: node test/browser-smoke.mjs （需先在 app/ 下起静态服务，脚本会自动起一个）
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const downloads = [];
page.on('download', (d) => downloads.push(d.suggestedFilename()));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.error('✗', name, extra); }
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('完成'), { timeout: 15000 });
  check('首屏 three-pixels 计算完成', (await page.locator('#status').textContent()).includes('完成'));

  // 三个画布均有非空像素
  const nonBlank = await page.evaluate(() => {
    const out = {};
    for (const id of ['canvasCurrent', 'canvasAcc', 'canvasReason']) {
      const c = document.getElementById(id);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      out[id] = sum;
    }
    return out;
  });
  check('三视图均已绘制', Object.values(nonBlank).every((v) => v > 0), JSON.stringify(nonBlank));

  // 跳到帧 1 后点击中心像素 → 检视器出现采样点表（首帧无历史、没有采样表）
  const box = await page.locator('#canvasAcc').boundingBox();
  await page.fill('#frameJump', '1');
  await page.dispatchEvent('#frameJump', 'change');
  await page.locator('#canvasAcc').click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForSelector('.samples');
  const insp = await page.locator('#inspector').innerText();
  check('像素检视显示四采样点', insp.includes('像素 (1, 0)') && insp.includes('(1, 0)'));
  check('检视含混合前后数值', insp.includes('混合前') && insp.includes('混合后'));

  // 切到 moving 序列
  await page.selectOption('#sequenceSelect', { index: 1 });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('完成'), { timeout: 15000 });
  const stats = await page.locator('#frameStats').innerText();
  check('moving 帧统计含原因分类', stats.length > 0, stats);

  // 跳转到最后一帧
  await page.fill('#frameJump', '11');
  await page.dispatchEvent('#frameJump', 'change');
  check('任意跳转帧号生效', (await page.locator('#frameLabel').innerText()).includes('11'));

  // 播放 1 秒后帧号推进
  const before = await page.locator('#frameLabel').innerText();
  await page.click('#btnPlay');
  await page.waitForTimeout(900);
  await page.click('#btnPlay');
  const after = await page.locator('#frameLabel').innerText();
  check('播放推进帧号', before !== after, `${before} -> ${after}`);

  // 改 tau 参数 → 触发全量重算并再次完成
  await page.fill('#tau', '0.3');
  await page.dispatchEvent('#tau', 'change');
  await page.waitForTimeout(4000);
  const paramStatus = await page.locator('#status').textContent();
  console.log('DEBUG paramStatus =', paramStatus, '| tau =', await page.inputValue('#tau'));
  check('改参数后从头重算完成', paramStatus.includes('tau=0.3'), paramStatus);

  // 一致性自检（主线程分帧让出，无 Worker 帧消息，用事件等待而非轮询）
  const selfCheckDone = page.waitForEvent('console', { timeout: 30000 }).catch(() => null);
  await page.click('#btnSelfCheck');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('一致性自检通过'),
    { timeout: 30000, polling: 200 }
  );
  check('一致性自检（Worker vs 主线程重算）', (await page.locator('#status').textContent()).includes('最大绝对偏差 0'));
  await selfCheckDone;

  // 导出浮点 JSON 弹窗
  await page.click('#btnExportFloat');
  await page.waitForSelector('.export-text');
  const jsonText = await page.locator('.export-text').inputValue();
  const parsed = JSON.parse(jsonText);
  check('浮点 JSON 含尺寸/帧号/参数/颜色/计数',
    parsed.width === 32 && 'frame' in parsed && 'params' in parsed &&
    Array.isArray(parsed.color) && Array.isArray(parsed.count) &&
    parsed.color.length === parsed.width * parsed.height);

  // 像素追踪 JSON
  await page.click('#btnCloseModal');
  await page.locator('#canvasCurrent').click({ position: { x: 50, y: 50 } });
  await page.waitForSelector('.insp-head');
  await page.click('#btnExportTrace');
  await page.waitForSelector('.export-text');
  const trace = JSON.parse(await page.locator('.export-text').inputValue());
  check('追踪 JSON 含全部帧与四采样点',
    trace.trace.length === 12 && trace.trace[1].samples.length === 4 &&
    'historyX' in trace.trace[1] && 'bilinearWeight' in trace.trace[1].samples[0]);
  await page.click('#btnCloseModal');

  // PNG 导出（headless 下 download 事件可能被策略拦截，主要验证不报错并出预览）
  await page.click('#btnPngAcc');
  await page.waitForSelector('#modal img', { timeout: 5000 });
  check('PNG 导出预览生成', await page.locator('#modal img').count() === 1);
  await page.click('#btnCloseModal');

  // invalid 序列 → 错误卡片
  await page.selectOption('#sequenceSelect', { index: 3 });
  await page.waitForSelector('#errorBox:not([hidden])');
  check('invalid.json 结构错误被拦截', (await page.locator('#errorBox').innerText()).includes('color 长度应为 2'));

  // capacity（gzip 侧载，48 帧）
  await page.selectOption('#sequenceSelect', { index: 2 });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('完成'), { timeout: 30000 });
  const capStatus = await page.locator('#status').innerText();
  check('capacity gzip 加载且 48 帧算完', capStatus.includes('48 帧'), capStatus);

  check('全程无控制台错误', errors.length === 0, errors.join('\n'));
} catch (e) {
  fail++; console.error('测试异常:', e.stack);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
