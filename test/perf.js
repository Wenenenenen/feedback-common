#!/usr/bin/env node
/* 满额工程（4×30s、16 方位、512 抽头、2 万轨迹点）浏览器渲染计时。
 * 用法: NODE_PATH=$(npm root -g) node test/perf.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TMP = '/tmp/hrir-test';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = p.startsWith('/t/') ? path.join(TMP, p.slice(3)) : path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(async () => {
    const proj = await (await fetch('/t/full/project.json')).json();
    for (const s of proj.sources) {
      const buf = await (await fetch('/t/full/' + s.wav)).arrayBuffer();
      state.wavPool.set(s.wav, RenderCore.decodeWavPcm16Mono(buf));
    }
    importProjectJson(proj);
    refreshUI();
    const t0 = performance.now();
    startRender(dirtySourceIds());
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const t = document.querySelector('#render-status').textContent;
        if (t.includes('完成')) { clearInterval(iv); resolve(); }
        if (t.includes('出错')) { clearInterval(iv); reject(new Error(t)); }
      }, 100);
    });
    const renderMs = performance.now() - t0;
    // 量化 + 建播放缓冲（可播放前的最后一步）
    const t1 = performance.now();
    const qc = quantizedTarget();
    const ctx = new OfflineAudioContext(2, qc.ql.length, 48000);
    const buf = ctx.createBuffer(2, qc.ql.length, 48000);
    buf.copyToChannel(Float32Array.from(qc.ql, (v) => v / 32768), 0);
    buf.copyToChannel(Float32Array.from(qc.qr, (v) => v / 32768), 1);
    return { renderMs, prepareMs: performance.now() - t1, frames: qc.ql.length, cores: navigator.hardwareConcurrency };
  });
  console.log(`渲染耗时 ${(result.renderMs / 1000).toFixed(1)} s，播放准备 ${result.prepareMs.toFixed(0)} ms，共 ${result.frames} 帧，${result.cores} 核`);
  console.log(result.renderMs + result.prepareMs < 20000 ? '✓ 满额工程 20 秒预算内' : '✗ 超过 20 秒预算');
  await browser.close();
  srv.close();
});
