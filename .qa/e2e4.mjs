import pkg from '/tmp/sf-domtest/node_modules/playwright-core/index.js';
const { chromium } = pkg;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = process.cwd();
const EXE = '/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const t = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!t.startsWith(ROOT) || !fs.existsSync(t)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(t)] || 'application/octet-stream' });
  fs.createReadStream(t).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.querySelector('#metaW').textContent === '16', null, { timeout: 10000 });

const st = () => page.evaluate(() => {
  const A = __PM_APP__.S;
  return { round: A.round, status: document.querySelector('#statusText').textContent,
    loss: A.loss, stepSize: A.stepSize, metaW: A.engineMeta && A.engineMeta.W,
    busy: A.busy, playing: A.playing, done: A.done, eta: A.eta, z: A.z.slice() };
});
const waitFor = async (pred, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await st(); if (pred(v)) return v; await page.waitForTimeout(200); }
  throw new Error('timeout ' + JSON.stringify(await st()));
};
const exportBin = async (name) => {
  const d = page.waitForEvent('download'); await page.click('#btnExportDrive');
  const dl = await d; await dl.saveAs('.qa/' + name); return fs.readFileSync('.qa/' + name);
};
async function setZReset(i, val) {
  await page.locator('#zRows input').nth(i).fill(String(val));
  await page.locator('#zRows input').nth(i).press('Enter');
  await page.waitForTimeout(200);
  await waitFor((v) => v.status === '第 0 轮' && !v.busy);
}
async function setSteps(v) {
  await page.locator('#stepsInput').fill(String(v));
  await page.locator('#stepsInput').press('Enter');
  await waitFor((x) => !x.busy);
}

const ch = page.waitForEvent('filechooser'); await page.click('#btnLoad'); (await ch).setFiles('.qa/big.json');
await waitFor((v) => v.metaW === 256 && v.status === '第 0 轮');
await setSteps(6);

/* ---- A. 满规模 12 轮计时（steps 改回 12） ---- */
await setSteps(12);
await setZReset(0, 4);
const t0 = Date.now();
await page.click('#btnRun');
const done = await waitFor((v) => v.done && v.round === 12, 60000);
console.log('PERF 12 rounds:', Date.now() - t0, 'ms; loss', done.loss.toFixed(6), 'step', done.stepSize);
await page.screenshot({ path: '.qa/shot-big-done.png', fullPage: true });

/* ---- B. 暂停续跑 vs 同设置直跑（同一 z 设置） ---- */
async function reloadSame() {
  await page.evaluate(() => __PM_APP__.loadProjectObject(JSON.parse(JSON.stringify(__PM_APP__.S.project)), 'reload'));
  await page.waitForTimeout(200);
  await waitFor((v) => v.status === '第 0 轮' && !v.busy);
}
await setSteps(6);
await setZReset(0, 5);
await page.click('#btnRun');
await waitFor((v) => v.round >= 3);
await page.click('#btnPause');
const paused = await waitFor((v) => !v.playing && !v.busy);
console.log('PAUSED at round', paused.round, 'loss', paused.loss.toFixed(10), 'step', paused.stepSize);
await page.click('#btnRun');
const resumed = await waitFor((v) => v.done && v.round === 6);
await page.evaluate(() => __PM_APP__.pause()); await waitFor((v) => !v.playing && !v.busy);
const resBin = await exportBin('resumed6.bin');
await reloadSame();
await page.click('#btnRun');
const straight = await waitFor((v) => v.done && v.round === 6);
const refBin = await exportBin('ref6.bin');
console.log('PAUSE resume loss', resumed.loss.toFixed(10), 'straight', straight.loss.toFixed(10),
  'equal', Math.abs(resumed.loss - straight.loss) < 1e-12,
  'bytesEqual', Buffer.compare(resBin, refBin) === 0);

/* ---- C. 旧任务不得覆盖新设置 ---- */
await setSteps(12);
await reloadSame();
await page.click('#btnRun');
await page.waitForTimeout(700);
await setZReset(1, 11.5);          // 旧任务仍在后台跑
await page.locator('#etaInput').fill('0.5');
await page.locator('#etaInput').press('Enter');
await page.waitForTimeout(200);
const fresh = await waitFor((v) => v.status === '第 0 轮' && !v.busy);
const freshLoss = fresh.loss;
await page.waitForTimeout(6000);   // 给旧任务充足时间“归来”
const after = await st();
console.log('STALE after wait:', JSON.stringify({ status: after.status, round: after.round, eta: after.eta, z: after.z }),
  'loss', after.loss, 'freshRound0', freshLoss, 'unchanged', Math.abs(after.loss - freshLoss) < 1e-12);
await page.screenshot({ path: '.qa/shot-stale.png', fullPage: true });

console.log('errors', errs);
await browser.close(); await new Promise((r) => server.close(r));
