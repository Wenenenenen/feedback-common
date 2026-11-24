// 截图核对：桌面明暗主题与手机窄屏，跑一次完整反查后截图。
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

let pw;
try {
  pw = (await import('playwright')).default ?? (await import('playwright'));
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  const mod = await import(join(globalRoot, 'playwright', 'index.js'));
  pw = mod.default ?? mod;
}
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');
const outDir = join(root, '_shots');
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const server = createServer((req, res) => {
  const filePath = join(srcDir, req.url === '/' ? 'index.html' : req.url);
  if (!filePath.startsWith(srcDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});
await new Promise((r) => server.listen(8124, r));

const browser = await chromium.launch();

async function shoot(name, { width, height, theme }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8124/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#fileInput', join(root, 'samples', 'inverse-color-cases.zip'));
  await page.waitForFunction(() =>
    document.getElementById('nameTable').textContent.includes('table.json')
  );
  await page.locator('#applyBtn').click();
  await page.waitForFunction(() =>
    document.getElementById('statStatus').textContent === '完成'
  );
  await page.locator('#cvTarget').click({ position: { x: 20, y: 12 } });
  await page.waitForFunction(() => document.getElementById('piCode').textContent !== '—');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });
  await context.close();
  console.log('saved', name);
}

await shoot('desktop-light', { width: 1280, height: 900, theme: 'light' });
await shoot('desktop-dark', { width: 1280, height: 900, theme: 'dark' });
await shoot('mobile-light', { width: 390, height: 844, theme: 'light' });

await browser.close();
server.close();
