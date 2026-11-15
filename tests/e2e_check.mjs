/*
 * 浏览器端到端测试（零依赖，使用已安装的 Playwright + Chromium）。
 *
 * 用法：
 *   python3 -I src/py/server.py --port 8899 &
 *   node tests/e2e_check.mjs http://127.0.0.1:8899
 *
 * 覆盖：样例载入、峰值/长度、clip 超限、长任务进度与取消、竞态、
 * 采样率不一致点名、缺干声、w=0 长度、导出 WAV 字节核对。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8899';
async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  let lastErr;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  // 全局安装的 shim 需要绝对路径才能被 import
  try {
    const { execSync } = await import('node:child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(`${globalRoot}/playwright/index.mjs`);
  } catch (err) {
    lastErr = err;
  }
  throw new Error(
    '需要 Playwright（npm i -g playwright 或设置 PLAYWRIGHT_PATH）：' +
      (lastErr?.message || ''),
  );
}

const { chromium } = await loadPlaywright();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc-e2e-'));
let failures = 0;
let checks = 0;

function check(name, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const disabled = (sel) => page.$eval(sel, (e) => e.disabled);

async function loadSample(id) {
  await page.selectOption('#sample-select', id);
  await page.click('#load-sample');
}

/** 等待一次新的分析完成（不依赖旧结果残留）。 */
async function waitAnalysis(timeout = 120000) {
  const before = await page.evaluate(() => Number(document.body.dataset.analysisCount || 0));
  await page.waitForFunction(
    (prev) => Number(document.body.dataset.analysisCount || 0) > prev,
    before,
    { timeout },
  );
  return page.evaluate(() => Number(document.body.dataset.analysisCount || 0));
}

async function waitDone(timeout = 120000) {
  await page.waitForFunction(
    () => !document.querySelector('#status-strip').classList.contains('busy') &&
      !document.querySelector('#status-text').textContent.includes('载入') &&
      !document.querySelector('#status-text').textContent.includes('取消'),
    null,
    { timeout },
  );
}

async function exportWav(target) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#export-btn'),
  ]);
  await download.saveAs(target);
  return download.suggestedFilename();
}

/** 读取 24-bit WAV，返回 {rate, frames, left, right}。 */
function readWav24(file) {
  const buf = fs.readFileSync(file);
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  const dataOffset = 44;
  const frames = (buf.length - dataOffset) / (channels * 3);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const p = dataOffset + (i * channels + ch) * 3;
      let v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      (ch === 0 ? left : right)[i] = v / 8388608;
    }
  }
  return { rate, channels, bits, frames, left, right };
}

/* ── 1. 初始状态 ─────────────────────────────────────── */
console.log('\n[1] 初始状态');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
check('样例下拉已填充', (await page.$$eval('#sample-select option', (o) => o.length)) >= 6);
check('初始无峰值', (await text('#stat-peak')) === '—');
check('初始 compute 按钮禁用', await disabled('#export-btn'));

/* ── 2. sparse 精确样例 ──────────────────────────────── */
console.log('\n[2] sparse 精确样例');
await loadSample('sparse');
await waitAnalysis(30000);
check('采样率显示 48 kHz', (await text('#stat-rate')) === '48.0 kHz', await text('#stat-rate'));
check('固定长度 5,160 帧', (await text('#stat-length-sub')) === '5,160 帧', await text('#stat-length-sub'));
check('尾长 1,061 帧', (await text('#stat-tail-sub')).startsWith('1,061 帧'), await text('#stat-tail-sub'));
check('峰值 −12.3 dB', (await text('#stat-peak')) === '-12.3 dB', await text('#stat-peak'));
check('无水超限', (await text('#stat-peak-sub')).includes('超限样本 0'));
check('预延迟 37 帧', (await text('#predelay-readout')).startsWith('37'), await text('#predelay-readout'));
check('湿声比例 0.650', (await text('#wet-readout')) === '0.650');
check('公式显示 37 帧偏移', (await page.$eval('#formula', (e) => e.textContent)).includes('t − 37'));
check('路由卡片四条齐备', (await page.$$eval('.matrix-cell', (c) => c.length)) === 4);

const fileName = await exportWav(path.join(tmp, 'sparse.wav'));
check('导出文件名含参数', fileName === 'matrix-room-48kHz-w0.650-pd37.wav', fileName);
const wav = readWav24(path.join(tmp, 'sparse.wav'));
check('导出为 24-bit 双声道 48 kHz', wav.bits === 24 && wav.channels === 2 && wav.rate === 48000);
check('导出 5,160 帧', wav.frames === 5160, String(wav.frames));
check('L[0] = 0.175', Math.abs(wav.left[0] - 0.175) < 1e-6, String(wav.left[0]));
check('L[37] = 0.1625', Math.abs(wav.left[37] - 0.1625) < 1e-6, String(wav.left[37]));
check('R[2085] = 0.24375', Math.abs(wav.right[2085] - 0.24375) < 1e-6, String(wav.right[2085]));
check('末尾尾段 L[5159] = -0.0203125', Math.abs(wav.left[5159] + 0.0203125) < 1e-6, String(wav.left[5159]));
check('导出报告峰值 −12.3 dB', (await text('#rep-peak')) === '-12.3 dB', await text('#rep-peak'));
check('导出报告超限 0', (await text('#rep-over')) === '0');

/* ── 3. clip 超限 ────────────────────────────────────── */
console.log('\n[3] clip 超限样例');
await loadSample('clip');
await waitAnalysis(30000);
check('clip w = 1.000（样例参数生效）', (await text('#wet-readout')) === '1.000');
check('clip 峰值 10.6 dB（3.375）', (await text('#stat-peak')) === '10.6 dB', await text('#stat-peak'));
check('clip 超限 8,198', (await text('#stat-peak-sub')) === '超限样本 8,198', await text('#stat-peak-sub'));
await exportWav(path.join(tmp, 'clip.wav'));
const clipWav = readWav24(path.join(tmp, 'clip.wav'));
let clipPeak = 0;
for (const arr of [clipWav.left, clipWav.right]) for (const v of arr) clipPeak = Math.max(clipPeak, Math.abs(v));
check('导出有限幅样本', (await text('#rep-clamp')) === '8,198', await text('#rep-clamp'));
check('导出后峰值限幅到 ≤ 1', clipPeak <= 1.0000002, String(clipPeak));

/* ── 4. 长任务：进度、可操作、取消 ─────────────────── */
console.log('\n[4] long 长任务');
await loadSample('long');
await page.waitForFunction(
  () => document.querySelector('#status-text').textContent.includes('正在卷积'),
  null,
  { timeout: 30000 },
);
check('显示进度', (await text('#status-text')).includes('正在卷积'), await text('#status-text'));
const during = await text('#stat-length-sub');
check('计算期间长度已更新', during.includes('3,071,999'), during);
await page.fill('#wet-number', '0.2');
await page.dispatchEvent('#wet-number', 'input');
check('计算期间参数可改', (await text('#wet-readout')) === '0.200');
await waitAnalysis(120000);
check('long 输出 3,071,999 帧', (await text('#stat-length-sub')) === '3,071,999 帧', await text('#stat-length-sub'));
check('long 长度 1:04.000', (await text('#stat-length')) === '1:04.000', await text('#stat-length'));

// 取消
await page.fill('#wet-number', '0.3');
await page.dispatchEvent('#wet-number', 'input');
await page.waitForFunction(
  () => /正在卷积/.test(document.querySelector('#status-text').textContent),
  null,
  { timeout: 20000 },
);
await page.click('#cancel-task');
await page.waitForFunction(
  () => document.querySelector('#status-text').textContent === '已取消计算。',
  null,
  { timeout: 5000 },
);
check('取消后显示已取消', (await text('#status-text')) === '已取消计算。', await text('#status-text'));
check('取消后无结果', (await text('#stat-peak')) === '—', await text('#stat-peak'));
check('取消后处理后试听禁用', await disabled('#play-wet'));
check('取消后仍可导出', !(await disabled('#export-btn')));

/* ── 5. 竞态：旧任务不得覆盖新结果 ───────────────────── */
console.log('\n[5] 竞态');
await page.fill('#wet-number', '0.25');
await page.dispatchEvent('#wet-number', 'input');
await page.waitForFunction(
  () => /正在卷积/.test(document.querySelector('#status-text').textContent),
  null,
  { timeout: 20000 },
);
await page.fill('#wet-number', '0.5');
await page.dispatchEvent('#wet-number', 'input');
await waitAnalysis(120000);
check('最终参数为最后输入 0.500', (await text('#wet-readout')) === '0.500');
check('最终峰值来自 0.5（-10.1 dB）', (await text('#stat-peak')) === '-10.1 dB', await text('#stat-peak'));

/* ── 6. 采样率不一致：点名具体文件 ───────────────────── */
console.log('\n[6] 采样率不一致');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const bad = {
  dry: '/tmp/mrc-sample/rate441/dry.wav',
  LL: '/tmp/mrc-sample/rate441/LL.wav',
  LR: '/tmp/mrc-sample/sparse/LR.wav',
  RL: '/tmp/mrc-sample/rate441/RL.wav',
  RR: '/tmp/mrc-sample/rate441/RR.wav',
};
for (const [key, file] of Object.entries(bad)) {
  await page.setInputFiles(`.slot[data-key="${key}"] input[type=file]`, {
    name: path.basename(file),
    mimeType: 'audio/wav',
    buffer: fs.readFileSync(file),
  });
  await page.waitForTimeout(120);
}
await page.waitForTimeout(500);
const alertText = await page.$eval('#alerts', (e) => e.textContent.replace(/\s+/g, ' '));
check('报错点名 LR.wav 为 48,000 Hz', alertText.includes('LR.wav') && alertText.includes('48,000'));
check('报错列出 44,100 Hz 文件', alertText.includes('44,100 Hz'));
check('提示采样率必须一致', alertText.includes('采样率必须一致'));
check('输入不完整时禁用计算', await disabled('#export-btn'));

/* ── 7. 缺干声：补零且保留尾长 ───────────────────────── */
console.log('\n[7] 缺干声');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.selectOption('#sample-select', 'sparse');
await page.evaluate(async () => {
  const manifest = await (await fetch('/api/samples')).json();
  const entry = manifest.find((e) => e.id === 'sparse');
  for (const [k, rel] of Object.entries(entry.files)) {
    if (k === 'dry') continue;
    const buf = await (await fetch('/api/sample?path=' + encodeURIComponent(rel))).arrayBuffer();
    const input = document.querySelector(`.slot[data-key="${k}"] input[type=file]`);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], rel.split('/').pop(), { type: 'audio/wav' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await waitAnalysis(30000);
check('缺干声仍能计算', (await text('#stat-peak')) === '−∞ dB', await text('#stat-peak'));
check('缺干声提示补零', (await page.$eval('#alerts', (e) => e.textContent)).includes('按零输入处理'));
check('缺干声长度 = 最长 IR', waitDoneLen(await text('#stat-length-sub')), await text('#stat-length-sub'));
check('缺干声时处理前试听禁用', await disabled('#play-dry'));

/* ── 8. w = 0 仍保留尾长 ────────────────────────────── */
console.log('\n[8] w = 0');
await loadSample('sparse');
await waitAnalysis(30000);
const lenBefore = await text('#stat-length-sub');
const tailBefore = await text('#stat-tail-sub');
await page.fill('#wet-number', '0');
await page.dispatchEvent('#wet-number', 'input');
await waitAnalysis(60000);
check('w = 0 长度不变', (await text('#stat-length-sub')) === lenBefore);
check('w = 0 尾长不变', (await text('#stat-tail-sub')) === tailBefore);
await exportWav(path.join(tmp, 'w0.wav'));
const w0 = readWav24(path.join(tmp, 'w0.wav'));
check('w = 0 导出仍为固定长度', w0.frames === 5160, String(w0.frames));
check('w = 0 尾段全为 0', w0.left[5159] === 0 && w0.right[5159] === 0);

/* ── 9. 预延迟 200 ms ───────────────────────────────── */
console.log('\n[9] 预延迟 200 ms');
await page.fill('#predelay-frames', '9600');
await page.dispatchEvent('#predelay-frames', 'input');
await waitAnalysis(60000);
check('200 ms = 9,600 帧', (await text('#predelay-readout')).startsWith('9,600'), await text('#predelay-readout'));
check('输出 14,723 帧（4099+1025-1+9600）', (await text('#stat-length-sub')) === '14,723 帧', await text('#stat-length-sub'));
check('帧数越界被钳制到范围', await page.$eval('#predelay-range', (e) => e.max) === '9600');

/* ── 10. 控制台无错误 ───────────────────────────────── */
console.log('\n[10] 浏览器错误');
check('无未捕获错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}

function waitDoneLen(text) {
  return text === '1,024 帧';
}
