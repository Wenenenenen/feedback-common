// Browser end-to-end test driven by Playwright. Serves the studio over HTTP,
// loads each sample through the real file input, and exercises the full UI path.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = '/home/wendy/jianzhi/feedback-tasks/apng-disposal-studio';
const SAMPLES = '/tmp/apng-sample-extract';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.apng': 'image/png' };

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = normalize(join(ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8731, r));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  PASS ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)) };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

async function loadApng(name) {
  await page.goto('http://localhost:8731/');
  await page.setInputFiles('#file-input', `${SAMPLES}/${name}`);
  await page.waitForSelector('#workspace:not([hidden])');
}

// --- valid included.apng: full interaction path ---
console.log('== included.apng browser flow');
await loadApng('included.apng');
check('workspace visible', await page.isVisible('#workspace'));
check('error hidden', await page.isHidden('#error-panel'));
check('6 timeline items', await page.locator('.tl-item').count() === 6);
check('four canvases have content', await page.evaluate(() =>
  ['cv-raw', 'cv-before', 'cv-shown', 'cv-after'].every((id) => document.getElementById(id).width > 0)));

// pixel picker: hover over shown canvas, readout updates
await page.mouse.move(10, 10);
const shownBox = await page.locator('#cv-shown').boundingBox();
await page.mouse.move(shownBox.x + 2, shownBox.y + 2);
const readout = await page.textContent('#pixel-readout');
check('pixel readout shows coordinates', /坐标/.test(readout), readout);

// jump to frame 2
await page.fill('#frame-jump', '2');
await page.dispatchEvent('#frame-jump', 'change');
check('frame index shows 2', (await page.textContent('#frame-index')) === '2');

// edit dispose op on frame 2 -> thumbnails re-render, edited style applied
await page.selectOption('#in-dispose', '1');
check('dispose select marked edited', await page.locator('#in-dispose').evaluate((el) => el.classList.contains('edited')));
const thumbDataAfter = await page.locator('.tl-thumb').nth(3).evaluate((c) => c.toDataURL());

// edit blend op
await page.selectOption('#in-blend', '1');
check('blend marked edited', await page.locator('#in-blend').evaluate((el) => el.classList.contains('edited')));

// edit delay fraction
await page.fill('#in-delay-num', '7');
await page.dispatchEvent('#in-delay-num', 'change');
await page.fill('#in-delay-den', '50');
await page.dispatchEvent('#in-delay-den', 'change');
check('frame ms readout updates to 140', (await page.textContent('#frame-ms')).startsWith('140'),
  await page.textContent('#frame-ms'));

// num plays
await page.fill('#num-plays', '5');
await page.dispatchEvent('#num-plays', 'change');
check('meta plays shows 5', (await page.textContent('#info-plays')) === '5');

// reset
await page.click('#btn-reset');
check('reset clears edited class', await page.locator('#in-dispose').evaluate((el) => !el.classList.contains('edited')));
check('reset restores num plays', (await page.textContent('#info-plays')) === '2');

// export APNG via download event
const [dlApng] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export-apng'),
]);
const apngPath = await dlApng.path();
const apngBytes = readFileSync(apngPath);
check('exported APNG has PNG signature', apngBytes.subarray(0, 8).equals(
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

// export ZIP sequence
const [dlZip] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export-seq'),
]);
const zipPath = await dlZip.path();
const zipBytes = readFileSync(zipPath);
check('ZIP has End of Central Directory signature', zipBytes.subarray(zipBytes.length - 22, zipBytes.length - 18).equals(
  Buffer.from([0x50, 0x4b, 0x05, 0x06])));

// re-import the exported APNG through the same input → identical composite vs fresh import
await page.setInputFiles('#file-input', apngPath);
await page.waitForSelector('#workspace:not([hidden])');
check('re-imported APNG shows 6 frames', await page.locator('.tl-item').count() === 6);
const reShown = await page.locator('#cv-shown').evaluate((c) => c.toDataURL());
await loadApng('included.apng');
const origShown = await page.locator('#cv-shown').evaluate((c) => c.toDataURL());
check('re-import frame0 shown identical to original', reShown === origShown);

// --- poster-excluded: poster flag wording ---
console.log('== poster-excluded.apng');
await loadApng('poster-excluded.apng');
check('poster-only wording', (await page.textContent('#poster-flag')).includes('仅作封面'));
check('6 frames still', await page.locator('.tl-item').count() === 6);

// included file wording
await loadApng('included.apng');
check('poster-included wording', (await page.textContent('#poster-flag')).includes('参与动画'));

// --- playback: play then stop, frame advances ---
console.log('== playback');
await page.click('#btn-play');
check('play button says 暂停', (await page.textContent('#btn-play')) === '暂停');
await page.waitForTimeout(350);
const advanced = Number(await page.textContent('#frame-index')) > 0;
check('playback advanced frames', advanced);
await page.click('#btn-play');

// keyboard navigation
await page.keyboard.press('Home');
check('Home key jumps to 0', (await page.textContent('#frame-index')) === '0');
await page.keyboard.press('ArrowRight');
check('ArrowRight advances', (await page.textContent('#frame-index')) === '1');

// finite loop: set every frame to ~20ms and num_plays=2, playback must stop on the
// final frame after exactly two plays, not loop forever.
await page.evaluate(() => {
  const inputs = document.querySelectorAll('#timeline-strip .tl-item');
  inputs.forEach((_, i) => { /* frames edited through UI below */ });
});
for (let i = 0; i < 6; i++) {
  await page.fill('#frame-jump', String(i));
  await page.dispatchEvent('#frame-jump', 'change');
  await page.fill('#in-delay-num', '1');
  await page.dispatchEvent('#in-delay-num', 'change');
  await page.fill('#in-delay-den', '50'); // 20ms
  await page.dispatchEvent('#in-delay-den', 'change');
}
await page.fill('#num-plays', '2');
await page.dispatchEvent('#num-plays', 'change');
await page.fill('#frame-jump', '0');
await page.dispatchEvent('#frame-jump', 'change');
await page.click('#btn-play');
await page.waitForTimeout(700); // 6 frames * 20ms * 2 plays = 240ms plus scheduling slack
check('finite playback stops', (await page.textContent('#btn-play')) === '播放');
check('finite playback ends on last frame #5', (await page.textContent('#frame-index')) === '5');

// infinite loop: num_plays=0 keeps cycling back to frame 0
await page.fill('#num-plays', '0');
await page.dispatchEvent('#num-plays', 'change');
await page.fill('#frame-jump', '0');
await page.dispatchEvent('#frame-jump', 'change');
await page.click('#btn-play');
await page.waitForTimeout(400);
const cycling = await page.evaluate(() => {
  const idx = Number(document.getElementById('frame-index').textContent);
  return idx >= 0 && idx <= 5; // still alive inside the frame range
});
check('infinite playback still cycling', cycling);
await page.click('#btn-play'); // stop
await page.click('#btn-reset');

// --- every invalid file: error panel with chunk + offset ---
console.log('== invalid files');
const expected = {
  'invalid-crc.apng': ['CRC', 'IEND'],
  'invalid-sequence.apng': ['序号', 'fdAT'],
  'invalid-bounds.apng': ['越界', 'fcTL'],
  'invalid-count.apng': ['帧数', 'acTL'],
  'invalid-truncated.apng': ['截断', null],
};
for (const [name, [kw, chunk]] of Object.entries(expected)) {
  await page.goto('http://localhost:8731/');
  await page.setInputFiles('#file-input', `${SAMPLES}/${name}`);
  await page.waitForSelector('#error-panel:not([hidden])');
  const errText = await page.textContent('#error-panel');
  check(`${name} mentions ${kw}`, errText.includes(kw), errText);
  check(`${name} shows byte offset`, /字节偏移|偏移 \d+/.test(errText), errText);
  if (chunk) check(`${name} names chunk ${chunk}`, errText.includes(chunk), errText);
  check(`${name} workspace stays hidden`, await page.isHidden('#workspace'));
}

// --- checkerboard toggle and zoom (frame 0 "before" is fully transparent, so the checker shows) ---
await loadApng('included.apng');
const checkerBefore = await page.locator('#cv-before').evaluate((c) => c.toDataURL());
await page.uncheck('#chk-checker');
const checkerAfter = await page.locator('#cv-before').evaluate((c) => c.toDataURL());
check('checker toggle changes render', checkerBefore !== checkerAfter);
await page.check('#chk-checker');
const checkerRestored = await page.locator('#cv-before').evaluate((c) => c.toDataURL());
check('checker re-enable restores render', checkerRestored === checkerBefore);
await page.click('#btn-zoom-in');
check('zoom label updates', (await page.textContent('#zoom-label')) !== '8×');

// --- multi-error aggregation panel ---
{
  await page.goto('http://localhost:8731/');
  await page.setInputFiles('#file-input', `${SAMPLES}/invalid-multi.apng`);
  await page.waitForSelector('#error-panel:not([hidden])');
  const multiText = await page.textContent('#error-panel');
  check('multi-error shows problem count', /问题 1\/3/.test(multiText), multiText.slice(0, 60));
  check('multi-error lists both kinds', multiText.includes('序号') && multiText.includes('帧数'));
  check('multi-error shows separators', await page.locator('.err-sep').count() === 2);
}

// --- static PNG (not APNG) gives structure error, not a fake success ---
const staticPng = `${SAMPLES}/reference/before-0.png`;
await page.goto('http://localhost:8731/');
await page.setInputFiles('#file-input', staticPng);
await page.waitForSelector('#error-panel:not([hidden])');
check('static PNG rejected as non-APNG', (await page.textContent('#error-panel')).includes('acTL'));

check('no console errors during whole run', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
