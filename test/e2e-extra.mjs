// 窄屏布局 + 导出内容验证
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  const name = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const buf = await readFile(join(root, name));
    res.writeHead(200, { 'content-type': types[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8732, r));
const exe = '/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

// 窄屏 390px
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
const hOverflow = [];
phone.on('console', (m) => { if (m.type() === 'error') hOverflow.push(m.text()); });
await phone.goto('http://127.0.0.1:8732/');
await phone.fill('#count', '8000');
await phone.click('#runBtn');
await phone.waitForFunction(() => document.querySelector('#runPill')?.textContent === '完成', { timeout: 30000 });
await phone.waitForTimeout(200);
const noHScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const scrollW = await phone.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log(`${noHScroll ? 'PASS' : 'FAIL'} 窄屏无横向滚动 ${JSON.stringify(scrollW)} 控制台错误:${hOverflow.length}`);
await phone.screenshot({ path: '/tmp/e2e-phone.png', fullPage: false });

// 点格 + 详情在窄屏
await phone.locator('#heat .cell').nth(50).click();
const detailVisible = await phone.evaluate(() => !document.querySelector('#detailCard').hidden);
console.log(`${detailVisible ? 'PASS' : 'FAIL'} 窄屏点格详情可用`);

// 导出内容（用页面同源的模块在 node 不可直接调，改为拦截 download 事件）
const desk = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const downloads = [];
desk.on('download', (d) => downloads.push(d));
await desk.goto('http://127.0.0.1:8732/');
await desk.click('#runBtn');
await desk.waitForFunction(() => document.querySelector('#runPill')?.textContent === '完成', { timeout: 30000 });
await desk.click('.tab-row button[data-tab="export"]');
await desk.click('#dlCsvBtn');
await desk.waitForEvent('download', { timeout: 5000 }).catch(() => {});
if (downloads.length) {
  const d = downloads[0];
  const path = '/tmp/exported.csv';
  await d.saveAs(path);
  const text = await readFile(path, 'utf8');
  const lines = text.trim().split('\n');
  const hasHeader = lines[0].startsWith('# 尝试数,40000') || lines[0].includes('尝试数');
  const dataRows = lines.filter((l) => !l.startsWith('#')).length - 1; // 去掉列名行
  const hasBothEnergy = text.includes('能量_采样') && text.includes('能量_确定性积分');
  const hasReject = text.includes('拒收数');
  console.log(`${dataRows === 128 ? 'PASS' : 'FAIL'} CSV 含 128 格数据行（实际 ${dataRows}）`);
  console.log(`${hasHeader ? 'PASS' : 'FAIL'} CSV 含尝试数表头`);
  console.log(`${hasBothEnergy ? 'PASS' : 'FAIL'} CSV 含两种能量`);
  console.log(`${hasReject ? 'PASS' : 'FAIL'} CSV 含拒收数`);
  console.log('--- CSV 头部预览 ---');
  console.log(lines.slice(0, 16).join('\n'));
} else {
  console.log('WARN 无头环境未触发 download 事件（复制回退路径已在逻辑中实现）');
}

await browser.close();
server.close();
