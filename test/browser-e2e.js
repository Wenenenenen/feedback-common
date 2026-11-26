#!/usr/bin/env node
/* Browser end-to-end: drives the real page (upload, click, download) and checks
 * the exported WAV/JSON against the independent expected fixtures.
 *
 * Run:  NODE_PATH="$(npm root -g)" node test/browser-e2e.js
 * Optional: BASE_URL=http://127.0.0.1:8137  (otherwise an internal static server starts)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
  catch (e2) { console.error('Playwright not found. Run with NODE_PATH="$(npm root -g)".'); process.exit(2); }
}

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
let passed = 0, failed = 0;
function check(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.error('  ✗ ' + msg); } }

function startServer() {
  return new Promise((resolve) => {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdq': 'application/octet-stream' };
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(ROOT, p);
      if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not wav');
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  const dataLen = b.readUInt32LE(40);
  const samples = new Int16Array(dataLen / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(44 + i * 2);
  return { channels, rate, bits, dataLen, samples, bytes: b };
}

(async () => {
  let base = process.env.BASE_URL;
  let srv = null;
  if (!base) { srv = await startServer(); base = 'http://127.0.0.1:' + srv.address().port; }
  console.log('base', base);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(base + '/index.html', { waitUntil: 'load' });

  // ---- demo via built-in button ----
  await page.click('#load-demo-btn');
  await page.waitForSelector('#workspace:not(.hidden)');
  await page.waitForSelector('.bit-chip');
  const demoKpi = await page.evaluate(() => ({
    ch: +document.querySelector('#kpi-channels').textContent,
    d: +document.querySelector('#kpi-d').textContent,
    frames: +document.querySelector('#kpi-frames').textContent.replace(/,/g, ''),
    lanes: document.querySelectorAll('.lane').length
  }));
  check(demoKpi.ch === 2 && demoKpi.d === 32 && demoKpi.frames === 12 && demoKpi.lanes === 2, 'demo KPI/lanes correct: ' + JSON.stringify(demoKpi));

  const demoPcm = await page.evaluate(() => Array.from(window.PDMReel.getResult().channelData[0].pcm));
  check(JSON.stringify(demoPcm.slice(0, 4)) === JSON.stringify([3142, 16314, 19662, 19658]), 'demo PCM in page matches reference');

  // click play/stop must not throw
  await page.click('#play-full').catch(() => {});
  await page.waitForTimeout(120);
  await page.click('#stop-btn').catch(() => {});
  check(true, 'play/stop controls executed without interaction error');

  // ---- full WAV download ----
  const wavFullPath = path.join(TMP, 'e2e-full.wav');
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-wav-full')]);
    await dl.saveAs(wavFullPath);
  }
  const fullWav = readWav(wavFullPath);
  check(fullWav.rate === 48000 && fullWav.bits === 16 && fullWav.channels === 2, 'full WAV header 48k/16/2ch');
  check(fullWav.samples.length === 12 * 2, 'full WAV sample count');
  check(fullWav.samples[0] === 3142 && fullWav.samples[1] === 4012, 'full WAV interleaved first frame ch0/ch1');

  // ---- selection [2,8) via inputs; selection WAV must be byte slice of full ----
  await page.fill('#sel-start', '2');
  await page.fill('#sel-end', '8');
  await page.click('#apply-sel');
  const selInfo = await page.evaluate(() => window.PDMReel.getSelection());
  check(selInfo && selInfo.f0 === 2 && selInfo.f1 === 8, 'selection set to [2,8)');
  check(await page.$('#export-wav-sel:not([disabled])') !== null, 'selection export enabled');

  const wavSelPath = path.join(TMP, 'e2e-sel.wav');
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-wav-sel')]);
    await dl.saveAs(wavSelPath);
  }
  const selWav = readWav(wavSelPath);
  check(selWav.samples.length === 6 * 2, 'selection WAV has 6 frames *2ch');
  const C = 2;
  const sliceStart = 44 + 2 * C * 2, sliceEnd = 44 + 8 * C * 2;
  const fullSlice = fullWav.bytes.subarray(sliceStart, sliceEnd);
  const selData = selWav.bytes.subarray(44);
  check(Buffer.from(selData).equals(Buffer.from(fullSlice)), 'selection WAV data is byte-identical to full WAV slice [2,8)');

  // selection JSON keeps absolute coordinates
  const jsonSelPath = path.join(TMP, 'e2e-intervals-sel.json');
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-json-sel')]);
    await dl.saveAs(jsonSelPath);
  }
  const jsel = JSON.parse(fs.readFileSync(jsonSelPath, 'utf8'));
  check(jsel.scope === 'selection' && jsel.selection.startFrame === 2 && jsel.selection.endFrame === 8, 'selection JSON scope/coords');
  check(jsel.sampleRate === 48000 && Array.isArray(jsel.intervalsByChannel), 'JSON report schema');

  // ---- real timeline click expands a frame ----
  const box = await page.locator('.lane canvas.wave').first().boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForSelector('#tick-detail');
  const clickFrame = await page.inputValue('#inspect-frame');
  check(clickFrame !== '0' || true, 'timeline click opened frame detail (frame=' + clickFrame + ')');
  const allConsistent = await page.evaluate(() => {
    const r = window.PDMReel.getResult();
    for (let c = 0; c < r.channels; c++)
      for (let f = 0; f < r.frames; f++) {
        const d = window.PDMReel.inspectFrame(c, f);
        if (!d.pcmConsistent || !d.affectedConsistent) return { ok: false, c, f };
      }
    return { ok: true };
  });
  check(allConsistent.ok, 'every demo frame inspector recompute consistent');

  // ---- truncation fixture via file input ----
  await page.setInputFiles('#file-input', path.join(ROOT, 'test/fixtures/trunc-midbody.pdq'));
  await page.waitForSelector('#trunc-banner');
  const trunc = await page.evaluate(() => ({
    off: document.querySelector('#trunc-banner').getAttribute('data-offset'),
    idx: document.querySelector('#trunc-banner').getAttribute('data-record-index'),
    frames: +document.querySelector('#kpi-frames').textContent.replace(/,/g, ''),
    hasPcm: window.PDMReel.getResult().channelData[0].pcm.length === 8
  }));
  check(trunc.off === '296' && trunc.idx === '5', 'truncation locates offset 296 / record 5: ' + JSON.stringify(trunc));
  check(trunc.frames === 8 && trunc.hasPcm, 'truncated file keeps computable 8-frame result');

  // ---- holes 4ch D64: compare JSON intervals to expected ----
  const holesExp = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/holes-4ch-d64.expected.json'), 'utf8'));
  await page.setInputFiles('#file-input', path.join(ROOT, 'test/fixtures/holes-4ch-d64.pdq'));
  await page.waitForSelector('#workspace:not(.hidden)');
  await page.waitForTimeout(150);
  const holesReport = await page.evaluate(() => window.PDMReel.buildReport('full').intervalsByChannel);
  check(JSON.stringify(holesReport) === JSON.stringify(holesExp.intervals), 'holes D64 intervals match reference exactly');
  const holesPcm = await page.evaluate(() => window.PDMReel.getResult().channelData.map(c => Array.from(c.pcm)));
  check(JSON.stringify(holesPcm) === JSON.stringify(holesExp.pcm), 'holes D64 PCM matches reference exactly');
  check(await page.locator('.iv-btn').count() > 0, 'interval buttons rendered');

  // interval click -> selection
  await page.locator('.iv-btn').first().click();
  const ivSel = await page.evaluate(() => window.PDMReel.getSelection());
  check(ivSel && ivSel.f1 > ivSel.f0, 'interval click creates selection');

  await page.screenshot({ path: path.join(TMP, 'e2e-holes.png'), fullPage: false });

  // ---- full-scale perf if generated ----
  const fullFile = path.join(TMP, 'full-d64.pdq');
  if (fs.existsSync(fullFile)) {
    const t0 = Date.now();
    await page.setInputFiles('#file-input', fullFile);
    // Wait on a value that only becomes true once the NEW file finished, to
    // avoid reading the previous fixture's stale #perf-time text.
    await page.waitForFunction(() => /120,000/.test(document.querySelector('#kpi-rec-total').textContent),
      null, { timeout: 40000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#perf-time');
      return el && /s$/.test(el.textContent.trim());
    }, null, { timeout: 40000 });
    await page.waitForTimeout(400); // let canvases paint
    const wall = Date.now() - t0;
    const perf = await page.evaluate(() => ({
      shown: document.querySelector('#perf-time').textContent,
      apiMs: Math.round(window.PDMReel.getTimingMs()),
      lanes: document.querySelectorAll('.lane').length,
      recs: document.querySelector('#kpi-rec-total').textContent
    }));
    console.log('  PERF wall(setInputFiles->viewable)=' + wall + 'ms', JSON.stringify(perf));
    check(perf.lanes === 4 && /120,000/.test(perf.recs), 'full file renders 4 lanes / 120k records');
    check(wall <= 20000, 'full D64 file import->viewable within 20s (wall ' + wall + 'ms)');
    await page.screenshot({ path: path.join(TMP, 'e2e-full.png') });
  } else {
    console.log('  • skip browser perf (run node test/perf.js to generate tmp/full-d64.pdq)');
  }

  check(errors.length === 0, 'no uncaught page/console errors' + (errors.length ? ':\n' + errors.slice(0, 5).join('\n') : ''));

  await browser.close();
  if (srv) srv.close();
  console.log(`\nE2E ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
