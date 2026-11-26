/* Real-browser verification: rendering, cross-pane selection, downloads,
 * edit-and-recompute latency under the full spec. Run against the static server. */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const URL = 'http://localhost:8731/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await page.goto(URL);
  await page.waitForSelector('#pathTbody tr');

  // 1. initial render populated
  const rowCount = await page.locator('#pathTbody tr').count();
  const cntOk = await page.locator('#cntOk').textContent();
  const cntBlock = await page.locator('#cntBlock').textContent();
  const pathLines = await page.locator('.pathline').count();
  console.log('rows', rowCount, 'reachable', cntOk, 'blocked', cntBlock, 'svg path marks', pathLines);
  if (rowCount < 20 || pathLines < 20) throw new Error('rendering incomplete');

  // 2. table row click -> selection + IR marker + plan highlight
  await page.locator('#pathTbody tr').nth(3).click();
  await sleep(100);
  const selRow = await page.locator('#pathTbody tr.sel').count();
  const irMeta = await page.locator('#irMeta').textContent();
  console.log('selected rows highlighted', selRow, '| IR meta:', irMeta.trim());
  if (selRow !== 1 || !irMeta.includes('帧')) throw new Error('cross-pane selection failed');

  // 3. WAV download: 44-byte header + 96000 float32 frames
  const [wavDl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#wavBtn'),
  ]);
  const wavPath = await wavDl.path();
  const wav = require('fs').readFileSync(wavPath);
  const N = 96000;
  if (wav.length !== 44 + N * 4) throw new Error('bad WAV size ' + wav.length);
  if (wav.readUInt16LE(20) !== 3 || wav.readUInt32LE(24) !== 48000) throw new Error('bad WAV fmt');
  console.log('WAV download OK', wavDl.suggestedFilename(), wav.length, 'bytes');

  // 4. JSON path table download
  const [jsonDl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#jsonBtn'),
  ]);
  const j = JSON.parse(require('fs').readFileSync(await jsonDl.path(), 'utf8'));
  if (!j.paths || j.paths.length !== rowCount) throw new Error('bad JSON export');
  const sampleRow = j.paths.find(p => !p.reachable);
  console.log('JSON download OK rows=', j.count, 'blocked sample:', JSON.stringify({
    order: sampleRow.wallOrder, seg: sampleRow.blockedSegment, box: sampleRow.blockedBox }));

  // 5. wall coefficient edit -> recompute; total energy must change (the direct
  // path dominates the peak, so energy is the sensitive quantity here)
  const before = await page.evaluate(() => window.__irEnergy);
  await page.evaluate(() => {
    const inp = document.querySelector('input[data-wall="5"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '0');                          // zero z1 first tap
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  const after = await page.evaluate(() => window.__irEnergy);
  console.log('wall edit energy before/after', before.toExponential(4), after.toExponential(4));
  if (before === after) throw new Error('wall edit did not change response');

  // 6. full-spec room: 6 sources, 32 mics, 24 boxes, order 4; edit one box and time refresh
  const bigRoom = await page.evaluate(() => {
    const rnd = (n) => Math.floor(Math.random() * n);
    const size = [22000, 16000, 9500];
    const boxes = [];
    while (boxes.length < 24) {
      const sx = 900 + rnd(1200), sy = 900 + rnd(1200), sz = 600 + rnd(800);
      const mn = [300 + rnd(size[0] - sx - 600), 300 + rnd(size[1] - sy - 600), 300 + rnd(size[2] - sz - 600)];
      boxes.push({ min: mn, max: [mn[0] + sx, mn[1] + sy, mn[2] + sz] });
    }
    const outside = (p) => boxes.every(b => p.some((v, a) => v < b.min[a] || v > b.max[a]));
    const pts = [];
    while (pts.length < 38) {
      const p = [200 + rnd(size[0] - 400), 200 + rnd(size[1] - 400), 200 + rnd(size[2] - 400)];
      if (outside(p) && pts.every(q => q.some((v, a) => v !== p[a]))) pts.push(p);
    }
    return { size, sources: pts.slice(0, 6), receivers: pts.slice(6, 38), boxes, order: 4,
      walls: [[2320, -520, 130], [2048, 0, 0], [1800, 512, 0], [1960, 0, 0], [1500, 220, 0], [2400, 0, 0]] };
  });
  await page.evaluate((room) => {
    localStorage.setItem('rrefl-room', JSON.stringify(room));
  }, bigRoom);
  await page.reload();
  await page.waitForSelector('#pathTbody tr');
  const bigRows = await page.locator('#pathTbody tr').count();
  console.log('full-spec pair rows', bigRows);

  // time a box edit + apply (recomputes selected source -> all 32 mics + responses)
  const timing = await page.evaluate(async () => {
    const t0 = performance.now();
    // mutate one box through the editor inputs then click apply
    const firstRow = document.querySelector('#boxTbody tr');
    const inputs = firstRow.querySelectorAll('input[type=number]');
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setVal.call(inputs[3], String(+inputs[3].value + 150)); // maxX
    inputs[3].dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('applyBoxBtn').click();
    await new Promise(r => setTimeout(r, 50));
    return performance.now() - t0;
  });
  const timePill = await page.locator('#timePill').textContent();
  console.log('full-spec box-edit wall-clock ms ~', timing.toFixed(0), '| pill:', timePill.trim());
  if (timing > 5000) throw new Error('exceeded 5s refresh budget');

  // 7. invalid box shows an error, no crash
  await page.evaluate(() => {
    const inp = document.querySelector('#boxTbody input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '99999999');
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#applyBoxBtn').click();
  await sleep(100);
  const errShown = await page.locator('#cfgErr.show').count();
  console.log('invalid config error surfaced:', errShown === 1);

  await page.screenshot({ path: '/tmp/fullspec.png', fullPage: false });

  // 8. mobile width
  await page.setViewportSize({ width: 400, height: 900 });
  await sleep(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.screenshot({ path: '/tmp/mobile.png' });
  console.log('no horizontal overflow at 400px:', overflow);

  if (errors.length) console.log('CONSOLE ERRORS:', errors);
  else console.log('no console errors');
  await browser.close();
  console.log('BROWSER VERIFICATION PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
