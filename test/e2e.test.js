/* 浏览器端到端测试：node test/e2e.test.js（需要全局 playwright 与静态服务器） */
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function assert(cond, msg) { if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; } else console.log('  ✓ ' + msg); }

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TCApp && TCApp.state && TCApp.state.result, { timeout: 15000 });
  const r1 = await page.evaluate(() => {
    const s = TCApp.state;
    return { frags: s.result.fragments.length, badCells: s.badCells.length, badFaces: s.badFaces.length, verts: s.result.verts.length };
  });
  assert(r1.frags >= 1 && r1.badCells === 0 && r1.badFaces === 0, `样本流水线成功（碎片 ${r1.frags}，无非法项）`);
  assert(errors.length === 0, '无控制台错误: ' + errors.join(' | '));

  // 导出结构与字段
  const exp = await page.evaluate(() => {
    const e = TCExport.buildExport(TCApp.state.result, 'deformed');
    const f0 = e.fragments[0];
    return {
      schema: e.schema, has: ['originFace', 'cell', 'positions', 'normals'].every(k => k in f0),
      unitNormal: Math.abs(Math.hypot(...f0.normals[0]) - 1) < 1e-6,
      posLen: f0.positions.length, nLen: f0.normals.length,
    };
  });
  assert(exp.has && exp.schema.startsWith('tetra-cage'), '导出含位置/法线/单元/原面编号');
  assert(exp.unitNormal, '导出法线为单位向量（容差 1e-6）');
  assert(exp.posLen === exp.nLen, '位置与法线逐角对应');

  // 非法姿态：把样本 pose 改成体积翻号，应标出单元且 lastGood 仍可导出
  await page.evaluate(() => {
    const d = TCApp.state.data;
    d.pose = d.pose.map(p => [...p]);
    // 交换单元前两顶点对应的空间点不易直接做，改为令一个顶点重合制造零体积
    d.pose[1] = [...d.pose[0]];
    TCApp.runWorker(true);
  });
  await page.waitForFunction(() => {
    const s = TCApp.state;
    return s.badCells && s.badCells.length > 0 && !s.busy;
  }, { timeout: 15000 });
  const illegal = await page.evaluate(() => ({
    badCells: TCApp.state.badCells.length,
    lastGoodFrags: TCApp.state.lastGood ? TCApp.state.lastGood.fragments.length : 0,
  }));
  assert(illegal.badCells > 0, '非法姿态被拒绝并标出单元');
  assert(illegal.lastGoodFrags > 0, '上一份成功结果仍保留可导出');

  // 越界面：构造一个远离笼的三角形
  await page.evaluate(() => {
    const d = TCApp.state.data;
    d.pose = d.rest.map(p => [...p]); // 恢复合法姿态
    d.faces = [{ p: [[90, 90, 90], [92, 90, 90], [90, 92, 90]], n: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] }];
    TCApp.runWorker(true);
  });
  await page.waitForFunction(() => TCApp.state && TCApp.state.badFaces && TCApp.state.badFaces.length > 0 && !TCApp.state.busy, { timeout: 15000 });
  const badFace = await page.evaluate(() => TCApp.state.badFaces[0]);
  assert(badFace === 0, '越出原笼的原面被拒绝并标记编号');

  await browser.close();
  server.close();
  console.log(process.exitCode ? '\n存在失败' : '\n端到端全部通过');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
