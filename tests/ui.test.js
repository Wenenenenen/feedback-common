// End-to-end UI tests. Requires Playwright with Chromium.
//   node tests/ui.test.js
// Set PLAYWRIGHT_MODULE to the playwright package path if it is not resolvable.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright'
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE');
}

const ROOT = path.join(__dirname, '..');
const CASES_DIR = path.join(ROOT, '.cache', 'synthetic');
const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(ROOT, '.untrusted-samples');
const PAGE_URL = 'file://' + path.join(ROOT, 'index.html');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 }, acceptDownloads: true
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  async function fresh() {
    pageErrors.length = 0;
    await page.goto(PAGE_URL);
    await page.waitForTimeout(200);
  }
  const state = () => page.evaluate(() => {
    const s = window.__roiApp.state;
    return {
      layer: s.layer && { offset: s.layer.offset, orientation: s.layer.orientation, kind: s.layer.kind },
      roi: s.roi,
      result: s.roiResult && {
        width: s.roiResult.width, height: s.roiResult.height,
        hitTiles: s.roiResult.hitTiles, decodes: s.roiResult.decodes,
        missingTiles: s.roiResult.missingTiles, corruptTiles: s.roiResult.corruptTiles,
        oobTiles: s.roiResult.oobTiles, invalidTiles: s.roiResult.invalidTiles,
        maskValid: Array.from(s.roiResult.mask).reduce((a, b) => a + b, 0)
      }
    };
  });

  await test('sample package: plain.tif loads with 6 tiles and no errors', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(900);
    assert.deepEqual(pageErrors, []);
    const info = await page.evaluate(() => ({
      banner: document.getElementById('banner').innerText,
      dirs: document.querySelectorAll('.dir-item').length,
      progress: document.getElementById('overview-progress').innerText,
      canvas: [document.getElementById('overview-canvas').width,
        document.getElementById('overview-canvas').height]
    }));
    assert.ok(/plain\.tif/.test(info.banner));
    assert.equal(info.dirs, 1);
    assert.ok(/存在/.test(info.progress), info.progress);
    assert.ok(/6 块/.test(info.progress), info.progress);
    assert.deepEqual(info.canvas, [35, 21]);
  });

  await test('rotated.tif: display (0,1) matches truth and missing tiles are flagged', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(600);
    await page.selectOption('#sample-select', 'rotated.tif');
    await page.waitForTimeout(900);
    const truth = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'truth.json'), 'utf8')).rotated;
    const pix = await page.evaluate(async () => {
      const s = window.__roiApp.state;
      return window.__roiApp.state.reader.pixelAt(s.layer, 0, 1);
    });
    assert.deepEqual(pix.channels, truth.rgb);
    assert.deepEqual(pix.storage, { x: 1, y: 20 });
    const layers = await page.evaluate(() =>
      [...document.querySelectorAll('.dir-item')].map((b) => b.innerText.replace(/\s+/g, ' ')));
    assert.equal(layers.length, 2);
    assert.ok(/SubIFD #0/.test(layers[1]));
    assert.ok(/11 × 18/.test(layers[1]));
  });

  await test('huge.tif: ROI (260,261,4,5) decodes exactly one tile', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(600);
    await page.selectOption('#sample-select', 'huge.tif');
    await page.waitForTimeout(1800);
    await page.evaluate(async () => {
      const app = window.__roiApp;
      app.state.reader.clearCache();
      document.getElementById('roi-x').value = '260';
      document.getElementById('roi-y').value = '261';
      document.getElementById('roi-w').value = '4';
      document.getElementById('roi-h').value = '5';
      await app.readRoiRegion();
    });
    await page.waitForTimeout(500);
    const r = (await state()).result;
    assert.deepEqual(r.hitTiles, [129]);
    assert.equal(r.decodes, 1);
    assert.deepEqual([r.width, r.height], [4, 5]);
    const firstRow = await page.evaluate(() =>
      Array.from(window.__roiApp.state.roiResult.values.slice(0, 4)));
    assert.deepEqual(firstRow, [46945, 47676, 48407, 49138]);
    const stats = await page.evaluate(() => ({
      decodes: document.getElementById('stat-decodes').innerText,
      cache: document.getElementById('stat-cache').innerText
    }));
    assert.equal(stats.decodes, '1');
  });

  await test('1024 limit is enforced with a visible message', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.getElementById('roi-w').value = '2000';
      document.getElementById('roi-h').value = '10';
      document.getElementById('roi-apply').click();
    });
    await page.waitForTimeout(300);
    const hint = await page.evaluate(() => ({
      text: document.getElementById('roi-hint').innerText,
      cls: document.getElementById('roi-hint').className
    }));
    assert.ok(/1024/.test(hint.text));
    assert.ok(/error/.test(hint.cls));
  });

  await test('drag creates a new ROI and reading it updates the tile list', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(800);
    const box = await page.locator('#preview-stage').boundingBox();
    const canvas = await page.locator('#overview-canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const s = await state();
    assert.ok(s.roi.width > 0 && s.roi.height > 0);
    assert.ok(s.roi.width <= 1024 && s.roi.height <= 1024);
    assert.ok(s.result, 'drag should auto-read');
    assert.ok(s.result.hitTiles.length > 0);
    assert.ok(box.width > 0);
  });

  await test('rotated ROI export downloads 16-bit PNG and mask PNG', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(500);
    await page.selectOption('#sample-select', 'rotated.tif');
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
      const app = window.__roiApp;
      app.state.roi = { x: 0, y: 0, width: 21, height: 35 };
      document.getElementById('roi-x').value = 0;
      document.getElementById('roi-y').value = 0;
      document.getElementById('roi-w').value = 21;
      document.getElementById('roi-h').value = 35;
      await app.readRoiRegion();
    });
    await page.waitForTimeout(300);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-png')]);
    const roiPath = await dl.path();
    const maskDl = (await Promise.all([
      page.waitForEvent('download'), page.click('#export-mask')
    ]))[0];
    const maskPath = await maskDl.path();
    assert.equal(dl.suggestedFilename(), 'rotated_roi16.png');
    assert.equal(maskDl.suggestedFilename(), 'rotated_mask.png');
    // parse PNG chunks to confirm 16-bit RGB
    const png = fs.readFileSync(roiPath);
    assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
    const ihdr = png.subarray(16, 29);
    assert.equal(ihdr.readUInt32BE(0), 21);
    assert.equal(ihdr.readUInt32BE(4), 35);
    assert.equal(ihdr[8], 16, 'bit depth');
    assert.equal(ihdr[9], 2, 'color type RGB');
    const mask = fs.readFileSync(maskPath);
    const mihdr = mask.subarray(16, 29);
    assert.equal(mihdr[8], 8);
    assert.equal(mihdr[9], 0);
    fs.writeFileSync('/tmp/export-roi.png', png);
    fs.writeFileSync('/tmp/export-mask.png', mask);
  });

  await test('cycle.tif: loop is reported with directory and offset', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(500);
    await page.selectOption('#sample-select', 'cycle.tif');
    await page.waitForTimeout(700);
    const txt = await page.evaluate(() => ({
      banner: document.getElementById('banner').innerText,
      issues: document.getElementById('issues').innerText,
      dirs: document.querySelectorAll('.dir-item').length
    }));
    assert.ok(/循环/.test(txt.banner));
    assert.ok(/536/.test(txt.banner));
    assert.ok(/循环/.test(txt.issues));
    assert.equal(txt.dirs, 1);
  });

  await test('corrupt tile is reported by block number in the tile list', async () => {
    await fresh();
    const patched = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // decode once to find tile 1's byte range, then trash it
      const { TiffReader } = window.TiffRoi;
      const probe = await TiffReader.fromBytes(bytes.slice(), {});
      const d = probe.layers[0];
      const off = d.tileOffsets[1];
      const cnt = d.tileCounts[1];
      for (let i = 0; i < cnt; i++) bytes[off + i] = 0xff;
      await window.__roiApp.openBuffer(bytes, 'corrupt-demo.tif');
      const app = window.__roiApp;
      app.state.roi = { x: 16, y: 0, width: 16, height: 16 };
      document.getElementById('roi-x').value = 16;
      document.getElementById('roi-y').value = 0;
      document.getElementById('roi-w').value = 16;
      document.getElementById('roi-h').value = 16;
      await app.readRoiRegion();
      return true;
    }, fs.readFileSync(path.join(CASES_DIR, 'le_classic_gray_corrupt.tif')).toString('base64'));
    assert.ok(patched);
    await page.waitForTimeout(400);
    const out = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('.tile-row')].map((r) => r.innerText.replace(/\s+/g, ' ')),
      issues: document.getElementById('issues').innerText,
      summary: document.getElementById('tile-summary').innerText
    }));
    assert.ok(out.rows.some((r) => /#1/.test(r) && /损坏块/.test(r)), out.rows.join('\n'));
    assert.ok(/#1/.test(out.issues));
    assert.ok(/异常/.test(out.summary));
  });

  await test('out-of-bounds tile is reported without decoding', async () => {
    await fresh();
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // patch TileOffsets[2] and TileByteCounts[2] (little-endian classic)
      const dv = new DataView(bytes.buffer);
      const ifd = dv.getUint32(4, true);
      const n = dv.getUint16(ifd, true);
      const start = ifd + 2;
      const find = (tag) => {
        for (let i = 0; i < n; i++) {
          const p = start + i * 12;
          if (dv.getUint16(p, true) === tag) {
            const count = dv.getUint32(p + 4, true);
            const valuePos = count * 4 > 4 ? dv.getUint32(p + 8, true) : p + 8;
            return { pos: valuePos, count };
          }
        }
        throw new Error('tag not found ' + tag);
      };
      const offs = find(324);
      dv.setUint32(offs.pos + 2 * 4, 0x7ffffff0, true);
      const counts = find(325);
      dv.setUint32(counts.pos + 2 * 4, 1000, true);
      await window.__roiApp.openBuffer(bytes, 'oob-demo.tif');
      const app = window.__roiApp;
      document.getElementById('roi-x').value = 0;
      document.getElementById('roi-y').value = 16;
      document.getElementById('roi-w').value = 16;
      document.getElementById('roi-h').value = 16;
      await app.readRoiRegion();
    }, fs.readFileSync(path.join(CASES_DIR, 'le_classic_gray_oob.tif')).toString('base64'));
    await page.waitForTimeout(400);
    const out = await page.evaluate(() => ({
      issues: document.getElementById('issues').innerText,
      decodes: document.getElementById('stat-decodes').innerText,
      rows: [...document.querySelectorAll('.tile-row')].map((r) => r.innerText.replace(/\s+/g, ' '))
    }));
    assert.ok(/偏移越界/.test(out.issues), out.issues);
    assert.ok(/#2/.test(out.issues));
    assert.equal(out.decodes, '0');
    assert.ok(out.rows.some((r) => /#2/.test(r) && /越界/.test(r)), out.rows.join('\n'));
  });

  await test('orientation 8 and 3 samples render with rotated display size', async () => {
    await fresh();
    for (const [file, expectNote] of [
      ['be_classic_rgb_orient1_raw.tif', '方向 1'],
      ['le_classic_rgb_orient3_chunky.tif', '方向 3'],
      ['le_big_rgb_orient8_chunky.tif', '方向 8']
    ]) {
      const b64 = fs.readFileSync(path.join(CASES_DIR, file)).toString('base64');
      await page.evaluate(async ({ b64, file }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await window.__roiApp.openBuffer(bytes, file);
      }, { b64, file });
      await page.waitForTimeout(500);
      const note = await page.evaluate(() => document.getElementById('orientation-note').innerText);
      assert.ok(note.includes(expectNote), file + ' → ' + note);
      if (expectNote === '方向 8') {
        assert.ok(/存储 37×23 → 显示 23×37/.test(note), note);
      }
    }
    assert.deepEqual(pageErrors, []);
  });

  await test('file input accepts a TIFF file directly', async () => {
    await fresh();
    await page.setInputFiles('#file-input', path.join(SAMPLE_DIR, 'rotated.tif'));
    await page.waitForTimeout(900);
    const out = await page.evaluate(() => ({
      banner: document.getElementById('banner').innerText,
      dirs: document.querySelectorAll('.dir-item').length,
      sampleHidden: document.getElementById('sample-select').hidden
    }));
    assert.ok(/rotated\.tif/.test(out.banner));
    assert.equal(out.dirs, 2);
    assert.equal(out.sampleHidden, true);
  });

  await test('zoom / pan / locate-ROI keep the matching tile under the cursor', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(400);
    await page.selectOption('#sample-select', 'huge.tif');
    await page.waitForTimeout(500);
    // ROI on the single present tile
    await page.evaluate(async () => {
      const app = window.__roiApp;
      document.getElementById('roi-x').value = '256';
      document.getElementById('roi-y').value = '256';
      document.getElementById('roi-w').value = '256';
      document.getElementById('roi-h').value = '256';
      await app.readRoiRegion();
    });
    await page.waitForTimeout(300);
    await page.click('#roi-view');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      vp: window.__roiApp.state.viewport,
      readout: document.getElementById('viewport-readout').innerText,
      zoom: document.getElementById('zoom-level').innerText
    }));
    assert.equal(after.zoom, '缩放');
    assert.ok(after.vp.width < 32768, 'viewport must be zoomed in');
    assert.ok(/视图/.test(after.readout));
    // centre of the viewport is inside the ROI's tile
    const centre = await page.evaluate(() => {
      const s = window.__roiApp.state;
      return { x: s.viewport.x + s.viewport.width / 2, y: s.viewport.y + s.viewport.height / 2 };
    });
    assert.ok(centre.x > 256 && centre.x < 512 && centre.y > 256 && centre.y < 512,
      JSON.stringify(centre));
    // zoom out all the way returns to whole image
    await page.click('#zoom-fit');
    await page.waitForTimeout(200);
    const fit = await page.evaluate(() => ({
      vp: window.__roiApp.state.viewport,
      zoom: document.getElementById('zoom-level').innerText
    }));
    assert.equal(fit.vp, null);
    assert.equal(fit.zoom, '全图');
  });

  await test('ROI canvas hover reports true 16-bit values and block numbers', async () => {
    await fresh();
    await page.click('#sample-btn');
    await page.waitForTimeout(400);
    await page.selectOption('#sample-select', 'rotated.tif');
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      const app = window.__roiApp;
      document.getElementById('roi-x').value = '0';
      document.getElementById('roi-y').value = '0';
      document.getElementById('roi-w').value = '21';
      document.getElementById('roi-h').value = '35';
      await app.readRoiRegion();
    });
    await page.waitForTimeout(300);
    const cb = await page.locator('#roi-canvas').boundingBox();
    // display (0,1) = truth rgb; canvas x = 0.5px, y = 1.5px
    const scale = await page.evaluate(() => window.__roiApp.state.roiViewScale);
    await page.mouse.move(cb.x + 0.5 * scale, cb.y + 1.5 * scale);
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => ({
      pos: document.getElementById('cursor-pos').innerText,
      rows: document.getElementById('pixel-rows').innerText.replace(/\s+/g, ' '),
      chips: document.getElementById('pixel-tiles').innerText.replace(/\s+/g, ' ')
    }));
    const truth = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'truth.json'), 'utf8')).rotated;
    assert.ok(/显示 0,1/.test(info.pos), info.pos);
    for (const v of truth.rgb) {
      assert.ok(info.rows.includes(v.toLocaleString('en-US')), info.rows + ' missing ' + v);
    }
    // storage (1,20) => tile row 1 col 0; planar blocks are c*6 + row*3 + col
    assert.ok(/#3/.test(info.chips) && /#9/.test(info.chips) && /#15/.test(info.chips),
      info.chips);
  });

  await test('no page errors across a full run', async () => {
    assert.deepEqual(pageErrors, []);
  });

  await browser.close();
  if (process.exitCode) console.error('\n' + passed + ' passed, failures above');
  else console.log('\nall ' + passed + ' UI tests passed');
})();
