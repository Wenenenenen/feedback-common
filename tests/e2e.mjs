// 浏览器端到端验证（Playwright）：node tests/e2e.mjs
// 起静态服务器，加载页面，导入每个样例，核对页面读数与导出。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const casesDir = path.join(root, 'samples', 'loudness-cases');
const reference = JSON.parse(await readFile(path.join(casesDir, 'reference.json'), 'utf8'));

const mime = { '.wav': 'audio/wav', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(root, p);
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': mime[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/index.html`);

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.log('  FAIL:', msg); }
};

for (const tc of reference.cases) {
  console.log(`\n== ${tc.file}`);
  await page.setInputFiles('#fileInput', path.join(casesDir, tc.file));
  await page.waitForSelector('#analysisPanel:not([hidden])');
  await page.waitForFunction(() => document.getElementById('freshBadge').textContent === '当前结果');

  const shownI = await page.textContent('#statI');
  if (tc.i_lufs === null) {
    check(shownI.includes('不可测'), `${tc.file} I 应显示不可测，实得 ${shownI}`);
  } else {
    check(Math.abs(parseFloat(shownI) - tc.i_lufs) <= 0.2, `${tc.file} I=${shownI} 参考 ${tc.i_lufs}`);
  }

  // 曲线点数
  const mPoints = await page.evaluate(() => window.__mCount || document.querySelectorAll('#loudnessChart path').length);
  check(mPoints >= 2, 'M/S 曲线已渲染');

  // 交付按钮状态
  const exportDisabled = await page.$eval('#exportWav', (el) => el.disabled);
  if (tc.i_lufs === null) {
    check(exportDisabled, `${tc.file} 不可测时禁止导出 WAV`);
  } else {
    check(!exportDisabled, `${tc.file} 可测时应允许导出`);
  }
}

// 失效管理：修改目标参数后标记过期再刷新（用 intersample，提高目标会撞峰值上限）
console.log('\n== 失效管理');
await page.setInputFiles('#fileInput', path.join(casesDir, 'intersample.wav'));
await page.waitForSelector('#deliveryPanel:not([hidden])');
await page.fill('#targetLufs', '4');
await page.waitForFunction(() => document.getElementById('freshBadge').textContent === '当前结果');
const gapVisible = await page.$eval('#gapBanner', (el) => !el.hidden);
check(gapVisible, '提高目标响度引发峰值约束时应显示缺口提示');
const gapText = await page.textContent('#gapBanner');
check(/峰值约束优先/.test(gapText), '缺口提示含“峰值约束优先”');
check(/LU/.test(gapText), '缺口提示给出距目标的 LU 缺口');

// 过采样倍数切换触发重新分析
await page.selectOption('#oversampleSelect', '8');
await page.waitForFunction(() => document.getElementById('freshBadge').textContent === '当前结果');
const osLabel = await page.textContent('#statOversample');
check(osLabel === '8×', '过采样倍数切换后标签更新');

// 导出 JSON 内容校验
console.log('\n== 导出 JSON');
const downloaded = await page.evaluate(() => {
  return new Promise((resolve) => {
    const blob = window.__lastBlob || null;
    resolve(blob);
  });
});
// 通过拦截下载获取内容
const jsonPromise = page.waitForEvent('download');
await page.click('#exportJson');
const dl = await jsonPromise;
const dlPath = path.join(here, 'dl-report.json');
await dl.saveAs(dlPath);
const report = JSON.parse(await readFile(dlPath, 'utf8'));
check(report.target_lufs === 4, 'JSON 含修改后的目标');
check(typeof report.gain.gain_db === 'number', 'JSON 含实际增益');
check(report.gain.peak_constrained === true, 'intersample 提高目标后应受峰值约束');
check(report.input.integrated_lufs !== null && report.delivered.integrated_lufs !== null, 'JSON 含处理前后 I');
check(Array.isArray(report.delivered.per_channel) && report.delivered.per_channel.length === 2, 'JSON 逐声道读数');

// 导出 WAV 规格校验
const wavPromise = page.waitForEvent('download');
await page.click('#exportWav');
const wavDl = await wavPromise;
const wavPath = path.join(here, 'dl-out.wav');
await wavDl.saveAs(wavPath);
const wavBytes = await readFile(wavPath);
const view = new DataView(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
check(view.getUint16(20, true) === 1, '导出 WAV 为 PCM 格式');
check(view.getUint32(24, true) === 48000, '导出 WAV 采样率不变');
check(view.getUint16(34, true) === 24, '导出 WAV 为 24 位');
const dataBytes2 = view.getUint32(40, true);
check(dataBytes2 === 144000 * 2 * 3, `导出 WAV 数据字节对应帧数/声道不变，实得 ${dataBytes2 / 6} 帧`);

// 静音文件禁止交付
console.log('\n== 静音禁止交付');
await page.setInputFiles('#fileInput', path.join(casesDir, 'silence.wav'));
await page.waitForSelector('#analysisPanel:not([hidden])');
const blockedShown = await page.$eval('#blockedBanner', (el) => !el.hidden);
check(blockedShown, '纯静音应显示禁止交付横幅');
check(await page.$eval('#exportWav', (el) => el.disabled), '静音时导出按钮禁用');

check(errors.length === 0, `页面无 JS 错误（实得 ${errors.length}: ${errors.join('; ')}）`);

await browser.close();
server.close();
console.log(`\n${failures === 0 ? '全部 E2E 检查通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
