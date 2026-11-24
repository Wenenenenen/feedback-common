// 浏览器端到端测试（Playwright + Chromium）。无 Playwright 时自动跳过。
//
// 覆盖：导入样例包、数值与参考一致、参数编辑（重定位 / 重新反卷积）、窗冲突提示、
// 越界补零、逐通道独立零点、导出 WAV 字节逐样点核对、导出 ZIP、私密零外部请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { analyzeRef } from './reference.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function globalRoot() {
  return path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
}
let chromium = null;
try {
  ({ chromium } = require(path.join(globalRoot(), 'playwright')));
} catch { /* 未安装 */ }
const skip = chromium ? false : '未安装 Playwright';

const Core = require(path.join(ROOT, 'src/js/core.js'));
const Wav = require(path.join(ROOT, 'src/js/wav.js'));
const Zip = require(path.join(ROOT, 'src/js/zip.js'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.wav': 'audio/wav',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const f = path.normalize(path.join(ROOT, u === '/' ? 'index.html' : u));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withPage(fn, viewport) {
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  const external = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(`http://127.0.0.1:${port}/`) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await fn(page, port, errors, external);
    assert.deepEqual(errors, [], `页面错误：${errors.join(' | ')}`);
    assert.deepEqual(external, [], `出现外部请求：${external.join(' | ')}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function loadSample(page) {
  await page.setInputFiles('#fileInput', path.join(ROOT, 'samples/sweep-harmonic-cases.zip'));
  await page.waitForFunction(() => {
    const s = window.__shm && window.__shm.state;
    return s && s.results.length > 0 && !s.busy;
  }, null, { timeout: 30000 });
}

const stateOf = (page) => page.evaluate(() => {
  const s = window.__shm.state;
  return {
    status: document.getElementById('statusText').textContent,
    tone: document.getElementById('statusPill').dataset.tone,
    chips: {
      ch: document.getElementById('chipCh').textContent,
      n: document.getElementById('chipN').textContent,
      m: document.getElementById('chipM').textContent,
      d: document.getElementById('chipD').textContent,
      t: document.getElementById('chipT').textContent,
    },
    params: s.params,
    results: s.results.map((r) => ({
      ch: r.channel,
      calib: r.calib,
      dataLen: r.dataLen,
      zero: r.analysis.zero,
      zeroRel: r.analysis.zeroRel,
      zeroValue: r.analysis.zeroValue,
      conflicts: r.analysis.conflicts,
      windows: r.analysis.windows.map((w) => ({
        q: w.q, center: w.center, start: w.start, end: w.end,
        energy: w.energy, peak: w.peak, peakIndex: w.peakIndex, zeroFilled: w.zeroFilled,
        samples: Array.from(w.samples),
      })),
    })),
  };
});

/* ------------------------------ tests ------------------------------- */

test('样例包：载入、数值与参考一致、四窗上屏', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const st = await stateOf(page);
    assert.equal(st.status, '已载入');
    assert.equal(st.tone, 'ok');
    assert.equal(st.chips.ch, '2');
    assert.equal(st.chips.n, '48,000');
    assert.equal(st.chips.m, '51,000');
    assert.equal(st.results.length, 2);
    const [a, b] = st.results;
    assert.equal(a.zero, 48479);
    assert.equal(a.zeroRel, 480);
    assert.ok(Math.abs(a.zeroValue - 0.6500018) < 1e-5);
    assert.equal(b.zero, 48812);
    assert.equal(b.zeroRel, 813);
    assert.ok(Math.abs(b.zeroValue + 0.4499979) < 1e-5);
    assert.deepEqual(a.conflicts, []);
    // 四张窗卡片 + 能量数值
    const cards = await page.$$eval('#wgrid .wcard', (els) => els.length);
    assert.equal(cards, 4);
    const energyText = await page.textContent('#wgrid .wcard .wstats .sv');
    assert.ok(Number(energyText) > 1, `直达窗能量 ${energyText}`);
    // 与独立暴力参考逐窗核对
    const zipBytes = fs.readFileSync(path.join(ROOT, 'samples/sweep-harmonic-cases.zip'));
    const entries = await Zip.unzip(new Uint8Array(zipBytes));
    const sweep = Wav.decode(entries.get('sweep.wav'));
    const cap = Wav.decode(entries.get('capture.wav'));
    const setup = JSON.parse(new TextDecoder().decode(entries.get('setup.json')));
    const ref = analyzeRef(cap.data[0], sweep.data[0], setup);
    for (let i = 0; i < 4; i++) {
      assert.equal(a.windows[i].start, ref.windows[i].start);
      assert.equal(a.windows[i].end, ref.windows[i].end);
      assert.ok(Math.abs(a.windows[i].energy - ref.windows[i].energy) < 1e-9, `q${i + 1} 能量`);
    }
    // 参考值快照
    assert.ok(Math.abs(a.windows[0].energy - 1.701439256963902) < 1e-9);
    assert.ok(Math.abs(a.windows[1].energy - 0.008563615992578988) < 1e-11);
  });
});

test('参数编辑：缩窄窗重定位、放宽窗重算、非法参数提示', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const setF = async (id, v) => {
      await page.fill('#' + id, String(v));
      await page.dispatchEvent('#' + id, 'change');
      await page.waitForFunction(() => !window.__shm.state.busy, null, { timeout: 30000 });
    };
    await setF('inPre', 20);
    await setF('inPost', 100);
    let st = await stateOf(page);
    assert.equal(st.params.pre, 20);
    assert.equal(st.results[0].windows[0].end - st.results[0].windows[0].start, 120);
    assert.equal(st.results[0].zero, 48479, '缩窗不改零点');

    // 放宽到互相重叠，应报冲突
    await setF('inPre', 20000);
    await setF('inPost', 30000);
    st = await stateOf(page);
    assert.ok(st.results[0].conflicts.length > 0, '宽窗应冲突');
    assert.equal(await page.isVisible('#conflictBar'), true);
    const banner = await page.textContent('#conflictText');
    assert.match(banner, /窗冲突/);
    assert.match(banner, /第 1 阶/);
    const conflictCards = await page.$$eval('#wgrid .wcard.conflict', (els) => els.length);
    assert.equal(conflictCards, 4, '四张卡都应标冲突');

    // 恢复
    await page.click('#btnReset');
    await page.waitForFunction(() => !window.__shm.state.busy && window.__shm.state.params.pre === 80, null, { timeout: 30000 });
    st = await stateOf(page);
    assert.deepEqual(st.params, { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 });
    assert.deepEqual(st.results[0].conflicts, []);

    // 非法：hi 超出采集帧数
    await page.fill('#inHi', '999999');
    await page.dispatchEvent('#inHi', 'change');
    await page.waitForTimeout(400);
    assert.equal(await page.isVisible('#paramErr'), true);
    assert.match(await page.textContent('#paramErrText'), /小于采集帧数/);
    assert.equal(await page.getAttribute('#inHi', 'aria-invalid'), 'true');
    // 修正后错误消失
    await page.fill('#inHi', '1300');
    await page.dispatchEvent('#inHi', 'change');
    await page.waitForFunction(() => document.getElementById('paramErr').hidden, null, { timeout: 20000 });
    assert.equal(await page.isVisible('#paramErr'), false);
  });
});

test('搜索区间：零点随区间改变，逐通道独立', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    // 改 lo 到 700：通道 1 的 rel=480 峰被排除，应落到区间内其它位置
    await page.fill('#inLo', '700');
    await page.dispatchEvent('#inLo', 'change');
    await page.waitForFunction(() => !window.__shm.state.busy && window.__shm.state.params.lo === 700, null, { timeout: 30000 });
    const st = await stateOf(page);
    assert.notEqual(st.results[0].zeroRel, 480, '通道 1 零点应变化');
    // 通道 2 的 rel=813 仍在区间内
    const r2 = st.results[1];
    assert.ok(r2.zeroRel >= 700 && r2.zeroRel <= 1300);
    assert.equal(r2.zeroRel, 813);
    for (const r of st.results) {
      assert.ok(r.zeroRel >= 700 && r.zeroRel <= 1300, `通道 ${r.ch + 1} 零点必须在区间内`);
    }
    // 通道零点各不相同（独立定位）
    assert.notEqual(st.results[0].zero, st.results[1].zero);
  });
});

test('窗越界补零：负索引与超出末尾都取零并计数', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    // pre 很大 → q4 窗左端负索引
    await page.fill('#inPre', '40000');
    await page.dispatchEvent('#inPre', 'change');
    await page.waitForFunction(() => !window.__shm.state.busy && window.__shm.state.params.pre === 40000, null, { timeout: 30000 });
    let st = await stateOf(page);
    const q4 = st.results[0].windows[3];
    assert.ok(q4.start < 0);
    assert.ok(q4.zeroFilled > 0);
    assert.equal(q4.samples[0], 0);
    const badge = await page.$$eval('#wgrid .wcard[data-q="4"] .badge', (els) => els.map((e) => e.textContent));
    assert.ok(badge.some((t) => /补零/.test(t)), `补零徽标：${badge}`);

    // 右端越界
    await page.fill('#inPre', '80');
    await page.dispatchEvent('#inPre', 'change');
    await page.fill('#inPost', '60000');
    await page.dispatchEvent('#inPost', 'change');
    await page.waitForFunction(() => !window.__shm.state.busy && window.__shm.state.params.post === 60000, null, { timeout: 30000 });
    st = await stateOf(page);
    const w1 = st.results[0].windows[0];
    assert.ok(w1.end > st.results[0].dataLen);
    assert.ok(w1.samples[w1.samples.length - 1] === 0);
    assert.ok(w1.zeroFilled > 0);
  });
});

test('导出 WAV：48 kHz 单声道 float32，窗样本逐点一致，不归一化', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const st = await stateOf(page);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exList .exrow:nth-child(2) .btn'),      // 通道 1 第 2 阶
    ]);
    const name = dl.suggestedFilename();
    assert.match(name, /^ch1_q2_f-?\d+-\d+\.wav$/);
    const tmp = path.join(ROOT, '.cache', 'test-downloads');
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, name);
    await dl.saveAs(file);
    const bytes = fs.readFileSync(file);
    const w = Wav.decode(bytes);
    assert.equal(w.channels, 1);
    assert.equal(w.sampleRate, 48000);
    assert.equal(w.bitsPerSample, 32);
    assert.equal(w.encoding, 3);
    const win = st.results[0].windows[1];
    assert.equal(w.frames, win.end - win.start);
    let maxErr = 0;
    for (let i = 0; i < w.frames; i++) {
      maxErr = Math.max(maxErr, Math.abs(w.data[0][i] - win.samples[i]));
    }
    assert.ok(maxErr <= 1e-7, `导出与窗样本最大差 ${maxErr}`);
    assert.ok(Math.abs(w.data[0][win.peakIndex - win.start] - win.peak) < 1e-7);
    // 不归一化：峰值的绝对值远小于 1（q2 约 0.036）
    assert.ok(Math.abs(win.peak) < 0.2, `未见归一化：峰值 ${win.peak}`);
  });
});

test('全部导出 ZIP：8 个 WAV + results.json，可解包', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnExportAll'),
    ]);
    assert.equal(dl.suggestedFilename(), 'sweep-harmonic-export.zip');
    const tmp = path.join(ROOT, '.cache', 'test-downloads');
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, 'export.zip');
    await dl.saveAs(file);
    const entries = await Zip.unzip(new Uint8Array(fs.readFileSync(file)));
    const wavs = [...entries.keys()].filter((n) => n.endsWith('.wav'));
    assert.equal(wavs.length, 8, `WAV 数量 ${wavs.length}`);
    assert.ok(entries.has('results.json'));
    const json = JSON.parse(new TextDecoder().decode(entries.get('results.json')));
    assert.equal(json.channels.length, 2);
    assert.equal(json.params.hi, 1300);
    assert.match(json.formula.inverseSweep, /x\[N-1-j\]/);
    for (const ch of json.channels) {
      assert.equal(ch.windows.length, 4);
      for (const w of ch.windows) assert.ok(w.energy > 0);
    }
    // 抽查一个导出文件
    const one = Wav.decode(entries.get('ch2_q1_f48732-49291.wav'));
    assert.equal(one.frames, 560);
  });
});

test('导出结果 JSON 含全部窗口与定标值', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnExportJson'),
    ]);
    assert.equal(dl.suggestedFilename(), 'sweep-harmonic-results.json');
    const tmp = path.join(ROOT, '.cache', 'test-downloads');
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, 'results.json');
    await dl.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(json.sampleRate, 48000);
    assert.equal(json.channels[0].zero, 48479);
    assert.ok(Math.abs(json.channels[0].calibrator - 1001.149401094645) < 1e-9);
    assert.equal(json.channels[1].windows[1].start, 41026);
  });
});

test('主题切换：浅/深两套颜色都在 Canvas 上生效', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    // 只统计不透明像素（画布本身是透明的，透明像素按 0 计会污染均值）
    const sample = () => page.evaluate(() => {
      const cv = document.getElementById('cvOverview');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
    await page.click('.theme button[data-t="light"]');
    await page.waitForTimeout(120);
    const light = await sample();
    await page.click('.theme button[data-t="dark"]');
    await page.waitForTimeout(120);
    const dark = await sample();
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    assert.ok(lum(light) > lum(dark) + 20, `浅色 ${light} 应比深色 ${dark} 亮`);
    // 页面底色也要跟着切换（Canvas 与 CSS 用同一组角色变量）
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim());
    assert.equal(bg, '#1a1a19');
    await page.click('.theme button[data-t="light"]');
    await page.waitForTimeout(120);
    const bg2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim());
    assert.equal(bg2, '#fcfcfb');
  });
});

test('窄屏 380px：布局不横向溢出，图表仍绘制', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `横向溢出 ${overflow}px`);
    const drawn = await page.evaluate(() => {
      const cv = document.getElementById('cvOverview');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) > 20) colored++;
      return colored;
    });
    assert.ok(drawn > 50, '窄屏总览应有彩色笔迹');
  }, { width: 380, height: 900 });
});

test('载入示例包按钮：走 HTTP 读取 samples/ 下的 ZIP', { skip }, async () => {
  await withPage(async (page) => {
    await page.click('#btnSample');
    await page.waitForFunction(() => {
      const s = window.__shm && window.__shm.state;
      return s && s.results.length === 2 && !s.busy;
    }, null, { timeout: 30000 });
    const st = await stateOf(page);
    assert.equal(st.results[0].zero, 48479);
  });
});

test('窗宽超上限：拒绝并提示，不产生巨大分配', { skip }, async () => {
  await withPage(async (page) => {
    await loadSample(page);
    const before = await stateOf(page);
    await page.fill('#inPre', '4000000');
    await page.dispatchEvent('#inPre', 'change');
    await page.waitForTimeout(400);
    assert.equal(await page.isVisible('#paramErr'), true);
    const msg = await page.textContent('#paramErrText');
    assert.match(msg, /上限|超过/);
    // 结果保持上一次有效状态，不被清空
    const after = await stateOf(page);
    assert.equal(after.results.length, before.results.length);
    assert.equal(after.params.pre, 80, '非法值不生效');
  });
});

test('坏 ZIP：报中文原因且不产生结果', { skip }, async () => {
  await withPage(async (page) => {
    const tmp = path.join(ROOT, '.cache', 'test-downloads');
    fs.mkdirSync(tmp, { recursive: true });
    const bad = path.join(tmp, 'bad.zip');
    fs.writeFileSync(bad, Buffer.from('PK\x03\x04 broken archive'));
    await page.setInputFiles('#fileInput', bad);
    await page.waitForTimeout(400);
    assert.equal(await page.isVisible('#importErr'), true);
    const msg = await page.textContent('#importErrText');
    assert.match(msg, /ZIP|解包/);
    const n = await page.evaluate(() => window.__shm.state.results.length);
    assert.equal(n, 0);
  });
});
