/**
 * 截图脚本：启动服务器，打开若干关键状态并截图。
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(ROOT, '.smoke-shots');
const PORT = 8141;
const BASE = `http://localhost:${PORT}`;

await mkdir(SHOTS, { recursive: true });
const server = spawn(process.execPath, [join(HERE, 'serve.mjs'), String(PORT), ROOT], { cwd: ROOT });
await new Promise((r) => server.stdout.on('data', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1380, height: 1180 }, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');

  // flash: 三角权重 + 扫描延迟 + 选中像素
  await page.selectOption('#caseSelect', { label: 'flash' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');
  await page.evaluate(() => {
    const s = document.getElementById('startRange'); s.value = '-0.1'; s.dispatchEvent(new Event('input'));
    const d = document.getElementById('durationRange'); d.value = '0.5'; d.dispatchEvent(new Event('input'));
    const sd = document.getElementById('scanDelayRange'); sd.value = '0.5'; sd.dispatchEvent(new Event('input'));
    document.querySelector('[data-weight="triangle"]').click();
  });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');
  await page.evaluate(() => {
    const cv = document.getElementById('integratedCanvas');
    const r = cv.getBoundingClientRect();
    // 点击像素 (1,2)
    const scale = cv.width / 5;
    cv.dispatchEvent(new MouseEvent('click', {
      clientX: r.left + (1.5 * scale) * (r.width / cv.width),
      clientY: r.top + (2.5 * scale) * (r.height / cv.height),
      bubbles: true,
    }));
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'state-flash-triangle.png'), fullPage: true });

  // cross: 默认参数，选中中心
  await page.selectOption('#caseSelect', { label: 'cross' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');
  await page.evaluate(() => {
    document.getElementById('startRange').value = '0';
    document.getElementById('startRange').dispatchEvent(new Event('input'));
    document.getElementById('durationRange').value = '1';
    document.getElementById('durationRange').dispatchEvent(new Event('input'));
    document.getElementById('scanDelayRange').value = '0';
    document.getElementById('scanDelayRange').dispatchEvent(new Event('input'));
    document.querySelector('[data-weight="uniform"]').click();
    document.querySelector('[data-scan="down"]').click();
  });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');
  await page.evaluate(() => {
    const cv = document.getElementById('integratedCanvas');
    const r = cv.getBoundingClientRect();
    const scale = cv.width / 5;
    cv.dispatchEvent(new MouseEvent('click', {
      clientX: r.left + (2.5 * scale) * (r.width / cv.width),
      clientY: r.top + (2.5 * scale) * (r.height / cv.height),
      bubbles: true,
    }));
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'state-cross.png'), fullPage: true });

  // curved-event 瞬时 t=0.5
  await page.selectOption('#caseSelect', { label: 'curved-event' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'state-curved.png'), fullPage: true });

  console.log('errors:', errors.length ? errors : 'none');
} catch (e) {
  console.log('error', e.stack);
} finally {
  await browser.close();
  server.kill();
}
