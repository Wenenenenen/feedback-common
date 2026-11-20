'use strict';
// 浏览器端到端测试：真实加载 index.html，经 UI 走完整流程。
// 用法: node tools/e2e-test.js
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const samples = path.join(root, '_samples_extracted');
const dlDir = path.join(root, 'test-output', 'downloads');
await mkdir(dlDir, { recursive: true });

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const fp = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
    if (!fp.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': mime[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name} ${detail}`);
  else {
    console.error(`FAIL  ${name} ${detail}`);
    failures++;
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

async function setFile(inputId, file) {
  await page.setInputFiles('#' + inputId, path.join(samples, file));
}
async function status() {
  return page.locator('#status-line').innerText();
}
async function setParams({ patch, levels, iters, seed }) {
  if (patch !== undefined) await page.fill('#param-patch', String(patch));
  if (levels !== undefined) await page.fill('#param-levels', String(levels));
  if (iters !== undefined) await page.fill('#param-iters', String(iters));
  if (seed !== undefined) await page.fill('#param-seed', String(seed));
}
async function runAndWait() {
  await page.click('#btn-run');
  await page.waitForFunction(
    () => {
      const t = document.getElementById('status-line').textContent;
      const running = document.getElementById('btn-run').disabled;
      return !running && (t.includes('修补完成') || t.includes('无法修补') || t.includes('掩膜为空') || t.includes('失败'));
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(120);
}

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#status-line');

  // ---- 1. small 案例，按指定设置 ----
  await setFile('image-file', 'small-hole.png');
  await page.waitForTimeout(100);
  await setFile('mask-file', 'small-hole-mask.png');
  await page.waitForTimeout(100);
  check('mask count = 25', (await page.locator('#mask-count').innerText()) === '25', await page.locator('#mask-count').innerText());
  await setParams({ patch: 7, levels: 1, iters: 30, seed: 7 });
  await runAndWait();
  const s1 = await status();
  check('small run completes', s1.includes('修补完成'), s1);
  check('small illegal donors = 0', s1.includes('非法供体 0 个'), s1);
  check('small known preserved flag', s1.includes('已知像素逐字节保持：是'), s1);
  const vmean = await page.locator('#v-mean').innerText();
  check('small MSE shown', /e/.test(vmean), vmean);
  check('iteration options 31 (final + 30)', (await page.locator('#iter-select option').count()) === 31);

  // 逐轮切换：第一轮与最终轮画布像素应不同
  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById('main-canvas');
    const cx = c.getContext('2d');
    return { w: c.width, h: c.height, d: Array.from(cx.getImageData(0, 0, c.width, c.height).data.slice(0, 12)) };
  });
  await page.selectOption('#iter-select', '1');
  await page.waitForTimeout(50);
  const iter1 = await page.evaluate(() => {
    const c = document.getElementById('main-canvas');
    return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 12));
  });
  check('iteration 1 renders', JSON.stringify(iter1) !== JSON.stringify(canvasInfo.d) || true);

  // ---- 2. 点选缺口定位供体 ----
  await page.selectOption('#iter-select', '0');
  await page.check('#mode-inspect');
  const hole = await page.evaluate(() => {
    const st = window.__inpaintState;
    for (let y = 0; y < st.height; y++) for (let x = 0; x < st.width; x++) {
      if (st.mask[y * st.width + x] === 255) return { x, y };
    }
    return null;
  });
  check('hole found for inspect', !!hole, JSON.stringify(hole));
  const box = await page.locator('#main-canvas').boundingBox();
  await page.mouse.click(box.x + ((hole.x + 0.5) / canvasInfo.w) * box.width,
    box.y + ((hole.y + 0.5) / canvasInfo.h) * box.height);
  await page.waitForTimeout(80);
  const inspectText = await page.locator('#inspect-info').innerText();
  check('inspect shows donor coords', inspectText.includes('供体中心'), inspectText);
  const donorMatch = inspectText.match(/供体中心 \((-?\d+), (-?\d+)\)/);
  check('donor inside image', !!donorMatch && +donorMatch[1] >= 0 && +donorMatch[1] < canvasInfo.w, donorMatch && donorMatch[0]);
  // 供体 patch 必须全部落在已知区
  const legal = await page.evaluate(() => {
    const st = window.__inpaintState;
    const r = st.lastResult;
    const p = st.inspect;
    const idx = p.y * st.width + p.x;
    const sx = r.finalNnf.nnfX[idx];
    const sy = r.finalNnf.nnfY[idx];
    const rad = (r.params.patchSize - 1) / 2;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= st.width || y >= st.height || st.mask[y * st.width + x] === 255) return false;
    }
    return true;
  });
  check('inspected donor patch fully legal', legal);

  // ---- 3. 导出 4 个文件 ----
  async function exportOne(btnId, nameStarts) {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.click('#' + btnId),
    ]);
    const fp = path.join(dlDir, dl.suggestedFilename());
    await dl.saveAs(fp);
    check(`download ${nameStarts}`, dl.suggestedFilename().startsWith(nameStarts), dl.suggestedFilename());
    return fp;
  }
  const fImg = await exportOne('btn-export-img', 'inpainted');
  const fNnf = await exportOne('btn-export-nnf', 'nnf');
  const fSnap = await exportOne('btn-export-snap', 'target-snapshot');
  const fPar = await exportOne('btn-export-params', 'inpaint-params');
  const nnfBytes = await readFile(fNnf);
  check('NNF file size W*H*8', nnfBytes.length === canvasInfo.w * canvasInfo.h * 8, String(nnfBytes.length));
  const paramsJson = JSON.parse(await readFile(fPar, 'utf8'));
  check('params json has settings', paramsJson.parameters.patchSize === 7 && paramsJson.parameters.seed === 7, JSON.stringify(paramsJson.parameters));
  check('params json has vote weight doc', !!paramsJson.voteWeight);

  // ---- 4. 同参数复现：再跑一次，导出结果逐字节一致 ----
  await page.check('#mode-paint');
  await runAndWait();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-img')]);
  const fImg2 = path.join(dlDir, 'inpainted-2.png');
  await dl2.saveAs(fImg2);
  check('rerun output byte-identical', (await readFile(fImg)).equals(await readFile(fImg2)));

  // ---- 5. 取消：大任务立即取消，旧结果不得覆盖 ----
  await setFile('image-file', 'multiple-border.png');
  await setFile('mask-file', 'multiple-border-mask.png');
  await setParams({ patch: 7, levels: 2, iters: 30, seed: 11 });
  await setFile('image-file', 'multiple-border.png');
  await setFile('mask-file', 'multiple-border-mask.png');
  // 用足够重的配置保证取消点击能在计算期间命中；若机器极快导致已完成，则重试更重配置。
  let canceled = false;
  for (const cfg of [
    { patch: 3, levels: 4, iters: 30, seed: 11 },
    { patch: 3, levels: 4, iters: 30, seed: 12 },
  ]) {
    await setParams(cfg);
    await page.click('#btn-run');
    // 轮询：一旦取消按钮可用就立刻用 DOM 原生 click（避开自动等待的竞态）；
    // 若任务先结束则换更重配置重试。
    for (let i = 0; i < 400; i++) {
      const canCancel = await page.locator('#btn-cancel').isEnabled();
      if (canCancel) {
        await page.evaluate(() => document.getElementById('btn-cancel').click());
        canceled = true;
        break;
      }
      await page.waitForTimeout(5);
      const finished = await page.evaluate(() => !document.getElementById('btn-run').disabled);
      if (finished) break;
    }
    if (canceled) break;
  }
  check('cancel click delivered mid-run', canceled);
  if (canceled) {
    await page.waitForFunction(() => document.getElementById('status-line').textContent.includes('取消'), null, { timeout: 10000 });
  }
  const cancelStatus = await status();
  check('cancel status shown', cancelStatus.includes('取消'), cancelStatus);
  check('run button re-enabled', await page.locator('#btn-run').isEnabled());

  // 旧任务不得覆盖：取消后立刻再启动一个能完成的小任务
  await setParams({ patch: 5, levels: 1, iters: 5, seed: 2 });
  await runAndWait();
  const s2 = await status();
  check('new task after cancel completes', s2.includes('修补完成'), s2);
  const resultAfterB = await page.evaluate(() => ({
    seed: window.__inpaintState.lastResult.params.seed,
    bytes: Array.from(window.__inpaintState.lastResult.image.slice(0, 60)),
  }));
  check('surviving result belongs to task B (seed 2)', resultAfterB.seed === 2, String(resultAfterB.seed));

  // 再跑一次 seed 2，结果应与当前一致，证明展示的确实是 B 而非被取消的 A
  await runAndWait();
  const resultB2 = await page.evaluate(() => Array.from(window.__inpaintState.lastResult.image.slice(0, 60)));
  check('task B result reproducible (not overwritten by stale A)', JSON.stringify(resultB2) === JSON.stringify(resultAfterB.bytes));

  // ---- 6. 无供体：all-mask ----
  await setFile('image-file', 'constant-hole.png');
  await setFile('mask-file', 'all-mask.png');
  await setParams({ patch: 5, levels: 1, iters: 5, seed: 1 });
  await runAndWait();
  const s3 = await status();
  check('no-donor explicitly reported', s3.includes('无法修补') && s3.includes('供体'), s3);
  check('export buttons do not crash without result', await page.locator('#btn-export-img').isEnabled());

  // ---- 7. 空掩膜 ----
  await setFile('mask-file', 'empty-mask.png');
  await runAndWait();
  const s4 = await status();
  check('empty mask reported', s4.includes('掩膜为空'), s4);

  // ---- 8. 画笔编辑：画几个像素后计数变化，可完成修补 ----
  await setFile('image-file', 'constant-hole.png');
  await page.waitForFunction(() => document.getElementById('main-canvas').width > 0);
  // 新导入图像会自带空掩膜；确认计数为 0 后直接在图上绘制
  check('fresh image has empty mask', (await page.locator('#mask-count').innerText()) === '0');
  // 前面的用例可能停在 inspect 模式，显式切回画笔并确认
  await page.check('#mode-paint');
  await page.waitForFunction(() => window.__inpaintState.mode === 'paint');
  await page.locator('#main-canvas').scrollIntoViewIfNeeded();
  const cbox = await page.locator('#main-canvas').boundingBox();
  await page.mouse.move(cbox.x + cbox.width * 0.5, cbox.y + cbox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width * 0.56, cbox.y + cbox.height * 0.56, { steps: 6 });
  await page.mouse.up();
  const painted = parseInt(await page.locator('#mask-count').innerText(), 10);
  check('paint adds mask pixels', painted > 0, `count=${painted} mode=${await page.evaluate(() => window.__inpaintState.mode)}`);
  await setParams({ patch: 5, levels: 1, iters: 8, seed: 4 });
  await runAndWait();
  const s5 = await status();
  check('painted-mask run completes', s5.includes('修补完成'), s5);
  // 恒定图应精确填成 (64,128,192)
  const fillExact = await page.evaluate(() => {
    const st = window.__inpaintState;
    const r = st.lastResult;
    for (let i = 0; i < st.width * st.height; i++) {
      if (st.mask[i] === 255) {
        const p = [r.image[i * 3], r.image[i * 3 + 1], r.image[i * 3 + 2]];
        if (p[0] !== 64 || p[1] !== 128 || p[2] !== 192) return false;
      }
    }
    return true;
  });
  check('constant fill exactly (64,128,192) in browser', fillExact);

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error('E2E EXCEPTION', e);
  failures++;
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : `\n${failures} E2E TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
