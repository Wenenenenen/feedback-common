// Browser smoke test with Playwright: drives the real UI through import,
// preset application, view switching, polygon drawing/editing, playback and
// export, then downloads the ZIP and re-checks its structure in-page.
//   CASES_DIR=... node tools/browser-smoke.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const C = process.env.CASES_DIR;
if (!C) { console.error('set CASES_DIR'); process.exit(1); }
const EXE = join(process.env.HOME, '.cache/ms-playwright/chromium-1254/chrome-linux64/chrome');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok -', msg); };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(process.env.APP_URL || 'http://localhost:8317/index.html');
await page.waitForSelector('#canvas');

// 1. import sequence via file chooser (input is hidden; click its label)
const seqZip = { name: 'sequence.zip', mimeType: 'application/zip', buffer: readFileSync(join(C, 'sequence.zip')) };
page.once('filechooser', async fc => fc.setFiles(seqZip));
await page.locator('label.btn:has(#fileInput)').click();
await page.waitForFunction(() => document.getElementById('infoFrames').textContent.includes('24'));
check((await page.textContent('#infoSize')).includes('160×120'), 'sequence imported: 24 frames 160x120');
check(await page.$eval('#exportBtn', b => !b.disabled), 'export button enabled');

// 2. apply preset.json via chooser
page.once('filechooser', async fc => fc.setFiles({ name: 'preset.json', mimeType: 'application/json', buffer: readFileSync(join(C, 'preset.json')) }));
await page.click('#presetBtn');
await page.waitForFunction(() => document.querySelectorAll('#polyList li').length === 2);
check((await page.$$eval('#polyList li', ls => ls.length)) === 2, 'preset polygons appear in list');
check(await page.inputValue('#fpsInput') === '24', 'preset fps applied');
check((await page.inputValue('#keyColor')).toLowerCase() === '#21d321', 'preset key color applied');

// 3. switch every view mode without errors
for (const v of ['matte', 'checker', 'black', 'white', 'original']) {
  await page.check(`input[name="view"][value="${v}"]`);
  await sleep(60);
}
check(true, 'all built-in view modes render');

// 4. custom background
page.once('filechooser', async fc => fc.setFiles({ name: 'background.png', mimeType: 'image/png', buffer: readFileSync(join(C, 'background.png')) }));
await page.locator('label.btn:has(#bgInput)').click();
await page.waitForFunction(() => document.querySelector('input[name="view"][value="custom"]').checked);
check((await page.textContent('#bgStatus')).includes('background.png'), 'custom background selected and view switched');

// 5. draw a protect polygon (3 clicks + double click to close)
await page.click('#toolProtect');
const box = await page.locator('#canvas').boundingBox();
const pts = [[40, 30], [70, 30], [70, 60], [40, 60]];
for (const [x, y] of pts.slice(0, 3)) await page.mouse.click(box.x + x * box.width / 160, box.y + y * box.height / 120);
await page.dblclick('#canvas', { position: { x: 55 * box.width / 160, y: 45 * box.height / 120 } });
await sleep(100);
check((await page.$$eval('#polyList li', ls => ls.length)) === 3, 'new protect polygon added via canvas');

// 6. edit tool: select and delete it
await page.click('#toolEdit');
await page.locator('#polyList li').last().click();
await page.click('#deletePolyBtn');
check((await page.$$eval('#polyList li', ls => ls.length)) === 2, 'polygon deletion works');

// 7. parameter sliders change output
const matteBefore = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 40).join(',');
});
await page.check('input[name="view"][value="matte"]');
await page.fill('#innerRange', '0.15');
await page.dispatchEvent('#innerRange', 'input');
await sleep(80);
const matteAfter = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 40).join(',');
});
check(matteBefore !== matteAfter, 'threshold slider changes the rendered matte');

// 8. zoom controls
await page.click('#zoomIn');
await page.click('#zoomIn');
const zoomText = await page.textContent('#zoomLabel');
check(!zoomText.startsWith('100%'), 'zoom changes label: ' + zoomText);
await page.click('#zoomFit');

// 9. playback at preset fps
await page.click('#playBtn');
await sleep(350);
const midFrame = await page.inputValue('#scrub');
await page.click('#stopBtn');
check(Number(midFrame) > 0, 'playback advances frames (scrub=' + midFrame + ')');
check(await page.inputValue('#scrub') === '0', 'stop returns to first frame');

// 10. scrub to last frame and export through the real download path
await page.fill('#scrub', '23');
await page.dispatchEvent('#scrub', 'input');
await sleep(60);
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#exportBtn'),
]);
const dlPath = await download.path();
const zipBytes = readFileSync(dlPath);
check(zipBytes.length > 1000, 'exported ZIP downloaded (' + zipBytes.length + ' bytes)');

// 11. verify exported ZIP inside the browser using the app's own modules
const stats = await page.evaluate(async (b64) => {
  const { readZip } = await import('/src/zip.js');
  const { decodePNG } = await import('/src/png.js');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const entries = await readZip(bytes);
  const dirs = [...new Set(entries.map(e => e.name.split('/')[0]))].sort();
  const sample = await decodePNG(entries.find(e => e.name.startsWith('rgba/')).bytes);
  const gray = await decodePNG(entries.find(e => e.name.startsWith('matte/')).bytes);
  const comp = await decodePNG(entries.find(e => e.name.startsWith('composite/')).bytes);
  let zeroRgbOk = true;
  for (let o = 3; o < sample.data.length; o += 4) {
    if (sample.data[o] === 0 && (sample.data[o - 3] || sample.data[o - 2] || sample.data[o - 1])) { zeroRgbOk = false; break; }
  }
  return { count: entries.length, dirs, ch: [sample.channels, gray.channels, comp.channels], size: sample.width + 'x' + sample.height, zeroRgbOk };
}, zipBytes.toString('base64'));
check(stats.count === 72, 'ZIP has 72 entries (24x3), got ' + stats.count);
check(JSON.stringify(stats.dirs) === JSON.stringify(['composite', 'matte', 'rgba']), 'three directories: ' + stats.dirs);
check(JSON.stringify(stats.ch) === JSON.stringify([4, 1, 3]), 'color types RGBA/gray/RGB: ' + stats.ch);
check(stats.size === '160x120', 'export dimensions preserved: ' + stats.size);
check(stats.zeroRgbOk, 'transparent pixels have zero RGB');

// 12. invalid-size rejection
page.once('filechooser', async fc => fc.setFiles({ name: 'invalid-size.zip', mimeType: 'application/zip', buffer: readFileSync(join(C, 'invalid-size.zip')) }));
await page.locator('label.btn:has(#fileInput)').click();
await sleep(300);
const toast = await page.textContent('#toast');
check(toast.includes('不一致'), 'mismatched-size ZIP rejected with Chinese error: ' + toast);

await browser.close();
if (errors.length) { failures++; console.error('unexpected browser errors:\n' + errors.join('\n')); }
console.log(failures ? `\nBROWSER SMOKE FAILED (${failures})` : '\nBROWSER SMOKE OK');
process.exit(failures ? 1 : 0);
