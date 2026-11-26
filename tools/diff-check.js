/* Verifies the cabinet-change diff workflow in the UI. */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8731/index.html');
  await page.waitForSelector('#pathTbody tr');

  const setInput = (sel, val, idx = 0) => page.evaluate(([s, v, i]) => {
    const el = document.querySelectorAll(s)[i];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, val, idx]);

  const counts = () => page.evaluate(() => ({
    reach: +document.getElementById('cntOk').textContent,
    block: +document.getElementById('cntBlock').textContent,
  }));
  console.log('before:', await counts());

  // Enlarge B0 (maxX 3500->4200, maxY 2500->3000, maxZ 1700->2400) then apply
  const boxInputs = '#boxTbody tr[data-box="0"] input[type=number]';
  await setInput(boxInputs, 4200, 3); // maxX
  await setInput(boxInputs, 3000, 4); // maxY
  await setInput(boxInputs, 2400, 5); // maxZ
  await page.click('#applyBoxBtn');
  await sleep(120);

  const after = await counts();
  console.log('after:', after);
  const bannerVisible = await page.locator('#diffBanner:not([hidden])').count();
  const bannerText = bannerVisible ? await page.locator('#diffBanner').innerText() : '(hidden)';
  console.log('diff banner:', bannerText.replace(/\n/g, ' '));
  const newMarks = await page.locator('.badge.diff.new').count();
  const openMarks = await page.locator('.badge.diff.open').count();
  console.log('new-block markers:', newMarks, 'reopened markers:', openMarks);
  if (!bannerVisible || newMarks === 0) throw new Error('diff markers not shown after cabinet edit');

  // the marked row names an actual wall order and segment/box
  const firstNew = await page.locator('tr.row-diff').first().innerText();
  console.log('first newly blocked row:\n' + firstNew.replace(/\t/g, ' | '));

  // clear markers
  await page.click('#clearDiffBtn');
  await sleep(80);
  const cleared = await page.locator('#diffBanner:not([hidden])').count();
  if (cleared !== 0) throw new Error('banner did not clear');
  console.log('markers cleared OK');

  if (errors.length) throw new Error('page errors: ' + errors.join('; '));
  await page.screenshot({ path: '/tmp/diff-banner.png' });
  await browser.close();
  console.log('DIFF WORKFLOW PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
