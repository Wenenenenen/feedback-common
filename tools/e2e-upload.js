// 本地文件上传路径：有效 RAW 可切换并计算；三个 invalid 文件必须被拒绝且不污染当前状态。
import { createRequire } from 'node:module';
const require = createRequire('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/');
const { chromium } = require('playwright');

const DATA = '/home/wendy/jianzhi/feedback-tasks/bayer-demosaic-bench/samples/extracted';
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

// 监听 dialog 自动接受，并记录文案
const dialogs = [];
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
page.on('pageerror', (e) => { failures++; console.log('PAGEERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERROR:', m.text()); });

await page.goto('http://localhost:8123/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('psnrOverall').textContent !== '—');
const psnrBefore = await page.textContent('#psnrOverall');

// 1. 三个无效文件：弹出原因明确的 alert，且 PSNR 维持样例值
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const f of ['invalid-magic.raw', 'invalid-pattern.raw', 'invalid-truncated.raw']) {
  dialogs.length = 0;
  await page.setInputFiles('#rawFile', `${DATA}/${f}`);
  for (let i = 0; i < 50 && !dialogs.length; i++) await sleep(50);
  check(dialogs[0]?.includes('RAW 文件无法解析'), `${f} 被拒绝：${dialogs[0] ?? '未弹窗'}`);
}
check((await page.textContent('#psnrOverall')) === psnrBefore, '拒绝无效文件后样例状态未被污染');

// 2. 有效本地 RAW：切换成功，PSNR 显示 —（无 truth），仍可导出
await page.setInputFiles('#rawFile', `${DATA}/zone.raw`);
await page.waitForFunction(() => document.getElementById('cfaName').textContent === 'RGGB');
await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 8000 });
await page.waitForFunction(() => !document.getElementById('exportPngBtn').disabled);
check((await page.textContent('#psnrOverall')) === '—', '本地文件无 truth 时 PSNR 显示 —');
check(await page.$eval('#rawMeta', (e) => e.textContent.includes('12 bit')), '文件头位深正确显示 12 bit');
check(await page.$eval('#rawMeta', (e) => e.textContent.includes('256 × 256')), '尺寸 256×256 正确');

const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#exportPngBtn')]);
await dl.saveAs('/tmp/e2e-local.png');
const fs = await import('node:fs/promises');
const buf = new Uint8Array(await fs.readFile('/tmp/e2e-local.png'));
console.log(`  PNG 前 8 字节: ${[...buf.slice(0, 8)].map((b) => b.toString(16)).join(' ')}，IHDR depth/type: ${buf[24]}/${buf[25]}，大小 ${buf.length}`);
const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
check(isPng && buf[24] === 16 && buf[25] === 2, '本地文件同样导出 16 位 PNG');

const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exportJsonBtn')]);
await dl2.saveAs('/tmp/e2e-local.json');
const report = JSON.parse(await (await import('node:fs/promises')).readFile('/tmp/e2e-local.json', 'utf8'));
check(report.metrics.note && report.source === 'local-upload', '本地文件 JSON 标注无参考且来源为 local-upload');

await browser.close();
console.log(failures ? `\n${failures} 项失败` : '\n上传路径全部通过');
process.exit(failures ? 1 : 0);
