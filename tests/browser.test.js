/* 真实浏览器测试：加载页面、导入样例、绘制、拾取、撤销、导出、错误保留 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'index.html');
const SAMPLE = path.join(ROOT, 'cases-extract', '展板.json');

let browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(async () => {
  if (browser) await browser.close();
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { throw new Error('页面异常: ' + e.message); });
  page.on('console', (msg) => {
    if (msg.type() === 'error') throw new Error('console 错误: ' + msg.text());
  });
  await page.goto(PAGE);
  return page;
}

async function importSample(page) {
  await page.setInputFiles('#fileInput', SAMPLE);
  await page.waitForFunction(() => /已加载/.test(document.getElementById('status').textContent));
}

test('浏览器：导入样例后双画布出现非背景内容', async () => {
  const page = await newPage();
  await importSample(page);
  const status = await page.textContent('#status');
  assert.match(status, /8 顶点/);
  assert.match(status, /4 面/);
  const hasBase = await page.evaluate(() => {
    const d = document.getElementById('viewCanvas').getContext('2d').getImageData(20, 20, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.deepEqual(hasBase, [212, 221, 224]);
  const bg = await page.evaluate(() => {
    const d = document.getElementById('viewCanvas').getContext('2d').getImageData(2, 2, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.deepEqual(bg, [32, 36, 40]);
  await page.close();
});

test('浏览器：在铭牌上画红笔，预览与纹理同步变红', async () => {
  const page = await newPage();
  await importSample(page);
  const box = await page.locator('#viewCanvas').boundingBox();
  const scale = box.width / 160;
  await page.mouse.move(box.x + 90 * scale, box.y + 55 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 96 * scale, box.y + 55 * scale, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => /已上色/.test(document.getElementById('status').textContent));
  const red = await page.evaluate(() => {
    const d = document.getElementById('viewCanvas').getContext('2d').getImageData(93, 55, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.deepEqual(red, [220, 60, 60]); // 默认笔刷色
  const texHas = await page.evaluate(() => {
    const c = document.getElementById('texCanvas');
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i] === 220 && img[i + 1] === 60 && img[i + 2] === 60) return true;
    }
    return false;
  });
  assert.ok(texHas);
  await page.close();
});

test('浏览器：点纹理纹素显示归属面/投影/最前深度', async () => {
  const page = await newPage();
  await importSample(page);
  const box = await page.locator('#texCanvas').boundingBox();
  const scale = box.width / 160;
  await page.mouse.click(box.x + 10 * scale + scale / 2, box.y + 60 * scale + scale / 2);
  const info = await page.textContent('#info');
  assert.match(info, /纹素 \(10,60\)/);
  assert.match(info, /归属面：[23]/);
  assert.match(info, /投影定点/);
  assert.match(info, /最前深度：20/);
  await page.close();
});

test('浏览器：撤销后预览恢复，重做回来，新笔清空重做', async () => {
  const page = await newPage();
  await importSample(page);
  const box = await page.locator('#viewCanvas').boundingBox();
  const scale = box.width / 160;
  for (const [x, y] of [[90, 55], [30, 30]]) {
    await page.mouse.move(box.x + x * scale, box.y + y * scale);
    await page.mouse.down();
    await page.mouse.move(box.x + (x + 4) * scale, box.y + y * scale, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => /已上色/.test(document.getElementById('status').textContent));
  }
  const undo = page.locator('#undoBtn'), redo = page.locator('#redoBtn');
  assert.equal(await undo.isEnabled(), true);
  assert.equal(await redo.isDisabled(), true);
  await undo.click();
  assert.equal(await redo.isEnabled(), true);
  await redo.click();
  await undo.click();
  await page.mouse.move(box.x + 40 * scale, box.y + 40 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 44 * scale, box.y + 40 * scale, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => /已上色/.test(document.getElementById('status').textContent));
  assert.equal(await redo.isDisabled(), true);
  await page.close();
});

test('浏览器：导出 PNG 下载，尺寸为纹理原始大小', async () => {
  const page = await newPage();
  await importSample(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn')
  ]);
  const tmp = path.join(__dirname, 'downloaded.png');
  await download.saveAs(tmp);
  const buf = fs.readFileSync(tmp);
  assert.deepEqual([...buf.subarray(0, 4)], [137, 80, 78, 71]);
  const dv = new DataView(buf.buffer, buf.byteOffset);
  assert.equal(dv.getUint32(16), 160);
  assert.equal(dv.getUint32(20), 96);
  assert.equal(buf[25], 2); // 真彩色
  fs.unlinkSync(tmp);
  await page.close();
});

test('浏览器：导入失败报字段且保留画布与历史', async () => {
  const page = await newPage();
  await importSample(page);
  const box = await page.locator('#viewCanvas').boundingBox();
  const scale = box.width / 160;
  await page.mouse.move(box.x + 90 * scale, box.y + 55 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 96 * scale, box.y + 55 * scale, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => /已上色/.test(document.getElementById('status').textContent));

  const bad = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  bad.faces[0].v[1] = 99999;
  const badPath = path.join(__dirname, 'bad-scene.json');
  fs.writeFileSync(badPath, JSON.stringify(bad));
  await page.setInputFiles('#fileInput', badPath);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('error')).display !== 'none');
  const errText = await page.textContent('#error');
  assert.match(errText, /faces\[0\]\.v\[1\]/);
  assert.match(errText, /保持不变/);
  const dims = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    return [c.width, c.height];
  });
  assert.deepEqual(dims, [160, 104]);
  assert.equal(await page.locator('#undoBtn').isEnabled(), true);
  fs.unlinkSync(badPath);
  await page.close();
});
