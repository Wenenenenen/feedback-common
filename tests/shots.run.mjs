/* 截图检查：桌面明/暗、手机明/暗，以及失败用例和导出弹窗 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, '..', 'site', 'index.html');
const outDir = path.join(here, '..', 'tmp-shots');

const browser = await chromium.launch();

async function shot(name, { width, height, theme, setup }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme === 'dark' ? 'dark' : 'light'
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('#timeline .beat-cell').length === 3);
  if (theme) await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  if (setup) await setup(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: true });
  await context.close();
  console.log('saved', name);
}

await shot('desktop-light', { width: 1280, height: 1000, theme: 'light' });
await shot('desktop-dark', { width: 1280, height: 1000, theme: 'dark' });
await shot('mobile-light', { width: 390, height: 844, theme: 'light' });
await shot('mobile-dark', { width: 390, height: 844, theme: 'dark' });
await shot('failure-dark', {
  width: 1280, height: 1000, theme: 'dark',
  setup: async (p) => {
    await p.click('#loadFailBtn');
    await p.waitForFunction(() => document.querySelector('#statusPill').classList.contains('fail'));
  }
});
await shot('export-light', {
  width: 1280, height: 1000, theme: 'light',
  setup: async (p) => {
    await p.click('#exportBtn');
    await p.waitForSelector('.modal pre');
  }
});

await browser.close();
console.log('DONE');
