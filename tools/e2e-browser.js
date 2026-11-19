/*
 * Browser end-to-end test: serves web/ over HTTP, drives the real page with
 * Playwright, loads every sample PNG, clicks blocks, and checks exports.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PW_PATH = '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright';
const { chromium } = require(PW_PATH);

const ROOT = path.join(__dirname, '..', 'web');
const CASES = path.join(__dirname, '..', '_cases_extracted');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.dds': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(url.parse(req.url).pathname);
  let rel = p === '/' || p.endsWith('/') ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg); if (!cond) failures++; };

function uploadInput(page, inputId, absPath) {
  return page.setInputFiles('#' + inputId, absPath);
}

async function waitForIdle(page, timeout = 60000) {
  // Wait for the decode canvas to be painted (objective signal, no text matching).
  await page.waitForFunction(() => {
    const cv = document.getElementById('cv-dec');
    if (!cv || !cv.width) return false;
    if (document.getElementById('progress').classList.contains('on')) return false;
    const ctx = cv.getContext('2d');
    return ctx.getImageData(0, 0, cv.width, cv.height).data.some((v) => v !== 0);
  }, { timeout });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#empty-state');
  check(true, 'page loads with empty state');

  // ---- valid PNG: gradient BC1, threshold 39 dB ----
  await uploadInput(page, 'file-png', path.join(CASES, 'gradient.png'));
  await waitForIdle(page);
  const gradPsnr = await page.$eval('#metrics', (el) => el.textContent);
  const m1 = gradPsnr.match(/RGB PSNR\s*([\d.]+)/);
  check(!!m1 && parseFloat(m1[1]) >= 39, `gradient BC1 PSNR ${m1 && m1[1]} >= 39 dB`);

  // canvases rendered
  const imgData = await page.$eval('#cv-src', (cv) => {
    const ctx = cv.getContext('2d');
    return { w: cv.width, h: cv.height, nonZero: ctx.getImageData(0, 0, cv.width, cv.height).data.some((v) => v !== 0) };
  });
  check(imgData.w === 256 && imgData.h === 64 && imgData.nonZero, 'source canvas painted at original size');

  // click a block -> detail panel populates
  await page.click('#cv-src', { position: { x: 20, y: 20 } });
  const detail = await page.$eval('#detail-title', (el) => el.textContent);
  check(/Block \(\d+, \d+\)/.test(detail), 'clicking canvas selects a 4x4 block: ' + detail);
  const idxCells = await page.$$eval('table.idx td', (tds) => tds.length);
  check(idxCells >= 16, 'index grid shows 16 texels');
  const swatches = await page.$$eval('.swatch', (els) => els.length);
  check(swatches === 4, 'four palette swatches shown');

  // ---- cutout BC1: alpha exact, transparent-mode blocks present ----
  await uploadInput(page, 'file-png', path.join(CASES, 'cutout.png'));
  await waitForIdle(page);
  // inspect decoded alpha vs source through page context
  const cutoutAlphaOk = await page.evaluate(() => {
    // Compare source and decoded alpha directly from the displayed canvases.
    const sc = document.getElementById('cv-src').getContext('2d');
    const dc = document.getElementById('cv-dec').getContext('2d');
    const w = sc.canvas.width, h = sc.canvas.height;
    const sd = sc.getImageData(0, 0, w, h).data, dd = dc.getImageData(0, 0, w, h).data;
    for (let i = 3; i < sd.length; i += 4) {
      if (sd[i] === 255 && dd[i] !== 255) return false;
      if (sd[i] === 0 && dd[i] !== 0) return false;
    }
    return true;
  });
  check(cutoutAlphaOk, 'cutout alpha preserved exactly in displayed decode');

  // ---- soft-alpha BC3: switch format, wait for re-encode to finish ----
  await page.click('#fmt-seg button[data-fmt="BC3"]');
  await page.waitForFunction(() => {
    const t = document.getElementById('metrics').textContent;
    return t.includes('BC3') && !document.getElementById('progress').classList.contains('on');
  });
  const softText = await page.$eval('#metrics', (el) => el.textContent);
  check(/Alpha PSNR/.test(softText),
    'BC3 shows Alpha PSNR tile: ' + (softText.match(/Alpha PSNR[\s\d.]+dB/) || ['present'])[0]);
  // detail panel includes alpha sub-block
  await page.click('#cv-src', { position: { x: 40, y: 40 } });
  const alphaDetail = await page.$eval('#detail-alpha', (el) => el.textContent);
  check(/a0 \/ a1/.test(alphaDetail) && /8-interp|6-interp/.test(alphaDetail), 'BC3 block detail shows alpha table and mode');
  const alphaCells = await page.$$eval('.alpha-table .cell', (els) => els.length);
  check(alphaCells === 8, 'eight alpha table entries');

  // ---- odd size: padding indicator ----
  await page.click('#fmt-seg button[data-fmt="BC1"]');
  await uploadInput(page, 'file-png', path.join(CASES, 'odd-30x22.png'));
  await waitForIdle(page);
  await page.waitForFunction(() => {
    const cv = document.getElementById('cv-src');
    return cv.width === 30 && cv.height === 22;
  });
  const sizeText = await page.$eval('#metrics', (el) => el.textContent);
  check(/30×22\s*\/\s*32×24/.test(sizeText), 'odd image shows original/padded sizes: ' + sizeText.replace(/\s+/g, ' '));
  const oddCanvas = await page.$eval('#cv-src', (cv) => ({ w: cv.width, h: cv.height }));
  check(oddCanvas.w === 30 && oddCanvas.h === 22, 'display canvas stays at original (cropped) size');

  // ---- noise roundtrip ----
  await uploadInput(page, 'file-png', path.join(CASES, 'noise-64.png'));
  await waitForIdle(page);
  const noiseText = await page.$eval('#metrics', (el) => el.textContent);
  check(/RGB PSNR\s*[\d.]+/.test(noiseText), 'noise-64 encodes and reports PSNR');

  // ---- invalid inputs ----
  await uploadInput(page, 'file-png', path.join(CASES, 'invalid-16bit.png'));
  await page.waitForFunction(() =>
    document.getElementById('status').className.includes('err') &&
    document.getElementById('status').textContent.includes('8-bit'));
  check(true, 'rejects 16-bit PNG with clear message');
  await uploadInput(page, 'file-png', path.join(CASES, 'invalid-too-large.png'));
  await page.waitForFunction(() =>
    document.getElementById('status').className.includes('err') &&
    document.getElementById('status').textContent.includes('1024px'));
  check(true, 'rejects >1024px PNG with clear message');
  // previous valid result still on screen
  const stillRendered = await page.$eval('#cv-src', (cv) => cv.width === 64);
  check(stillRendered, 'failed import keeps previous result on screen');

  // ---- reference DDS decode path ----
  await uploadInput(page, 'file-dds', path.join(CASES, 'bc3-alpha.dds'));
  await page.waitForFunction(() => {
    const cv = document.getElementById('cv-dec');
    return cv && cv.width === 64 && !document.getElementById('progress').classList.contains('on');
  });
  const refFmt = await page.$eval('#metrics', (el) => el.textContent);
  check(/BC3/.test(refFmt), 'reference DDS recognized as BC3');
  const ddsBtnDisabled = await page.$eval('#btn-dds', (b) => b.disabled);
  check(ddsBtnDisabled, 'DDS export disabled in reference-decode mode');
  const jsonBtnEnabled = await page.$eval('#btn-json', (b) => !b.disabled);
  check(jsonBtnEnabled, 'JSON export enabled in reference-decode mode');

  // ---- export DDS + JSON downloads (re-import PNG to leave reference mode) ----
  await uploadInput(page, 'file-png', path.join(CASES, 'gradient.png'));
  await waitForIdle(page);
  // default format is BC1; verify the metric tile agrees before exporting
  await page.waitForFunction(() => document.getElementById('metrics').textContent.includes('BC1'));
  await page.waitForFunction(() => !document.getElementById('btn-dds').disabled &&
    !document.getElementById('btn-json').disabled);
  // Register one persistent listener before either click, so two rapid
  // downloads can't both be consumed by a single waitForEvent promise.
  const downloads = [];
  const collect = new Promise((resolve) => {
    const onDl = (d) => {
      downloads.push(d);
      if (downloads.length === 2) resolve();
    };
    page.on('download', onDl);
  });
  await page.click('#btn-dds');
  await page.click('#btn-json');
  await collect;
  check(downloads.length === 2, `two exports triggered (got ${downloads.length})`);
  if (downloads.length === 2) {
    const names = downloads.map((d) => d.suggestedFilename());
    const ddsCount = names.filter((n) => n.endsWith('.dds')).length;
    const jsonCount = names.filter((n) => n.endsWith('.json')).length;
    check(ddsCount === 1 && jsonCount === 1,
      'one DDS + one JSON export: ' + names.join(', '));
    const ddsDl = downloads.find((d) => d.suggestedFilename().endsWith('.dds'));
    const ddsPath = await ddsDl.path();
    const ddsBytes = fs.readFileSync(ddsPath);
    check(ddsBytes.slice(0, 4).toString('ascii') === 'DDS ' && ddsBytes.readUInt32LE(16) === 256,
      'exported DDS has magic and original width 256');
    const jsonDl = downloads.find((d) => d.suggestedFilename().endsWith('.json'));
    const json = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
    check(json.blockCount === (256 / 4) * (64 / 4) && json.blocks.length === json.blockCount,
      'JSON contains one record per block (' + json.blockCount + ')');
    check(json.blocks[0].color.indices.length === 16 && 'rgbPsnr' in json.blocks[0],
      'per-block record has 16 indices and rgbPsnr');
    check(json.wholeImage.rgbPsnr >= 39, 'JSON whole-image PSNR matches threshold');
  }

  check(consoleErrors.length === 0, 'no browser console/page errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));

  await browser.close();
  server.close();
  console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
