/* 临时 HTTP 冒烟：随机端口静态服务 + Playwright 验证 fetch-zip 内置导入。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require('playwright');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.zip': 'application/zip', '.json': 'application/json', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__ccl && window.__ccl.snapshot().n === 19200, null, { timeout: 10000 });
    // http 下内置按钮应走 fetch zip；重新点一次并观察仍正常
    await page.click('#btn-load-sample');
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => window.__ccl.snapshot());
    const fetchOk = await page.evaluate(async () => {
      const r = await fetch('samples/cyclic-ceiling-cases.zip');
      return r.ok;
    });
    console.log('HTTP smoke snapshot n=', s.n, 'ceiling=', s.settings.ceiling, 'fetchZip=', fetchOk, 'errors=', errs);
    if (s.n !== 19200 || s.settings.ceiling !== 16000 || !fetchOk || errs.length) process.exitCode = 1;
  } catch (e) {
    console.error('HTTP smoke failed', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
