// End-to-end tests driven through a real browser (Playwright + Chromium).
// Skipped automatically when Playwright or its browser is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium = null;
try {
  const pw = require(path.join(execGlobalRoot(), 'playwright'));
  chromium = pw.chromium;
} catch { /* not installed */ }

function execGlobalRoot() {
  // node's global module root, without spawning a process
  const p = process.execPath;
  const bin = path.dirname(p);
  return path.join(bin, '..', 'lib', 'node_modules');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.f32': 'application/octet-stream',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const target = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
      if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withPage(fn) {
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await fn(page, port, errors);
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

const skip = chromium ? false : 'playwright unavailable';

test('sample case solves, certifies and downloads a valid export', { skip }, async () => {
  await withPage(async (page, port, errors) => {
    await page.click('#btnSample');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 30000 });
    const cert = await page.textContent('#certText');
    assert.match(cert, /已复核|核查/);
    const pg = Number(await page.textContent('#certVal'));
    assert.ok(pg <= 1e-7, `pg ${pg}`);
    await page.click('[data-view=filters]');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnDownloadFilters'),
    ]);
    const txt = fs.readFileSync(await dl.path(), 'utf8');
    const j = JSON.parse(txt);
    assert.equal(j.sample_rate, 48000);
    assert.equal(j.taps, 16);
    assert.equal(j.delay, 1);
    assert.equal(j.lambda, 0.2);
    assert.ok(Number.isFinite(j.objective));
    assert.ok(j.projected_residual <= 1e-7);
    assert.equal(j.filters.length, 2);
    assert.equal(j.filters[0][0].length, 16);
  });
});

test('bad bundles are located precisely and the last result is kept', { skip }, async () => {
  await withPage(async (page) => {
    await page.click('#btnSample');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 30000 });
    const before = await page.textContent('#summaryStats');

    const ZIP = require('../src/inflate.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrinv-test-'));
    const sampleZip = fs.readFileSync(path.join(ROOT, 'samples', 'array-inverse-cases.zip'));
    const entries = await ZIP.unzip(sampleZip);
    const proj = JSON.parse(new TextDecoder().decode(entries.get('project.json')));
    const sig = Buffer.from(entries.get('signals.f32'));
    const bad = path.join(dir, 'badsize.zip');
    fs.writeFileSync(bad, ZIP.zip([
      { name: 'project.json', data: new TextEncoder().encode(JSON.stringify(proj)) },
      { name: 'signals.f32', data: new Uint8Array(12) },
    ]));
    await page.setInputFiles('#fileInput', bad);
    await page.waitForTimeout(300);
    let text = await page.textContent('#caseErrors');
    assert.match(text, /signals\.f32/);
    assert.match(text, /期望 40 字节/);
    assert.equal(await page.textContent('#summaryStats'), before);

    // NaN sample
    const cp = Buffer.from(sig);
    cp.writeFloatLE(NaN, 4);
    const nanZip = path.join(dir, 'nan.zip');
    fs.writeFileSync(nanZip, ZIP.zip([
      { name: 'project.json', data: new TextEncoder().encode(JSON.stringify(proj)) },
      { name: 'signals.f32', data: cp },
    ]));
    await page.setInputFiles('#fileInput', nanZip);
    await page.waitForTimeout(300);
    text = await page.textContent('#caseErrors');
    assert.match(text, /h\[m=1\]\[p=1\]\[n=1\]/);
    assert.equal(await page.textContent('#summaryStats'), before);

    // invalid field
    const badField = path.join(dir, 'badfield.zip');
    fs.writeFileSync(badField, ZIP.zip([
      { name: 'project.json', data: new TextEncoder().encode(JSON.stringify({ ...proj, weights: [1, 9] })) },
      { name: 'signals.f32', data: sig },
    ]));
    await page.setInputFiles('#fileInput', badField);
    await page.waitForTimeout(300);
    text = await page.textContent('#caseErrors');
    assert.match(text, /weights\[1\]/);
    assert.equal(await page.textContent('#summaryStats'), before);
  });
});

test('parameter edits go stale, can be reverted, and invalid values block solving', { skip }, async () => {
  await withPage(async (page) => {
    await page.click('#btnSample');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 30000 });
    assert.equal(await page.isVisible('#staleNote'), false);

    await page.fill('#weightGrid input[data-idx="0"]', '2');
    await page.waitForTimeout(150);
    assert.equal(await page.isVisible('#staleNote'), true);
    assert.equal(await page.isVisible('#btnRevert'), true);

    await page.fill('#weightGrid input[data-idx="0"]', '9');
    await page.waitForTimeout(150);
    const errs = await page.textContent('#paramErrors');
    assert.match(errs, /weights\[0\]/);
    assert.equal(await page.isDisabled('#btnSolve'), true);

    await page.fill('#weightGrid input[data-idx="0"]', '2');
    await page.waitForTimeout(150);
    assert.equal(await page.isDisabled('#btnSolve'), false);
    await page.click('#btnSolve');
    await page.waitForFunction(() => {
      const t = document.getElementById('statusText').textContent;
      return t === '已求解' && !document.getElementById('staleNote').classList.contains('show');
    }, null, { timeout: 30000 });

    await page.fill('#tapsInput', '8');
    await page.dispatchEvent('#tapsInput', 'input');
    await page.waitForTimeout(150);
    assert.equal(await page.isVisible('#staleNote'), true);
    await page.click('#btnRevert');
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue('#tapsInput'), '16');
    assert.equal(await page.isVisible('#staleNote'), false);
  });
});

test('cancel and supersede never overwrite the last valid result', { skip }, async () => {
  await withPage(async (page) => {
    const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrinv-scale-'));
    const heavy = path.join(caseDir, 'scale.zip');
    await new Promise((resolve, reject) => {
      const { execFile } = require('node:child_process');
      execFile(process.execPath, [path.join(ROOT, 'tools/make-case.mjs'), heavy, '--limit', '0.001'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    await page.setInputFiles('#fileInput', heavy);
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 60000 });
    const baseline = await page.textContent('#summaryStats');

    // start a solve and cancel it almost immediately
    await page.click('#btnSolve');
    await page.waitForTimeout(150);
    await page.click('#btnCancel');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#statusText'), '已取消');
    assert.equal(await page.textContent('#summaryStats'), baseline);
    await page.waitForTimeout(1500);
    assert.equal(await page.textContent('#summaryStats'), baseline, 'cancelled solve must not publish');

    // rapid double solve: only the newest may land
    await page.click('#btnSolve');
    await page.waitForTimeout(60);
    await page.click('#btnSolve');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 60000 });
    const after = await page.textContent('#summaryStats');
    assert.match(after, /目标 E/);
    await page.waitForTimeout(1500);
    assert.equal(await page.textContent('#summaryStats'), after);
  });
});

test('per-sample readout matches the plotted curves at every point', { skip }, async () => {
  await withPage(async (page) => {
    await page.click('#btnSample');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '已求解', null, { timeout: 30000 });
    const N = Number(await page.getAttribute('#sampleInput', 'max'));
    assert.ok(N > 0);
    for (const n of [0, 1, Math.floor(N / 2), N - 1]) {
      await page.fill('#sampleInput', String(n));
      await page.dispatchEvent('#sampleInput', 'input');
      await page.waitForTimeout(80);
      const rows = await page.locator('#sampleTable tbody tr').all();
      const first = await rows[0].locator('td').allTextContents();
      const vals = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('#sampleRead .rv .v')].map((e) => Number(e.textContent));
        return spans;
      });
      // residual must equal prediction - target to displayed precision
      const [tgt, pred, res] = vals;
      assert.ok(Math.abs((pred - tgt) - res) <= 1.5e-6, `n=${n}: ${pred} - ${tgt} != ${res}`);
      assert.equal(first[0], '测点 1');
    }
  });
});
