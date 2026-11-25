const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const ROOT = path.join(__dirname, '..', 'web');
const srv = http.createServer((q, r) => { let f = path.join(ROOT, q.url === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { r.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/css'.length && f.endsWith('.css') ? 'text/css' : 'text/html'); r.end(d); }); });
(async () => {
  await new Promise((r) => srv.listen(21191, '127.0.0.1', r));
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 1050 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:21191/');
  await p.waitForFunction(() => document.body.dataset.ready === '1');
  // 定位 AP 风格路径并打开 hex
  await p.fill('#path-input', 'basis.m[1][2]');
  await p.click('#btn-path-locate');
  await p.click('#tab-hex');
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(__dirname, '..', '.cache', 'hex-inspector.png') });
  // 点击 hex 第 21 字节附近（legacy 填充）
  await p.evaluate(() => Rebinder.setOffsetQuery(21));
  await p.waitForTimeout(100);
  await p.screenshot({ path: path.join(__dirname, '..', '.cache', 'hex-offset21.png') });
  // 展开树并截图
  await p.click('#tab-tree');
  await p.evaluate(() => { document.querySelectorAll('#tree .t-row').forEach((r) => { const k = r.parentElement.querySelector('.hidden-kids'); if (k) { k.style.display = 'block'; k.dataset.built = '1'; r.querySelector('.t-toggle').textContent = '▾'; } }); });
  // trigger lazy build by clicking root rows
  await p.reload();
  await p.waitForFunction(() => document.body.dataset.ready === '1');
  await p.click('#tab-tree');
  for (const name of ['gain', 'basis']) {
    const rows = await p.$$('#tree .t-row');
    for (const r of rows) {
      const t = await r.$('.t-name');
      if (t && (await t.textContent()) === name) { await r.click(); break; }
    }
  }
  await p.waitForTimeout(100);
  await p.screenshot({ path: path.join(__dirname, '..', '.cache', 'tree.png') });
  console.log('errors', errs);
  await b.close(); srv.close();
})();
