'use strict';

/* Optional browser smoke test. Requires Playwright:
 *   npm i -D playwright @playwright/browser-chromium
 * or set QA_PLAYWRIGHT to a Playwright install path.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function loadPlaywright() {
  const candidates = [process.env.QA_PLAYWRIGHT, 'playwright', '@playwright/test'];
  let lastError;
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const mod = require(candidate);
      return mod.chromium ? mod : mod.default;
    } catch (error) {
      lastError = error;
    }
  }
  console.error('Playwright is not available. Set QA_PLAYWRIGHT or install playwright.');
  throw lastError || new Error('playwright unavailable');
}

function readPcm(file) {
  const bytes = fs.readFileSync(file);
  return {
    sampleRate: bytes.readUInt32LE(24),
    channels: bytes.readUInt16LE(22),
    frames: (bytes.length - 44) / (2 * bytes.readUInt16LE(22)),
    bytes,
  };
}

(async () => {
  const { chromium } = await loadPlaywright();
  const target = process.env.BASE_URL || `file://${path.join(__dirname, '..', 'index.html')}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(target);
  await page.waitForSelector('[data-state="ready"]', { timeout: 20000 });
  const turns = await page.textContent('#seg-turns');
  if (turns.trim() !== '53') throw new Error(`expected sample segment k=53, got ${turns}`);

  await page.fill('#selection-start', '100');
  await page.fill('#selection-end', '1000');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-smoke-'));
  const selectionPath = path.join(dir, 'selection.wav');
  const fullPath = path.join(dir, 'full.wav');
  const [selectionDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-selection'),
  ]);
  await selectionDownload.saveAs(selectionPath);
  const [fullDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-full'),
  ]);
  await fullDownload.saveAs(fullPath);

  const selection = readPcm(selectionPath);
  const full = readPcm(fullPath);
  if (selection.sampleRate !== 48000 || selection.channels !== 2) throw new Error('bad WAV format');
  if (selection.frames !== 900 || full.frames !== 9600) throw new Error('bad WAV frame counts');
  let mismatches = 0;
  for (let frame = 0; frame < 900; frame += 1) {
    for (let ch = 0; ch < 2; ch += 1) {
      const selected = selection.bytes.readInt16LE(44 + (frame * 2 + ch) * 2);
      const whole = full.bytes.readInt16LE(44 + ((100 + frame) * 2 + ch) * 2);
      if (selected !== whole) mismatches += 1;
    }
  }
  if (mismatches) throw new Error(`${mismatches} selection/full PCM mismatches`);

  // A one-frame segment with equal endpoint remainders cannot choose any k:
  // k=0 dips below 20 Hz-equivalent curvature constraints; k=1 exceeds 20 kHz.
  await page.evaluate(async () => {
    const app = window.AnchoredPartialApp;
    const track = app.state.doc.tracks[0];
    track.anchors[1][0] = 1;
    track.anchors[1][1] = 0;
    await app.recommit();
  });
  await page.waitForSelector('#error-banner:not([hidden])');
  const errorTrack = await page.getAttribute('#error-banner', 'data-track-id');
  const errorSegment = await page.getAttribute('#error-banner', 'data-segment-index');
  if (errorTrack !== 'A' || errorSegment !== '0') throw new Error('error locator missing');

  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log('browser smoke OK: sample, WAV slice equality, invalid-segment locator/retention');
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
