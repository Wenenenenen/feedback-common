#!/usr/bin/env node
// Browser end-to-end checks for the workbench, driven by Playwright.
//
// The page itself has no third-party dependencies; Playwright is only used by
// this test driver and is not part of the app. If Playwright (or a browser)
// is not installed, the script prints a skip message and exits 0, so the app
// still checks with `node --test tests/section.test.mjs` alone.
//
// Usage:
//   node tests/e2e.mjs [--url http://localhost:8000] [--headed]

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* keep looking */ }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  console.log('SKIP e2e: Playwright is not installed (the app itself needs none).');
  process.exit(0);
}

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const headed = args.includes('--headed');

function executablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = pw.chromium.executablePath();
    if (p) return p;
  } catch { /* fall through */ }
  return undefined;
}

// Boot the server on a free port unless a URL was supplied.
async function startServer() {
  if (urlArg) return { url: urlArg, stop() {} };
  const port = 18000 + Math.floor(Math.random() * 500);
  const python = process.env.PYTHON || 'python3';
  const proc = spawn(python, [join(root, 'server.py'), '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('Section workbench')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', (d) => { if (String(d).trim()) console.error('server:', String(d).trim()); });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { url, stop() { proc.kill('SIGTERM'); } };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = await startServer();
let browser;
try {
  browser = await pw.chromium.launch({
    executablePath: executablePath(),
    args: ['--no-sandbox'],
    headless: !headed,
  });
} catch (err) {
  server.stop();
  console.log(`SKIP e2e: could not launch Chromium (${err.message.split('\n')[0]}).`);
  process.exit(0);
}
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const metrics = () => page.evaluate(() =>
  [...document.querySelectorAll('.metric strong')].map((e) => e.textContent));

try {
  await page.goto(server.url + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const selfCheck = await page.textContent('#self-check');
  check('fixture self-check 8/8', /8\/8/.test(selfCheck), selfCheck.trim());

  await page.click('.sample-btn:has-text("hollow-binary.stl")');
  await page.waitForTimeout(700);
  const m1 = await metrics();
  check('hollow-binary d=6 area/perimeter/loops',
    m1[0].startsWith('336') && m1[1].startsWith('112') && m1[2] === '2' && m1[3] === '1',
    m1.join(' | '));

  // d = 12 is the limit from +n: empty.
  await page.fill('#d-number', '12');
  await page.waitForTimeout(300);
  const m2 = await metrics();
  check('d=12 approached from +n is empty', m2[2] === '0' && m2[0].startsWith('0'), m2.join(' | '));
  await page.fill('#d-number', '0');
  await page.waitForTimeout(300);
  const m3 = await metrics();
  check('d=0 on the bottom face is still a ring', m3[0].startsWith('336'), m3.join(' | '));

  // Oblique plane with non-normalised normal via the scale field.
  await page.fill('#n-x', '1');
  await page.fill('#n-z', '1');
  await page.fill('#n-scale', '2');
  await page.fill('#d-number', '20');
  await page.waitForTimeout(400);
  const readout = await page.textContent('#plane-origin');
  check('non-normalised n readout uses the unit d', /d̂ = 7\.0710\d*/.test(readout), readout);

  // Back to a clean axial section for exports.
  await page.click('#btn-z-plane');
  await page.waitForTimeout(350);

  const [svgDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-svg'),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'section-e2e-'));
  const svgPath = join(dir, 'section.svg');
  await svgDownload.saveAs(svgPath);
  const svg = readFileSync(svgPath, 'utf8');
  check('SVG declares mm and has no px units',
    svg.includes('data-unit="mm"') && svg.includes('mm"') && !svg.includes('px'),
    `${svg.length} bytes`);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-json'),
  ]);
  const jsonPath = join(dir, 'section.json');
  await jsonDownload.saveAs(jsonPath);
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  check('JSON has plane, 2-D rings, 3-D intersections, ownership, measurements',
    report.units === 'mm' &&
    Array.isArray(report.plane.n_unit) &&
    report.loops.length > 0 &&
    report.loops.every((l) => Array.isArray(l.ring_2d_mm) && Array.isArray(l.intersections_3d_mm)) &&
    report.measurements.area_mm2 > 0 &&
    report.loops.some((l) => l.kind === 'hole' && l.hole_owner_body_id !== null),
    `${report.loops.length} loops`);

  // Bad file must not replace the loaded model.
  const badPath = join(root, 'samples', 'extracted', 'truncated.stl');
  await page.setInputFiles('#file-input', badPath);
  await page.waitForTimeout(500);
  const modelName = await page.textContent('#model-name');
  const warnings = await page.textContent('#warnings');
  check('bad file keeps the previous model', modelName.includes('hollow-binary'), modelName);
  check('bad file shows an explicit error', /载入失败/.test(warnings));

  // Fast drag: only the newest result paints.
  await page.evaluate(async () => {
    const slider = document.getElementById('d-slider');
    for (let i = 0; i < 60; i++) {
      slider.value = String(2 + i * 0.1);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 6));
    }
    slider.value = '4';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const dShown = Number(await page.inputValue('#d-number'));
  const mFinal = await metrics();
  // The range input quantises to its step (span/4000 ≈ 0.003 mm), so the
  // final d must land within one step of the last requested value.
  check('rapid drag converges on the latest plane',
    Math.abs(dShown - 4) <= 0.0031 && mFinal[2] === '2', `d=${dShown}, ${mFinal.join(' | ')}`);

  // 20k-triangle model: slice latency well under 2 s.
  await page.click('.sample-btn:has-text("many-rings.stl")');
  await page.waitForTimeout(1200);
  const t0 = Date.now();
  await page.evaluate(() => {
    const n = document.getElementById('d-number');
    n.value = '5';
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const t = document.getElementById('slice-time').textContent;
    return t && !t.startsWith('—');
  }, { timeout: 5000 });
  const manyMetrics = await metrics();
  check('20k-triangle model slices in under 2 s',
    Date.now() - t0 < 2000 && manyMetrics[2] === '1250',
    `${Date.now() - t0} ms, loops ${manyMetrics[2]}`);

  // Open shell: warning shown, open boundary counted, area never invented.
  await page.click('.sample-btn:has-text("open-shell.stl")');
  await page.waitForTimeout(700);
  const openWarnings = await page.textContent('#warnings');
  const openMetrics = await metrics();
  check('open shell shows open-boundary handling',
    /开口/.test(openWarnings) && openMetrics[5] !== '0', `${openMetrics.join(' | ')}`);

  check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join('; '));
} finally {
  await browser.close();
  server.stop();
}

const failures = results.filter((r) => !r.ok).length;
console.log(failures ? `\n${failures} E2E FAILURES` : '\nALL E2E CHECKS PASS');
process.exit(failures ? 1 : 0);
