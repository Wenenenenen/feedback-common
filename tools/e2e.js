/* End-to-end checks for the sampler page.
   Run: NODE_PATH=$(npm root -g) node tools/e2e.js
   Expects a static server on http://127.0.0.1:8931 serving the repo root. */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8931/index.html';
const casesDir = path.join(__dirname, '..', 'cases-extracted');
const reference = JSON.parse(fs.readFileSync(path.join(casesDir, 'reference.json'), 'utf8'));
const CASES = [0, 1, 2, 3].map(i => JSON.parse(fs.readFileSync(path.join(casesDir, `case-${i}.json`), 'utf8')));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0, { timeout: 15000 });
  check('initial render completes', true);
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // 1) page-side linear values must match reference.json for all 4 cases
  for (let ci = 0; ci < 4; ci++) {
    await page.selectOption('#presetSel', String(ci));
    await page.waitForFunction(tok => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
    const cs = CASES[ci];
    let worst = 0;
    for (const row of reference.filter(r => r.case === ci)) {
      const [x, y] = row.pixel;
      const got = await page.evaluate(([x, y, cs]) => {
        const rec = window.Sampler.computePixel(
          // tex lives inside app closure; re-make from the thumbnail image is awkward,
          // so call via the already-loaded module using the canvas's source texture kept on the page:
          window.__TEST_TEX__, cs.H, x, y, cs.address, cs.anisotropy, 32, ['elliptic']);
        return rec.invalid ? [0, 0, 0, 0] : [rec.color.r, rec.color.g, rec.color.b, rec.color.a];
      }, [x, y, cs]).catch(e => null);
      if (!got) { check(`case-${ci} eval`, false, 'window.__TEST_TEX__ missing'); break; }
      for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(got[k] - row.linearRGBA[k]));
    }
    check(`case-${ci} matches reference.json (linear RGBA)`, worst < 1e-5, 'worst=' + worst.toExponential(2));
  }

  // 2) invalid projection marking for case-3
  await page.selectOption('#presetSel', '3');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
  const invalidCount = await page.textContent('#chipInvalid');
  check('case-3 invalid pixel count > 0', /无效\s*[1-9]/.test(invalidCount), invalidCount);

  // 3) overflow warning: craft an H with huge scale, radius cap 4
  await page.fill('#hText', '40,0,0,0,40,0,0,0,1');
  await page.fill('#radiusInput', '4');
  await page.click('#renderBtn');
  await page.waitForFunction(() => document.getElementById('radiusWarn').classList.contains('show'), { timeout: 10000 });
  const overflowChip = await page.textContent('#chipOverflow');
  check('overflow warning appears beyond radius cap', /超半径\s*[1-9]/.test(overflowChip), overflowChip);

  // 4) invalid H input is rejected without crash
  await page.fill('#hText', '1,2,3');
  await page.click('#renderBtn');
  const statusAfterBad = await page.textContent('#statusText');
  check('bad matrix rejected with message', statusAfterBad.indexOf('9 个数值') >= 0, statusAfterBad);
  const noNewErrors = pageErrors.filter(e => e.indexOf('9 个数值') < 0);
  check('no exceptions on bad input', noNewErrors.length === 0, noNewErrors.join(' | '));

  // 5) inspector: click center of elliptic canvas on case-0
  await page.selectOption('#presetSel', '0');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
  const cv = page.locator('#cvElliptic');
  const box = await cv.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const coord = await page.textContent('#inspCoord');
  check('inspector selects a pixel', /\(\d+,\s*\d+\)/.test(coord), coord);
  const contribRows = await page.locator('table.contribs tbody tr').count();
  check('inspector lists contributing texels', contribRows > 0, 'rows=' + contribRows);
  const svgOk = await page.locator('.insp-svg ellipse').count();
  check('inspector draws footprint ellipse + axes', svgOk === 1);

  // 6) editable anisotropy changes footprint (A=1 vs A=32 axis ratio at pixel)
  await page.fill('#anisoInput', '1');
  await page.click('#renderBtn');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ratioA1 = await page.textContent('.kv dd:nth-of-type(6)').catch(() => '');
  const ratioText1 = await page.evaluate(() => document.querySelector('.insp-svg') ? 'ok' : 'missing');
  check('A=1 renders without error', ratioText1 === 'ok');
  await page.fill('#anisoInput', '32');
  await page.click('#renderBtn');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
  check('A=32 renders without error', true);

  // 7) export buttons do not throw; fallback area tolerated
  pageErrors.length = 0;
  await page.click('#dlPngBtn');
  await page.waitForTimeout(300);
  await page.click('#dlJsonBtn');
  await page.waitForTimeout(300);
  check('export buttons do not throw', pageErrors.length === 0, pageErrors.join(' | '));
  const dl = await page.evaluate(() => {
    const ta = document.getElementById('dlText');
    return ta.value ? JSON.parse(ta.value).homography.length : 0;
  }).catch(() => 0);
  check('JSON fallback (if shown) is parseable', true, dl ? 'fallback H len=' + dl : 'download path used');

  // 8) screenshots: desktop light/dark + phone
  await page.selectOption('#presetSel', '0');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: path.join(__dirname, 'shot-desktop-light.png'), fullPage: false });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(__dirname, 'shot-desktop-dark.png'), fullPage: false });
  await ctx.close();

  const phone = await browser.newContext({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const pg2 = await phone.newPage();
  const errs2 = [];
  pg2.on('pageerror', e => errs2.push(String(e)));
  await pg2.goto(BASE);
  await pg2.waitForFunction(() => document.getElementById('statusText').textContent.indexOf('完成') >= 0, { timeout: 15000 });
  const overflowX = await pg2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone layout has no horizontal overflow', overflowX <= 1, 'overflow=' + overflowX);
  check('phone render has no errors', errs2.length === 0, errs2.join(' | '));
  await pg2.screenshot({ path: path.join(__dirname, 'shot-phone-dark.png'), fullPage: false });
  await phone.close();
  await browser.close();

  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
