/* 浏览器端到端测试（Playwright）。运行：NODE_PATH=<全局 node_modules> node test/browser-e2e.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));

const b64 = (u8) => Buffer.from(u8).toString('base64');
const crcHex = (u8) => E.crc32(u8).toString(16).padStart(8, '0');
const blockRec = (id, u8) => ({ id, data: b64(u8), crc: crcHex(u8) });
const checkRec = (id, members, u8) => ({ id, members, data: b64(u8), crc: crcHex(u8) });
const xorBytes = (arrs) => { const o = new Uint8Array(512); for (const a of arrs) for (let i = 0; i < 512; i++) o[i] ^= a[i]; return o; };
function randBlock(seed) {
  const u = new Uint8Array(512); let s = seed * 2654435761 + 12345;
  for (let i = 0; i < 512; i++) { s = (s * 1103515245 + 12345) >>> 0; u[i] = s & 255; }
  return u;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-e2e-'));
function writeJson(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
// 样本只以 zip 入库：解压到隔离临时目录
require('child_process').execFileSync('unzip',
  ['-o', '-q', path.join(ROOT, 'samples', 'stem-parity.zip'), '-d', tmp]);
const samplePath = path.join(tmp, 'rehearsal.json');

function startServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const fp = path.normalize(path.join(ROOT, url));
      if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  const srv = await startServer();
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);

  /* ---- 构造矛盾场景归档 ---- */
  const g = [0, 1, 2, 3].map((i) => randBlock(70 + i));
  const tampered = (() => { const t = xorBytes([g[0], g[1]]); t[5] ^= 0x33; return t; })();
  const arc = {
    tracks: ['左', '右'], blocksPerTrack: 2,
    blocks: [blockRec(2, g[2]), blockRec(3, g[3])], // 块0/1 缺失
    checks: [
      checkRec(10, [0, 1], xorBytes([g[0], g[1]])),
      checkRec(11, [0, 1], tampered),               // 与行10冲突 => 矛盾组
      checkRec(12, [2], (() => { const t = g[2].slice(); t[1] ^= 1; return t; })()), // 纯已知矛盾
    ],
  };
  const arcPath = writeJson('conflict.json', arc);
  await page.setInputFiles('#fileInput', arcPath);
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForTimeout(500); // 等防抖求解发布

  console.log('E1 矛盾归档导入与渲染');
  const stats = await page.$$eval('#stats .stat', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('统计含 2 已知 / 2 矛盾', stats.some((s) => s.includes('2') && s.includes('有效原音块'))
    && stats.some((s) => s.includes('2') && s.includes('矛盾块')), stats.join(' | '));
  const pure = await page.textContent('#pureContradictions');
  check('纯已知矛盾定位到行 12', pure.includes('12'), pure);
  const cg = await page.textContent('#contradictionGroups');
  check('封锁组含校验组合 10/11', cg.includes('10') && cg.includes('11'), cg);
  check('块 0/1 显示矛盾色', await page.locator('.cell.contradiction').count() === 2);
  // 已知块仍保留可查看
  await page.locator('.cell.known').first().click();
  const detail = await page.textContent('#blockDetail');
  check('已知块详情含状态与数据', detail.includes('有效原音块') && detail.includes('512 字节'));

  console.log('E2 停用/恢复校验行（连改防抖只发最后一版）');
  // 快速连改：停用 10、停用 11、恢复 10 —— 最终只停用 11
  await page.fill('#checkSearch', '1');
  async function toggleRow(id) {
    await page.locator(`tr[data-id="${id}"] .toggle-btn`).click();
  }
  await toggleRow(10);
  await toggleRow(11);
  await toggleRow(10);
  await page.waitForTimeout(600);
  const offRows = await page.$$eval('tr.off', (els) => els.map((e) => e.dataset.id));
  check('最终只有行 11 处于停用', offRows.length === 1 && offRows[0] === '11', JSON.stringify(offRows));
  // 停用 11 后矛盾消除：行 10 单独可恢复块 0/1? 行10: x0+x1 只有 1 秩 2 未知 => 两个都未定
  const undeterminedCells = await page.locator('.cell.undetermined').count();
  check('矛盾解除后块 0/1 变未定（秩不足）', undeterminedCells === 2, `count=${undeterminedCells}`);
  // 全部恢复
  await page.click('#enableAll');
  await page.waitForTimeout(600);
  check('恢复后重新出现 2 个矛盾块', await page.locator('.cell.contradiction').count() === 2);

  console.log('E3 结构错误导入保留上一份结果');
  const badPath = writeJson('bad.json', { tracks: [], blocksPerTrack: 0, blocks: 'x', checks: [] });
  await page.setInputFiles('#fileInput', badPath);
  await page.waitForTimeout(200);
  const errBanner = await page.textContent('#importError');
  check('显示结构错误横幅', errBanner.includes('结构错误'));
  check('上一份结果仍在（矛盾块仍是 2 个）', await page.locator('.cell.contradiction').count() === 2);
  const badJsonPath = path.join(tmp, 'notjson.json');
  fs.writeFileSync(badJsonPath, '{这不是合法JSON');
  await page.setInputFiles('#fileInput', badJsonPath);
  await page.waitForTimeout(200);
  check('JSON 解析失败也保留上一份结果', (await page.textContent('#importError')).includes('JSON 解析失败')
    && await page.locator('.cell.contradiction').count() === 2);

  console.log('E4 样本归档：恢复组合与重验按钮');
  await page.setInputFiles('#fileInput', samplePath);
  await page.waitForTimeout(500);
  // 块 2 是恢复块（全局 id=2）
  const cells = page.locator('.cell');
  await cells.nth(2).click();
  const d2 = await page.textContent('#blockDetail');
  check('块 2 标记为已恢复且组合含行 10', d2.includes('已恢复') && d2.includes('10'), d2.slice(0, 120));
  await page.click('#verifyComboBtn');
  const vr = await page.textContent('#verifyComboResult');
  check('组合重验通过', vr.includes('重验通过'), vr);

  console.log('E5 试听缓冲与 WAV 导出（逐样本同源 + 静音确认门控）');
  await page.fill('#rangeStart', '0');
  await page.fill('#rangeEnd', '512'); // 块0、块1 各 256；块2 为恢复块，块0/1 已知
  await page.click('#buildRange');
  await page.waitForTimeout(100);
  const rangeInfo = await page.textContent('#rangeInfo');
  check('区间缓冲 512 采样', rangeInfo.includes('512 采样'), rangeInfo);
  check('无未定块时导出按钮直接可用', await page.isEnabled('#exportBtn'));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  const wavPath = path.join(tmp, 'out.wav');
  await download.saveAs(wavPath);
  const wav = fs.readFileSync(wavPath);
  check('WAV 头 RIFF/WAVE', wav.slice(0, 4).toString() === 'RIFF' && wav.slice(8, 12).toString() === 'WAVE');
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.length);
  check('48kHz 单声道 16bit', dv.getUint32(24, true) === 48000 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16);
  check('数据区 1024 字节', dv.getUint32(40, true) === 1024);
  // 数据区前 256 采样必须等于归档块 0 的 PCM
  const sampleArc = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const block0 = E.b64ToBytes(sampleArc.blocks.find((b) => b.id === 0).data);
  let wavMatchBlock0 = true;
  for (let i = 0; i < 512; i++) if (wav[44 + i] !== block0[i]) { wavMatchBlock0 = false; break; }
  check('WAV 数据区与原音块逐字节相同', wavMatchBlock0);

  // 构造含未定块的区间（换一个有缺失的归档：只给块0，块1 缺失且无校验）
  const missArc = {
    tracks: ['solo'], blocksPerTrack: 2,
    blocks: [blockRec(0, randBlock(99))], checks: [],
  };
  const missPath = writeJson('missing.json', missArc);
  await page.setInputFiles('#fileInput', missPath);
  await page.waitForTimeout(500);
  await page.fill('#rangeStart', '0');
  await page.fill('#rangeEnd', '512');
  await page.click('#buildRange');
  await page.waitForTimeout(100);
  check('未定块未确认前导出禁用', !(await page.isEnabled('#exportBtn')));
  check('未定块被列出', (await page.textContent('#unresolvedList')).includes('块 1'));
  await page.check('#silenceConfirm');
  check('确认补静音后导出可用', await page.isEnabled('#exportBtn'));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const wav2Path = path.join(tmp, 'out2.wav');
  await dl2.saveAs(wav2Path);
  const wav2 = fs.readFileSync(wav2Path);
  let silentTail = true;
  for (let i = 44 + 512; i < 44 + 1024; i++) if (wav2[i] !== 0) { silentTail = false; break; }
  check('导出的未定块区域确为静音零样本', silentTail);

  console.log('E6 浏览器内满额性能（8192 块 / 12000 校验）');
  // 复用 Node 侧生成器逻辑，独立生成一份满额归档
  const full = buildFullArchive();
  const fullPath = writeJson('full.json', full.arc);
  const tMark = Date.now();
  await page.setInputFiles('#fileInput', fullPath);
  await page.waitForFunction(() => {
    const b = document.getElementById('busyBanner');
    return b && b.hidden === true && document.querySelector('#stats .stat');
  }, null, { timeout: 15000 });
  const durText = await page.$$eval('#stats .stat', (els) => els.map((e) => e.textContent).find((t) => t.includes('ms')));
  const ms = Number((durText.match(/([\d.]+)ms/) || [])[1]);
  check(`首次求解 < 8000ms（实测 ${ms}ms）`, Number.isFinite(ms) && ms < 8000, durText);
  check('导入总耗时（含解析渲染）合理', Date.now() - tMark < 12000);
  // 改行后再求解
  await page.fill('#checkSearch', '');
  await page.locator('tr[data-id] .toggle-btn').first().click();
  await page.waitForTimeout(800);
  const dur2 = await page.$$eval('#stats .stat', (els) => els.map((e) => e.textContent).find((t) => t.includes('ms')));
  const ms2 = Number((dur2.match(/([\d.]+)ms/) || [])[1]);
  check(`改行求解 < 8000ms（实测 ${ms2}ms）`, Number.isFinite(ms2) && ms2 < 8000, dur2);

  check('页面无未捕获 JS 错误', errors.length === 0, errors.join(' || '));

  await browser.close();
  srv.close();
  console.log(failures ? `\n${failures} 项失败` : '\n浏览器端到端全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* 满额归档生成（与 Node 测试同规模） */
function buildFullArchive() {
  const tracks = 8, bpt = 1024, N = tracks * bpt;
  const truth = [];
  for (let i = 0; i < N; i++) truth.push(randBlock(1000 + i));
  const missing = new Set();
  let s = 7;
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) >>> 0; if (s % 100 < 30) missing.add(i); }
  const rng = (() => { let x = 42; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const checks = []; let cid = 0; const G = 6;
  for (let base0 = 0; base0 < N; base0 += G) {
    const members = [];
    for (let k = 0; k < G && base0 + k < N; k++) members.push(base0 + k);
    for (let r = 0; r < 7 && checks.length < 11994; r++) {
      const sub = members.filter(() => rng() < 0.6);
      if (sub.length < 1) sub.push(members[0]);
      checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));
    }
  }
  while (checks.length < 11994) {
    const sub = [...new Set([Math.floor(rng() * N), Math.floor(rng() * N), Math.floor(rng() * N)])];
    checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));
  }
  const cbase = 100, grp = [cbase, cbase + 1, cbase + 2, cbase + 3, cbase + 4, cbase + 5];
  for (const id of grp) missing.add(id);
  const t1 = (() => { const t = xorBytes(grp.map((x) => truth[x])); t[3] ^= 0xff; return t; })();
  checks.push(checkRec(cid++, grp, t1));
  const knownIds = [...Array(N).keys()].filter((i) => !missing.has(i)).slice(0, 3);
  const t2 = (() => { const t = xorBytes(knownIds.map((x) => truth[x])); t[1] ^= 0x0f; return t; })();
  checks.push(checkRec(cid++, knownIds, t2));
  const rbase = 300, rgrp = [rbase, rbase + 1, rbase + 2, rbase + 3, rbase + 4, rbase + 5];
  for (const id of rgrp) missing.add(id);
  for (const sub of [[rgrp[0], rgrp[1]], [rgrp[1], rgrp[2]], [rgrp[2], rgrp[3]], [rgrp[3], rgrp[4], rgrp[5]]]) {
    checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));
  }
  const blocks = [];
  for (let i = 0; i < N; i++) if (!missing.has(i)) blocks.push(blockRec(i, truth[i]));
  return { arc: { tracks: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'], blocksPerTrack: bpt, blocks, checks } };
}
