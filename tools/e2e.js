// End-to-end browser test for dist/index.html using Playwright + headless Chromium.
// Serves the repo root so the page can load three.js from the CDN (network required).
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'dist/index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { failures++; console.log('FAIL', name, extra || ''); }
}

(async () => {
  await new Promise(r => server.listen(8931, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:8931/dist/index.html', { waitUntil: 'networkidle' });
  check('no console errors on load', consoleErrors.length === 0, consoleErrors.join('\n'));

  // Load the small built-in sample.
  await page.click('#btnSampleSmall');
  await page.waitForSelector('.status-pill.done', { timeout: 10000 });
  check('analysis completed', (await page.textContent('.status-pill')).includes('分析完成'));

  const tiles = await page.evaluate(() => ({
    total: document.getElementById('tileTotal').textContent,
    overlap: document.getElementById('tileOverlap').textContent,
    mirror: document.getElementById('tileMirror').textContent,
    outside: document.getElementById('tileOutside').textContent,
    deg: document.getElementById('tileDegenerate').textContent
  }));
  check('tiles show 6 faces', tiles.total === '6', JSON.stringify(tiles));
  check('tiles show 1 overlap pair', tiles.overlap === '1', JSON.stringify(tiles));
  check('tiles show 1 mirrored', tiles.mirror === '1', JSON.stringify(tiles));
  check('tiles show 1 outside', tiles.outside === '1', JSON.stringify(tiles));
  check('tiles show 2 degenerate', tiles.deg === '2', JSON.stringify(tiles));

  // Table content: face #0 metrics.
  await page.waitForSelector('#faceTbody tr[data-face="0"]');
  const row0 = await page.evaluate(() => {
    const tr = document.querySelector('#faceTbody tr[data-face="0"]');
    return tr.innerText.replace(/\n/g, ' | ');
  });
  check('table row face0 contains ratio 1', /#0/.test(row0) && row0.includes('1'), row0);

  // Click on the UV canvas inside the overlap region (face 2 covers [0,.5]^2).
  const box = await page.locator('#uvCanvas').boundingBox();
  // unit square inset: padding 26px inside a square canvas; point (0.15, 0.15)
  const unit = box.width - 52;
  const px = box.x + 26 + 0.15 * unit;
  const py = box.y + 26 + (1 - 0.15) * unit;
  // Approach from a different spot each time: identical rapid clicks are
  // coalesced by the browser's dblclick synthesis.
  async function uvClick(k) {
    await page.mouse.move(px - 45 + k * 22, py - 45);
    await page.waitForTimeout(90);
    await page.mouse.move(px, py, { steps: 4 });
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
  await uvClick(0);
  let sel = await page.textContent('#detailId');
  check('UV click selects a face (#0 or #2)', /#0|#2/.test(sel), sel);
  const cycleInfo1 = await page.textContent('#cyclePos');
  check('cycle info lists 2 faces', /1 \/ 2/.test(cycleInfo1) && cycleInfo1.includes('#0') && cycleInfo1.includes('#2'), cycleInfo1);

  // Re-click same spot to rotate selection to the other face.
  await uvClick(1);
  const sel2 = await page.textContent('#detailId');
  check('second UV click rotates to the other face', sel2 !== sel && /#0|#2/.test(sel2), sel + ' -> ' + sel2);

  // Next-cycle button advances one more step around the two-face cycle.
  await page.click('#btnNextCycle');
  const sel3 = await page.textContent('#detailId');
  check('next button rotates back to the first face', sel3 === sel, sel2 + ' -> ' + sel3);

  // Pair list for the selected overlap face.
  const pairRows = await page.locator('.pair-row').count();
  check('pair list shows one overlap pair', pairRows === 1, 'count=' + pairRows);

  // Click a table row -> selection syncs.
  await page.click('#faceTbody tr[data-face="3"]');
  check('table click selects face 3', (await page.textContent('#detailId')) === '#3');
  const badges = await page.textContent('#detailBadges');
  check('face3 badges show mirror + outside', badges.includes('镜像') && badges.includes('越界'), badges);

  // Degenerate face shows excluded note.
  await page.click('#faceTbody tr[data-face="4"]');
  const detail = await page.textContent('#metricList');
  check('degenerate face marked excluded', detail.includes('退化面不参与统计'), detail);

  // Filters: enable mirror only -> table shrinks to matching rows.
  await page.click('.filter-chip[data-filter="mirror"]');
  const visibleRows = await page.locator('#faceTbody tr[data-face]').count();
  check('mirror filter leaves 1 visible table row', visibleRows === 1, 'rows=' + visibleRows);
  const filterCount = await page.textContent('#filterCount');
  check('filter count says 1/6', filterCount.includes('匹配 1 / 6'), filterCount);
  await page.click('#btnClearFilter');

  // Stretch threshold: set high so nothing matches.
  await page.fill('#stretchThreshold', '1000');
  await page.click('.filter-chip[data-filter="stretch"]');
  const stretchRows = await page.locator('#faceTbody tr[data-face]').count();
  check('stretch>=1000 matches nothing', stretchRows === 0, 'rows=' + stretchRows);
  await page.click('#btnClearFilter');
  await page.fill('#stretchThreshold', '2');

  // Mask overlay toggle + PNG export modal.
  await page.check('#chkMask');
  await page.click('#btnExportPng');
  await page.waitForSelector('.modal-backdrop:not([hidden]) img.preview-img');
  const imgInfo = await page.evaluate(() => {
    const img = document.querySelector('.modal-backdrop img.preview-img');
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  check('PNG preview is 256x256', imgInfo.w === 256 && imgInfo.h === 256, JSON.stringify(imgInfo));
  const maskPixels = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    return new Promise(resolve => {
      const img = document.querySelector('.modal-backdrop img.preview-img');
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, 256, 256).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 0) n++;
      resolve(n);
    });
  });
  check('PNG white pixels = 8256 (engine mask)', maskPixels === 8256, 'got ' + maskPixels);
  await page.click('#modalClose');

  // CSV export content check via the copy text stored on the modal.
  await page.click('#btnExportCsv');
  await page.waitForSelector('.modal-backdrop:not([hidden])');
  const csv = await page.evaluate(() => document.querySelector('#modalBackdrop')._copyText);
  check('CSV has header + 6 rows', csv.includes('area_ratio') && csv.split('\n').length === 7,
    'len=' + csv.length);
  check('CSV marks degenerate face 4', csv.split('\n')[5].split(',').slice(-3, -2)[0] === '1', csv.split('\n')[5]);
  await page.click('#modalClose');

  // JSON report.
  await page.click('#btnExportJson');
  await page.waitForSelector('.modal-backdrop:not([hidden]) textarea');
  const report = await page.evaluate(() => JSON.parse(document.querySelector('.modal-backdrop textarea').value));
  check('JSON report overlap 0/2 area .125',
    report.overlaps.length === 1 && report.overlaps[0].faces.join() === '0,2' &&
    Math.abs(report.overlaps[0].area - 0.125) < 1e-12, JSON.stringify(report.overlaps));
  check('JSON report mask count 8256', report.summary.mask_covered_pixels === 8256);
  await page.click('#modalClose');

  // Cancel semantics on the 5000-face sample.
  await page.click('#btnSampleGrid');
  await page.click('#btnCancel');
  await page.waitForFunction(() => {
    const p = document.querySelector('.status-pill');
    return p && (p.textContent.includes('已取消') || p.textContent.includes('完成'));
  }, { timeout: 15000 });
  const afterCancel = await page.textContent('.status-pill');
  check('grid run cancelled or finished', /已取消|完成/.test(afterCancel), afterCancel);

  // Re-import after cancel: wait for completion and check 5000 rows + zero overlaps.
  await page.click('#btnSampleGrid');
  await page.waitForSelector('.status-pill.done', { timeout: 20000 });
  const gridTile = await page.textContent('#tileTotal');
  const gridOvl = await page.textContent('#tileOverlap');
  check('reimported grid shows 5000 faces', gridTile === '5000', gridTile);
  check('grid has zero overlap pairs', gridOvl === '0', gridOvl);
  const gridRows = await page.locator('#faceTbody tr[data-face]').count();
  check('table renders a page of rows', gridRows === 50, 'rows=' + gridRows);

  // Race: start the grid analysis, immediately import the small sample. The stale
  // grid result must never overwrite the small project's tiles.
  await page.click('#btnSampleGrid');
  await page.waitForTimeout(30);
  await page.click('#btnSampleSmall');
  await page.waitForSelector('.status-pill.done', { timeout: 20000 });
  const racedTotal = await page.textContent('#tileTotal');
  const racedName = await page.textContent('#projectName');
  check('stale analysis cannot overwrite new project', racedTotal === '6', 'got ' + racedTotal);
  check('project name belongs to the latest import', racedName.includes('audit'), racedName);

  // 3D view exists and has a WebGL canvas.
  const glOk = await page.evaluate(() => !!document.querySelector('#threeContainer canvas'));
  check('three.js canvas mounted', glOk);

  // Invalid file handling: out-of-range index must show a clear Chinese error.
  const invalidJson = JSON.stringify({
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    faces: [[0, 1, 999]],
    uv: [[[0, 0], [1, 0], [0, 1]]]
  });
  await page.setInputFiles('#fileInput', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(invalidJson)
  });
  await page.waitForSelector('#errorText:not([hidden])');
  const errMsg = await page.textContent('#errorText');
  check('invalid index reports a clear error', errMsg.includes('越界'), errMsg);
  check('error state disables exports', await page.$eval('#btnExportCsv', b => b.disabled));

  // A valid re-import after the error must recover and replace the error state.
  await page.click('#btnSampleSmall');
  await page.waitForSelector('.status-pill.done');
  check('re-import recovers from error state',
    (await page.textContent('#tileOverlap')) === '1' && (await page.$eval('#errorText', e => e.hidden)));

  // Screenshots for visual review.
  await page.screenshot({ path: path.join(ROOT, 'tools', 'shot-grid.png'), fullPage: false });
  await page.click('#btnSampleSmall');
  await page.waitForSelector('.status-pill.done');
  await page.check('#chkMask');
  await uvClick(2);
  await page.screenshot({ path: path.join(ROOT, 'tools', 'shot-small.png'), fullPage: false });

  check('no console errors during whole run', consoleErrors.length === 0, consoleErrors.join('\n'));

  await browser.close();
  server.close();
  console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : '\n' + failures + ' E2E FAILURE(S)');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
