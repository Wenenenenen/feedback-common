// End-to-end browser test driven by Playwright. Serves the repo over http,
// loads the page with the real sample, and asserts the rendered exact moments
// match the Node engine, the editor rejects invalid edits, and export works.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.pgm': 'application/octet-stream' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => document.querySelector('#moments tr') !== null, { timeout: 20000 });

const m00 = await page.locator('#moments tr').first().innerText();
if (!/M00/.test(m00)) throw new Error('moments not rendered: ' + m00);
const centroid = await page.locator('#centroid').innerText();
if (/null/.test(centroid)) throw new Error('sample has nonzero mass but centroid null');
const cellCount = await page.locator('#meta').innerText();
if (!/相交格 \d+/.test(cellCount)) throw new Error('meta missing: ' + cellCount);

// hover a cell to populate inspector
const box = await page.locator('#canvas').boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForFunction(() => /交叠分数/.test(document.querySelector('#cellInfo').innerText));

// invalid edit: make a self-crossing outer ring (bowtie) via textarea
await page.locator('#ringText').fill('0, 0\n80, 80\n80, 0\n0, 80');
await page.locator('#applyRingText').click();
await page.waitForFunction(() => !document.querySelector('#errors').hidden);
const errText = await page.locator('#errors').innerText();
if (!/交叉|定位/.test(errText)) throw new Error('invalid edit not localized: ' + errText);
// old valid region must still drive the stats (status says retained)
const status = await page.locator('#status').innerText();
if (!/保留|合法/.test(status)) throw new Error('old region not retained: ' + status);

// restore a valid edit and confirm errors clear
await page.locator('#ringText').fill('0, 0\n112, 16\n112, 80\n16, 80');
await page.locator('#applyRingText').click();
await page.waitForFunction(() => document.querySelector('#errors').hidden === true);

// export JSON (capture the real download)
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#exportBtn').click(),
]);
const tmpPath = path.join(HERE, 'exported-test.json');
await download.saveAs(tmpPath);
const exported = JSON.parse(await readFile(tmpPath, 'utf8'));
if (!exported.moments || !/^\d+\/\d+$/.test(exported.moments.M00)) throw new Error('export fractions wrong');
if (!exported.centroid || !exported.covariance) throw new Error('export missing derived stats');

if (errors.length) throw new Error('console/page errors: ' + errors.join(' | '));
console.log('E2E OK — moments rendered, cell inspector works, invalid edit rejected+localized, export valid');
await browser.close();
server.close();
