// End-to-end page test with Playwright: serves docs/, loads each sample through
// the real file input, and checks status chips, frame table rows, waveform
// canvas painting, row-click selection, and CSV export wiring.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const DOCS = '/home/wendy/jianzhi/feedback-tasks/ltc-wave-indexer/docs';
const SAMPLES = '/home/wendy/jianzhi/feedback-tasks/ltc-wave-indexer/samples/extracted';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav' };

const server = createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url;
  try {
    const data = readFileSync(join(DOCS, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(7799, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:7799/');
await page.waitForSelector('#emptyState:not(.hidden)');

async function loadSample(file, mode, expectedFrames) {
  await page.selectOption('#modeSelect', mode);
  await page.setInputFiles('#fileInput', join(SAMPLES, file));
  await page.waitForFunction(
    (n) => document.querySelectorAll('#frameBody tr').length === n,
    expectedFrames,
  );
  const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent.trim()));
  const firstRow = await page.$eval('#frameBody tr:first-child', (el) =>
    Array.from(el.querySelectorAll('td')).map((td) => td.textContent.trim()));
  return { chips, firstRow };
}

const r1 = await loadSample('df.wav', 'df30', 11);
console.log('df chips:', r1.chips.join(' | '));
console.log('df first row:', r1.firstRow.join(' / '));

// canvas actually painted (non-blank pixels)
const painted = await page.$eval('#scope', (c) => {
  const ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonBg = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonBg++;
  return nonBg;
});
console.log('canvas painted pixels:', painted);

// click a frame row -> selection readout updates
await page.click('#frameBody tr:nth-child(4)');
const sel = await page.textContent('#cursorFrame');
console.log('selected frame label after row click:', sel);
await page.click('#zoomIn');
await page.click('#zoomReset');

// reverse sample
const r2 = await loadSample('tenth-rev.wav', 'df30', 11);
console.log('tenth-rev chips:', r2.chips.join(' | '));

// midnight NDF
const r3 = await loadSample('midnight.wav', 'ndf25', 11);
console.log('midnight chips:', r3.chips.join(' | '));
const breakNotes = await page.$$eval('.break-note', (els) =>
  els.map((e) => e.textContent.trim()));
console.log('break notes:', JSON.stringify([...new Set(breakNotes)]));

// stereo check not present (samples mono); verify channel selector has 1 option
const channelOpts = await page.$$eval('#channelSelect option', (o) => o.length);
console.log('channel options (mono file):', channelOpts);

// export button enabled
const exportDisabled = await page.$eval('#exportBtn', (b) => b.disabled);
console.log('export enabled:', !exportDisabled);

console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
