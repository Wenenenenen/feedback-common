const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:8137/index.html', { waitUntil: 'load' });
  await page.click('#load-demo-btn');
  await page.waitForSelector('#workspace:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(300);
  const kpi = await page.evaluate(() => ({
    ch: document.querySelector('#kpi-channels').textContent,
    d: document.querySelector('#kpi-d').textContent,
    frames: document.querySelector('#kpi-frames').textContent,
    recs: document.querySelector('#kpi-rec-total').textContent,
    perf: document.querySelector('#perf-time').textContent,
    lanes: document.querySelectorAll('.lane').length,
    chips: document.querySelectorAll('.bit-chip').length
  }));
  console.log('KPI', JSON.stringify(kpi));
  await page.screenshot({ path: 'tmp/shot-demo-top.png' });
  // inspector should auto-render frame 0 chips
  await page.waitForSelector('.bit-chip', { timeout: 5000 });
  const insp = await page.evaluate(() => {
    const api = window.PDMReel;
    const d = api.inspectFrame(0, 0);
    return { sum: d.exactSum, pcm: d.pcm, consistent: d.pcmConsistent && d.affectedConsistent, ticks: d.ticks.length };
  });
  console.log('inspect', JSON.stringify(insp));
  await page.locator('#inspector-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'tmp/shot-demo-inspector.png' });
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
