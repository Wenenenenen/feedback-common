// End-to-end browser test for the headroom planner page.
// Run: node tools/e2e_check.js
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const CASES = path.join(ROOT, 'tools', 'cases');
const UNPACKED = path.join(ROOT, '_unpacked');
const H = require(path.join(WEB, 'headroom.js'));

const http = require('http');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('ok  :', msg);
  else { failures++; console.error('FAIL:', msg); }
}

function startServer(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wav': 'audio/wav',
  };
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const fp = path.normalize(path.join(root, url));
    if (!fp.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': types[path.extname(fp)] || 'application/octet-stream',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      server: srv,
      base: 'http://127.0.0.1:' + srv.address().port,
    }));
  });
}

(async () => {
  // serve repo root so /web and /tools/cases share one origin
  const { server, base } = await startServer(ROOT);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base + '/web/index.html');
  await page.waitForSelector('#solveBtn');

  // --- demo solve -----------------------------------------------------------
  await page.click('#demoBtn');
  await page.click('#solveBtn');
  await page.waitForSelector('#stagePanel:not([hidden])');
  check(await page.textContent('#tTotal') === '0', 'demo: total shift 0');
  check(await page.textContent('#tPsum') === '0', 'demo: prefix sum 0');
  const stageRows = await page.$$eval('#stageBody tr', (trs) => trs.length);
  check(stageRows === 6, 'demo: 3 stages x (margin+book) rows = 6');
  const ids = await page.$$eval('#stageBody td',
    (tds) => tds.map((t) => t.textContent));
  // first margin row: stage index, id, shift pill, label, margins...
  check(ids[1] === '2' && ids[2] === '>>0',
    'demo: first processed section id is 2, shift 0 — got ' + ids.slice(0, 3));

  // --- infeasible plan shows explicit no-solution ---------------------------
  await page.setInputFiles('#planFile', path.join(CASES, 'infeasible.json'));
  await page.waitForSelector('#solveBtn:not([disabled])');
  await page.click('#solveBtn');
  await page.waitForFunction(
    () => document.querySelector('#tTotal')?.textContent === '无解');
  const noSolText = await page.textContent('#solMsg');
  check(noSolText.includes('没有任何顺序'), 'infeasible: explicit no-solution message');
  check(await page.$('#dlPlan[disabled]') !== null,
    'infeasible: plan download disabled');

  // --- needshift + wav: full worker pipeline --------------------------------
  await page.setInputFiles('#planFile', path.join(CASES, 'needshift.json'));
  await page.setInputFiles('#wavFile', path.join(CASES, 'mix.wav'));
  await page.waitForSelector('#solveBtn:not([disabled])');
  await page.click('#solveBtn');
  await page.waitForSelector('#stagePanel:not([hidden])');
  check(await page.textContent('#tTotal') === '5', 'needshift: total shift 5');
  check(await page.textContent('#tPsum') === '10', 'needshift: prefix sum 10');

  await page.waitForSelector('#simPanel:not([hidden])');
  const wavMeta = await page.textContent('#wavMeta');
  check(wavMeta.includes('48000Hz') && wavMeta.includes('双声道')
    && wavMeta.includes('48000 帧'), 'wav metadata rendered: ' + wavMeta);

  const [downloadPlan] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlPlan'),
  ]);
  const planPath = '/tmp/e2e_plan.json';
  await downloadPlan.saveAs(planPath);
  const planJson = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  check(planJson.totalShift === 5 && planJson.stages.length === 3
    && planJson.stages[0].id === 11 && planJson.stages[0].shift === 1,
    'plan download content correct');
  check(Array.isArray(planJson.stages[0].margin)
    && planJson.stages[0].margin.length === 2,
    'plan download carries per-stage margins');

  await page.click('#simBtn');
  await page.waitForSelector('#simResult:not([hidden])');
  const clipRows = await page.$$eval('#clipBody tr', (trs) => trs.length);
  check(clipRows === 3, 'clip table has 3 stage rows');
  const clipTable = await page.$$eval('#clipBody tr', (trs) => trs.map(
    (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)));
  // expected counts come from the same core via a fresh Node-side run,
  // which node_check.js already proved identical to the Python reference
  const needPlan = JSON.parse(fs.readFileSync(
    path.join(CASES, 'needshift.json'), 'utf8'));
  const needSol = H.solvePlan(needPlan.sections, needPlan.bands);
  const byId = {};
  needPlan.sections.forEach((s) => { byId[s.id] = s; });
  const mixWav = H.parseWav(fs.readFileSync(path.join(CASES, 'mix.wav')));
  const expect = H.simulate(byId, needSol.order, mixWav.frames,
    mixWav.channels, mixWav.samples).clips.map((a) => Array.from(a));
  const got = clipTable.map((r) => [Number(r[3]), Number(r[4])]);
  check(JSON.stringify(got) === JSON.stringify(expect),
    'needshift on mix.wav: rendered clip counts match reference — '
    + JSON.stringify(got));

  // --- range export equals full-track cut -----------------------------------
  await page.fill('#rangeLo', '11040');
  await page.fill('#rangeHi', '32160');
  await page.dispatchEvent('#rangeLo', 'input');
  const meta = await page.textContent('#rangeMeta');
  check(meta.includes('[11040, 32160)'), 'range meta shows half-open interval');

  const [dlRange] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlRange'),
  ]);
  const rangePath = '/tmp/e2e_range.wav';
  await dlRange.saveAs(rangePath);

  const [dlFull] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlFull'),
  ]);
  const fullPath = '/tmp/e2e_full.wav';
  await dlFull.saveAs(fullPath);

  const rangeWav = H.parseWav(fs.readFileSync(rangePath));
  const fullWav = H.parseWav(fs.readFileSync(fullPath));
  check(rangeWav.frames === 32160 - 11040, 'range wav frame count exact');
  let mismatch = 0;
  for (let f = 11040; f < 32160; f++) {
    for (let c = 0; c < 2; c++) {
      if (rangeWav.samples[(f - 11040) * 2 + c]
          !== fullWav.samples[f * 2 + c]) mismatch++;
    }
  }
  check(mismatch === 0, 'exported range samples identical to full-track cut');

  // clip stats download
  const [dlClips] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlClips'),
  ]);
  const clipsPath = '/tmp/e2e_clips.json';
  await dlClips.saveAs(clipsPath);
  const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
  const expectTotal = expect.reduce(
    (s, r) => s + r.reduce((a, b) => a + b, 0), 0);
  check(clipsJson.stages.length === 3
    && clipsJson.totalClips === expectTotal
    && clipsJson.frames === 48000,
    'clip stats download matches reference totals (' + expectTotal + ' clips)');

  // --- clipping actually happens on the sample program with demo plan -------
  await page.setInputFiles('#planFile', path.join(UNPACKED, 'plan.json'));
  await page.setInputFiles('#wavFile', path.join(CASES, 'mix.wav'));
  await page.waitForSelector('#solveBtn:not([disabled])');
  await page.click('#solveBtn');
  await page.waitForSelector('#simPanel:not([hidden])');
  await page.click('#simBtn');
  await page.waitForSelector('#simResult:not([hidden])');
  const clipText = await page.textContent('#clipBody');
  check(clipText.includes('1') && clipText.includes('clip') === false,
    'sample plan on mix.wav records nonzero clip counts: '
    + clipText.replace(/\s+/g, ' ').trim());
  const simMsg = await page.textContent('#simMsg');
  check(simMsg.includes('削顶'), 'simulation summary mentions clipping');

  // --- validation errors -----------------------------------------------------
  await page.setInputFiles('#planFile', path.join(CASES, 'mono.wav'));
  const errMsg = await page.textContent('#planMsg');
  check(errMsg.includes('JSON') || errMsg.includes('校验') || errMsg.includes('解析'),
    'non-JSON plan upload surfaces an error: ' + errMsg.slice(0, 40));

  // --- WAV boundary: exactly 120s accepted, 120.1s rejected ------------------
  await page.setInputFiles('#wavFile', path.join(CASES, 'over120.wav'));
  await page.waitForFunction(() => {
    const m = document.querySelector('#planMsg');
    return m.classList.contains('show') && m.textContent.includes('120 秒');
  });
  check(true, '120.1s WAV rejected with explicit length error');

  await page.setInputFiles('#planFile', path.join(CASES, 'needshift.json'));
  await page.setInputFiles('#wavFile', path.join(CASES, 'max120.wav'));
  await page.waitForSelector('#solveBtn:not([disabled])');
  await page.click('#solveBtn');
  await page.waitForSelector('#simPanel:not([hidden])');
  const meta120 = await page.textContent('#wavMeta');
  check(meta120.includes('5760000 帧') && meta120.includes('120.000 秒'),
    'exactly-120s WAV accepted: ' + meta120);
  await page.click('#simBtn');
  await page.waitForSelector('#simResult:not([hidden])', { timeout: 60000 });
  const fullClipRows = await page.$$eval('#clipBody tr', (trs) => trs.length);
  check(fullClipRows === 3, 'full 120s simulation produced clip table');
  check(errors.length === 0,
    'no browser console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
