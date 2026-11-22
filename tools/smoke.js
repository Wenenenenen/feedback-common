// Headless browser smoke test for the film stack preview page.
// Run: node tools/smoke.js
'use strict';

const path = require('path');
const fs = require('fs');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1366, height: 960 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    if (msg.type() === 'warning') errors.push(`console.warn: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  const fileUrl = 'file://' + path.resolve(__dirname, '..', 'index.html');
  await page.goto(fileUrl);
  await page.waitForFunction(() =>
    document.getElementById('statusLine').textContent.includes('重算'));
  await page.waitForTimeout(50);

  const results = {};

  // 1. default case (glass, no layers) renders charts and sphere
  results.layerRowsGlass = await page.locator('#layerBody tr').count();
  results.statusText = await page.locator('#statusLine').textContent();
  results.seriesPaths = await page.locator('#specChart path.series-line').count();
  results.spherePixels = await page.evaluate(() => {
    const cv = document.getElementById('sphereCanvas');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(cv.width / 2, cv.height / 2, 1, 1).data;
    return Array.from(d);
  });
  // bare glass R=4% at center: near-white but the readout shows the linear value
  results.glassRgbReadout = await page.locator('#rgbReadout').textContent();
  results.glassLinearOk = /线性\(0\.040, 0\.040, 0\.040\)/.test(results.glassRgbReadout);

  // 2. switch to TIR case and verify R=100% at 60 deg for both polarizations
  const statusBefore = await page.locator('#statusLine').textContent();
  await page.selectOption('#caseSelect', 'tir');
  await page.waitForFunction((prev) =>
    document.getElementById('statusLine').textContent !== prev, statusBefore);
  await page.waitForTimeout(50);
  results.tirStats = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#statBody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((c) => c.textContent)));

  // 3. switch to coherent case, enable s and p roles too
  await page.selectOption('#caseSelect', 'coherent');
  await page.waitForTimeout(80);
  await page.check('input[name="role"][value="s"]');
  await page.check('input[name="role"][value="p"]');
  await page.waitForTimeout(50);
  results.threeRolePaths = await page.locator('#specChart path.series-line').count();

  // 4. quantity switch to A
  await page.check('input[name="quantity"][value="A"]');
  await page.waitForTimeout(50);
  results.absSelected = await page.isChecked('input[name="quantity"][value="A"]');

  // 5. add layers up to the cap (each add triggers an async rAF re-render)
  const addBtn = page.locator('#addLayerBtn');
  for (let i = 0; i < 20; i++) {
    if (await addBtn.isDisabled()) break;
    const prevStatus = await page.locator('#statusLine').textContent();
    await addBtn.click();
    await page.waitForFunction((prev) =>
      document.getElementById('statusLine').textContent !== prev, prevStatus);
  }
  results.maxLayerRows = await page.locator('#layerBody tr').count();
  results.addDisabledAtCap = await addBtn.isDisabled();

  // 6. reorder: mark the last row uniquely, then move THAT row to the top
  // by clicking its own up button repeatedly (re-resolved after each render).
  const uniqueDInput = page.locator('#layerBody tr').last().locator('.d-input');
  await uniqueDInput.fill('777');
  await uniqueDInput.dispatchEvent('change');
  await page.waitForTimeout(40);
  const firstUpBefore = await page.locator('#layerBody tr').first().locator('.d-input').inputValue();
  const rowCount = results.maxLayerRows;
  const markedRow = () => page.locator('#layerBody tr', {
    has: page.locator('.d-input[value="777"]')
  });
  for (let i = 0; i < rowCount - 1; i++) {
    await markedRow().locator('.up').click();
    await page.waitForTimeout(15);
  }
  const firstUpAfter = await page.locator('#layerBody tr').first().locator('.d-input').inputValue();
  results.firstUpBefore = firstUpBefore;
  results.firstUpAfter = firstUpAfter;
  results.reorderWorked = firstUpBefore !== firstUpAfter && firstUpAfter === '777';
  results.firstNAfter = await page.locator('#layerBody tr').first().locator('.n-input').inputValue();

  // 7. delete one layer
  await page.locator('#layerBody tr').first().locator('.del').click();
  await page.waitForFunction((n) =>
    document.querySelectorAll('#layerBody tr').length === n, results.maxLayerRows - 1);
  results.rowsAfterDelete = await page.locator('#layerBody tr').count();

  // 8. sphere pick simulation: dispatch pointer events on canvas, verify the
  // readout angle matches the geometry theta = asin(rho) of the click point.
  const sphereInfo = await page.evaluate(() => {
    const cv = document.getElementById('sphereCanvas');
    const r = cv.getBoundingClientRect();
    const rho = 0.45;
    return {
      x: r.x + r.width / 2 + rho * (r.width / 2 - 2),
      y: r.y + r.height / 2,
      expectedDeg: Math.asin(rho) * 180 / Math.PI
    };
  });
  await page.mouse.click(sphereInfo.x, sphereInfo.y);
  await page.waitForTimeout(50);
  results.angleAfterSpherePick = parseFloat((await page.locator('#angleReadout').textContent()).replace('°', ''));
  results.spherePickExpected = sphereInfo.expectedDeg;

  // 9. JSON export: intercept the blob download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#exportJsonBtn')
  ]);
  const tmpJson = path.join(__dirname, 'downloaded-export.json');
  await download.saveAs(tmpJson);
  const exported = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  results.exportKeys = Object.keys(exported);
  results.exportWlCount = exported.parameters.wavelengthNm.length;
  results.exportAngleCount = exported.parameters.incidenceAngleDeg.length;
  results.exportSpectraShape = [
    exported.spectra.s.R.length, exported.spectra.s.R[0].length
  ];
  results.exportPhysical = (() => {
    let ok = true;
    for (const pol of ['s', 'p']) {
      for (const q of ['R', 'T', 'A']) {
        for (const row of exported.spectra[pol][q]) {
          for (const v of row) {
            if (!Number.isFinite(v) || v < -1e-9 || v > 1.000000001) ok = false;
          }
        }
      }
    }
    return ok;
  })();
  fs.unlinkSync(tmpJson);

  // 10. PNG export
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#exportPngBtn')
  ]);
  const tmpPng = path.join(__dirname, 'downloaded-export.png');
  await pngDownload.saveAs(tmpPng);
  const pngBuf = fs.readFileSync(tmpPng);
  results.pngBytes = pngBuf.length;
  results.pngSignatureOk = pngBuf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.unlinkSync(tmpPng);

  // 11. absorbing case stability through the real page engine
  await page.selectOption('#caseSelect', 'absorb');
  await page.waitForTimeout(120);
  results.absorbStats = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#statBody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((c) => c.textContent)));

  // 12. screenshots for visual review (light/dark)
  await page.selectOption('#caseSelect', 'coherent');
  await page.check('input[name="quantity"][value="R"]');
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(__dirname, 'shot-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'shot-dark.png'), fullPage: true });

  // 13. mobile width
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.waitForTimeout(80);
  results.mobileNoHorizontalScroll = await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.screenshot({ path: path.join(__dirname, 'shot-mobile.png'), fullPage: true });

  await browser.close();

  // ---------------------------------------------------------------- assertions
  const checks = [
    ['glass has zero layer rows', results.layerRowsGlass === 0],
    ['glass linear RGB = 0.040', results.glassLinearOk],
    ['TIR s/p reflectance = 100%',
      results.tirStats.every((r) => r[1] === '100.00%' && r[2] === '0.00%' && r[3] === '0.00%')],
    ['three polarization paths render', results.threeRolePaths === 3],
    ['absorption radio switches', results.absSelected === true],
    ['layer cap at 16', results.maxLayerRows === 16 && results.addDisabledAtCap === true],
    ['reorder moves last row to top', results.reorderWorked && results.firstNAfter === '1.5'],
    ['delete removes one row', results.rowsAfterDelete === 15],
    ['sphere pick matches geometric angle',
      Math.abs(results.angleAfterSpherePick - results.spherePickExpected) < 0.5],
    ['JSON export structure', results.exportWlCount === 31 && results.exportAngleCount === 86 &&
      results.exportSpectraShape[0] === 86 && results.exportSpectraShape[1] === 31],
    ['exported values physical and finite', results.exportPhysical === true],
    ['PNG export valid', results.pngSignatureOk && results.pngBytes > 50000],
    ['absorbing stack T=0 at normal incidence',
      results.absorbStats.every((r) => r[2] === '0.00%')],
    ['no horizontal scroll on mobile', results.mobileNoHorizontalScroll === true]
  ];
  const failed = checks.filter(([, ok]) => !ok);

  console.log(JSON.stringify(results, null, 2));
  console.log('\nassertions:');
  for (const [name, ok] of checks) console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${name}`);

  if (errors.length) {
    console.error('\nCONSOLE/PAGE ERRORS:');
    for (const e of errors) console.error(' -', e);
  }
  if (failed.length || errors.length) {
    console.error(`\n${failed.length} failed assertion(s), ${errors.length} console error(s)`);
    process.exit(1);
  }
  console.log('\nsmoke test passed with no console errors');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
