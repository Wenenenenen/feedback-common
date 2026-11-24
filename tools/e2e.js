#!/usr/bin/env node
// 端到端浏览器测试：file:// 打开 index.html，验证渲染、检视、错误保留、压力预算。
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(process.env.HOME, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(URL);
  await sleep(300);

  // 1. 首帧自动渲染内置样例
  const status = await page.textContent('#statusText');
  if (!status.includes('运行成功')) throw new Error('首帧未自动渲染: ' + status);
  const pillInsn = await page.textContent('#pillInsn');
  console.log('1) 首帧:', status, '|', pillInsn.trim());

  // 2. 点击像素检视
  await page.click('canvas#screen', { position: { x: 20, y: 20 } });
  await sleep(100);
  const insp = await page.textContent('#inspBody');
  if (!insp.includes('quad #0') || !insp.includes('LOD')) throw new Error('检视面板缺少 quad/LOD 内容');
  if (!insp.includes('最终 RGB')) throw new Error('检视面板缺少最终 RGB');
  console.log('2) 检视面板 OK，含:', insp.replace(/\s+/g, ' ').slice(0, 160));

  // 3. 载入功能用例（通过注入 fetch 替代不了 file input，直接用页面引擎跑 cases 文件）
  const cases = ['basic.json', 'derivatives.json', 'discards_depth.json', 'zero_deriv.json'];
  for (const cf of cases) {
    const pkg = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'tools/cases', cf), 'utf8'));
    const res = await page.evaluate((p) => {
      const r = window.QuadEngine.validateAndRun(p);
      return r.ok ? { ok: true, ms: r.timings.total, covered: r.state.frame.alpha.reduce((s, a) => s + a, 0) }
        : { ok: false, errors: r.errors };
    }, pkg);
    if (!res.ok) throw new Error(`${cf} 浏览器引擎报错: ${JSON.stringify(res.errors)}`);
    console.log(`3) ${cf.padEnd(20)} 浏览器引擎 OK ${res.ms.toFixed(1)}ms 覆盖=${res.covered}`);
  }

  // 4. 坏包：标行号 + 保留上一次画面
  const bad = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'samples/quad-program.json'), 'utf8'));
  bad.program.push(['纹理', 'x', 'u', 'v', 9]);
  await page.setInputFiles('#fileInput', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await sleep(200);
  const errVisible = await page.isVisible('#errors');
  const errText = await page.textContent('#errList');
  const staleVisible = await page.isVisible('#staleNote');
  const exportStillEnabled = await page.isEnabled('#exportBtn');
  if (!errVisible || !errText.includes('第 2 行') || !staleVisible || !exportStillEnabled)
    throw new Error(`坏包处理不符: visible=${errVisible} text="${errText}" stale=${staleVisible} exportEnabled=${exportStillEnabled}`);
  console.log('4) 坏包行号/旧画面保留 OK:', errText.replace(/\s+/g, ' '));

  // 5. 压力测试：点按钮跑 25 万组，测 10 秒预算
  const t0 = Date.now();
  await page.click('#stressBtn');
  await page.waitForFunction(() => {
    const t = document.getElementById('statusText').textContent;
    return t.includes('运行成功') || t.includes('校验失败');
  }, { timeout: 60000 });
  const wall = Date.now() - t0;
  const stressStatus = await page.textContent('#statusText');
  const stressTime = await page.textContent('#pillTime');
  const stressQuad = await page.textContent('#pillQuad');
  if (!stressStatus.includes('运行成功')) throw new Error('压力包运行失败: ' + stressStatus);
  console.log(`5) 压力包: ${stressQuad.trim()} ${stressTime.trim()} 端到端等待=${wall}ms（预算 10000ms）`);
  if (wall > 10000) throw new Error(`压力场景超出 10 秒预算: ${wall}ms`);

  // 压力后检视仍可用
  await page.click('canvas#screen', { position: { x: 250, y: 250 } });
  await sleep(100);
  const insp2 = await page.textContent('#inspBody');
  if (!insp2.includes('LOD') || !insp2.includes('胜者')) throw new Error('压力后检视面板异常');
  console.log('6) 压力后像素检视 OK');

  // 7. 导出按钮产生两个下载（二进制 + meta.json），全部收集后分别校验
  const downloads = [];
  const onDl = (d) => downloads.push(d);
  page.on('download', onDl);
  await page.click('#exportBtn');
  for (let i = 0; i < 50 && downloads.length < 2; i++) await sleep(100);
  page.off('download', onDl);
  if (downloads.length < 2) throw new Error(`期望 2 个下载，实际 ${downloads.length}`);
  const bins = [];
  for (const dl of downloads) {
    const stream = await dl.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    bins.push({ name: dl.suggestedFilename(), buf: Buffer.concat(chunks) });
  }
  const bin = bins.find((b) => b.name.endsWith('.bin'));
  const meta = bins.find((b) => b.name.endsWith('.json'));
  const expectBytes = 512 * 512 * 16;
  if (!bin || bin.buf.length !== expectBytes) throw new Error(`二进制导出异常: ${JSON.stringify(bins.map((b) => [b.name, b.buf.length]))}`);
  if (!meta || !meta.buf.toString('utf8').includes('binary32 little-endian')) throw new Error('meta.json 内容异常');
  console.log(`7) 导出 OK: ${bin.name} ${bin.buf.length} 字节 + ${meta.name} ${meta.buf.length} 字节`);

  if (consoleErrors.length) throw new Error('控制台错误: ' + consoleErrors.join(' | '));
  console.log('\n全部端到端检查通过，无控制台错误。');
  await browser.close();
}

main().catch((e) => { console.error('E2E FAIL:', e); process.exit(1); });
