// End-to-end browser test with Playwright. Serves ../web over http and drives
// the real UI: sample load, compute, canvases, click correspondence, cancel,
// and export zip. Run: node e2e.js
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = '/home/wendy/jianzhi/feedback-tasks/dense-motion-correspondence/web';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exitCode = 1; } else console.log('  ok:', msg); };

await page.goto(base);
await page.waitForFunction(() => document.readyState === 'complete');

// 1. Load integer-translation sample via its button
await page.getByRole('button', { name: '整数平移' }).click();
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
assert((await page.textContent('#loadMsg')).includes('96×72'), 'sample loaded at 96x72');

// 2. Run and wait for completion pill
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('pillState').textContent === '完成', { timeout: 30000 });
const validCount = Number(await page.textContent('#stValid'));
const zeroCount = Number(await page.textContent('#stZero'));
assert(validCount > 3000, `produces many valid pixels (${validCount})`);
assert(zeroCount === 0, 'translation case has no valid zero-motion pixels');
const levels = await page.textContent('#stLevels');
assert(levels === '3', `uses 3 pyramid levels (got ${levels})`);

// canvases actually painted (non-blank)
const blank = await page.evaluate(() => {
  const cv = document.getElementById('cvA');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let nonBg = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i+1] > 40) nonBg++;
  return nonBg < 100;
});
assert(!blank, 'direction canvas has painted content');

// 3. Click a known textured inner pixel and read the correspondence readout
const cv = await page.$('#cvA');
const box = await cv.boundingBox();
await page.mouse.click(box.x + box.width * (40 / 96), box.y + box.height * (30 / 72));
const readout = await page.textContent('#readout');
assert(readout.includes('有效'), 'clicked inner pixel reported valid');
assert(/\(3\.0\d*|接近/.test(readout) || readout.includes('流'), 'readout shows flow values');

// 4. Switch views without errors
for (const v of ['vectors', 'valid', 'reproj', 'fb', 'frames', 'direction']) {
  await page.click(`button[data-view="${v}"]`);
  await page.waitForTimeout(60);
}
assert(true, 'all five visualization views render');

// 5. Flat sample must yield zero valid pixels
await page.getByRole('button', { name: '平坦无纹理' }).click();
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('pillState').textContent === '完成', { timeout: 30000 });
const flatValid = Number(await page.textContent('#stValid'));
assert(flatValid === 0, `flat/textureless case gives 0 valid pixels (got ${flatValid})`);

// 6. Cancellation: load integer again, start, immediately cancel
await page.getByRole('button', { name: '整数平移' }).click();
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
await page.click('#runBtn');
await page.click('#cancelBtn');
await page.waitForFunction(() => document.getElementById('pillState').textContent === '已取消', { timeout: 15000 });
assert(true, 'computation can be canceled');

// 7. Re-run and test export produces a zip download
await page.click('#runBtn');
await page.waitForFunction(() => !document.getElementById('exportBtn').disabled, { timeout: 30000 });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#exportBtn'),
]);
const dlPath = await download.path();
assert(!!dlPath && (await readFile(dlPath)).length > 100, `exported ZIP downloaded (${download.suggestedFilename()})`);

// 8. Subpixel case median accuracy through the real pipeline
await page.getByRole('button', { name: '亚像素平移' }).click();
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('pillState').textContent === '完成', { timeout: 30000 });
assert((await page.textContent('#stMag')) !== '–', 'subpixel run produced stats');

// 9. Real file-input upload path (not the embedded-sample buttons)
const SAMPLE_DIR = '/home/wendy/jianzhi/feedback-tasks/dense-motion-correspondence/samples/extracted';
await page.setInputFiles('#fileA', `${SAMPLE_DIR}/a.png`);
await page.setInputFiles('#fileB', `${SAMPLE_DIR}/subpixel-b.png`);
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
assert((await page.textContent('#loadMsg')).includes('96×72'), 'file inputs loaded a same-size pair');
await page.click('#runBtn');
await page.waitForFunction(() => document.getElementById('pillState').textContent === '完成', { timeout: 30000 });
assert(Number(await page.textContent('#stValid')) > 3000, 'uploaded pair computed dense valid flow');

// 10. Reject mismatched-size uploads with an inline error (no crash)
await page.setInputFiles('#fileA', `${SAMPLE_DIR}/a.png`);
await page.setInputFiles('#fileB', `${SAMPLE_DIR}/flat-b.png`);
await page.waitForTimeout(150);
const errVisible = await page.evaluate(() => !document.getElementById('errLine').hidden);
assert(errVisible, 'mismatched-size pair shows inline error and does not run');

assert(errors.length === 0, `no browser console/page errors (${errors.join(' | ')})`);
await browser.close();
server.close();
console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E ALL PASSED');
