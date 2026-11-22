/*
 * test/e2e.playwright.mjs — 真实 Chromium 端到端测试
 * 运行：node test/e2e.playwright.mjs（依赖全局 playwright 与已安装的 chromium）
 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 极简静态服务器（file:// 下 ES module 会被 CORS 拦截）
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = join(root, p === '/' ? 'index.html' : p);
  if (!file.startsWith(root + '/')) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const indexUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ✓', name);
};

await page.goto(indexUrl);
await page.waitForSelector('#stage svg');

await test('初始渲染：样例首帧 SVG 存在且无控制台错误', async () => {
  assert.equal(await page.textContent('#frameNo'), '帧 1/3');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok((await page.locator('#stage svg rect').count()) > 3);
});

await test('深度遮挡：帧1/帧2 中 C 的红色隐藏锚点存在', async () => {
  const red = page.locator('#stage svg circle[fill="#ef4444"]');
  assert.ok(await red.count());
});

await test('拖帧到帧2再回拖，首帧 SVG 逐字节重现（回拖确定性）', async () => {
  const svg0 = await page.locator('#stage svg').evaluate((el) => el.outerHTML);
  await page.fill('#frameSlider', '1');
  await page.waitForFunction(() => document.querySelector('#frameNo').textContent === '帧 2/3');
  const svg1 = await page.locator('#stage svg').evaluate((el) => el.outerHTML);
  assert.notEqual(svg0, svg1);
  // 帧2 只有 A 显示
  assert.match(await page.textContent('#statbar'), /显示标签\s*1\/3/);
  await page.fill('#frameSlider', '0');
  await page.waitForFunction(() => document.querySelector('#frameNo').textContent === '帧 1/3');
  const svg0again = await page.locator('#stage svg').evaluate((el) => el.outerHTML);
  assert.equal(svg0again, svg0);
});

await test('修改优先分触发重新求解，统计条更新', async () => {
  const before = await page.textContent('#statbar');
  // 在页面内设值并派发 change，避免 fill 的焦点处理与整体重渲染冲突
  await page.evaluate(() => {
    const inp = document.querySelector('#labelTable .weight-input');
    inp.value = '100';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    (b) => document.querySelector('#statbar').textContent !== b,
    before
  );
  assert.match(await page.textContent('#statbar'), /优先分\s*105/); // 100+5+4 总权重
});

await test('修改换落位罚分触发重算', async () => {
  await page.evaluate(() => {
    const inp = document.querySelector('#switchPenalty');
    inp.value = '5';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#stage svg');
  assert.equal(errors.length, 0, errors.join('\n'));
});

await test('新增预留区并在画面上出现，删除后消失', async () => {
  const before = await page.locator('#reservedList .reserved-row').count();
  await page.click('#btnAddReserved');
  assert.equal(await page.locator('#reservedList .reserved-row').count(), before + 1);
  assert.ok((await page.locator('#stage svg .svg-reserved').count()) >= 1);
  await page.locator('#reservedList [data-del]').last().click();
  assert.equal(await page.locator('#reservedList .reserved-row').count(), before);
});

await test('预留区盖住全部落位时标签被求解隐藏', async () => {
  // 新增一个覆盖整个画布的预留区；每次 change 会整体重渲染，故逐字段重新定位并先失焦
  await page.click('#btnAddReserved');
  const setField = async (k, v) => {
    // 整体重渲染会替换输入框，故在页面内一次性设值并派发 change，避免外部句柄失效
    await page.evaluate(
      ({ key, val }) => {
        const inp = document.querySelector(
          `#reservedList .reserved-row:last-child input[data-k="${key}"]`
        );
        inp.value = val;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { key: k, val: String(v) }
    );
  };
  await setField('x', 0);
  await setField('y', 0);
  await setField('w', 32);
  await setField('h', 16);
  await page.waitForFunction(() => /显示标签\s*0\/3/.test(document.querySelector('#statbar').textContent));
  assert.match(await page.textContent('#statbar'), /显示标签\s*0\/3/);
  // 清理
  await page.locator('#reservedList [data-del]').last().click();
});

await test('冲突诊断面板可点选并高亮', async () => {
  const items = page.locator('#conflictList .conflict-item');
  assert.ok((await items.count()) >= 1);
  await items.first().click();
  assert.ok(await items.first().evaluate((el) => el.classList.contains('active')));
});

await test('候选落位虚影开关', async () => {
  await page.check('#chkGhost');
  await page.uncheck('#chkGhost');
  assert.equal(errors.length, 0, errors.join('\n'));
});

await test('导出 SVG 与落位 JSON 触发下载且内容正确', async () => {
  const [svgDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExportSVG'),
  ]);
  assert.match(svgDownload.suggestedFilename(), /overlay-frame-.*\.svg/);
  const svgStream = await svgDownload.createReadStream();
  const svgText = await new Promise((res, rej) => {
    let s = '';
    svgStream.on('data', (c) => (s += c));
    svgStream.on('end', () => res(s));
    svgStream.on('error', rej);
  });
  assert.ok(svgText.startsWith('<svg'));

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExportJSON'),
  ]);
  const jsonText = await jsonDownload.path().then((p) => import('node:fs').then((fs) => fs.readFileSync(p, 'utf8')));
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.frames.length, 3);
  assert.ok(parsed.frames[0].labels.some((l) => l.id === 'A' && l.visible && l.choice === 1));
});

await test('整体重渲染后焦点保持在原输入框', async () => {
  const kept = await page.evaluate(() => {
    const inp = document.querySelector('#labelTable .weight-input');
    inp.focus();
    inp.value = '7';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    // 重渲染后 activeElement 仍应是权重输入框（按 data-li 定位的新节点）
    const a = document.activeElement;
    return a && a.classList.contains('weight-input') && a.dataset.li === '0';
  });
  assert.ok(kept);
});

await test('键盘左右方向键切帧', async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.textContent('#frameNo'), '帧 2/3');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.textContent('#frameNo'), '帧 1/3');
});

assert.equal(errors.length, 0, '整个会话无 JS 错误：' + errors.join('\n'));
await browser.close();
server.close();
console.log(`\n全部 ${passed} 项端到端测试通过`);
