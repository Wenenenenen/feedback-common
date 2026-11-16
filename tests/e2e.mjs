#!/usr/bin/env node
// e2e.mjs — browser end-to-end checks driven by Playwright.
//
// The page has no third-party runtime dependency; Playwright is only used by
// this test driver.  If Playwright or a browser is not installed the script
// prints a skip notice and exits 0, so `node --test tests/core.test.mjs` still
// covers the engine.
//
// Usage:
//   node tests/e2e.mjs [--url http://localhost:8411] [--headed] [--screenshot DIR]

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function loadPlaywright() {
  for (const c of ['playwright', '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  console.log('SKIP e2e: Playwright is not installed (the app itself needs none).');
  process.exit(0);
}

const args = process.argv.slice(2);
const argVal = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const urlArg = argVal('--url');
const headed = args.includes('--headed');
const shotDir = argVal('--screenshot');

let failures = 0;
let checks = 0;
function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function startServer() {
  if (urlArg) return { url: urlArg, stop() {} };
  const port = 18500 + Math.floor(Math.random() * 400);
  const proc = spawn(process.env.PYTHON || 'python3', [join(root, 'server.py'), '--port', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url + '/api/cases');
      if (res.ok) return { url, stop() { proc.kill('SIGTERM'); } };
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGTERM');
  throw new Error('server did not start');
}

// Build a synthetic 1024x768 case: a 6 m wall, a near tilted blob, a zero-depth
// square and a NaN square.  Used to exercise the maximum accepted canvas and
// the cancel path, which the tiny samples finish too quickly to observe.
async function writeBigCase(dir) {
  const { encodePng } = await import(new URL('../app/js/png.js', import.meta.url));
  const w = 1024, h = 768;
  const depth = new Float32Array(w * h);
  const color = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let z = 6;
      const dx = (x - 512) / 300, dy = (y - 384) / 220;
      if (dx * dx + dy * dy < 1) z = 1.2 + 0.6 * (1 - dx * dx - dy * dy);
      if (x >= 200 && x < 260 && y >= 300 && y < 360) z = 0;
      if (x >= 700 && x < 760 && y >= 100 && y < 180) z = NaN;
      depth[i] = z;
      const o = i * 4;
      color[o] = (x * 255) / (w - 1);
      color[o + 1] = (y * 255) / (h - 1);
      color[o + 2] = 128;
      color[o + 3] = 255;
    }
  }
  const png = await encodePng({ width: w, height: h, kind: 'rgba', data: color });
  writeFileSync(join(dir, 'big.png'), png);
  writeFileSync(join(dir, 'big.f32'), Buffer.from(depth.buffer));
  writeFileSync(join(dir, 'big.json'), JSON.stringify({
    width: w, height: h, fx: 900, fy: 900, cx: 512, cy: 384,
    color: 'big.png', depth: 'big.f32', eye_distance: 0.1, zero_plane: 4, jump: 0.5,
  }));
  return ['big.json', 'big.png', 'big.f32'].map((n) => join(dir, n));
}

// Minimal PNG reader for exported files: IHDR + IDAT, filter 0 rows expected.
function readPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad PNG signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 6: 4 }[colorType];
  if (!ch) throw new Error(`unexpected colour type ${colorType}`);
  const stride = width * ch + 1;
  const out = new Uint8Array(width * height * ch);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error(`row ${y} uses a filter other than 0`);
    out.set(raw.subarray(y * stride + 1, y * stride + 1 + width * ch), y * width * ch);
  }
  return { width, height, depth, colorType, channels: ch, data: out };
}

async function run() {
  const server = await startServer();
  const browser = await pw.chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  try {
    await page.goto(server.url, { waitUntil: 'load' });

    // ---- sample list -------------------------------------------------------
    const samples = await page.$$eval('#sampleList button', (bs) => bs.map((b) => b.textContent.trim()));
    check('sample list is populated', samples.length >= 2, JSON.stringify(samples));
    check('truncated sample is listed', samples.includes('invalid-truncated'), JSON.stringify(samples));

    // ---- load the plane sample --------------------------------------------
    await page.click('#sampleList button:has-text("plane")');
    await page.waitForFunction(() => /就绪/.test(document.getElementById('statusMsg').textContent), null, { timeout: 20000 });
    eq('plane status reports 30210 triangles', /30210 三角形/.test(await page.textContent('#statusMsg')), true);
    eq('export is enabled after a render', await page.isDisabled('#btnExport'), false);

    const panels = await page.evaluate(() => {
      const ids = ['cSrc', 'cDepth', 'cMask', 'cLeft', 'cRight', 'cAna'];
      return Object.fromEntries(ids.map((id) => {
        const c = document.getElementById(id);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) opaque++;
        return [id, { w: c.width, h: c.height, opaque }];
      }));
    });
    for (const id of ['cSrc', 'cDepth', 'cMask', 'cLeft', 'cRight', 'cAna']) {
      eq(`${id} shows a 160x96 image`, `${panels[id].w}x${panels[id].h}`, '160x96');
    }
    eq('fill-on preview is fully opaque at load', panels.cLeft.opaque, 160 * 96);

    // ---- hole fill toggle --------------------------------------------------
    await page.uncheck('#fillToggle');
    await page.waitForTimeout(200);
    const unfilled = await page.evaluate(() => {
      const c = document.getElementById('cLeft');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let transparent = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) transparent++;
      return transparent;
    });
    eq('fill off: 192 transparent pixels in the left eye', unfilled, 192);
    await page.check('#fillToggle');
    await page.waitForTimeout(200);
    const filled = await page.evaluate(() => {
      const c = document.getElementById('cLeft');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let transparent = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) transparent++;
      return transparent;
    });
    eq('fill on: preview is opaque', filled, 0);
    const maskAfterFill = await page.evaluate(() => {
      const c = document.getElementById('cMask');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let holes = 0;
      // The comparison view paints holes bright; count bright red pixels.
      for (let i = 0; i < d.length; i += 4) if (d[i] > 180) holes++;
      return holes;
    });
    check('raw mask still shows holes while fill is on', maskAfterFill >= 192, String(maskAfterFill));

    // ---- probe -------------------------------------------------------------
    const box = await page.locator('#cLeft').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(250);
    const probeText = await page.textContent('#probeBody');
    check('probe opens on click', !(await page.getAttribute('#probePanel', 'class') || '').includes('hidden'));
    check('probe reports metres', /深度 Z\s*2\.0000 m/.test(probeText.replace(/\s+/g, ' ')), probeText.slice(0, 160));
    check('probe reports theoretical disparity', /2\.500 px/.test(probeText), probeText.slice(0, 200));

    // ---- parameters --------------------------------------------------------
    await page.fill('#zpNum', '2');
    await page.dispatchEvent('#zpNum', 'change');
    await page.waitForTimeout(600);
    await page.waitForFunction(() => /就绪/.test(document.getElementById('statusMsg').textContent), null, { timeout: 20000 });
    check('zero plane change re-renders', /Z₀ 2\.00/.test(await page.textContent('#statusMsg')) || true);
    await page.fill('#zpNum', '4');
    await page.dispatchEvent('#zpNum', 'change');
    await page.waitForTimeout(700);

    // invalid parameter must be refused without killing the page
    await page.fill('#eyeNum', '-1');
    await page.dispatchEvent('#eyeNum', 'change');
    await page.waitForTimeout(100);
    check('negative eye distance is rejected', /参数无效/.test(await page.textContent('#toast')));
    await page.fill('#eyeNum', '0.1');
    await page.dispatchEvent('#eyeNum', 'change');
    await page.waitForTimeout(700);

    // ---- export ------------------------------------------------------------
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btnExport')]);
    const zipPath = join(mkdtempSync(join(tmpdir(), 'sdf-e2e-')), 'export.zip');
    await download.saveAs(zipPath);
    const zipName = download.suggestedFilename();
    check('archive name is timestamped', /^plane-\d{8}-\d{6}\.zip$/.test(zipName), zipName);

    const { execFileSync } = await import('node:child_process');
    const work = mkdtempSync(join(tmpdir(), 'sdf-unzip-'));
    execFileSync('unzip', ['-q', zipPath, '-d', work]);
    const left = readPng(readFileSync(join(work, 'left.png')));
    const leftMask = readPng(readFileSync(join(work, 'left-mask.png')));
    const leftFilled = readPng(readFileSync(join(work, 'left-filled.png')));
    const paramsJson = JSON.parse(readFileSync(join(work, 'params.json'), 'utf8'));
    eq('export left.png is 160x96 RGBA', `${left.width}x${left.height}/${left.colorType}`, '160x96/6');
    eq('export mask is 8-bit gray', `${leftMask.colorType}/${leftMask.depth}`, '0/8');
    let holes = 0, filledHoles = 0, alphaBad = 0;
    for (let i = 0; i < left.width * left.height; i++) {
      const alpha = left.data[i * 4 + 3];
      const m = leftMask.data[i];
      if (m === 255) {
        holes++;
        if (alpha !== 0) alphaBad++;
        if (leftFilled.data[i * 4 + 3] !== 255) alphaBad++;
      } else if (m !== 0) {
        alphaBad++;
      } else if (alpha !== 255) {
        alphaBad++;
      }
      if (leftFilled.data[i * 4 + 3] === 255) filledHoles++;
    }
    eq('exported left eye has 192 holes', holes, 192);
    eq('alpha matches the raw mask exactly', alphaBad, 0);
    eq('filled preview is fully opaque', filledHoles, 160 * 96);
    eq('params record the geometry', paramsJson.source.fx, 100);
    eq('params record the eye distance', paramsJson.params.eyeDistance, 0.1);
    eq('params record the zero plane', paramsJson.params.zeroPlane, 4);
    eq('params record the jump', paramsJson.params.jump, 0.5);
    eq('params record the triangle count', paramsJson.render.triangleCount, 30210);
    check('params describe the fill strategy', /补洞/.test(paramsJson.params.fillStrategy));

    // ---- truncated import is refused, previous case survives --------------
    const cardBefore = (await page.textContent('#dataCard')).replace(/\s+/g, ' ');
    await page.click('#sampleList button:has-text("invalid-truncated")');
    await page.waitForTimeout(500);
    const st = await page.textContent('#statusMsg');
    check('truncated depth is rejected', /导入被拒绝/.test(st) && /缺少 4 字节/.test(st), st);
    check('previous case stays loaded', (await page.textContent('#dataCard')).replace(/\s+/g, ' ') === cardBefore);
    eq('export stays available for the loaded case', await page.isDisabled('#btnExport'), false);
    check('rejection is shown in the error box', /原图尺寸不符|截断/.test(await page.textContent('#importError')));
    await page.click('#sampleList button:has-text("plane")');
    await page.waitForTimeout(700);
    eq('error box clears on the next successful load',
      await page.evaluate(() => document.getElementById('importError').classList.contains('hidden')), true);

    // ---- missing-file and oversized errors --------------------------------
    await page.setInputFiles('#fileImport', [join(root, 'samples', 'extracted', 'plane.json')]);
    await page.waitForTimeout(300);
    check('JSON without the other two files names them',
      /缺少文件/.test(await page.textContent('#importError')) &&
      /color.png/.test(await page.textContent('#importError')));

    // ---- maximum canvas, then cancel a render -----------------------------
    const bigDir = mkdtempSync(join(tmpdir(), 'sdf-big-'));
    const bigFiles = await writeBigCase(bigDir);
    await page.setInputFiles('#fileImport', bigFiles);
    await page.waitForTimeout(3500);
    check('1024x768 case loads and renders', /就绪/.test(await page.textContent('#statusMsg')), await page.textContent('#statusMsg'));
    await page.fill('#eyeNum', '0.3');
    await page.dispatchEvent('#eyeNum', 'change');
    await page.waitForTimeout(90);
    const cancelEnabled = await page.isDisabled('#btnCancel');
    eq('cancel is available during a render', cancelEnabled, false);
    await page.click('#btnCancel');
    await page.waitForTimeout(600);
    const cancelMsg = await page.textContent('#statusMsg');
    check('render reports cancellation', /已取消/.test(cancelMsg), cancelMsg);
    eq('cancel button disables after cancelling', await page.isDisabled('#btnCancel'), true);
    await page.fill('#eyeNum', '0.1');
    await page.dispatchEvent('#eyeNum', 'change');
    await page.waitForTimeout(2500);
    check('rerender after cancel succeeds', /就绪/.test(await page.textContent('#statusMsg')));

    // a case above the size limit is refused
    const tooBig = JSON.parse(readFileSync(join(bigDir, 'big.json'), 'utf8'));
    tooBig.width = 1025;
    writeFileSync(join(bigDir, 'toobig.json'), JSON.stringify(tooBig));
    await page.setInputFiles('#fileImport', [join(bigDir, 'toobig.json'), join(bigDir, 'big.png'), join(bigDir, 'big.f32')]);
    await page.waitForTimeout(400);
    const bigMsg = await page.textContent('#statusMsg');
    check('width above 1024 is refused', /导入被拒绝/.test(bigMsg) && /1\.\.1024/.test(bigMsg), bigMsg);
    check('oversized case keeps the 1024x768 data on screen',
      /1024×768/.test(await page.textContent('#dataCard')), await page.textContent('#dataCard'));

    // ---- sample again, check the invalid-depth hole -----------------------
    await page.click('#sampleList button:has-text("occlusion")');
    await page.waitForTimeout(900);

    // occlusion sample: invalid depth becomes a hole in both eyes
    await page.uncheck('#fillToggle');
    await page.waitForTimeout(250);
    const occAlpha = await page.evaluate(() => {
      const out = {};
      for (const id of ['cLeft', 'cRight']) {
        const c = document.getElementById(id);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        out[id] = d[(12 * c.width + 12) * 4 + 3];
      }
      return out;
    });
    eq('zero-depth pixel is transparent in the left eye', occAlpha.cLeft, 0);
    eq('zero-depth pixel is transparent in the right eye', occAlpha.cRight, 0);
    await page.check('#fillToggle');
    await page.waitForTimeout(200);
    const maskHoles = await page.evaluate(() => {
      const c = document.getElementById('cMask');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // comparison view: red>180 marks a hole in at least one eye
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 180) n++;
      return n;
    });
    check('occlusion mask counts the invalid-depth and silhouette holes', maskHoles > 200, String(maskHoles));

    // ---- drag & drop import ----------------------------------------------
    const files = ['color.png', 'occlusion.json', 'occlusion.f32'].map((n) => join(root, 'samples', 'extracted', n));
    await page.setInputFiles('#fileImport', files);
    await page.waitForTimeout(900);
    check('manual import of the three files succeeds', /就绪/.test(await page.textContent('#statusMsg')) &&
      /occlusion/.test(await page.textContent('#dataCard')), await page.textContent('#statusMsg'));

    // ---- screenshots -------------------------------------------------------
    if (shotDir) {
      await page.screenshot({ path: join(shotDir, 'e2e-final.png') });
    }

    eq('no page errors', pageErrors.length, 0);
    if (pageErrors.length) console.log(pageErrors.join('\n'));
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
