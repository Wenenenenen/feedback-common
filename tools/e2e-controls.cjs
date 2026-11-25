const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const ROOT = path.join(__dirname, '..', 'web');
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) fail++; };
const srv = http.createServer((q, r) => {
  let rel = q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0].replace(/^\/+/, '');
  const f = path.normalize(path.join(ROOT, rel));
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    r.end(d);
  });
});
(async () => {
  await new Promise((r) => srv.listen(21192, '127.0.0.1', r));
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:21192/');
  await p.waitForFunction(() => document.body.dataset.ready === '1');

  // 选中 legacy gain[0]
  await p.evaluate(() => Rebinder.selectPath('legacy', 'gain[0]'));
  ok(await p.$('#hex-word') !== null, 'inspector renders hex-word');
  // raw bytes edit
  await p.fill('#raw-bytes', '11 22 33 44');
  await p.click('#btn-edit-raw');
  ok((await p.evaluate(() => Rebinder.dumpHex(0, 4))) === '11223344', 'raw edit writes address-order bytes');
  // hex word edit on little endian
  await p.fill('#hex-word', 'deadbeef');
  await p.click('#btn-edit-hex');
  ok((await p.evaluate(() => Rebinder.dumpHex(0, 4))) === 'efbeadde', 'word edit LE');
  // invalid hex shows error but no throw
  await p.fill('#hex-word', 'zzz');
  await p.click('#btn-edit-hex');
  ok((await p.textContent('#status')).includes('十六进制值非法'), 'invalid hex error');

  // JSON pairs
  await p.fill('#pairs-json', '[["legacy","reload"]]');
  await p.click('#btn-apply-json');
  ok((await p.evaluate(() => Rebinder.getPairs().length)) === 1, 'json pair applied');
  // bad json
  await p.fill('#pairs-json', '[[nope]]');
  await p.click('#btn-apply-json');
  ok((await p.textContent('#status')).length > 0, 'bad json reported');

  // hex tab + paging controls
  await p.click('#tab-hex');
  await p.fill('#hex-jump', '96');
  await p.click('#hex-goto');
  const pageTxt = await p.textContent('#hex-page');
  ok(pageTxt.includes('0..143'), 'hex single page range: ' + pageTxt);
  ok(await p.$eval('#hex-prev', (b) => b.disabled), 'prev disabled on first page');
  // offset query button
  await p.fill('#offset-input', '0x54');
  await p.click('#btn-offset-query');
  ok((await p.$$eval('#query-results .q-card', (n) => n.length)) >= 1, 'offset 0x54 query card');

  // tree tab expand basis and click leaf
  await p.click('#tab-tree');
  const rows = await p.$$('#tree .t-row');
  for (const r of rows) { const n = await r.$('.t-name'); if (n && (await n.textContent()) === 'basis') { await r.click(); break; } }
  await p.waitForTimeout(50);
  const leaf = await p.$('#tree .t-row.leaf[data-path="basis.m[0][0]"]');
  ok(!!leaf, 'basis matrix leaves rendered');
  await leaf.click();
  const inspPath = await p.textContent('#inspector');
  ok(inspPath.includes('basis.m[0][0]'), 'inspector shows clicked leaf path');

  // keyboard undo several
  await p.keyboard.press('Control+z');
  await p.keyboard.press('Control+y');
  ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  await b.close(); srv.close();
  console.log(fail ? fail + ' FAIL' : 'UI CONTROLS ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
