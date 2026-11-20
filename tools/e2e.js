// 真实浏览器端到端测试（Playwright + 缓存的 headless Chromium）。
// 覆盖：两种加载方式（http 源模块 / dist 经典脚本 + file://）、样例、
// 参数联动重算、取消、旧任务不覆盖新结果、组检查器、边界图、零噪声、导出。

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/');
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC =
  process.env.PLAYWRIGHT_CHROMIUM ||
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`;
const PORT = Number(process.env.PORT) || 8237;
const BASE = `http://localhost:${PORT}/app/`;

let failures = 0;
const results = [];
function check(cond, msg, detail = '') {
  results.push({ ok: !!cond, msg });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? ' — ' + detail : ''}`);
}

function waitFor(fn, arg, timeout = 30000, label = 'condition') {
  return page.waitForFunction(fn, arg, { timeout }).catch((e) => {
    throw new Error(`等待超时：${label}（${e.message.split('\n')[0]}）`);
  });
}

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve) => server.stdout.once('data', resolve));

let browser;
let page;
const pageErrors = [];

async function newPage(opts = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1100 }, ...opts });
  p.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text());
  });
  return p;
}

const getState = () => page.evaluate(() => window.__GTD.getState());
const setParam = (id, value) =>
  page.evaluate(([id, value]) => {
    const el = document.getElementById(id);
    el.value = String(value);
    // 滑杆与下拉都按真实交互顺序触发 input → change
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);

async function waitIdle(predicate, timeout = 60000) {
  // 轮询式等待，避免在页面上下文里用 new Function 构造表达式。
  const deadline = Date.now() + timeout;
  const fn = new Function('s', `return (${predicate});`);
  for (;;) {
    const s = await page.evaluate(() => window.__GTD.getState());
    if (!s.jobPending && fn(s)) return s;
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${predicate}；当前 ${JSON.stringify({ params: s.resultParams, stale: s.stale, pending: s.jobPending })}`);
    }
    await page.waitForTimeout(80);
  }
}

try {
  browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });

  // ---------------------------------------------------------------- 源模块模式
  page = await newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await waitFor(() => window.__GTD && window.__GTD.getState().resultParams, null, 30000, '初始运行');
  let s = await getState();
  check(s.image.width === 48 && s.image.height === 40, 'http 模式加载样例 48×40');
  check(s.resultParams.patch === 4 && s.resultParams.capacity === 4, '默认参数 p=4 K=4');
  check(!s.zeroNoise && Array.isArray(s.finalSample), '两阶段结果生成');
  check((await page.textContent('#statusText')).includes('完成'), '状态行显示完成');
  const psnrText = await page.textContent('#mPsnr');
  check(/最终\s*30\./.test(psnrText), '样例 PSNR 与参考一致（最终约 30.3 dB）', psnrText);

  // 四视图 canvas 有内容
  const viewSizes = await page.evaluate(() =>
    ['Original', 'Pilot', 'Final', 'Weight'].map((id) => {
      const c = document.getElementById('canvas' + id);
      return { id, w: c.width, h: c.height };
    }),
  );
  check(
    viewSizes.every((v) => v.w === 48 && v.h === 40),
    '原图/初估/最终/权重四个视图都渲染',
    JSON.stringify(viewSizes),
  );

  // 参数变化 → 自动重算 → 结果参数更新
  await setParam('patch', 8);
  await waitIdle("s.resultParams && s.resultParams.patch === 8 && !s.stale");
  s = await getState();
  check(s.resultParams.patch === 8 && s.resultParams.stride === 2, '改图块大小后自动重算');
  await setParam('stride', 4);
  await waitIdle("s.resultParams.stride === 4 && !s.stale");
  s = await getState();
  check(s.resultParams.stride === 4, '改步长后重算');
  await setParam('capacity', 8);
  await waitIdle('s.resultParams.capacity === 8 && !s.stale');
  await setParam('radius', 7);
  await page.waitForFunction(() => document.getElementById('radiusVal').textContent === '7');
  await waitIdle('s.resultParams.radius === 7 && !s.stale');
  await setParam('sigma', 9);
  await waitIdle('s.resultParams.sigma === 9 && !s.stale');
  s = await getState();
  check(s.resultParams.radius === 7 && s.resultParams.sigma === 9, '搜索半径 / σ 均生效');

  // 改参数但尚未重算，结果标记为旧参数
  await setParam('threshold', 3.4);
  const staleVisible = await page.evaluate(() => !document.getElementById('staleNote').hidden);
  check(staleVisible, '改参数未重算时提示“结果为旧参数”');
  await setParam('threshold', 2.7);
  await page.evaluate(() => window.__GTD.run());
  await waitIdle('s.resultParams.threshold === 2.7 && !s.stale');

  // 组检查器：点击图像选点
  await page.evaluate(() => window.__GTD.selectPatch(8, 8));
  await waitFor(() => window.__GTD.getState().inspect, null, 10000, '检查器');
  const insp = await page.evaluate(() => window.__GTD.getState().inspect);
  check(insp.m1 >= 2 && insp.m2 >= 2, '检查器返回两阶段组员', `m1=${insp.m1} m2=${insp.m2}`);
  check(insp.members[0].y === 8 && insp.members[0].x === 8 && insp.members[0].distance === 0, '组首成员为参考自身且距离 0');
  const currentPatch = (await getState()).resultParams.patch;
  check(
    insp.matrixDct?.length === currentPatch * currentPatch && insp.memberGain0?.length === currentPatch * currentPatch,
    'DCT 系数与增益矩阵为 p²',
    `p=${currentPatch} dct=${insp.matrixDct?.length}`,
  );
  const summaryText = await page.textContent('#inspectSummary');
  check(/组员/.test(summaryText) && /组权重/.test(summaryText), '检查器摘要显示组员与组权重');
  // 切换阶段 / 模式
  await page.evaluate(() => window.__GTD.setStage(2));
  await page.evaluate(() => window.__GTD.setMode('gain'));
  await page.waitForTimeout(120);
  const gainTitle = await page.textContent('#matrixTitle');
  check(/增益/.test(gainTitle), '维纳阶段可查看增益矩阵', gainTitle);
  const gainBtnDisabled = await page.evaluate(() =>
    document.querySelector('#modeTabs [data-mode="gain"]').disabled,
  );
  await page.evaluate(() => window.__GTD.setStage(1));
  await page.waitForTimeout(100);
  const gainBtnDisabled1 = await page.evaluate(() =>
    document.querySelector('#modeTabs [data-mode="gain"]').disabled,
  );
  check(!gainBtnDisabled && gainBtnDisabled1, '增益仅在维纳阶段可用');
  await page.evaluate(() => window.__GTD.setMode('group'));
  await page.evaluate(() => window.__GTD.setMember(1));
  await page.waitForTimeout(100);
  const memberTitle = await page.textContent('#matrixTitle');
  check(/#1/.test(memberTitle), '可切换查看其他组员', memberTitle);

  // 真实鼠标点击画布拾取
  const box = await page.locator('#canvasFinal').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6);
  await page.waitForTimeout(150);
  s = await getState();
  check(s.selected && s.selected.y >= 0 && s.selected.x >= 0, '点击视图可拾取图块', JSON.stringify(s.selected));
  const overlaySeen = await page.evaluate(() => {
    const overlay = document.getElementById('overlayFinal');
    if (!overlay.width) return false;
    const ctx = overlay.getContext('2d');
    const { data } = ctx.getImageData(0, 0, overlay.width, overlay.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return painted > 0;
  });
  check(overlaySeen, '选中图块在视图上以叠加层高亮');

  // 权重阶段切换
  await page.selectOption('#weightStage', '1');
  await page.waitForTimeout(100);
  const wm1 = await page.textContent('#metaWeight');
  await page.selectOption('#weightStage', '2');
  await page.waitForTimeout(100);
  const wm2 = await page.textContent('#metaWeight');
  check(/阶段 1/.test(wm1) && /阶段 2/.test(wm2), '聚合权重视图可切换阶段', `${wm1} | ${wm2}`);

  // 规则自检按钮
  await page.click('#selfTest');
  await page.waitForFunction(() => document.getElementById('selfTestOut').textContent.includes('PASS'), null, { timeout: 5000 });
  const selfText = await page.textContent('#selfTestOut');
  check((selfText.match(/PASS/g) || []).length >= 5 && !/FAIL/.test(selfText), '内置规则自检全部通过');

  // 加载 1×9 / 1×1 样例
  for (const [id, w, h] of [['thin', 1, 9], ['single', 1, 1]]) {
    await page.selectOption('#sampleSelect', id);
    await page.waitForFunction(
      ([w, h]) => {
        const st = window.__GTD.getState();
        return st.image.width === w && st.image.height === h && !st.jobPending && st.resultParams;
      },
      [w, h],
      { timeout: 20000 },
    );
    const st = await getState();
    check(Number.isFinite(st.finalSample[0]), `${id} 样例可计算（${w}×${h}）`);
  }

  // σ=0 原样返回
  await page.selectOption('#sampleSelect', 'noisy');
  await waitIdle('s.image && s.image.width === 48 && !s.jobPending && s.resultParams');
  await setParam('sigma', 0);
  await waitIdle('s.zeroNoise === true');
  const zero = await page.evaluate(() => {
    const a = document.getElementById('canvasOriginal').toDataURL();
    const b = document.getElementById('canvasFinal').toDataURL();
    return { equal: a === b, final: window.__GTD.getState().finalSample.slice(0, 8) };
  });
  check(zero.equal, 'σ=0 时最终图与原图逐像素一致');
  check(
    JSON.stringify(zero.final) === JSON.stringify([72, 104, 120, 129, 58, 56, 47, 63]),
    'σ=0 返回原始像素值',
  );
  check((await page.textContent('#metaFinal')).includes('σ = 0'), '最终视图标注原样返回');
  await setParam('sigma', 18);
  await waitIdle('s.resultParams.sigma === 18 && !s.stale');

  // 取消 & 旧任务不覆盖
  const bigB64 = await readFile(join(ROOT, 'test', 'fixtures', 'big-256.png')).then((b) => b.toString('base64'));
  await page.evaluate((b) => window.__GTD.importBase64(b, 'big-256.png'), bigB64);
  await waitIdle('s.image.width === 256 && s.resultParams');
  await setParam('patch', 8);
  await setParam('capacity', 8);
  await setParam('radius', 12);
  await page.waitForTimeout(120);
  const wasPending = (await getState()).jobPending;
  await page.click('#cancelBtn');
  await page.waitForTimeout(400);
  s = await getState();
  check(wasPending && !s.jobPending, '处理可取消');
  check((await page.textContent('#statusText')).includes('已取消'), '取消后状态行明确');
  check(s.finalSample !== null, '取消后保留上一次完成的结果');

  // 快速连续改参数：最终结果必须对应最后一次参数
  await setParam('patch', 4);
  await page.waitForTimeout(60);
  await setParam('patch', 8);
  await waitIdle('s.resultParams && s.resultParams.patch === 8 && !s.jobPending', 90000);
  await page.waitForTimeout(2500);
  s = await getState();
  check(s.resultParams.patch === 8 && s.resultParams.radius === 12 && s.resultParams.capacity === 8, '旧任务没有覆盖新参数结果', JSON.stringify(s.resultParams));

  // 256×256 完成后的耗时展示与权重无空洞
  check(s.weight2Sample.every((v) => v > 0), '256×256 结果无零权重像素');
  check(s.timing.totalMs > 0, '报告两阶段耗时', `${Math.round(s.timing.totalMs)} ms`);

  // 导出：逐个拦截下载并按内容校验
  const outDir = mkdtempSync(join(tmpdir(), 'gtd-e2e-'));
  const downloads = {};
  for (const kind of ['pilot', 'final', 'float', 'report', 'zip']) {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate((k) => window.__GTD.exportKind(k), kind),
    ]);
    const file = join(outDir, `${kind}-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    downloads[kind] = { file, name: dl.suggestedFilename() };
  }
  const { decodePNG } = await import('../lib/png.js');
  const finalPng = await decodePNG(await readFile(downloads.final.file));
  s = await getState();
  check(finalPng.width === 256 && finalPng.height === 256, '导出最终 PNG 尺寸正确');
  check(/-final\.png$/.test(downloads.final.name), '导出文件名含阶段标识');
  const npyBuf = await readFile(downloads.float.file);
  check(npyBuf.slice(0, 6).equals(Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])), '导出浮点结果 .npy 头部正确');
  check(npyBuf.length === 10 + (npyBuf[8] | (npyBuf[9] << 8)) + 4 * 256 * 256 * 8, '浮点结果包含两阶段与两组权重');
  const report = JSON.parse(await readFile(downloads.report.file, 'utf8'));
  check(
    report.params.patch === 8 && report.params.radius === 12 && report.image.width === 256,
    '参数报告记录参数与尺寸',
  );
  check(report.stages.stage1.groups > 0 && report.stages.stage2.groups > 0, '报告含两阶段组统计');
  check(/float-result\.npy|npy/.test(JSON.stringify(report.exports)), '报告说明浮点结果格式');
  const zipBuf = await readFile(downloads.zip.file);
  check(zipBuf[0] === 0x50 && zipBuf[1] === 0x4b, '导出结果包为 ZIP');

  // 暗色模式无错误
  const darkPage = await newPage({ colorScheme: 'dark' });
  await darkPage.goto(BASE, { waitUntil: 'networkidle' });
  await darkPage.waitForFunction(() => window.__GTD?.getState()?.resultParams, null, { timeout: 30000 });
  await darkPage.evaluate(() => window.__GTD.selectPatch(8, 8));
  await darkPage.waitForTimeout(200);
  const darkBg = await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(darkBg === 'rgb(13, 13, 13)', '暗色模式生效', darkBg);
  await darkPage.close();

  // ---------------------------------------------------------------- dist + file://
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'tools', 'build.js')], { cwd: ROOT });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('build 失败'))));
  });
  const distPage = await newPage();
  const distErrors = [];
  distPage.on('pageerror', (e) => distErrors.push(e.message));
  await distPage.goto('file://' + join(ROOT, 'dist', 'index.html'));
  await distPage.waitForFunction(() => window.__GTD?.getState()?.resultParams, null, { timeout: 30000 });
  const distState = await distPage.evaluate(() => window.__GTD.getState());
  check(distState.image.width === 48 && distState.resultParams.patch === 4, 'dist 经典脚本可在 file:// 直接运行');
  check(distErrors.length === 0, 'dist 模式无页面错误', distErrors.slice(0, 2).join(' | '));
  const distPsnr = await distPage.textContent('#mPsnr');
  check(/最终\s*30\./.test(distPsnr), 'dist 模式结果与源模块一致', distPsnr);
  await distPage.close();

  check(pageErrors.length === 0, '全程无页面/控制台错误', pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check(false, '端到端流程未抛出异常', err.message);
} finally {
  if (browser) await browser.close();
  server.kill();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过，${failures} 失败`);
  process.exitCode = failures ? 1 : 0;
}
