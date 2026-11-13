/* e2e.js — 端到端冒烟测试（Playwright + 无头 Chromium）。
 * 用法: NODE_PATH=$(npm root -g) node test/e2e.js <fixtures目录>
 * 覆盖：导入、自动分析、证据不足提示、手动锚点、旧任务不覆盖编辑、
 *       导出 WAV 格式、项目保存/重开关联恢复。 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const FIX = process.argv[2];
if (!FIX) { console.error('用法: node test/e2e.js <fixtures目录>'); process.exit(1); }
const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 800));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  page.on('pageerror', e => { console.log('页面错误:', e.message); failures++; });
  await page.goto(BASE);

  const fx = (n) => path.join(FIX, n);

  // 1. 导入参考
  await page.setInputFiles('#fileRef', fx('reference.wav'));
  await page.waitForFunction(() => document.getElementById('refInfo').textContent.includes('reference.wav'));
  check('导入参考', true);

  // 2. 导入四条待校准轨并等待全部分析结束
  await page.setInputFiles('#fileTracks', [
    fx('recorder-early.wav'), fx('recorder-late.wav'),
    fx('short-overlap.wav'), fx('unrelated.wav'),
  ]);
  await page.waitForFunction(() => {
    const badges = [...document.querySelectorAll('.track-item .badge')];
    return badges.length === 4 && badges.every(b => !b.classList.contains('analyzing'));
  }, null, { timeout: 30000 });

  const statusOf = async (name) => page.evaluate((n) => {
    const item = [...document.querySelectorAll('.track-item')]
      .find(li => li.querySelector('.name').textContent === n);
    return item ? item.querySelector('.badge').textContent : null;
  }, name);
  const mapOf = async (name) => page.evaluate((n) => {
    const item = [...document.querySelectorAll('.track-item')]
      .find(li => li.querySelector('.name').textContent === n);
    return item ? item.querySelector('.row .meta').textContent : null;
  }, name);

  check('recorder-early 已校准', (await statusOf('recorder-early.wav')) === '已校准');
  check('recorder-late 已校准', (await statusOf('recorder-late.wav')) === '已校准');
  check('short-overlap 证据不足', (await statusOf('short-overlap.wav')) === '证据不足');
  check('unrelated 证据不足', (await statusOf('unrelated.wav')) === '证据不足');

  const mEarly = await mapOf('recorder-early.wav');
  const mLate = await mapOf('recorder-late.wav');
  const ppmOf = (s) => parseFloat(s.match(/([+-]?\d+\.\d+)ppm/)[1]);
  const bOf = (s) => parseFloat(s.match(/b=([+-]?\d+\.\d+)s/)[1]);
  check('early ppm≈906', Math.abs(ppmOf(mEarly) - 906.06) < 5, mEarly);
  check('early b≈-2.916', Math.abs(bOf(mEarly) + 2.916) < 0.01, mEarly);
  check('late ppm≈-1001', Math.abs(ppmOf(mLate) + 1001.43) < 5, mLate);
  check('late b≈3.271', Math.abs(bOf(mLate) - 3.271) < 0.01, mLate);

  // 3. 选中 early，检查详情与映射显示
  await page.click(`.track-item:has-text("recorder-early.wav")`);
  await page.waitForFunction(() => document.getElementById('mapInfo').textContent.includes('t_ref'));
  const mapInfo = await page.textContent('#mapInfo');
  check('详情显示映射公式与ppm', mapInfo.includes('ppm') && mapInfo.includes('b ='), mapInfo.trim());
  check('预听按钮可用', !(await page.isDisabled('#btnPlay')));
  check('导出按钮可用', !(await page.isDisabled('#btnExport')));

  // 4. 旧任务不得覆盖后续编辑：重新分析后立即改手动锚点
  await page.click('#btnReanalyze');
  await page.fill('#maT1', '5'); await page.fill('#maR1', '2.5');
  await page.fill('#maT2', '60'); await page.fill('#maR2', '57.5');
  await page.click('#btnApplyManual');
  await page.waitForTimeout(2000); // 等旧分析任务返回（应被世代号丢弃）
  check('手动锚点生效且不被旧任务覆盖', (await statusOf('recorder-early.wav')) === '手动锚点');
  const mManual = await mapOf('recorder-early.wav');
  check('手动映射 b=-2.5, a=1', Math.abs(bOf(mManual) + 2.5) < 1e-6 && Math.abs(ppmOf(mManual)) < 1, mManual);

  // 5. 导出 WAV（48k/16bit/双声道）
  await page.fill('#exStart', '1');
  await page.fill('#exEnd', '11');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExport'),
  ]);
  const dlPath = path.join(os.tmpdir(), 'e2e-export.wav');
  await download.saveAs(dlPath);
  const dv = new DataView(fs.readFileSync(dlPath).buffer);
  check('导出为 48kHz', dv.getUint32(24, true) === 48000);
  check('导出为双声道', dv.getUint16(22, true) === 2);
  check('导出为 16 位', dv.getUint16(34, true) === 16);
  const frames = (dv.getUint32(40, true)) / 4;
  check('导出时长≈10s', Math.abs(frames / 48000 - 10) < 0.01, `${(frames / 48000).toFixed(3)}s`);

  // 6. 保存项目（不含音频）→ 重开 → 关联原文件恢复
  const [dlProj] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnSaveProj'),
  ]);
  const projPath = path.join(os.tmpdir(), 'e2e-project.json');
  await dlProj.saveAs(projPath);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  check('项目JSON不含音频数据', !JSON.stringify(proj).includes('mono') && proj.reference.name === 'reference.wav');
  check('项目保存了已校准轨', proj.tracks.length === 2, proj.tracks.map(t => t.name).join(','));

  await page.reload();
  await page.setInputFiles('#fileProj', projPath);
  await page.waitForFunction(() => !document.getElementById('banner').hidden);
  const banner1 = await page.textContent('#banner');
  check('打开项目后提示重新关联文件', banner1.includes('reference.wav') && banner1.includes('recorder-late.wav'));

  await page.setInputFiles('#fileRef', fx('reference.wav'));
  await page.setInputFiles('#fileTracks', [fx('recorder-late.wav')]);
  await page.waitForFunction(() => {
    const item = [...document.querySelectorAll('.track-item')]
      .find(li => li.querySelector('.name').textContent === 'recorder-late.wav');
    return item && !item.querySelector('.badge').classList.contains('analyzing');
  });
  check('重开后恢复已保存映射（无需重新分析）', (await statusOf('recorder-late.wav')) === '已校准');
  const mLate2 = await mapOf('recorder-late.wav');
  check('恢复的映射与保存一致', Math.abs(ppmOf(mLate2) - ppmOf(mLate)) < 0.01, mLate2);

  // 7. 同名不同内容提示：把 unrelated.wav 改名成 recorder-early.wav 导入
  const fakePath = path.join(os.tmpdir(), 'recorder-early.wav');
  fs.copyFileSync(fx('unrelated.wav'), fakePath);
  dialogs.length = 0;
  await page.setInputFiles('#fileTracks', [fakePath]);
  await page.waitForTimeout(800);
  check('同名不同内容弹出提示', dialogs.some(m => m.includes('同名文件内容不同')), dialogs[0] || '(无提示)');

  await browser.close();
  server.kill();
  console.log(failures === 0 ? '\nE2E 全部通过 ✓' : `\nE2E 存在 ${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
