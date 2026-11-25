/** 生成关键状态截图到 .smoke-shots/（人工检视用）。 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { const r = execSync('npm root -g').toString().trim(); ({ chromium } = require(join(r, 'playwright'))); }

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(ROOT, '.smoke-shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8163;
const oracle = JSON.parse(readFileSync(join(HERE, 'generated', 'oracle.json'), 'utf8'));

const srv = spawn(process.execPath, [join(HERE, 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

async function shoot(browser, scheme, suffix) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    colorScheme: scheme, deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.EVReel.getState().hasData);
  await page.evaluate(() => window.EVReel.whenIdle());

  // 样例：事件较多的像素 100
  await page.evaluate(() => window.EVReel.selectPixel(100));
  await page.waitForTimeout(250);
  await page.locator('[data-testid=pixel-chart]').screenshot({ path: join(SHOTS, `chart-events-${suffix}.png`) });
  await page.screenshot({ path: join(SHOTS, `full-${suffix}.png`) });

  // 覆盖率图层
  await page.click('[data-testid=layer-cov]');
  await page.waitForTimeout(150);
  await page.locator('.preview-card').screenshot({ path: join(SHOTS, `coverage-${suffix}.png`) });
  await page.click('[data-testid=layer-lum]');

  // 载入一个含缺锚/事件的随机用例，找缺锚像素
  const tc = oracle.valid[3];
  await page.evaluate(async (f) => {
    const r = await fetch('tools/generated/' + f);
    const b = await r.arrayBuffer();
    await window.EVReel.loadBuffer(b, f);
  }, tc.file);
  await page.evaluate((w) => window.EVReel.setWindows(w), tc.windows.slice(0, 3));
  const missingPixel = await page.evaluate(() => {
    const d = window.EVReel.core;
    const data = window.EVReel.getResult();
    const st = window.EVReel.getState();
    // 通过内部数据找缺锚像素：用 API 遍历 anchor code
    const A = st.anchorCount;
    // EVReel 未直接暴露 data；用 select + getAnchorCode 探测
    for (let p = 0; p < st.width * st.height; p++) {
      window.EVReel.selectPixel(p);
      let miss = false;
      for (let a = 0; a < A; a++) if (window.EVReel.getAnchorCode(a) === -32768) miss = true;
      if (miss) return p;
    }
    return 0;
  });
  await page.evaluate((p) => window.EVReel.selectPixel(p), missingPixel);
  await page.waitForTimeout(200);
  await page.locator('[data-testid=pixel-chart]').screenshot({ path: join(SHOTS, `chart-missing-${suffix}.png`) });

  if (errors.length) console.log(suffix, 'pageerrors:', errors);
  await ctx.close();
}

const browser = await chromium.launch({ headless: true });
await shoot(browser, 'light', 'light');
await shoot(browser, 'dark', 'dark');

// 移动端
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.EVReel.getState().hasData);
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, 'mobile-top.png') });
await browser.close();
srv.kill();
console.log('shots done');
