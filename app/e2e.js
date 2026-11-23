/* 端到端：真实 Chromium 加载页面，驱动文件载入/编辑/撤销/导出/画布点击 */
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname);
const URL = 'file://' + path.join(ROOT, 'index.html');
const WAV = path.resolve(ROOT, '../samples/cases/guide.wav');
const JSONF = path.resolve(ROOT, '../samples/cases/guide.json');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL);
  await page.setInputFiles('#wavFile', WAV);
  await page.setInputFiles('#jsonFile', JSONF);

  // 状态条：可行解、总分 1690
  await page.waitForSelector('#statePill.pill.ok');
  const score = await page.textContent('#scoreVal');
  const state = await page.textContent('#stateText');
  console.log('state=', state, 'score=', score.trim());
  if (score.trim() !== '1690') throw new Error('期望总分 1690，实际 ' + score);

  // 画布上应有 10 条正拍线（通过拍表行数验证）
  await page.click('#tabBeat');
  const beatRows = await page.locator('#beatTbody tr').count();
  console.log('beat rows=', beatRows);
  if (beatRows !== 10) throw new Error('拍表行数应为 10');

  // 点第 6 拍，详情应显示 swing s=1
  await page.locator('#beatTbody tr').nth(5).click();
  const detail = await page.textContent('#beatDetail');
  if (!detail.includes('s=1')) throw new Error('第 6 拍应为 s=1');
  if (!detail.includes('匹配候选')) throw new Error('详情缺少匹配来源');
  console.log('beat5 detail OK, contains offFrame info');

  // 回到候选表，改第一个候选的正拍权重 100 -> 250，触发重解
  await page.click('#tabOnsets');
  const firstInput = page.locator('#onsetTbody tr').first().locator('input[data-k="on"]');
  const before = await firstInput.inputValue();
  console.log('first weight before=', before);
  await firstInput.fill('250');
  await firstInput.dispatchEvent('change');
  await page.waitForSelector('#statePill.pill.ok');
  const score2 = (await page.textContent('#scoreVal')).trim();
  console.log('score after weight edit=', score2);
  if (score2 === '1690') throw new Error('改权重后总分应变化');

  // 撤销 -> 回到 1690；重做 -> 再变化
  await page.click('#undoBtn');
  const score3 = (await page.textContent('#scoreVal')).trim();
  if (score3 !== '1690') throw new Error('撤销后应恢复 1690，实际 ' + score3);
  await page.click('#redoBtn');
  const score4 = (await page.textContent('#scoreVal')).trim();
  if (score4 === '1690') throw new Error('重做后应回到编辑态分数');
  console.log('undo/redo OK:', score3, '->', score4);

  // 删除中间锚点（拍号 5），应仍可行
  await page.click('#tabAnchors');
  const anchorRows0 = await page.locator('#anchorTbody tr').count();
  await page.locator('#anchorTbody tr', { hasText: '5' }).locator('button').click();
  await page.waitForSelector('#statePill.pill.ok');
  const anchorRows1 = await page.locator('#anchorTbody tr').count();
  if (anchorRows1 !== anchorRows0 - 1) throw new Error('锚点未删除');
  console.log('anchor delete OK, rows', anchorRows0, '->', anchorRows1);
  await page.click('#undoBtn');

  // 无解场景：合法增序的锚点，但拍号 0->1 跨度 240 帧 = 40 个 6帧单位，
  // 超过单拍最大拍长 39 单位（234 帧），DP 必然无解
  await page.fill('#newAnchorBeat', '1');
  await page.fill('#newAnchorFrame', '240');
  await page.click('#addAnchorBtn');
  const pillClass = await page.getAttribute('#statePill', 'class');
  const warnVisible = await page.locator('.warn-banner').count();
  console.log('infeasible pill class=', pillClass, 'warn banner=', warnVisible);
  if (!pillClass.includes('bad') || warnVisible !== 1) throw new Error('应显示无解状态');
  const exportDisabled = await page.isDisabled('#exportJsonBtn');
  if (!exportDisabled) throw new Error('无解时导出必须禁用');
  // 撤销恢复到初始文档（1690）：连续撤销直到按钮禁用或分数归位
  for (let i = 0; i < 8; i++) {
    if (await page.isDisabled('#undoBtn')) break;
    await page.click('#undoBtn');
    await page.waitForTimeout(60);
    if ((await page.textContent('#scoreVal')).trim() === '1690') break;
  }
  await page.waitForFunction(() => document.getElementById('scoreVal').textContent.trim() === '1690');
  console.log('infeasible handling OK');

  // 导出 JSON：拦截下载，校验字段
  const [dlJson] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportJsonBtn')
  ]);
  const jsonPath = await dlJson.path();
  const exported = JSON.parse(require('fs').readFileSync(jsonPath, 'utf8'));
  if (exported.score !== 1690 || exported.beats.length !== 10) throw new Error('导出 JSON 内容错误');
  const keys = ['frame', 'period', 'swing', 'onMatch', 'offMatch', 'onScore', 'offScore', 'penalty'];
  for (const k of keys) if (!(k in exported.beats[0])) throw new Error('导出缺少字段 ' + k);
  if (exported.beats[0].penalty !== 0) throw new Error('首拍 penalty 必须为 0');
  console.log('grid JSON export OK, score', exported.score);

  // 导出 WAV：校验格式与脉冲
  const [dlWav] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportWavBtn')
  ]);
  const wavPath = await dlWav.path();
  const buf = require('fs').readFileSync(wavPath);
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('导出不是 WAV');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  if (dv.getUint32(24, true) !== 48000) throw new Error('采样率不是 48000');
  if (dv.getUint16(22, true) !== 1 || dv.getUint16(34, true) !== 16) throw new Error('非单声道16bit');
  const dataSize = dv.getUint32(40, true);
  if (44 + dataSize !== buf.length) throw new Error('WAV 长度不匹配');
  const s16 = new Int16Array(buf.buffer, buf.byteOffset + 44, dataSize / 2);
  let on = 0, off = 0;
  for (let i = 0; i < s16.length; i++) {
    if (s16[i] === 12000) on++;
    else if (s16[i] === 6000) off++;
    else if (s16[i] !== 0) throw new Error('存在非规范脉冲值 ' + s16[i]);
  }
  if (on !== 10 || off !== 10) throw new Error('脉冲数量错误 on=' + on + ' off=' + off);
  console.log('click WAV export OK, pulses on/off =', on, off);

  // 试听：点击播放，确认进入播放态后暂停
  await page.click('#playBtn');
  await page.waitForTimeout(300);
  const playLabel = await page.textContent('#playBtn');
  if (!playLabel.includes('暂停')) throw new Error('播放未启动');
  await page.click('#playBtn');
  console.log('playback start/stop OK');

  if (errors.length) throw new Error('页面错误: ' + errors.join(' | '));
  await browser.close();
  console.log('E2E ALL PASSED');
})().catch(e => { console.error('E2E FAILED:', e.message); process.exit(1); });
