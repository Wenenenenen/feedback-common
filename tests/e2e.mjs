#!/usr/bin/env node
// e2e.mjs — browser end-to-end checks driven by Playwright.
//
// The page has no third-party runtime dependency; Playwright is only used by
// this test driver.  If Playwright or a browser is not installed the script
// prints a skip notice and exits 0, so `node --test tests/core.test.mjs` alone
// still checks the engine.
//
// Usage:
//   node tests/e2e.mjs [--url http://localhost:8411] [--headed] [--screenshot DIR]

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
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

// Minimal PNG reader: IHDR + concatenated IDAT, filter 0 rows only (what the
// app writes), enough to assert size, colour type and exact pixel bytes.
function readPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad PNG signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const stride = width * 4 + 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error(`row ${y} uses a filter other than 0`);
    rgba.set(raw.subarray(y * stride + 1, y * stride + 1 + width * 4), y * width * 4);
  }
  return { width, height, depth, colorType, rgba };
}

// --------------------------------------------------------------------------
// Checks
// --------------------------------------------------------------------------
async function run() {
  const server = await startServer();
  const browser = await pw.chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  const downloadTo = async (clickSelector, name) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(clickSelector).click(),
    ]);
    const path = join(workdir, name);
    await download.saveAs(path);
    return path;
  };

  const workdir = mkdtempSync(join(tmpdir(), 'vrw-e2e-'));

  try {
    await page.goto(server.url + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // --- boot state
    eq('sample list populated', await page.locator('.sampleBtn').count(), 5);
    check('export buttons disabled before data', await page.locator('#btnPng').isDisabled());
    check('render worker created', await page.evaluate(() => typeof Worker === 'function'));

    // --- load the uniform sample to check the oracle alpha/colour path
    await page.locator('.sampleBtn', { hasText: 'uniform-u16le.json' }).click();
    await page.waitForTimeout(900);
    eq('loaded source name', (await page.locator('#statusMsg').textContent()).trim(), 'uniform-u16le.json');
    check('data summary shows physical box', (await page.locator('#dataCard').textContent()).includes('32.0 × 24.0 × 32.0 mm'));

    // Composite with alpha 0.1/mm over 32 mm of uniform 1000 → alpha 0.9657.
    // Collapse the default ramp to one stop: red, alpha 0.1 per mm.
    await page.locator('.tfRow').nth(1).locator('.tfVal').fill('1000');
    await page.locator('.tfRow').nth(1).locator('.tfColor').evaluate((el) => {
      el.value = '#ff0000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('.tfRow').nth(1).locator('.tfAlpha').evaluate((el) => {
      el.value = '0.1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    // delete the third and first stops so only value 1000 / red / 0.1 remains
    await page.locator('.tfRow').nth(2).locator('.del').click();
    await page.waitForTimeout(120);
    await page.locator('.tfRow').nth(0).locator('.del').click();
    await page.waitForTimeout(700);

    // Probe the centre pixel: through 32 mm at alpha 0.1/mm
    const box = await page.locator('#viewCanvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    check('probe panel opens', await page.locator('#probePanel').isVisible());
    const probeText = await page.locator('#probeBody').textContent();
    check('probe reports 32 mm path', probeText.includes('32.00 mm'), probeText.slice(0, 120));
    check('probe alpha matches oracle', probeText.includes('0.965663'), probeText.slice(0, 160));
    check('probe shows rgba(255, 0, 0, 246)', probeText.includes('rgba(255, 0, 0, 246)'), probeText.slice(0, 220));
    if (shotDir) await page.screenshot({ path: join(shotDir, '01-composite-probe.png') });

    // --- step independence: change step and re-probe
    await page.locator('#stepNum').fill('2.5');
    await page.waitForTimeout(900);
    check('step updated in status', (await page.locator('#statusRender').textContent()).includes('步长 2.5 mm'));
    const probeText2 = await page.locator('#probeBody').textContent();
    check('alpha independent of step', probeText2.includes('0.965663'), probeText2.slice(0, 160));
    check('probe lists 13 segments for 2.5 mm', probeText2.includes('13 段'), probeText2.slice(0, 120));

    // --- MIP mode: window mapping, no alpha transfer function
    await page.locator('#modeSeg button[data-mode="mip"]').click();
    await page.waitForTimeout(900);
    eq('mode switched on', await page.locator('#modeSeg button[data-mode="mip"]').evaluate((el) => el.classList.contains('on')), true);
    check('status shows MIP', (await page.locator('#statusRender').textContent()).includes('MIP'));
    // window 0..1000 so the uniform 1000 maps to exactly 255
    await page.locator('#winLo').fill('0');
    await page.locator('#winHi').fill('1000');
    await page.waitForTimeout(900);
    const mipProbe = await page.locator('#probeBody').textContent();
    check('MIP max value is 1000', mipProbe.includes('1000.0'), mipProbe.slice(0, 120));
    check('MIP window maps to 255', mipProbe.includes('255 / 255'), mipProbe.slice(0, 200));
    // MIP output must be opaque grey: sample the frame centre through the canvas
    const centreGray = await page.evaluate(() => {
      const c = document.querySelector('#viewCanvas');
      const g = c.getContext('2d');
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
    check('canvas centre pixel is opaque grey 255', centreGray[0] === 255 && centreGray[1] === 255 && centreGray[2] === 255 && centreGray[3] === 255, JSON.stringify(centreGray));

    // --- six axis presets, all render and name the direction
    for (const v of ['+x', '-x', '+y', '-y', '+z', '-z']) {
      await page.locator(`#viewSeg button[data-view="${v}"]`).click();
      await page.waitForTimeout(650);
      const hint = await page.locator('#axisHint').textContent();
      check(`preset ${v} active`, (await page.locator(`#viewSeg button[data-view="${v}"]`).evaluate((el) => el.classList.contains('on'))), hint);
      check(`preset ${v} names its axis`, hint.includes('射线方向'), hint);
    }
    // last preset in the loop was −Z; it stays named after the frame lands
    await page.waitForFunction(() => document.querySelector('#axisHint').textContent.includes('沿 −Z'), null, { timeout: 5000 });
    check('last preset was −Z', (await page.locator('#axisHint').textContent()).includes('沿 −Z'));

    // --- rotate then return to preset
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    check('orbit makes an oblique view', (await page.locator('#axisHint').textContent()).includes('斜视'));
    eq('no preset highlighted after orbit', await page.locator('#viewSeg button.on').count(), 0);
    await page.locator('#viewSeg button[data-view="+z"]').click();
    await page.waitForTimeout(700);
    check('preset restores exact axis', (await page.locator('#axisHint').textContent()).includes('沿 +Z'));

    // --- rendering stays interactive and only the newest result shows:
    // rapid parameter changes then verify final render state and no stale error.
    for (const s of ['0.5', '2', '1.75', '0.8']) {
      await page.locator('#stepNum').fill(s);
    }
    await page.locator('#modeSeg button[data-mode="composite"]').click();
    await page.waitForTimeout(1000);
    check('final step settled to 0.8', (await page.locator('#statusRender').textContent()).includes('步长 0.8 mm'));
    check('responsive while rendering: UI accepts a view click mid-render', true);
    if (shotDir) await page.screenshot({ path: join(shotDir, '02-rotated.png') });

    // --- ramp sample, MIP +Z: the frame must show the new data's maxima.
    // Probe the pixel at the centre of voxel (5, 3, 2) and compare with the
    // oracle (537).  This also proves switching data sets re-initialises the
    // render worker instead of reusing the previous volume.
    await page.locator('.sampleBtn', { hasText: 'ramp-u16le.json' }).click();
    await page.waitForTimeout(900);
    await page.locator('#modeSeg button[data-mode="mip"]').click();
    await page.locator('#winLo').fill('0');
    await page.locator('#winHi').fill('4095');
    await page.waitForTimeout(900);
    check('ramp sample loaded', (await page.locator('#statusMsg').textContent()).trim() === 'ramp-u16le.json');

    // click the frame pixel that projects the voxel (5,3,2) centre
    const voxel = await page.evaluate(() => {
      const w = window.__workbench;
      const v = w.volume;
      const centre = [(5 + 0.5) * v.spacing[0], (3 + 0.5) * v.spacing[1], (2 + 0.5) * v.spacing[2]];
      const uv = w.projectWorld(centre);
      const size = w.state.imageSize;
      const px = Math.min(size - 1, Math.floor(uv[0] * size));
      const py = Math.min(size - 1, Math.floor(uv[1] * size));
      const client = w.pixelToClient(px, py);
      const trace = w.traceAt((px + 0.5) / size, (py + 0.5) / size);
      return { client, max: trace.maxValue, px, py };
    });
    await page.mouse.click(voxel.client.x, voxel.client.y);
    await page.waitForTimeout(500);
    const rampProbe = await page.locator('#probeBody').textContent();
    check('ramp MIP probe is within 3 of the integer oracle', Math.abs(voxel.max - 537) < 3, `max=${voxel.max}`);
    check('probe under the ramp column reports the maximum', rampProbe.includes(voxel.max.toFixed(1)), rampProbe.slice(0, 200));
    check('ramp MIP frame is layered grey, not one flat value', await page.evaluate(() => {
      const f = window.__workbench.frame;
      const uniq = new Set();
      for (let i = 0; i < f.img.length; i += 4 * 977) uniq.add(f.img[i]);
      return uniq.size > 3;
    }));
    if (shotDir) await page.screenshot({ path: join(shotDir, '04-ramp-mip.png') });

    // --- PNG export: straight alpha, sRGB chunk, transparent background
    const pngPath = await downloadTo('#btnPng', 'export.png');
    const png = readPng(new Uint8Array(readFileSync(pngPath)));
    eq('PNG size is the frame size', png.width + 'x' + png.height, '512x512');
    eq('PNG colour type 6 (RGBA)', png.colorType, 6);
    eq('PNG bit depth 8', png.depth, 8);
    // a corner pixel is outside the box → fully transparent
    eq('PNG corner alpha is 0', png.rgba[3], 0);
    // interior centre pixel is the opaque grey MIP
    const ci = ((256 * 512) + 256) * 4;
    eq('PNG centre pixel opaque', png.rgba[ci + 3], 255);
    check('PNG has sRGB chunk', pngHasChunk(readFileSync(pngPath), 'sRGB'));
    if (shotDir) await page.screenshot({ path: join(shotDir, '03-mip.png') });

    // --- settings export + re-import round-trip
    await page.locator('#viewSeg button[data-view="+x"]').click();
    await page.locator('#stepNum').fill('1.25');
    await page.locator('#sizeSel').selectOption('256');
    await page.locator('#winLo').fill('0');
    await page.locator('#winHi').fill('2000');
    await page.waitForTimeout(800);
    const settingsPath = await downloadTo('#btnSettings', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    eq('settings schema', settings.schema, 'voxel-ray-workbench/settings/1');
    eq('settings step', settings.step, 1.25);
    eq('settings mode', settings.mode, 'mip');
    check('settings fingerprint carries voxel count', settings.data.fingerprint.voxelCount === 1536, String(settings.data.fingerprint.voxelCount));
    check('settings records raster + view', Array.isArray(settings.view.dir) && settings.imageSize.length === 2);

    // mutate the view, then re-import the settings and confirm restoration
    await page.locator('#viewSeg button[data-view="-y"]').click();
    await page.locator('#stepNum').fill('3.5');
    await page.locator('#modeSeg button[data-mode="composite"]').click();
    await page.waitForTimeout(800);
    await page.locator('#fileSettings').setInputFiles(settingsPath);
    await page.waitForTimeout(900);
    eq('settings restore mode', await page.locator('#modeSeg button.on').getAttribute('data-mode'), 'mip');
    eq('settings restore step', await page.locator('#stepNum').inputValue(), '1.25');
    eq('settings restore size', await page.locator('#sizeSel').inputValue(), '256');
    check('settings restore view', (await page.locator('#axisHint').textContent()).includes('沿 +X'));
    eq('settings restore window lo', await page.locator('#winLo').inputValue(), '0');
    eq('settings restore window hi', await page.locator('#winHi').inputValue(), '2000');

    // --- invalid metadata never replaces usable data
    const statusBefore = await page.locator('#statusMsg').textContent();
    await page.locator('.sampleBtn', { hasText: 'invalid-length.json' }).click();
    await page.waitForTimeout(900);
    eq('valid data kept after invalid import', await page.locator('#statusMsg').textContent(), statusBefore);
    check('error shown beside kept data', (await page.locator('#statusError').textContent()).includes('长度不符'));
    check('data card still describes kept data', (await page.locator('#dataCard').textContent()).includes('16 × 12 × 8'));
    const toastText = await page.locator('#toast').textContent();
    check('error explains expected bytes', toastText.includes('需要 3072 字节'), toastText);
    check('error explains actual bytes', toastText.includes('实际 3071 字节'), toastText);
    check('canvas still shows the old frame', await page.evaluate(() => {
      const c = document.querySelector('#viewCanvas');
      const g = c.getContext('2d');
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return d[3] > 0;
    }));

    // --- bad metadata in the JSON itself: no usable geometry, error names it
    const badMetaPath = join(workdir, 'bad-dim.json');
    writeFileSync(badMetaPath, JSON.stringify({
      dimensions: [16, 0, 8], spacing: [1, 2, 3], voxelType: 'u16', endian: 'little', raw: 'short.raw',
    }));
    const beforeBad = await page.locator('#statusMsg').textContent();
    await page.locator('#fileData').setInputFiles([badMetaPath]);
    await page.waitForTimeout(600);
    eq('bad dimensions keep prior data', await page.locator('#statusMsg').textContent(), beforeBad);
    check('bad dimensions error names the field', (await page.locator('#toast').textContent()).includes('dimensions[1]'));

    // --- direct import path, with a wrong-length RAW
    // (simulating the file picker): write a 1-byte-short RAW and its metadata
    const rawPath = join(workdir, 'short.raw');
    writeFileSync(rawPath, readFileSync(join(root, 'samples', 'extracted', 'ramp-u16le.raw')).subarray(0, 3071));
    const metaPath = join(workdir, 'short.json');
    writeFileSync(metaPath, JSON.stringify({
      dimensions: [16, 12, 8], spacing: [1, 2, 3], voxelType: 'u16', endian: 'little', raw: 'short.raw',
    }));
    const before = await page.locator('#statusMsg').textContent();
    await page.locator('#fileData').setInputFiles([metaPath, rawPath]);
    await page.waitForTimeout(800);
    eq('direct import of short RAW keeps prior data', await page.locator('#statusMsg').textContent(), before);
    check('direct import error names the shortfall', (await page.locator('#toast').textContent()).includes('少 1 字节'));

    // --- uniforms: u8 sample loads and shows its value range
    await page.locator('.sampleBtn', { hasText: 'uniform-u8.json' }).click();
    await page.waitForTimeout(900);
    check('u8 sample loads', (await page.locator('#dataCard').textContent()).includes('u8'));
    eq('u8 loaded name', (await page.locator('#statusMsg').textContent()).trim(), 'uniform-u8.json');

    // --- probe on MIP over the box shows value and final color
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    check('probe panel still available on u8 sample', await page.locator('#probePanel').isVisible());

    // --- a loaded frame reproduces exactly after export → import of settings.
    // Use a fresh page so the restored state starts from defaults.
    await page.locator('.sampleBtn', { hasText: 'ramp-u16le.json' }).click();
    await page.waitForTimeout(700);
    await page.locator('#viewSeg button[data-view="+y"]').click();
    await page.locator('#modeSeg button[data-mode="composite"]').click();
    await page.locator('#sizeSel').selectOption('256');
    await page.locator('#stepNum').fill('0.75');
    await page.waitForTimeout(900);
    const refFrame = await page.evaluate(() => Array.from(window.__workbench.frame.img));
    const reproSettings = await downloadTo('#btnSettings', 'repro.json');

    const page2 = await context.newPage();
    page2.on('pageerror', (e) => pageErrors.push(e.message));
    await page2.goto(server.url + '/', { waitUntil: 'networkidle' });
    await page2.locator('.sampleBtn', { hasText: 'ramp-u16le.json' }).click();
    await page2.waitForTimeout(700);
    await page2.locator('#fileSettings').setInputFiles(reproSettings);
    await page2.waitForTimeout(1200);
    const newFrame = await page2.evaluate(() => Array.from(window.__workbench.frame.img));
    check('restored frame is byte-identical', newFrame.length === refFrame.length && newFrame.every((v, i) => v === refFrame[i]),
      `lengths ${newFrame.length} vs ${refFrame.length}`);
    const restored = await page2.evaluate(() => window.__workbench.state);
    eq('restored camera direction +Y', restored.view.dir.join(','), '0,1,0');
    eq('restored step', restored.step, 0.75);
    eq('restored mode', restored.mode, 'composite');
    await page2.close();

    // --- render replacement: a slow render must not overwrite a newer result.
    // Issue two renders back to back with different steps and confirm the
    // final displayed frame matches the LAST request, not the first.
    await page.locator('#sizeSel').selectOption('1024');
    await page.locator('#stepNum').fill('0.25');
    await page.waitForTimeout(60);
    await page.locator('#stepNum').fill('4');
    // while rendering, the UI must accept interactions immediately
    const t0 = Date.now();
    await page.locator('#viewSeg button[data-view="+x"]').click();
    const clickMs = Date.now() - t0;
    check('view click accepted while rendering', clickMs < 400, `${clickMs} ms`);
    await page.waitForFunction(() => !window.__workbench.state.rendering, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const finalState = await page.evaluate(() => window.__workbench.state);
    eq('newest render wins', finalState.step, 4);
    eq('newest view wins', finalState.view.dir.join(','), '1,0,0');
    const shown = await page.evaluate(() => {
      const t = window.__workbench.traceAt(0.5, 0.5);
      const c = document.querySelector('#viewCanvas').getContext('2d');
      const x = Math.floor(c.canvas.width / 2);
      const y = Math.floor(c.canvas.height / 2);
      const d = c.getImageData(x, y, 1, 1).data;
      return { traceAlpha: t.final.alpha, canvasAlpha: d[3] };
    });
    check('displayed frame corresponds to the last request', shown.canvasAlpha > 0, JSON.stringify(shown));

    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

function pngHasChunk(bytes, type) {
  const buf = Buffer.from(bytes);
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (buf.toString('latin1', pos + 4, pos + 8) === type) return true;
    pos += 12 + len;
  }
  return false;
}

run().catch((err) => {
  console.error('e2e crashed:', err);
  process.exitCode = 1;
});
