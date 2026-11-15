/*
 * 浏览器端到端测试（零依赖，使用已安装的 Playwright + Chromium）。
 *
 * 用法：
 *   python3 -I src/py/server.py --port 8899 &
 *   node tests/e2e_check.mjs http://127.0.0.1:8899
 *
 * 覆盖：样例载入、旋转与参考逐样点核对、静态角、关键帧编辑与拒绝路径、
 *       溢出阻止导出、试听播放、方向示意、导出字节、格式 JSON、采样率/帧数保持。
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
  try {
    const { execSync } = await import('node:child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(`${globalRoot}/playwright/index.mjs`);
  } catch (err) {
    lastErr = err;
  }
  throw new Error(`需要 Playwright（npm i -g playwright 或设置 PLAYWRIGHT_PATH）：${lastErr?.message || ''}`);
}

const { chromium } = await loadPlaywright();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aob-e2e-'));
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

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

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const disabled = (sel) => page.$eval(sel, (e) => e.disabled);

async function loadSample(id, timeout = 30000) {
  await page.selectOption('#sample-select', id);
  await page.click('#load-sample');
  await page.waitForFunction(
    (want) => document.querySelector('#status-text').textContent.includes(want),
    '已载入样例',
    { timeout },
  );
  await page.waitForFunction(
    () => !document.querySelector('#status-strip').classList.contains('busy'),
    null,
    { timeout },
  );
  await page.waitForTimeout(250);
}

async function waitRendered(timeout = 30000) {
  await page.waitForTimeout(200);
  await page.waitForFunction(
    () => !document.querySelector('#status-strip').classList.contains('busy'),
    null,
    { timeout },
  );
  await page.waitForTimeout(150);
}

async function setAngle(which, value) {
  await page.fill(`#${which}`, String(value));
  await page.dispatchEvent(`#${which}`, 'input');
  await waitRendered();
}

async function exportDownload(button, ext) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click(button),
  ]);
  const name = download.suggestedFilename();
  const target = path.join(tmp, name);
  await download.saveAs(target);
  return { name, target, buffer: fs.readFileSync(target) };
}

/** 读取 24-bit 四声道 WAV 的头部与指定帧的整数样点。 */
function readWav24(buffer) {
  const rate = buffer.readUInt32LE(24);
  const channels = buffer.readUInt16LE(22);
  const bits = buffer.readUInt16LE(34);
  const format = buffer.readUInt16LE(20);
  const frames = (buffer.length - 44) / (channels * 3);
  function sample(frame, ch) {
    const p = 44 + (frame * channels + ch) * 3;
    let v = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v;
  }
  return { rate, channels, bits, format, frames, sample };
}

/* ── 1. 初始状态 ─────────────────────────────────────── */
console.log('\n[1] 初始状态');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
check('样例下拉已填充', (await page.$$eval('#sample-select option', (o) => o.length)) >= 6);
check('初始状态提示', (await text('#status-text')).includes('等待导入音频'));
check('初始导出禁用', await disabled('#export-wav'));
check('初始 JSON 导出禁用', await disabled('#export-json'));
check('初始播放禁用', await disabled('#play-btn'));
check('静态模式默认激活', (await text('#mode-static')).includes('静态欧拉角'));
check('输入格式默认 AmbiX', await page.$eval('#in-ambix', (e) => e.checked));
check('输出格式默认 AmbiX', await page.$eval('#out-ambix', (e) => e.checked));

/* ── 2. 参考自动旋转 ─────────────────────────────────── */
console.log('\n[2] 参考自动旋转（关键帧）');
await loadSample('reference');
check('自动切到关键帧模式', await page.$eval('#mode-automation', (e) => e.classList.contains('active')));
check('6 个关键帧', (await text('#kf-count')) === '6 个关键帧', await text('#kf-count'));
check('参考核对通过', (await text('#reference-result')).includes('与参考文件一致'),
  await text('#reference-result'));
const refDiff = await text('#reference-result');
check('参考最大差 0', /最大逐样点差 0 个/.test(refDiff), refDiff);
check('帧数保持 288,000', (await text('#stat-frames')).includes('288,000'), await text('#stat-frames'));
check('峰值 0.120000', (await text('#stat-peak')) === '0.120000', await text('#stat-peak'));
check('无溢出', (await text('#stat-overflow')) === '0');
check('导出可用', !(await disabled('#export-wav')));
check('已识别最短弧翻转（≥3 条警告）',
  (await text('#kf-status')).includes('点积'),
  await text('#kf-status'));

/* ── 3. 播放与拖动 ──────────────────────────────────── */
console.log('\n[3] 试听与拖动');
await page.click('#play-btn');
await page.waitForTimeout(900);
const playingFrame = await page.evaluate(() => window.__bench.player.currentFrame());
check('播放推进播放头', playingFrame > 0, String(playingFrame));
await page.click('#play-btn');
await page.waitForTimeout(150);
check('暂停后不再推进', await page.evaluate(() => !window.__bench.player.playing));

// 拖动时间轴到中间
const box = await page.$eval('#timeline', (e) => {
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
await page.waitForTimeout(300);
const midFrame = await page.evaluate(() => Math.round(window.__bench.state.playhead));
check('点击时间轴定位到中段', midFrame > 100000 && midFrame < 190000, String(midFrame));
const frameNow = await text('#frame-now');
check('帧号读数更新', frameNow.includes('frame'), frameNow);
const q = await text('#dir-quat');
check('方向示意四元数已变化', q !== '[1.0000, 0.0000, 0.0000, 0.0000]', q);
const azel = await text('#dir-azel');
check('朝向读数存在', /az .*° \/ el .*°/.test(azel), azel);

// 关键帧模式下拖动后方向示意应对应曲线（第 96000 帧对齐为 180°）
await page.evaluate(() => {
  const s = document.querySelector('#scrub');
  s.value = '96000';
  s.dispatchEvent(new Event('input'));
  s.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(250);
const q180 = await text('#dir-quat');
check('关键帧 96000 处四元数为 [0,0,0,±1]', /\|\s*1\.0000\]$|, 0\.0000, 0\.0000, -?1\.0000\]/.test(q180), q180);

/* ── 4. 导出 WAV 与参考一致 ──────────────────────────── */
console.log('\n[4] 导出 24-bit WAV');
const exp = await exportDownload('#export-wav', 'wav');
const wav = readWav24(exp.buffer);
check('导出文件名含参数', /kf6/.test(exp.name), exp.name);
check('导出 4 声道 PCM', wav.channels === 4 && wav.format === 1);
check('导出 24-bit', wav.bits === 24);
check('导出采样率保持 48 kHz', wav.rate === 48000, String(wav.rate));
check('导出帧数保持 288,000', wav.frames === 288000, String(wav.frames));
check('W 通道与输入一致（frame 1000）', wav.sample(1000, 0) === 871770, String(wav.sample(1000, 0)));

// 与参考文件逐样点比较（抽样 + 全量头部）
const refBuf = fs.readFileSync(path.join(
  process.env.SAMPLES_DIR || path.join(process.cwd(), 'samples', 'extracted'),
  'reference-automated-48000-24.wav',
));
const refWav = readWav24(refBuf);
let worst = 0;
const stride = 37;
for (let f = 0; f < wav.frames; f += stride) {
  for (let c = 0; c < 4; c++) {
    worst = Math.max(worst, Math.abs(wav.sample(f, c) - refWav.sample(f, c)));
  }
}
check('导出字节与参考文件一致（抽样 ≤4）', worst <= 4, `最大差 ${worst}`);

// 预览（监听立体声）与导出文件同源：用监听矩阵解码导出文件，应与预览逐样点一致
const monitorRows = await page.evaluate(() => window.__bench.state.monitorRows);
const previewSample = await page.evaluate(() => {
  const st = window.__bench.state.rendered.stereo;
  const out = [];
  for (const f of [0, 1000, 24000, 48000, 120000, 240000]) {
    out.push([f, st.left[f], st.right[f]]);
  }
  return out;
});
let previewWorst = 0;
for (const [f, pl, pr] of previewSample) {
  const order = [0, 1, 2, 3]; // W Y Z X
  const vals = order.map((c) => wav.sample(f, c) / 8388608);
  const l = monitorRows[0].reduce((acc, g, i) => acc + g * vals[i], 0);
  const r = monitorRows[1].reduce((acc, g, i) => acc + g * vals[i], 0);
  previewWorst = Math.max(previewWorst, Math.abs(l - pl), Math.abs(r - pr));
}
check('预览立体声与导出文件逐样点同源（≤1 LSB）', previewWorst <= 1.5 / 8388608 * 4,
  `最大差 ${previewWorst}`);

/* ── 5. 静态角 ──────────────────────────────────────── */
console.log('\n[5] 静态欧拉角');
await page.click('#mode-static');
await waitRendered();
await setAngle('yaw', 90);
check('yaw=90 时峰值仍在 W', (await text('#stat-peak-sub')).includes('W'), await text('#stat-peak-sub'));
const eq = await text('#euler-quat');
check('静态四元数显示 Rz(90°)', eq.includes('0.707107'), eq);

// yaw=90 时 X 通道内容应转到 Y（前向脉冲 → 左）
await page.evaluate(() => {
  const s = document.querySelector('#scrub');
  s.value = '1000';
  s.dispatchEvent(new Event('input'));
  s.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(250);
const values = await text('#frame-values');
check('yaw=90 时 X 内容出现在 Y', /Y -?\d/.test(values), values);

await page.click('#reset-angles');
await waitRendered();
check('归零后四元数为 [1,0,0,0]', (await text('#euler-quat')).includes('[1.000000, 0.000000, 0.000000, 0.000000]'));

/* ── 6. 溢出样例 ────────────────────────────────────── */
console.log('\n[6] 溢出阻止导出');
await loadSample('overload');
check('yaw 预置 45°', (await page.$eval('#yaw', (e) => e.value)) === '45');
check('峰值 1.131371', (await text('#stat-peak')) === '1.131371', await text('#stat-peak'));
check('溢出 24,000', (await text('#stat-overflow')) === '24,000', await text('#stat-overflow'));
check('首个溢出在 frame 0 的 Y', (await text('#stat-overflow-sub')).includes('frame 0 · Y'),
  await text('#stat-overflow-sub'));
check('PCM 导出禁用', await disabled('#export-wav'));
check('溢出提示出现', (await text('#overflow-msg')).includes('已阻止 PCM 导出'),
  await text('#overflow-msg'));
check('格式 JSON 仍可导出', !(await disabled('#export-json')));

// 点击被禁用的导出不应产生下载
let downloaded = false;
const onDownload = () => { downloaded = true; };
page.on('download', onDownload);
await page.evaluate(() => document.querySelector('#export-wav').click());
await page.waitForTimeout(400);
page.off('download', onDownload);
check('溢出时点击导出无下载', !downloaded);

await setAngle('yaw', 0);
check('yaw=0 溢出归零', (await text('#stat-overflow')) === '0');
check('yaw=0 峰值 0.800000', (await text('#stat-peak')) === '0.800000', await text('#stat-peak'));
check('yaw=0 导出恢复可用', !(await disabled('#export-wav')));
check('溢出提示已消失', (await text('#overflow-msg')) === '');

/* ── 7. 关键帧编辑与拒绝 ────────────────────────────── */
console.log('\n[7] 关键帧编辑');
await loadSample('ambix48');
await page.click('#mode-automation');
await waitRendered();
check('切换到关键帧模式', await page.$eval('#mode-automation', (e) => e.classList.contains('active')));
check('空曲线提示', !(await page.$eval('#kf-empty', (e) => e.hidden)));

await page.evaluate(() => {
  const s = document.querySelector('#scrub');
  s.value = '48000';
  s.dispatchEvent(new Event('input'));
  s.dispatchEvent(new Event('change'));
});
await page.click('#kf-add');
await waitRendered();
check('添加 1 个关键帧', (await text('#kf-count')) === '1 个关键帧');
let rows = await page.$$eval('#kf-body tr', (rs) => rs.map((r) => [...r.querySelectorAll('input')].map((i) => i.value)));
check('关键帧帧号为 48000', rows[0][0] === '48000', JSON.stringify(rows));
check('首个关键帧取静态角（四元数单位）', rows[0][1] === '1', JSON.stringify(rows[0]));

await page.evaluate(() => {
  const s = document.querySelector('#scrub');
  s.value = '0';
  s.dispatchEvent(new Event('input'));
  s.dispatchEvent(new Event('change'));
});
await page.click('#kf-add');
await waitRendered();
rows = await page.$$eval('#kf-body tr', (rs) => rs.map((r) => [...r.querySelectorAll('input')].map((i) => i.value)));
check('第二帧按帧号排序在前', rows[0][0] === '0' && rows[1][0] === '48000', JSON.stringify(rows));
check('时间轴显示两个关键帧标记', await page.evaluate(() => {
  const s = window.__bench.state;
  return s.keyframes.filter((k) => Number.isInteger(k.frame)).length === 2;
}));

// 重复帧
await page.evaluate(() => {
  const input = document.querySelectorAll('#kf-body input.frame')[1];
  input.value = '0';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitRendered();
check('重复帧被拒绝', (await text('#kf-status')).includes('重复'), await text('#kf-status'));
check('重复帧时导出禁用', await disabled('#export-wav'));

// 恢复
await page.evaluate(() => {
  const input = document.querySelectorAll('#kf-body input.frame')[1];
  input.value = '48000';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitRendered();
check('恢复后错误消失', (await text('#kf-status')) === '', await text('#kf-status'));

// 零四元数
await page.evaluate(() => {
  const row = document.querySelectorAll('#kf-body tr')[1];
  row.querySelectorAll('input.q').forEach((el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
await waitRendered();
check('零四元数被拒绝', (await text('#kf-status')).includes('零四元数'), await text('#kf-status'));

// 越界帧
await page.evaluate(() => {
  const row = document.querySelectorAll('#kf-body tr')[1];
  const qs = row.querySelectorAll('input.q');
  const vals = ['0.7071068', '0', '0', '0.7071068'];
  qs.forEach((el, i) => { el.value = vals[i]; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const f = row.querySelector('input.frame');
  f.value = '999999';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitRendered();
const outOfRange = await text('#kf-status');
check('超出音频范围的帧被拒绝', outOfRange.includes('超出'), outOfRange);
check('越界时导出禁用', await disabled('#export-wav'));

// 删除
await page.evaluate(() => {
  const f = document.querySelectorAll('#kf-body tr')[1].querySelector('input.frame');
  f.value = '48000';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitRendered();
await page.evaluate(() => document.querySelector('[data-kf-delete="1"]').click());
await waitRendered();
check('删除后剩 1 个关键帧', (await text('#kf-count')) === '1 个关键帧');

/* ── 8. 导入 / 导出关键帧 JSON ──────────────────────── */
console.log('\n[8] 关键帧 JSON 导入导出');
const jsonExp = await exportDownload('#kf-export', 'json');
const kfDoc = JSON.parse(fs.readFileSync(jsonExp.target, 'utf8'));
check('导出的 JSON 有 keyframes', Array.isArray(kfDoc.keyframes) && kfDoc.keyframes.length === 1);
check('关键帧含 frame 与 q', typeof kfDoc.keyframes[0].frame === 'number'
  && kfDoc.keyframes[0].q.length === 4);

// 用包里的 automation.json 导入
await page.setInputFiles('#kf-import', path.join(
  process.env.SAMPLES_DIR || path.join(process.cwd(), 'samples', 'extracted'),
  'automation.json',
));
await waitRendered();
check('导入 automation.json：6 个关键帧', (await text('#kf-count')) === '6 个关键帧',
  await text('#kf-count'));

// 导入零四元数文件必须被拒绝
await page.setInputFiles('#kf-import', path.join(
  process.env.SAMPLES_DIR || path.join(process.cwd(), 'samples', 'extracted'),
  'invalid-zero.json',
));
await page.waitForTimeout(400);
check('导入零四元数 JSON 被拒绝', (await text('#kf-status')).includes('零四元数'),
  await text('#kf-status'));

await page.setInputFiles('#kf-import', path.join(
  process.env.SAMPLES_DIR || path.join(process.cwd(), 'samples', 'extracted'),
  'invalid-duplicate.json',
));
await page.waitForTimeout(400);
check('导入重复帧 JSON 被拒绝', (await text('#kf-status')).includes('重复'),
  await text('#kf-status'));

/* ── 9. 格式切换 ────────────────────────────────────── */
console.log('\n[9] 输入/输出格式');
await loadSample('fuma48');
check('FuMa 样例自动选择 FuMa 输入', await page.$eval('#in-fuma', (e) => e.checked));
check('FuMa 样例峰值 0.120000', (await text('#stat-peak')) === '0.120000', await text('#stat-peak'));
const fumaExp = await exportDownload('#export-wav', 'wav');
const fumaWav = readWav24(fumaExp.buffer);
// FuMa 输入 + AmbiX 输出：样例 FuMa 的 W 在 frame 1000 为 616434，
// 转到 AmbiX 应乘 √2 ≈ 871770。
check('FuMa→AmbiX：W 被乘 √2', Math.abs(fumaWav.sample(1000, 0) - 871770) <= 4,
  String(fumaWav.sample(1000, 0)));

await page.click('label.format-card:has(#out-fuma)');
await waitRendered();
const fumaOut = await exportDownload('#export-wav', 'wav');
const foWav = readWav24(fumaOut.buffer);
check('FuMa 输出通道序 W X Y Z', Math.abs(foWav.sample(1000, 1)) > 0, 'X 通道非空');
check('FuMa 输出的 W 回到较低电平', Math.abs(foWav.sample(1000, 0)) < Math.abs(fumaWav.sample(1000, 0)),
  `${foWav.sample(1000, 0)} vs ${fumaWav.sample(1000, 0)}`);

/* ── 10. 格式 JSON 导出 ─────────────────────────────── */
console.log('\n[10] 格式 JSON');
const fmtExp = await exportDownload('#export-json', 'json');
const fmtDoc = JSON.parse(fs.readFileSync(fmtExp.target, 'utf8'));
check('格式 JSON 含 conventions', fmtDoc.conventions && fmtDoc.conventions.channelOrder.join(' ') === 'W X Y Z',
  JSON.stringify(fmtDoc.conventions?.channelOrder));
check('格式 JSON 含输入参数', fmtDoc.input.sampleRate === 48000 && fmtDoc.input.frames === 288000);
check('格式 JSON 含输出参数', fmtDoc.output.bitsPerSample === 24 && fmtDoc.output.channels === 4);
check('格式 JSON 标注不做归一化', String(fmtDoc.note).includes('不做响度归一化'));
check('格式 JSON 含旋转曲线描述', fmtDoc.rotationCurve && fmtDoc.rotationCurve.kind === 'constant');

/* ── 11. 41.1k 样例 ─────────────────────────────────── */
console.log('\n[11] 44.1 kHz 路径');
await loadSample('ambix44');
check('采样率显示 44.1 kHz', (await text('#stat-rate')).includes('44.1 kHz'), await text('#stat-rate'));
check('帧数 264,600', (await text('#stat-frames')).includes('264,600'));
const e44 = await exportDownload('#export-wav', 'wav');
const w44 = readWav24(e44.buffer);
check('导出保持 44.1 kHz', w44.rate === 44100, String(w44.rate));
check('导出保持 264,600 帧', w44.frames === 264600, String(w44.frames));
check('44.1k 导出位深 24', w44.bits === 24);

/* ── 12. 无效输入 ───────────────────────────────────── */
console.log('\n[12] 无效输入');
// 造一个双声道 16-bit WAV，应当被拒绝且清空导出状态
const badWav = (() => {
  const channels = 2, rate = 48000, bits = 16, frames = 8;
  const align = channels * 2;
  const buf = Buffer.alloc(44 + frames * align);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * align, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * align, 28); buf.writeUInt16LE(align, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * align, 40);
  return buf;
})();
const badPath = path.join(tmp, 'stereo.wav');
fs.writeFileSync(badPath, badWav);
await page.setInputFiles('#file-input', badPath);
await page.waitForTimeout(600);
check('双声道文件被拒绝', (await text('#status-text')).includes('无法读取'), await text('#status-text'));
check('拒绝后导出保持禁用', await disabled('#export-wav'));
check('拒绝后回到拖放区', !(await page.$eval('#dropzone', (e) => e.hidden)));
check('拒绝后播放禁用', await disabled('#play-btn'));

// 拒绝后改角度不应重新启用导出
await page.evaluate(() => {
  const s = document.querySelector('#yaw');
  s.value = '30';
  s.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(600);
check('拒绝后改角度仍不可导出', await disabled('#export-wav'));

/* ── 13. conventions.json 异常时的回退 ──────────────── */
console.log('\n[13] conventions.json 回退');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx.newPage();
  const p2errors = [];
  p2.on('pageerror', (e) => p2errors.push(e.message));
  // 拦截 API，返回异常形状的监听矩阵与不同通道序
  await p2.route('**/api/conventions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      formats: {
        ambix: { order: ['W', 'X', 'Y', 'Z'] },
        fuma: { order: ['W', 'Y', 'Z', 'X'] },
      },
      monitor_rows_wyzx: [[1, 2, 3], 'bad'],
    }),
  }));
  await p2.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  const warn = (await p2.$eval('#conventions-mismatch', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('页面报告 conventions 不一致', warn.includes('不一致'), warn);
  check('回退时仍显示内置 AmbiX 通道序', warn.includes('W Y Z X'), warn);
  check('回退时监听到内置矩阵', warn.includes('monitor_rows_wyzx'), warn);

  // 即使 conventions 异常，页面仍能载入样例并渲染
  await p2.selectOption('#sample-select', 'ambix48');
  await p2.click('#load-sample');
  await p2.waitForFunction(
    () => document.querySelector('#status-text').textContent.includes('已载入样例'),
    null,
    { timeout: 30000 },
  );
  await p2.waitForTimeout(1200);
  check('回退后仍能渲染', (await p2.$eval('#stat-peak', (e) => e.textContent.trim())) === '0.120000');
  check('回退后无页面错误', p2errors.length === 0, p2errors.join(' | '));
  await ctx.close();
}

/* ── 14. 无控制台错误 ───────────────────────────────── */
console.log('\n[14] 控制台');
const realErrors = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
check('无页面错误', realErrors.length === 0, realErrors.join(' | ').slice(0, 400));

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) {
  process.exitCode = 1;
}
