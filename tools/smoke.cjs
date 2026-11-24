'use strict';

/* Optional end-to-end smoke. Run with a Playwright-capable NODE_PATH, e.g.
 * NODE_PATH=../some-task/node_modules node tools/smoke.cjs
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.log('Playwright is not installed; skipping browser smoke.');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function writeTemp(name, obj) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.sphere-card', { timeout: 5000 });
    await page.waitForSelector('#renderBadge', { state: 'hidden', timeout: 10000 });

    const samplePixel = await page.evaluate(() => {
      const c = document.querySelector('#view');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      return [c.width, c.height, Array.from(d.slice(0, 4))];
    });
    console.log('sample canvas:', JSON.stringify(samplePixel));
    if (samplePixel[0] !== 1 || samplePixel[1] !== 1) throw new Error('sample canvas should be 1x1');
    if (samplePixel[2][0] === 0) throw new Error('sample pixel was not painted');

    const box = await page.locator('#view').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.branch-node', { timeout: 5000 });
    const branchCount = await page.locator('.branch-node').count();
    console.log('branch nodes:', branchCount);
    if (branchCount < 5) throw new Error('expected sample branch tree');

    await page.click('.locate-btn');
    await page.waitForSelector('.sphere-card.selected', { timeout: 2000 });
    const selectedId = await page.locator('.sphere-card.selected').getAttribute('data-sphere-id');
    console.log('located sphere:', selectedId);
    if (selectedId !== '1') throw new Error('wrong located sphere');

    // Depth 0: hit exists but all arrived weight is residual.
    await page.$eval('#depthRange', (el) => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(350);
    await page.waitForSelector('#renderBadge', { state: 'hidden', timeout: 10000 });
    const residualText = await page.locator('#selectedResidual').innerText();
    console.log('depth0 residual:', residualText);
    if (!/1\.000|0\.999|余量/.test(residualText)) throw new Error('depth zero residual missing');

    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    const [png] = await Promise.all([page.waitForEvent('download'), page.click('#exportPng')]);
    await png.saveAs(path.join(os.tmpdir(), 'nested-glass-smoke.png'));
    await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
    await Promise.all([page.waitForEvent('download'), page.click('#exportPixelJson')]);
    console.log('downloads:', downloads);
    if (downloads.length < 3) throw new Error('expected PNG + two JSON exports');

    // Invalid intersecting geometry must report IDs and preserve canvas bytes.
    const beforeInvalid = await page.evaluate(() => document.querySelector('#view').toDataURL());
    const invalidFile = writeTemp('invalid-nested-glass.json', {
      size: [1, 1],
      depth: 2,
      background: [1, 1, 1],
      spheres: [
        { id: 7, c: [0, 0, 0], r: 2, n: 1.4, sigma: [0, 0, 0] },
        { id: 8, c: [1.5, 0, 0], r: 1, n: 1.4, sigma: [0, 0, 0] }
      ],
      rays: [[[-4, 0, 0], [1, 0, 0]]]
    });
    await page.setInputFiles('#fileInput', invalidFile);
    await page.waitForSelector('#errorPanel:not([hidden])', { timeout: 3000 });
    const errorText = await page.locator('#errorPanel').innerText();
    console.log('invalid error:', errorText.replace(/\s+/g, ' ').slice(0, 220));
    if (!errorText.includes('#7') || !errorText.includes('#8')) throw new Error('conflict IDs missing');
    const afterInvalid = await page.evaluate(() => document.querySelector('#view').toDataURL());
    if (beforeInvalid !== afterInvalid) throw new Error('old image was not preserved');

    // Capacity scene: 96x64 explicit rays and 32 spheres.
    const spheres = Array.from({ length: 32 }, (_, i) => ({
      id: i + 1,
      c: [(i % 8) * 2.4 - 8.4, Math.floor(i / 8) * 2.4 - 3.6, 0],
      r: 0.72,
      n: 1.25 + (i % 5) * 0.12,
      sigma: [0.02 * (i % 3), 0.03, 0.01]
    }));
    const rays = [];
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        rays.push([[x * 0.22 - 10.5, y * 0.18 - 5.7, -8], [0, 0, 1]]);
      }
    }
    const capacityFile = writeTemp('capacity-nested-glass.json', {
      size: [96, 64],
      depth: 3,
      background: [0.95, 0.98, 1],
      spheres,
      rays
    });
    await page.setInputFiles('#fileInput', capacityFile);
    await page.waitForFunction(() => document.querySelector('#errorPanel').hidden === true, null, { timeout: 3000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('#view');
      return c.width === 96 && c.height === 64 && document.querySelector('#renderBadge').hidden;
    }, { timeout: 30000 });
    console.log('capacity render ok');
    const capBox = await page.locator('#view').boundingBox();
    await page.mouse.click(capBox.x + capBox.width * 0.52, capBox.y + capBox.height * 0.48);
    await page.waitForSelector('#branchTree .branch-node', { timeout: 5000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/nested-glass-phone.png', fullPage: true });
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.screenshot({ path: '/tmp/nested-glass-desktop.png', fullPage: true });

    if (errors.length) throw new Error(`browser console errors:\n${errors.join('\n')}`);
    console.log('SMOKE PASS');
  } catch (err) {
    await page.screenshot({ path: '/tmp/nested-glass-error.png', fullPage: true }).catch(() => {});
    console.error('SMOKE FAIL:', err);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
})();
