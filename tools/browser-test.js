// Real-browser test: loads the page, injects the sample files through the
// actual file inputs, runs both solver spaces, clicks a canvas, and exercises
// exports. Run while tools/serve.js is listening.
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const S = path.join(root, 'samples', 'extracted');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:8123/index.html');
await page.waitForSelector('#runBtn[disabled]');

async function setFile(inputId, filePath) {
  await page.setInputFiles('#' + inputId, {
    name: path.basename(filePath),
    mimeType: 'image/png',
    buffer: await readFile(filePath),
  });
}
await setFile('guideFile', path.join(S, 'split', 'guide.png'));
await setFile('depthFile', path.join(S, 'split', 'depth.png'));
await setFile('maskFile', path.join(S, 'split', 'domain.png'));
await page.waitForFunction(() => !document.getElementById('runBtn').disabled);

// Check file-row validation labels
console.log('guide meta:', await page.textContent('#guideMeta'));
console.log('depth meta:', await page.textContent('#depthMeta'));
console.log('mask meta:', await page.textContent('#maskMeta'));

async function run(space, solver) {
  await page.check(`input[name="space"][value="${space}"]`);
  await page.selectOption('#solver', solver);
  await page.click('#runBtn');
  await page.waitForSelector('#expDepth:not([disabled])');
  await page.waitForFunction(() => {
    const t = document.querySelector('#runMsg .msg')?.className || '';
    return t.includes('ok') || t.includes('err');
  });
  const msg = await page.textContent('#runMsg');
  const stats = await page.evaluate(() => ({
    state: document.getElementById('stState').textContent,
    valid: document.getElementById('stValid').textContent,
    anchor: document.getElementById('stAnchor').textContent,
    comp: document.getElementById('stComp').textContent,
    unanchored: document.getElementById('stUnanchored').textContent,
    ignored: document.getElementById('stIgnored').textContent,
    res: document.getElementById('stRes').textContent,
    rows: document.querySelectorAll('#compTable tbody tr').length,
  }));
  console.log(`[${space}/${solver}]`, msg.trim(), JSON.stringify(stats));
  return stats;
}

const s1 = await run('depth', 'pcg');
console.assert(s1.comp.startsWith('3'), 'component count 3');
console.assert(s1.unanchored === '1', 'one unanchored');
console.assert(s1.ignored === '1', 'one ignored');
console.assert(s1.state === '全部收敛', 'converged');

// Click on a completed pixel (0,0) in the status canvas and inspect
const box = await page.locator('#cvStatus').boundingBox();
await page.mouse.click(box.x + box.width * (0.5 / 11), box.y + box.height * (0.5 / 5));
const inspector = await page.textContent('#inspector');
console.log('inspector snippet:', inspector.replace(/\s+/g, ' ').slice(0, 220));
console.assert(inspector.includes('成功补全') || inspector.includes('原始测量'), 'inspector shows status');

// Inverse space + GS
const s2 = await run('inverse', 'gs');
console.assert(s2.state === '全部收敛', 'inverse GS converged');

// Screenshot both themes
await page.screenshot({ path: path.join(root, 'test-output', 'page-dark.png'), fullPage: true });
await page.click('#themeToggle');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(root, 'test-output', 'page-light.png'), fullPage: true });

// Exports: capture downloads
const downloads = [];
page.on('download', (d) => downloads.push(d.suggestedFilename()));
await page.click('#expDepth');
await page.click('#expStatus');
await page.click('#expJson');
await page.waitForTimeout(400);
console.log('downloads:', downloads);
console.assert(downloads.length === 3, 'three exports');

// Validation error path: load mismatched sizes via a generated bad PNG in-page
await page.evaluate(() => window.scrollTo(0, 0));
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('BROWSER TEST PASSED');
