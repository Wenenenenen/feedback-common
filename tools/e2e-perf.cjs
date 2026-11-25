/* 真实浏览器：ZIP 上传主路径 + 满额 500 万迁移计时 + 导出逐字节核对。
 * node tools/e2e-perf.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..', 'web');
const CACHE = path.join(__dirname, '..', '.cache');
const ZIP = path.join(__dirname, '..', 'samples', 'shader-block-cases.zip');
const PORT = 21189;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) failures++; };

const server = http.createServer((req, res) => {
  let rel = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /* ---- 原始 zip 通过文件输入上传（QA 主路径） ---- */
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.Rebinder, { timeout: 8000 });
  await page.setInputFiles('#file-archive', ZIP);
  await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 8000 });
  let names = await page.evaluate(() => Rebinder.views().map((v) => v.name));
  check(JSON.stringify(names) === JSON.stringify(['legacy', 'reload']), 'zip upload yields sample views');
  const zipStatus = await page.textContent('#status');
  check(/已导入/.test(zipStatus), 'status reports imported: ' + zipStatus.slice(0, 60));

  /* ---- 满额用例：多文件输入 layout.json + dump.bin ---- */
  await page.setInputFiles('#file-import', [
    path.join(CACHE, 'perf-layout.json'),
    path.join(CACHE, 'perf-dump.bin'),
  ]);
  await page.waitForFunction(() => Rebinder.views().length === 64, { timeout: 20000 });
  const dumpLen = await page.evaluate(() => Rebinder.summary().dumpLength);
  check(dumpLen === 64 * 1024 * 1024, 'dump exactly 64MiB, got ' + dumpLen);

  const pairs = JSON.parse(fs.readFileSync(path.join(CACHE, 'perf-pairs.json'), 'utf8'));
  check(pairs.length === 64, '64 pairs');
  await page.evaluate((p) => Rebinder.setPairs(p), pairs);

  // 真实点击提交 -> status ok
  const t0 = Date.now();
  await page.click('#btn-run-batch');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('ok'), { timeout: 30000 });
  const wall = Date.now() - t0;
  const timing = await page.textContent('#timing');
  console.log('   wall click->ok =', wall, 'ms;', timing);
  check(/5,000,000/.test(timing), 'timing reports 5,000,000 writes: ' + timing);
  check(wall < 6000, `browser submit->queryable ${wall}ms < 6000ms`);

  // 提交后立即可查询
  const qok = await page.evaluate(() => {
    const q = Rebinder.queryOffset(5_000_000);
    return q.length >= 1 && q.every((x) => x.view && (x.padding || !!x.path));
  });
  check(qok, 'queryable immediately after batch');

  /* ---- 导出并与独立参考逐字节比较 ---- */
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const out = path.join(os.tmpdir(), 'rb-perf-export.bin');
  await dl.saveAs(out);
  const actual = fs.readFileSync(out);
  const expected = fs.readFileSync(path.join(CACHE, 'perf-expected.bin'));
  check(actual.length === expected.length, 'export length 64MiB');
  let diff = -1;
  if (!actual.equals(expected)) {
    // 找第一个不同字节
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n; i++) if (actual[i] !== expected[i]) { diff = i; break; }
  }
  check(diff === -1, 'export matches independent reference byte-for-byte' + (diff >= 0 ? ` first diff @${diff}: ${actual[diff].toString(16)} vs ${expected[diff].toString(16)}` : ''));

  /* ---- 撤销后应回到批前（重新上传的文件字节） ---- */
  await page.keyboard.press('Control+z');
  const undoHex = await page.evaluate(() => Rebinder.dumpHex(0, 8));
  check(undoHex === '0000001001000010', 'undo restores first src bytes, got ' + undoHex);

  await page.screenshot({ path: path.join(CACHE, 'perf.png') });
  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
  await browser.close();
  server.close();
  console.log(`\n${failures === 0 ? 'ALL PERF E2E PASS' : failures + ' FAILURES'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
