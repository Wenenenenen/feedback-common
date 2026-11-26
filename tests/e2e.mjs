// 浏览器端到端测试（Playwright，驱动真实页面）。
// 需要本机 Playwright：PW_PATH 可覆盖。
// 运行：node tests/e2e.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { CASES, budgetScene } from '../tools/cases.mjs';
import { writeFile as writeFileCb } from 'node:fs';
import { promisify } from 'node:util';
const writeFile = promisify(writeFileCb);

// 大文件走 HTTP：把生成的 ZIP 暂存到临时目录，由站点按 /__clip__/ 提供
const CLIP_DIR = '/tmp/dc-e2e-clips';
let clipSeq = 0;
import { Engine } from '../src/js/engine.js';

const require = createRequire(import.meta.url);
const PW_PATH = process.env.PW_PATH ||
  '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright';
const { chromium } = require(PW_PATH);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', 'src');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : String(extra)); }
};

// ---------------------------------------------------------------------------
// 服务（带 COOP/COEP，便于并行路径）
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const rel = p.endsWith('/') ? 'index.html' : p.replace(/^\/+/, '');
    const candidates = [join(ROOT, rel)];
    if (rel.startsWith('samples/')) candidates.push(join(ROOT, '..', rel));
    if (rel.startsWith('__clip__/')) candidates.push(join(CLIP_DIR, rel.slice('__clip__/'.length)));
    let file = null;
    for (const cand of candidates) {
      const safe = normalizeSafe(cand);
      if (!safe) continue;
      try {
        await readFile(safe).then(() => { file = safe; });
      } catch { /* try next */ }
      if (file) break;
    }
    if (!file) { res.writeHead(404); return res.end('not found'); }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

function normalizeSafe(p) {
  const norm = resolve(p);
  const repo = resolve(HERE, '..');
  return norm.startsWith(ROOT)
    || norm.startsWith(repo + '/samples/')
    || norm.startsWith(CLIP_DIR + '/')
    ? norm : null;
}

async function waitIdle(page, timeout = 60000) {
  await page.waitForFunction(() => !window.__dc || !window.__dc.state.busy, null, { timeout });
}

/** 等一次导入结束：有引擎、且不忙。 */
async function waitLoaded(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const s = window.__dc && window.__dc.state;
    return s && !s.busy && !!s.engine;
  }, null, { timeout });
}

/**
 * 用页面自身入口加载。小包用拖放（与真实使用同一 API）；大包先经 HTTP 取回，
 * 避免 base64 字符串撑爆 CDP 通道。
 */
async function loadZipViaPage(page, zipBytes, fileName) {
  const seq = await page.evaluate(() => window.__dc.state.loadSeq);
  const useHttp = zipBytes.length > 4 * 1024 * 1024;
  if (useHttp) {
    const rel = `clip-${++clipSeq}.zip`;
    await writeFile(resolve(CLIP_DIR, rel), Buffer.from(zipBytes));
    await page.evaluate(async ({ url, name }) => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('取 ZIP 失败 ' + res.status);
      const bin = await res.arrayBuffer();
      const file = new File([bin], name, { type: 'application/zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { url: `/__clip__/${rel}`, name: fileName });
  } else {
    const b64 = Buffer.from(zipBytes).toString('base64');
    await page.evaluate(async ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], name, { type: 'application/zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { b64, name: fileName });
  }
  await page.waitForFunction(
    (seq) => {
      const s = window.__dc.state;
      return s.loadSeq > seq && !s.busy && !!s.engine;
    },
    seq, { timeout: 120000 },
  );
}

async function runViaButton(page) {
  await page.click('#btn-run');
  try {
    await page.waitForFunction(() => {
      const s = window.__dc.state;
      return !s.busy && (s.phase === 'computed' || s.phase === 'nosolution');
    }, null, { timeout: 120000 });
  } catch (err) {
    const snap = await page.evaluate(() => ({
      busy: window.__dc.state.busy,
      phase: window.__dc.state.phase,
      status: document.querySelector('#status-msg').textContent,
    })).catch(() => null);
    console.error('  等待校对完成超时：', JSON.stringify(snap));
    throw err;
  }
}

// ---------------------------------------------------------------------------

const CHROME = process.env.CHROME ||
  (process.env.HOME + '/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

let browser;
try {
  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'],
  });
} catch (err) {
  console.error('无法启动 Chromium：', err.message);
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}/`;

try {
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#empty-state');
  ok(true, '页面载入并显示空状态');

  const sab = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    hasSAB: typeof SharedArrayBuffer === 'function',
  }));
  ok(sab.hasSAB, '页面可用 SharedArrayBuffer（COOP/COEP 生效）', JSON.stringify(sab));

  // ---- 样例包：自带 ZIP（2 副本）----
  await page.click('#btn-sample');
  await waitLoaded(page);
  const sampleInfo = await page.evaluate(() => ({
    copies: window.__dc.state.engine.project.copies.length,
    frames: window.__dc.state.engine.project.anchor.frames,
  }));
  ok(sampleInfo.copies === 2 && sampleInfo.frames === 2352, '样例载入：2 副本 / 2352 帧', JSON.stringify(sampleInfo));

  await runViaButton(page);
  const sampleRes = await page.evaluate(() => {
    const r = window.__dc.result;
    return {
      ok: r.ok,
      offsets: r.copies.map((c) => c.offsets),
      disputes: r.stats.disputes,
      wav: window.__dc.exportText().wavLength,
    };
  });
  ok(sampleRes.ok, '样例校对成功');
  ok(JSON.stringify(sampleRes.offsets[0]) === '[1,2]' && JSON.stringify(sampleRes.offsets[1]) === '[0]',
    '样例偏移：copy-a [1, 2]、copy-b [0]', JSON.stringify(sampleRes.offsets));
  // 样例自带 copy-b 右声道坏区 [400,403)，且 copy-a 两块接缝只覆盖单份：
  // 独立交叉核对得左 7 帧、右 4 帧争议（帧 0 / 400–402 / 1177 / 2350–2351）。
  ok(sampleRes.disputes === 11, '样例争议 11 个声道帧（与独立核对一致）', sampleRes.disputes);
  ok(sampleRes.wav === 44 + 2352 * 4, '导出 WAV 长度 = 44 + 4×帧数', sampleRes.wav);

  const exportsText = await page.evaluate(() => window.__dc.exportText());
  const disputeLines = exportsText.disputes.trim().split(/\r?\n/);
  ok(disputeLines.length >= 2, '争议表有表头与争议段', disputeLines.length);
  // 争议表起止帧应覆盖帧 0 与 2351
  const disputeBody = disputeLines.slice(1).join('\n');
  ok(/^左,0,1,/m.test(disputeBody.replace(/﻿/g, '')), '争议表含左声道帧 0', disputeLines[1]);
  const alignLines = exportsText.alignment.trim().split(/\r?\n/);
  ok(alignLines.length === 4, '对齐表 3 块 + 表头', alignLines.length);

  // ---- 难点 1：重叠 ----
  const overlap = CASES.overlap();
  await loadZipViaPage(page, overlap.zip, 'overlap.zip');
  await runViaButton(page);
  const ovRes = await page.evaluate(() => ({
    offsets: window.__dc.result.copies[0].offsets,
    canExport: !document.querySelector('#btn-export-wav').disabled,
  }));
  ok(JSON.stringify(ovRes.offsets) === '[-2,0]', '重叠场景选定 [-2, 0]', JSON.stringify(ovRes.offsets));
  ok(ovRes.canExport, '重叠场景可导出');

  // ---- 难点 2：无解 ----
  const nsv = CASES.nosolution();
  await loadZipViaPage(page, nsv.zip, 'nosolution.zip');
  await runViaButton(page);
  const noRes = await page.evaluate(() => ({
    phase: window.__dc.state.phase,
    copyIndex: window.__dc.result.copyIndex,
    blockIndex: window.__dc.result.blockIndex,
    visible: !document.querySelector('#nosolution').classList.contains('hidden'),
    canExport: !document.querySelector('#btn-export-wav').disabled,
    msg: document.querySelector('#nosolution-msg').textContent,
  }));
  ok(noRes.phase === 'nosolution', '无解场景进入无解状态');
  ok(noRes.copyIndex === 0 && noRes.blockIndex === 1, '标出首次无法排下的块（副本 #1 第 2 块）', JSON.stringify(noRes));
  ok(noRes.visible, '无解提示可见');
  ok(!noRes.canExport, '无解时不开放导出');
  ok(/第 2 块/.test(noRes.msg), '无解文案点明块号', noRes.msg);

  // ---- 难点 3：投票 ----
  const vote = CASES.vote();
  await loadZipViaPage(page, vote.zip, 'vote.zip');
  await runViaButton(page);
  await page.evaluate((f) => window.__dc.gotoFrame(f), vote.expect.testFrame);
  await page.evaluate(() => window.__dc.setView('frame'));
  const voteRes = await page.evaluate(() => {
    const f = window.__dc.state.frame;
    const fr = window.__dc.frameAt(f);
    return {
      left: fr.left, right: fr.right,
      leftCard: document.querySelectorAll('.vote-card')[0].className,
      rightCard: document.querySelectorAll('.vote-card')[1].className,
    };
  });
  ok(voteRes.left.status === 1 && voteRes.left.votes === 4 && voteRes.left.top === 2,
    '左声道 4 票 2:2 未过严格过半', JSON.stringify(voteRes.left));
  ok(voteRes.right.status === 0 && voteRes.right.out === 50 && voteRes.right.votes === 3,
    '右声道 3 票采用 50', JSON.stringify(voteRes.right));

  // ---- 难点 4：改坏区重算 ----
  const bad = CASES.badedit();
  await loadZipViaPage(page, bad.zip, 'badedit.zip');
  await runViaButton(page);
  const before = await page.evaluate(() => window.__dc.result.copies[0].offsets[0]);
  ok(before === -10, '改坏区前偏移 −10', before);
  const after = await page.evaluate(async (span) => {
    // 直接经 UI 的坏区控件添加
    document.querySelector('#bad-read').value = '0';
    document.querySelector('#bad-read').dispatchEvent(new Event('change'));
    document.querySelector('#bad-channel').value = '0';
    document.querySelector('#bad-channel').dispatchEvent(new Event('change'));
    document.querySelector('#bad-start').value = String(span[0]);
    document.querySelector('#bad-end').value = String(span[1]);
    document.querySelector('#bad-add-btn').click();
    await new Promise((r) => setTimeout(r, 100));
    // 等重算结束
    await new Promise((resolve) => {
      const tick = () => {
        const s = window.__dc.state;
        if (!s.busy && s.phase === 'computed') resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
    return window.__dc.result.copies[0].offsets[0];
  }, bad.expect.badSpan);
  ok(after === 0, '标坏区后偏移改为 0', after);

  // ---- 难点 5：满额性能（7 副本 / 256 块 / 90 秒）----
  console.log('  生成满额场景…');
  const tGen = Date.now();
  const budget = budgetScene(90);
  console.log(`  生成用时 ${((Date.now() - tGen) / 1000).toFixed(1)}s，ZIP ${(budget.zip.length / 1e6).toFixed(1)}MB`);
  await loadZipViaPage(page, budget.zip, 'budget.zip');
  const loadMs = await page.evaluate(() => window.__dc.state.engine.loadMs);
  const tClick = Date.now();
  await runViaButton(page);
  const browserMs = Date.now() - tClick;
  const budgetRes = await page.evaluate(() => ({
    timings: window.__dc.state.engine.timings,
    mode: window.__dc.state.engine.executor ? window.__dc.state.engine.executor.mode : '?',
    ok: window.__dc.result.ok,
    offsets: window.__dc.result.copies.map((c) => c.offsets),
  }));
  // 与 Node 端独立计算的结果对照（用同一份数据，engine 单线程）
  const nodeEng = await Engine.load(budget.zip, { parallel: false });
  await nodeEng.compute();
  const nodeOffsets = nodeEng.aligned.copies.map((c) => c.offsets);
  let mismatch = 0;
  for (let c = 0; c < budget.copies; c++) {
    for (let i = 0; i < budget.blocksPer; i++) {
      if (budgetRes.offsets[c][i] !== nodeOffsets[c][i]) mismatch++;
    }
  }
  ok(budgetRes.ok, '满额场景校对成功');
  ok(mismatch === 0, '浏览器与 Node 偏移完全一致', mismatch);
  let truthMismatch = 0;
  for (let c = 0; c < budget.copies; c++) {
    for (let i = 0; i < budget.blocksPer; i++) {
      if (budgetRes.offsets[c][i] !== budget.truth[c][i]) truthMismatch++;
    }
  }
  ok(truthMismatch === 0, '满额偏移全部等于真值', truthMismatch);
  console.log(`  满额：载入 ${(loadMs / 1000).toFixed(2)}s，点校对到可导出 ${(browserMs / 1000).toFixed(2)}s，模式 ${budgetRes.mode}`);
  ok(browserMs < 15000, '满额从点校对到结果可导出 < 15 秒', `${browserMs} ms`);
  ok(budgetRes.timings.total < 15000, '引擎内部总耗时 < 15 秒', `${budgetRes.timings.total} ms`);

  // ---- 导出内容与页面位置一致（满额场景抽查）----
  const ex = await page.evaluate(() => window.__dc.exportText());
  const wavOk = ex.wavLength === 44 + budget.frames * 4;
  ok(wavOk, '满额 WAV 长度 = 44 + 4×基准帧数', ex.wavLength);
  ok(ex.disputes.trim().split(/\r?\n/).length >= 1, '争议表有表头');

  // ---- 无控制台异常 ----
  const fatal = pageErrors.filter((e) => !/favicon/.test(e));
  ok(fatal.length === 0, '无页面脚本错误', fatal.slice(0, 4).join(' | '));

  // 截图存证
  await page.evaluate(() => window.__dc.setView('sector'));
  await page.screenshot({ path: resolve(HERE, '..', 'docs', 'screenshot.png'), fullPage: false });
} catch (err) {
  console.error('E2E 异常：', err);
  fail++;
} finally {
  await browser.close();
  server.close();
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}
