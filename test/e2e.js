#!/usr/bin/env node
/* 端到端测试：静态服务 + Playwright。
 * 验证：样例工程渲染与 Python 参考逐码一致；选区导出与整轨切片逐码一致；
 *       编辑轨迹不影响其他声源；取消保留上次结果。
 * 用法: NODE_PATH=$(npm root -g) node test/e2e.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TMP = '/tmp/hrir-test';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav', '.zip': 'application/zip' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      let file;
      if (p.startsWith('/t/')) file = path.join(TMP, p.slice(3));
      else file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) && !file.startsWith(TMP)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function readWavStereo(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(40) / 4;
  const l = new Int16Array(n), r = new Int16Array(n);
  for (let i = 0; i < n; i++) { l[i] = b.readInt16LE(44 + i * 4); r[i] = b.readInt16LE(44 + i * 4 + 2); }
  return { l, r, n };
}

function assertEq(a, b, msg) {
  if (a !== b) { console.error(`FAIL: ${msg}: ${a} !== ${b}`); process.exitCode = 1; throw new Error(msg); }
}

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('页面错误:', e.message); process.exitCode = 1; });
  await page.goto(`http://127.0.0.1:${port}/`);

  // 1. 载入示例工程并渲染
  await page.click('#btn-load-sample');
  await page.waitForFunction(() => document.querySelector('#render-status').textContent.includes('完成'), null, { timeout: 30000 });

  const ref = readWavStereo(path.join(TMP, 'ref.wav'));
  const mix = await page.evaluate(() => {
    const qc = quantizedTarget();
    return { l: Array.from(qc.ql), r: Array.from(qc.qr) };
  });
  assertEq(mix.l.length, ref.n, '样例整轨长度');
  let bad = 0;
  for (let i = 0; i < ref.n; i++) {
    if (mix.l[i] !== ref.l[i] || mix.r[i] !== ref.r[i]) { bad++; if (bad < 5) console.error(`帧 ${i}: 页面(${mix.l[i]},${mix.r[i]}) 参考(${ref.l[i]},${ref.r[i]})`); }
  }
  assertEq(bad, 0, '样例整轨与 Python 参考逐码一致');
  console.log('✓ 样例工程整轨与 Python 参考逐码一致（', ref.n, '帧）');

  // 2. 发声帧查看
  await page.selectOption('#inspect-src', '0');
  await page.fill('#inspect-frame', '2400');
  await page.evaluate(() => updateInspector());
  const insp = await page.textContent('#inspect-out');
  if (!/左耳/.test(insp) || !/右耳/.test(insp) || !/权重/.test(insp) || !/延时/.test(insp)) {
    throw new Error('查看器输出不完整: ' + insp);
  }
  console.log('✓ 发声帧查看输出邻点/权重/两耳延时');

  // 3. 选区导出与整轨切片逐码一致
  await page.evaluate(() => { state.sel.start = 100; state.sel.end = 1000; syncSelectionUI(); });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export-wav'),
  ]);
  const dlPath = await download.path();
  const sel = readWavStereo(dlPath);
  assertEq(sel.n, 900, '选区帧数');
  bad = 0;
  for (let i = 0; i < 900; i++) {
    if (sel.l[i] !== ref.l[100 + i] || sel.r[i] !== ref.r[100 + i]) bad++;
  }
  assertEq(bad, 0, '选区导出与整轨对应区间逐码一致');
  console.log('✓ 选区 [100,1000) 导出与整轨对应区间逐码一致');

  // 4. 多源工程：编辑轨迹不影响其他声源
  await page.evaluate(async () => {
    document.querySelector('#btn-clear').click();
    const proj = await (await fetch('/t/rand1/project.json')).json();
    for (const s of proj.sources) {
      const buf = await (await fetch('/t/rand1/' + s.wav)).arrayBuffer();
      state.wavPool.set(s.wav, RenderCore.decodeWavPcm16Mono(buf));
    }
    importProjectJson(proj);
    refreshUI();
    startRender(dirtySourceIds());
  });
  await page.waitForFunction(() => document.querySelector('#render-status').textContent.includes('完成'), null, { timeout: 30000 });

  const ref1 = readWavStereo(path.join(TMP, 'rand1-ref.wav'));
  const mix1 = await page.evaluate(() => {
    const qc = quantizedTarget();
    return { l: Array.from(qc.ql), r: Array.from(qc.qr) };
  });
  assertEq(mix1.l.length, ref1.n, '随机工程整轨长度');
  bad = 0;
  for (let i = 0; i < ref1.n; i++) {
    if (mix1.l[i] !== ref1.l[i] || mix1.r[i] !== ref1.r[i]) bad++;
  }
  assertEq(bad, 0, '随机 4 源工程与 Python 参考逐码一致');
  console.log('✓ 随机 4 源工程（16 方位/512 抽头/多圈轨迹）与参考逐码一致');

  const hash = () => page.evaluate(() => {
    const fnv = (buf) => {
      const u = new Uint8Array(buf);
      let h = 0x811c9dc5;
      for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      return h;
    };
    return state.sources.map((s) => s.rendered ? [fnv(s.rendered.left.buffer), fnv(s.rendered.right.buffer)] : null);
  });
  const before = await hash();
  await page.evaluate(() => {
    // 修改声源 1（下标 0）的轨迹角度 → 只重算它
    state.sources[0].trackAngs[1] += 3700;
    markDirtyAndRender(0);
  });
  await page.waitForFunction(() => document.querySelector('#render-status').textContent.includes('完成'), null, { timeout: 30000 });
  const after = await hash();
  for (let i = 1; i < before.length; i++) {
    assertEq(JSON.stringify(after[i]), JSON.stringify(before[i]), `声源 ${i + 1} 渲染结果不应变化`);
  }
  if (JSON.stringify(after[0]) === JSON.stringify(before[0])) throw new Error('被编辑声源的结果未变化');
  console.log('✓ 编辑轨迹只重算该声源，其他声源结果逐字节不变');

  // 5. 取消保留上次结果
  const keep = await page.evaluate(() => {
    state.sources[1].trackAngs[1] += 1234;
    state.sources[1].dirty = true;
    const keepHash = (() => {
      const u = new Uint8Array(state.sources[1].rendered.left.buffer);
      let h = 0; for (let i = 0; i < u.length; i += 997) h = (h * 31 + u[i]) >>> 0;
      return h;
    })();
    startRender([1]);
    cancelRender();
    const u2 = new Uint8Array(state.sources[1].rendered.left.buffer);
    let h2 = 0; for (let i = 0; i < u2.length; i += 997) h2 = (h2 * 31 + u2[i]) >>> 0;
    return { same: keepHash === h2, status: document.querySelector('#render-status').textContent, dirty: state.sources[1].dirty };
  });
  if (!keep.same) throw new Error('取消后上次结果被改变');
  if (!keep.status.includes('已取消')) throw new Error('取消状态未显示: ' + keep.status);
  console.log('✓ 取消后保留上次结果（状态：' + keep.status + '）');

  await browser.close();
  srv.close();
  console.log(process.exitCode ? '存在失败项' : '全部端到端测试通过');
})().catch((e) => { console.error('E2E 失败:', e.message); process.exit(1); });
