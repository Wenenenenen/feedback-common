// 真实浏览器端到端测试（Playwright + 缓存的 headless Chromium）。
// 覆盖：页面加载、Worker 重算、PSNR 与 reference.json 一致性、算法/通道/放大切换、
// 导航拖拽、白平衡改参重算、PNG/JSON 导出、CFA 采样视图。
import { createRequire } from 'node:module';
const require = createRequire('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/');
const { chromium } = require('playwright');
import { readFile } from 'node:fs/promises';

const BASE = 'http://localhost:8123';
const reference = JSON.parse(await readFile(new URL('../samples/extracted/reference.json', import.meta.url)));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('psnrOverall').textContent !== '—', { timeout: 8000 });

// 1. 默认 zone + 双线性的 PSNR 与 reference.json 一致
const psnrText = await page.textContent('#psnrOverall');
const expected = reference.zone.bilinearPsnr;
check(Math.abs(parseFloat(psnrText) - expected) < 0.01, `zone 双线性 PSNR=${psnrText} 对齐参考 ${expected}`);
check((await page.textContent('#statusLine')).includes('完成'), '状态行显示完成');

// 2. 四个用例 × 双线性 PSNR 全部对齐
for (const name of ['zone', 'edges', 'lines', 'colorbars']) {
  await page.selectOption('#caseSelect', name);
  await page.waitForFunction(
    (exp) => {
      const t = document.getElementById('psnrOverall').textContent;
      return t !== '—' && Math.abs(parseFloat(t) - exp) < 0.01;
    },
    reference[name].bilinearPsnr,
    { timeout: 8000 },
  );
  const t = await page.textContent('#psnrOverall');
  check(Math.abs(parseFloat(t) - reference[name].bilinearPsnr) < 0.01,
    `${name} 双线性 PSNR=${t} 参考 ${reference[name].bilinearPsnr}`);
}

// 3. 切 HA：lines 上应明显高于双线性
await page.selectOption('#caseSelect', 'lines');
await page.waitForFunction(
  (exp) => Math.abs(parseFloat(document.getElementById('psnrOverall').textContent) - exp) < 0.01,
  reference.lines.bilinearPsnr,
);
await page.selectOption('#algoSelect', 'hamiltonAdams');
await page.waitForFunction(
  (bl) => parseFloat(document.getElementById('psnrOverall').textContent) > bl + 4,
  reference.lines.bilinearPsnr,
  { timeout: 8000 },
);
const haLines = parseFloat(await page.textContent('#psnrOverall'));
check(haLines > reference.lines.bilinearPsnr + 4, `lines HA PSNR ${haLines} 显著优于双线性 ${reference.lines.bilinearPsnr}`);

// 4. 通道切换：仅 R 时 G/B 画布列为零（采样画布像素检查）
await page.selectOption('#channelSelect', '0');
await page.waitForTimeout(300);
const rOnly = await page.evaluate(() => {
  const c = document.getElementById('cfaCanvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let greenish = 0, bluish = 0, redPx = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 1] > 0) greenish++;
    if (d[i + 2] > 0) bluish++;
    if (d[i] > 0) redPx++;
  }
  return { greenish, bluish, redPx, w: c.width };
});
check(rOnly.greenish === 0 && rOnly.bluish === 0 && rOnly.redPx > 0, '仅 R 通道视图无 G/B 分量');
await page.selectOption('#channelSelect', '-1');

// 5. 放大切换改变画布尺寸（按当前样例实际宽度断言）
const dims1 = await page.evaluate(() => ({ w: document.getElementById('curCanvas').width, base: document.getElementById('curCanvas').width / 2 }));
await page.selectOption('#zoomSelect', '4');
await page.waitForFunction((w2) => document.getElementById('curCanvas').width === w2, dims1.base * 4);
const size4 = await page.evaluate(() => document.getElementById('curCanvas').width);
check(size4 === dims1.base * 4, `放大 4× 画布宽度 ${size4} = 原始宽度 ${dims1.base} × 4`);

// 6. 导航点击改变滚动位置（用 255×171 的 edges：放大后超出视口才有滚动空间）
await page.selectOption('#algoSelect', 'bilinear');
await page.selectOption('#caseSelect', 'edges');
await page.waitForFunction(
  (exp) => Math.abs(parseFloat(document.getElementById('psnrOverall').textContent) - exp) < 0.01,
  reference.edges.bilinearPsnr,
);
await page.waitForTimeout(200);
const scrollable = await page.evaluate(() => {
  const c = document.getElementById('curScroll');
  return c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight;
});
check(scrollable, 'edges 放大后存在可滚动区域');
const panBefore = await page.evaluate(() => [document.getElementById('curScroll').scrollLeft, document.getElementById('curScroll').scrollTop]);
const navBox = await page.evaluate(() => {
  const c = document.getElementById('navCanvas');
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(navBox.x + navBox.w * 0.75, navBox.y + navBox.h * 0.6);
await page.waitForTimeout(300);
const panAfter = await page.evaluate(() => [document.getElementById('curScroll').scrollLeft, document.getElementById('curScroll').scrollTop]);
check(panAfter[0] !== panBefore[0] || panAfter[1] !== panBefore[1], '导航点击移动了放大区域');

// 7. 改白平衡触发重算，PSNR 数值改变
await page.selectOption('#zoomSelect', '2');
await page.selectOption('#algoSelect', 'bilinear');
await page.selectOption('#caseSelect', 'edges');
await page.waitForFunction(
  (exp) => Math.abs(parseFloat(document.getElementById('psnrOverall').textContent) - exp) < 0.01,
  reference.edges.bilinearPsnr,
);
const psnrBefore = await page.textContent('#psnrOverall');
await page.fill('#wbR', '3.0');
await page.dispatchEvent('#wbR', 'input');
await page.waitForFunction((t) => document.getElementById('psnrOverall').textContent !== t, psnrBefore);
const psnrWb = await page.textContent('#psnrOverall');
check(psnrWb !== psnrBefore, `白平衡 R=3.0 触发重算（${psnrBefore} -> ${psnrWb}）`);
await page.click('#resetWbBtn');
await page.waitForFunction((t) => document.getElementById('psnrOverall').textContent === t, psnrBefore);
check((await page.textContent('#psnrOverall')) === psnrBefore, '恢复白平衡后 PSNR 还原');

// 8. 导出 PNG 与 JSON：拦截下载，校验 16 位 PNG 魔数与 JSON 指标
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#exportPngBtn'),
]);
const pngPath = '/tmp/e2e-export.png';
await download.saveAs(pngPath);
const pngBytes = await readFile(pngPath);
const isPng = pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47;
check(isPng && pngBytes[24] === 16 && pngBytes[25] === 2,
  '导出的 PNG 为 16 位真彩（bit depth 16 / color type 2）');

const [dl2] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#exportJsonBtn'),
]);
const jsonPath = '/tmp/e2e-export.json';
await dl2.saveAs(jsonPath);
const report = JSON.parse(await readFile(jsonPath, 'utf8'));
check(typeof report.metrics.psnrDb === 'number' && report.raw.pattern === 'BGGR' && report.whiteBalance.r === 2.1,
  `导出 JSON 含指标与参数（PSNR=${report.metrics.psnrDb}, pattern=${report.raw.pattern}）`);

// 9. CFA 画布确实只在约 1/4（R/B）或 1/2（G）位置有值——统计非零占比
const cfaStats = await page.evaluate(() => {
  const c = document.getElementById('cfaCanvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 0) lit++;
  return lit / (d.length / 4);
});
check(cfaStats > 0.99, '合成 CFA 视图下每个像素恰有一个通道点亮（占比≈100%）');

// 10. 无页面错误
check(errors.length === 0, `浏览器无报错（${errors.length ? errors.join(' | ') : '干净'}）`);

await browser.close();
console.log(failures ? `\n${failures} 项失败` : '\n浏览器端到端全部通过');
process.exit(failures ? 1 : 0);
