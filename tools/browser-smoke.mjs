/**
 * 真实浏览器端到端冒烟：
 *  - 页面无 console/page 错误，样例自动载入
 *  - 浏览器计算结果与 Python oracle 全像素比对
 *  - 像素选择 / 图表 / 锚编辑 / 撤销 / 导出 LUM1 下载
 *  - 坏文件字节偏移且保留前次结果
 *  - 满额 400 万事件在浏览器内 < 12s
 * 运行：node tools/browser-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  const root = execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(root, 'playwright')));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GEN = join(HERE, 'generated');
const SHOTS = join(ROOT, '.smoke-shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8159;
const BASE = `http://127.0.0.1:${PORT}/index.html`;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} — ${detail}`); }
}

const oracle = JSON.parse(readFileSync(join(GEN, 'oracle.json'), 'utf8'));

const server = spawn(process.execPath, [join(HERE, 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.EVReel && window.EVReel.getState().hasData, { timeout: 8000 });
  await page.evaluate(() => window.EVReel.whenIdle());
  check('sample autoload in browser', true);

  // ---- oracle 全像素比对（样例 5 窗） ----
  const sampleCase = oracle.valid[0];
  await page.evaluate((wins) => window.EVReel.setWindows(wins), sampleCase.windows);
  await page.waitForFunction(() => !window.EVReel.getState().busy);
  const cmp = await page.evaluate((tc) => {
    const r = window.EVReel.getResult();
    const P = tc.w * tc.h;
    let maxRel = 0, maxCov = 0, n = 0, badZero = 0;
    for (let wi = 0; wi < tc.windows.length; wi++) {
      for (let p = 0; p < P; p++) {
        const a = r.lum[wi * P + p], b = tc.expected[wi][p][0];
        const d = Math.abs(a - b), m = Math.max(Math.abs(a), Math.abs(b));
        const rel = m ? d / m : d;
        if (rel > maxRel) maxRel = rel;
        const ac = Math.abs(r.cov[wi * P + p] - tc.expected[wi][p][1]);
        if (ac > maxCov) maxCov = ac;
        n++;
        if (b === 0 && a !== 0) badZero++;
      }
    }
    return { maxRel, maxCov, n, badZero };
  }, sampleCase);
  check('browser vs python lum rel < 1e-7', cmp.maxRel < 1e-7, `maxRel=${cmp.maxRel}`);
  check('browser vs python cov abs < 1e-10', cmp.maxCov < 1e-10, `maxCov=${cmp.maxCov}`);
  check('zero cases exact', cmp.badZero === 0, `${cmp.badZero} nonzero zeros`);

  // ---- 预览像素选择 + 图表 ----
  await page.evaluate(() => window.EVReel.selectPixel(7));
  await page.waitForSelector('[data-testid=pixel-chart] svg path', { timeout: 3000 });
  const anchorRects = await page.locator('[data-testid=pixel-chart] svg rect').count();
  check('chart rendered with rects/bands', anchorRects > 3, `rects=${anchorRects}`);
  const segChips = await page.locator('[data-testid=segment-chip]').count();
  check('segment chips = A-1 (2)', segChips === 2, `chips=${segChips}`);
  await page.screenshot({ path: join(SHOTS, 'desktop-main.png'), fullPage: false });

  // ---- 锚编辑 + 撤销 ----
  const before = await page.evaluate(() => ({
    v: window.EVReel.getPixelValues()[0].luminance,
    code: window.EVReel.getAnchorCode(1),
    depth: window.EVReel.undoDepth(),
  }));
  await page.click('[data-testid="anchor-missing-1"]');
  await page.waitForFunction(() => window.EVReel.getAnchorCode(1) === -32768);
  const afterEdit = await page.evaluate(() => window.EVReel.getPixelValues()[0]);
  check('anchor -> missing changes value/coverage',
    afterEdit.coverage !== before.coverage || afterEdit.luminance !== before.v,
    `before=${before.v} after=${afterEdit.luminance}`);
  check('undo button enabled', await page.locator('[data-testid=undo]').isEnabled());
  await page.click('[data-testid=undo]');
  await page.waitForFunction((oldCode) => window.EVReel.getAnchorCode(1) === oldCode, before.code);
  const afterUndo = await page.evaluate(() => window.EVReel.getPixelValues()[0].luminance);
  check('undo restores luminance exactly', afterUndo === before.v, `${afterUndo} vs ${before.v}`);

  // API 非法码值应抛错
  const badCode = await page.evaluate(() => {
    try { window.EVReel.setAnchorCode(0, 99999); return 'no-throw'; }
    catch (e) { return 'threw'; }
  });
  check('illegal anchor code rejected', badCode === 'threw');

  // ---- LUM1 下载并解析 ----
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('[data-testid=export-current]'),
  ]);
  const lumPath = join(SHOTS, 'downloaded.window.lum1');
  await download.saveAs(lumPath);
  const lb = readFileSync(lumPath);
  check('LUM1 magic', lb.subarray(0, 4).toString('ascii') === 'LUM1');
  check('LUM1 dims', lb.readUInt16LE(4) === 32 && lb.readUInt16LE(6) === 18);
  check('LUM1 interleaved size', lb.length === 8 + 8 * 32 * 18, `size=${lb.length}`);
  // 与浏览器当前结果 f32 一致
  const lumOk = await page.evaluate((bufArr) => {
    const dv = new DataView(new Uint8Array(bufArr).buffer);
    const r = window.EVReel.getResult();
    const wi = window.EVReel.getState().activeWindow;
    const P = 576;
    let worst = 0;
    for (let p = 0; p < P; p++) {
      const f = dv.getFloat32(8 + p * 8, true);
      const exp = Math.fround(r.lum[wi * P + p]);
      if (f !== exp) return { ok: false, p, f, exp };
      const c = dv.getFloat32(8 + p * 8 + 4, true);
      const expC = Math.fround(r.cov[wi * P + p]);
      if (c !== expC) return { ok: false, cp: p, c, expC };
      worst++;
    }
    return { ok: true, n: worst };
  }, new Uint8Array(lb).toJSON ? Array.from(lb) : Array.from(lb));
  check('downloaded LUM1 f32 bytes match current version', lumOk.ok === true, JSON.stringify(lumOk).slice(0, 200));

  // ZIP 导出头
  const zipB64 = await page.evaluate(() => {
    const z = window.EVReel.buildAllZip();
    let s = ''; for (let i = 0; i < Math.min(4, z.length); i++) s += String.fromCharCode(z[i]);
    return { head: s, len: z.length };
  });
  check('zip PK header', zipB64.head === 'PK\x03\x04', zipB64.head);

  // ---- 坏文件：偏移 28，且保留前次结果 ----
  const badCase = oracle.malformed.find((m) => m.name === 'event-time-after');
  const badPath = join(GEN, 'bad28.evl');
  writeFileSync(badPath, Buffer.from(badCase.b64, 'base64'));
  const versionBefore = await page.evaluate(() => window.EVReel.getState().version);
  await page.setInputFiles('[data-testid=file-input]', badPath);
  await page.waitForSelector('[data-testid=error-banner]:not([hidden])', { timeout: 4000 });
  const off = await page.textContent('[data-testid=error-offset]');
  check('bad file offset == 28', off.trim() === '28', `offset text=${off}`);
  const retained = await page.evaluate((v) => {
    const s = window.EVReel.getState();
    return s.hasData && s.version === v && !!window.EVReel.getResult();
  }, versionBefore);
  check('previous result retained after bad file', retained);
  await page.screenshot({ path: join(SHOTS, 'bad-file-offset.png') });

  // 再喂一个截断头部用例，偏移 12
  const bad12 = oracle.malformed.find((m) => m.name === 'eventcount-trunc');
  const bad12Path = join(GEN, 'bad12.evl');
  writeFileSync(bad12Path, Buffer.from(bad12.b64, 'base64'));
  await page.setInputFiles('[data-testid=file-input]', bad12Path);
  await page.waitForFunction(() => document.querySelector('[data-testid=error-offset]').textContent.trim() === '12');
  check('truncated eventCount offset == 12', true);

  // 好文件可从错误状态恢复
  await page.setInputFiles('[data-testid=file-input]', join(GEN, 'sample.evl'));
  await page.waitForFunction(() => window.EVReel.getState().hasData && !window.EVReel.getState().busy);
  check('good file recovers', true);

  // ---- 满额性能（浏览器内 fetch 同源 35MB） ----
  if (existsSync(join(GEN, 'full.evl'))) {
    // 显式布置 24 个窗（部分越界），再加载满额文件
    await page.evaluate(() => {
      const wins = [];
      for (let i = 0; i < 24; i++) {
        const s = Math.floor(i / 24 * 1_800_000);
        let e = s + 100_000 + (i % 5) * 40_000;
        if (i % 7 === 0) e = 2_050_000 + i;
        wins.push([s, e]);
      }
      window.__perfWins = wins;
      return window.EVReel.setWindows(wins);
    });
    await page.waitForFunction(() => !window.EVReel.getState().busy);
    const perf = await page.evaluate(async () => {
      const t0 = performance.now();
      const r = await window.EVReel.openFile('tools/generated/full.evl');
      await window.EVReel.whenIdle();
      return { wall: performance.now() - t0, ...r, state: window.EVReel.getState().timings };
    });
    console.log('PERF browser:', JSON.stringify(perf));
    check('full file ok', perf.ok === true);
    check('full 24 windows under 12s (in-app total)',
      perf.totalMs < 12000, `totalMs=${perf.totalMs?.toFixed?.(0) || perf.totalMs}`);
    check('full wall under ~15s incl fetch', perf.wall < 15000, `wall=${perf.wall.toFixed(0)}`);
    await page.screenshot({ path: join(SHOTS, 'full24-preview.png') });

    // ---- 竞态：窗口重算在途时连续改锚+撤销，最终结果必须与当前码一致 ----
    const race = await page.evaluate(async () => {
      const R = window.EVReel;
      const p = 12345;
      const p0 = R.setWindows([[0, 1000000], [100, 2000000], [500000, 1500000]]);
      R.selectPixel(p);
      R.setAnchorCode(0, -32768);
      R.setAnchorCode(2, -5000);
      R.undo();
      R.setAnchorCode(3, 1234);
      await p0;
      await R.whenIdle();
      // 用核心按“当前码”独立重算该像素
      const data = R.getData(), wins = R.getWindows(), P = data.pixels, W = wins.length;
      const lum = new Float64Array(W * P), cov = new Float64Array(W * P);
      const dur = new Float64Array(W), intg = new Float64Array(W);
      R.core.computePixelInto(data, p, wins, lum, cov, P, dur, intg);
      const got = R.getResult();
      let maxRel = 0, maxCov = 0;
      for (let w = 0; w < W; w++) {
        const i = w * P + p;
        maxRel = Math.max(maxRel, Math.abs(got.lum[i] - lum[i]) / Math.max(1e-30, Math.abs(lum[i])));
        maxCov = Math.max(maxCov, Math.abs(got.cov[i] - cov[i]));
      }
      // 导出字节也必须等于当前结果的 f32
      const bytes = new Uint8Array(R.buildLUM1(0));
      const dv = new DataView(bytes.buffer);
      const f0 = dv.getFloat32(8 + p * 8, true);
      return { maxRel, maxCov, f32Match: f0 === Math.fround(got.lum[p]), code0: R.getAnchorCode(0), code3: R.getAnchorCode(3) };
    });
    check('race: final pixel consistent with current codes', race.maxRel < 1e-12 && race.maxCov === 0,
      JSON.stringify(race));
    check('race: export follows final version', race.f32Match === true);
  }

  // ---- 覆盖率图层切换不报错 ----
  await page.click('[data-testid=layer-cov]');
  await page.click('[data-testid=layer-lum]');
  check('layer toggles ok', true);

  // ---- 移动端窄屏截图 ----
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'mobile-420.png') });

  check('no unexpected console errors',
    consoleErrors.filter((m) => !/favicon|Download the React/i.test(m)).length === 0,
    consoleErrors.join(' || ').slice(0, 400));
} catch (e) {
  fail++;
  console.log('EXCEPTION', e);
  await page.screenshot({ path: join(SHOTS, 'exception.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
