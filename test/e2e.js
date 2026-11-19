// 真实浏览器端到端测试（Playwright + 本地缓存的 headless Chromium）。
// 覆盖：样例加载、参考实现对齐、视图切换（权重/主导/差值/原图）、层数调整、
// 画笔锁定（结果像素必须完全等于所选原图）、导出 PNG/标签/项目 JSON、项目回环。
import { createRequire } from 'node:module';
const require = createRequire('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/');
const { chromium } = require('playwright');
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng } from '../js/png.js';
import { runStack, applyLock } from '../js/core.js';
import { decodeProject } from '../js/project.js';
import { extractSamples } from '../tools/extract-samples.js';

const SAMPLES = await extractSamples();

const BASE = process.env.BASE || 'http://localhost:8127';
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });

// ---------- 1. 样例初次结果与参考实现一致 ----------
{
  const focus = [];
  for (const name of ['focus-0.png', 'focus-1.png', 'focus-2.png']) {
    const d = await decodePng(await readFile(join(SAMPLES, name)));
    focus.push({ name, width: d.width, height: d.height, rgb8: d.rgb8 });
  }
  const lockImg = await decodePng(await readFile(join(SAMPLES, 'lock.png')));
  const ref = runStack({ images: focus, levels: 5 });
  const refLocked = applyLock(ref.fusedRgb8, lockImg.gray8, focus, ref.width * ref.height);

  const pagePixels = await page.evaluate(() => {
    const r = window.__state.result;
    return { w: r.width, h: r.height, fused: Array.from(r.fusedRgb8), locked: Array.from(r.lockedRgb8) };
  });
  let diffs = 0;
  for (let i = 0; i < ref.fusedRgb8.length; i++) if (pagePixels.fused[i] !== ref.fusedRgb8[i]) diffs++;
  check(diffs === 0, `页面融合结果与 Node 参考逐字节一致（差异 ${diffs}）`);

  let lockDiffs = 0;
  for (let i = 0; i < refLocked.rgb8.length; i++) if (pagePixels.locked[i] !== refLocked.rgb8[i]) lockDiffs++;
  check(lockDiffs === 0, `页面锁定结果与参考一致（差异 ${lockDiffs}）`);
  check((await page.textContent('#statusLine')).includes('5 层'), '状态行显示 5 层');
  check((await page.textContent('#lockCount')).includes('224'), `锁定计数 = 224（${await page.textContent('#lockCount')}）`);
}

// ---------- 2. 锁定区域确实来自 focus-1 ----------
{
  const lockImg = await decodePng(await readFile(join(SAMPLES, 'lock.png')));
  const f1 = await decodePng(await readFile(join(SAMPLES, 'focus-1.png')));
  const bad = await page.evaluate(
    ({ labels, src }) => {
      const r = window.__state.result;
      let mismatch = 0;
      let outsideChanged = 0;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] === 2) {
          for (let c = 0; c < 3; c++) if (r.lockedRgb8[i * 3 + c] !== src[i * 3 + c]) mismatch++;
        } else {
          for (let c = 0; c < 3; c++) if (r.lockedRgb8[i * 3 + c] !== r.fusedRgb8[i * 3 + c]) outsideChanged++;
        }
      }
      return { mismatch, outsideChanged };
    },
    { labels: Array.from(lockImg.gray8), src: Array.from(f1.rgb8) },
  );
  check(bad.mismatch === 0, `锁定像素逐字节等于 focus-1（不一致 ${bad.mismatch}）`);
  check(bad.outsideChanged === 0, `未锁定像素保持自动融合（被改 ${bad.outsideChanged}）`);
}

// ---------- 3. 视图切换与画布像素 ----------
{
  // 主导来源视图：swath 中心颜色应为对应调色板色
  await page.click('button[data-view="dominant"]');
  await page.waitForTimeout(120);
  const dom = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const z = c.width / window.__state.result.width;
    const ctx = c.getContext('2d');
    const sample = (x, y) => Array.from(ctx.getImageData(x * z + Math.floor(z / 2), y * z + Math.floor(z / 2), 1, 1).data.slice(0, 3));
    return { left: sample(5, 24), mid: sample(30, 24), right: sample(50, 24), palette: window.__palette };
  });
  check(JSON.stringify(dom.left) === JSON.stringify(dom.palette[0]), `swath0 主导色 #1（${dom.left}）`);
  check(JSON.stringify(dom.mid) === JSON.stringify(dom.palette[1]), `swath1 主导色 #2（${dom.mid}）`);
  check(JSON.stringify(dom.right) === JSON.stringify(dom.palette[2]), `swath2 主导色 #3（${dom.right}）`);

  // 权重图：像素值随所选帧变化
  await page.click('button[data-view="weight"]');
  await page.waitForTimeout(120);
  const w0 = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const z = c.width / window.__state.result.width;
    const ctx = c.getContext('2d');
    return Array.from(ctx.getImageData(5 * z + 1, 24 * z + 1, 1, 1).data.slice(0, 3));
  });
  await page.selectOption('#weightIndex', '1');
  await page.waitForTimeout(120);
  const w1 = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const z = c.width / window.__state.result.width;
    const ctx = c.getContext('2d');
    return Array.from(ctx.getImageData(5 * z + 1, 24 * z + 1, 1, 1).data.slice(0, 3));
  });
  check(w0[0] > 200 && w1[0] < 60, `swath0 的 W1 高（${w0[0]}）而 W2 低（${w1[0]}）`);

  // 差值视图：对主导硬选择，差异应为小块非零；统计非黑像素
  await page.selectOption('#weightIndex', '0');
  await page.click('button[data-view="diff"]');
  await page.waitForTimeout(150);
  const diffStats = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return { lit, total: d.length / 4, hint: document.getElementById('viewHint').textContent };
  });
  check(diffStats.lit > 0 && diffStats.lit < diffStats.total, `差值图在交界处有非零像素（${diffStats.lit}/${diffStats.total}）`);
  check(diffStats.hint.includes('平均'), `差值统计显示（${diffStats.hint}）`);

  // 原图视图显示第 1 帧
  await page.click('button[data-view="source"]');
  await page.waitForTimeout(120);
  const srcPx = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const z = c.width / window.__state.result.width;
    return Array.from(c.getContext('2d').getImageData(5 * z + 1, 10 * z + 1, 1, 1).data.slice(0, 3));
  });
  check(JSON.stringify(srcPx) === JSON.stringify([45, 53, 37]), `原图视图显示 focus-0 的棋盘格（${srcPx}）`);
  await page.click('button[data-view="result"]');
}

// ---------- 4. 层数调整 ----------
{
  const before = await page.evaluate(() => Array.from(window.__state.result.fusedRgb8));
  await page.fill('#levelsInput', '3');
  await page.dispatchEvent('#levelsInput', 'input');
  await page.waitForFunction(() => window.__state.result.levels === 3, { timeout: 10000 });
  const after = await page.evaluate(() => Array.from(window.__state.result.fusedRgb8));
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  check(changed > 0, `层数 5→3 改变了结果（${changed} 个字节不同）`);
  check((await page.textContent('#levelsOut')).includes('3'), '层数读数更新为 3');
  const lv = await page.evaluate(() => window.__state.result.stats.weightLevels.length);
  check(lv === 3, `层诊断有 3 层（实际 ${lv}）`);

  // 1 层与 6 层都可运行
  for (const L of ['1', '6']) {
    await page.fill('#levelsInput', L);
    await page.dispatchEvent('#levelsInput', 'input');
    await page.waitForFunction((n) => window.__state.result.levels === Number(n), L, { timeout: 15000 });
    check(true, `${L} 层计算完成`);
  }
  await page.fill('#levelsInput', '5');
  await page.dispatchEvent('#levelsInput', 'input');
  await page.waitForFunction(() => window.__state.result.levels === 5, { timeout: 15000 });
}

// ---------- 5. 画笔锁定：画一笔，结果必须完全等于所选原图 ----------
{
  // 选择第 3 帧作为画笔来源，半径 2
  await page.selectOption('#brushLabel', '3');
  await page.fill('#brushSize', '2');
  await page.dispatchEvent('#brushSize', 'input');
  const box = await page.evaluate(() => {
    const c = document.getElementById('viewCanvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // 在图像右上角（原是自动区域）拖一笔
  const z = await page.evaluate(() => document.getElementById('viewCanvas').width / window.__state.result.width);
  const px = (x, y) => ({ x: box.x + ((x * z + z / 2) / box.w) * box.w, y: box.y + ((y * z + z / 2) / box.h) * box.h });
  const a = px(50, 5);
  const b = px(60, 5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const res = await page.evaluate(() => {
    const st = window.__state;
    const r = st.result;
    const src = st.images[2].rgb8;
    let labels3 = 0;
    let mismatch = 0;
    let outside = 0;
    for (let i = 0; i < st.labels.length; i++) {
      if (st.labels[i] === 3) {
        labels3++;
        for (let c = 0; c < 3; c++) if (r.lockedRgb8[i * 3 + c] !== src[i * 3 + c]) mismatch++;
      }
    }
    // 自动融合图不应被改动
    return { labels3, mismatch, count: document.getElementById('lockCount').textContent };
  });
  check(res.labels3 > 0, `笔画写入标签 3 的像素 ${res.labels3} 个`);
  check(res.mismatch === 0, `新锁定像素完全取自第 3 张原图（不一致 ${res.mismatch}）`);
  check(res.count.includes('#3'), `锁定计数包含 #3（${res.count}）`);

  // 锁定后自动权重不变
  const weightSum = await page.evaluate(() => {
    const r = window.__state.result;
    let maxDev = 0;
    for (let i = 0; i < r.width * r.height; i++) {
      let s = 0;
      for (const w of r.weights) s += w[i];
      maxDev = Math.max(maxDev, Math.abs(s - 1));
    }
    return maxDev;
  });
  check(weightSum < 1e-5, `锁定不改自动权重：逐像素权重和 = 1（偏差 ${weightSum}）`);

  // 撤销：标签 3 消失
  await page.click('#undoBtn');
  await page.waitForTimeout(200);
  const afterUndo = await page.evaluate(() => {
    const st = window.__state;
    let labels3 = 0;
    for (let i = 0; i < st.labels.length; i++) if (st.labels[i] === 3) labels3++;
    return labels3;
  });
  check(afterUndo === 0, `撤销后不再有标签 3 像素（剩余 ${afterUndo}）`);
}

// ---------- 6. 导出 PNG / 锁定标签 / 项目 JSON ----------
let exportedProject = null;
{
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportPngBtn')]);
  const pngPath = '/tmp/fps-e2e-result.png';
  await dl.saveAs(pngPath);
  const bytes = await readFile(pngPath);
  check(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[24] === 8 && bytes[25] === 2, `合成 PNG 为 8 位真彩（depth ${bytes[24]}, type ${bytes[25]}）`);
  const dec = await decodePng(bytes);
  const expect = await page.evaluate(() => Array.from(window.__state.result.lockedRgb8));
  let diff = 0;
  for (let i = 0; i < expect.length; i++) if (dec.rgb8[i] !== expect[i]) diff++;
  check(diff === 0, `导出的合成 PNG 与页面结果逐字节一致（${dec.width}×${dec.height}）`);
  check(dec.width === 65 && dec.height === 49, '导出尺寸 65×49');

  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exportLockBtn')]);
  const lockPath = '/tmp/fps-e2e-lock.png';
  await dl2.saveAs(lockPath);
  const lockDec = await decodePng(await readFile(lockPath));
  check(lockDec.colorType === 0 && lockDec.gray8 !== null, '锁定标签 PNG 为 8 位灰度');
  const sameLabels = await page.evaluate((labels) => {
    const st = window.__state;
    let diff = 0;
    for (let i = 0; i < st.labels.length; i++) if (st.labels[i] !== labels[i]) diff++;
    return diff;
  }, Array.from(lockDec.gray8));
  check(sameLabels === 0, '标签 PNG 与页面标签逐字节一致');

  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#exportProjectBtn')]);
  const projPath = '/tmp/fps-e2e-project.json';
  await dl3.saveAs(projPath);
  exportedProject = JSON.parse(await readFile(projPath, 'utf8'));
  check(exportedProject.format === 'focus-pyramid-stack-project' && exportedProject.parameters.levels === 5, `项目 JSON 记录格式与层数（L${exportedProject.parameters.levels}）`);
  check(Array.isArray(exportedProject.inputs) && exportedProject.inputs.length === 3, '项目 JSON 记录 3 张输入与顺序');
  check(exportedProject.lock && exportedProject.lock.lockedPixels === 224, `项目 JSON 记录锁定标签（${exportedProject.lock && exportedProject.lock.lockedPixels}）`);
  const back = await decodeProject(exportedProject);
  check(back.levels === 5 && back.images.length === 3 && back.labels && back.labels.length === 65 * 49, '项目 JSON 可被 Node 端解码回完整输入');
}

// ---------- 7. 导出项目可重新导入并继续修改 ----------
{
  const errsBefore = errors.length;
  const input = page.locator('#projectFile');
  await input.setInputFiles('/tmp/fps-e2e-project.json');
  await page.waitForFunction(() => window.__state.projectName === 'fps-e2e-project.json', { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
  const info = await page.evaluate(() => {
    const st = window.__state;
    let mismatch = 0;
    let locked = 0;
    for (let i = 0; i < st.labels.length; i++) {
      const label = st.labels[i];
      if (label >= 1) {
        locked++;
        const src = st.images[label - 1].rgb8;
        for (let c = 0; c < 3; c++) if (st.result.lockedRgb8[i * 3 + c] !== src[i * 3 + c]) mismatch++;
      } else {
        for (let c = 0; c < 3; c++) if (st.result.lockedRgb8[i * 3 + c] !== st.result.fusedRgb8[i * 3 + c]) mismatch++;
      }
    }
    return {
      n: st.images.length,
      levels: st.result.levels,
      lock: st.labels ? st.labels.filter((v) => v >= 1).length : 0,
      mismatch,
      locked,
    };
  });
  check(info.n === 3 && info.levels === 5, `重新导入后 3 张 / 5 层（${info.n} / ${info.levels}）`);
  check(info.lock === 224, `重新导入保留 224 个锁定像素（${info.lock}）`);
  check(info.mismatch === 0, `锁定像素仍逐字节取自原图、其余为自动融合（不一致 ${info.mismatch}）`);
  check(errors.length === errsBefore, '重新导入未产生页面错误');

  // 继续修改：改层数
  await page.fill('#levelsInput', '4');
  await page.dispatchEvent('#levelsInput', 'input');
  await page.waitForFunction(() => window.__state.result.levels === 4, { timeout: 15000 });
  const lockAfter = await page.evaluate(() => window.__state.labels.filter((v) => v >= 1).length);
  check(lockAfter === 224, '改层数后锁定标签保留');
  await page.fill('#levelsInput', '5');
  await page.dispatchEvent('#levelsInput', 'input');
  await page.waitForFunction(() => window.__state.result.levels === 5, { timeout: 15000 });
}

// ---------- 8. 相同输入与参数 → 相同结果 ----------
{
  const runOnce = async () => {
    await page.evaluate(() => window.__rerun());
    await page.waitForTimeout(50);
    await page.waitForFunction(() => window.__state && document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
    return page.evaluate(() => Array.from(window.__state.result.fusedRgb8));
  };
  // 先触发一次重算得到基线
  await page.evaluate(() => window.__rerun());
  await page.waitForTimeout(100);
  await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
  const a = await page.evaluate(() => Array.from(window.__state.result.fusedRgb8));
  await page.evaluate(() => window.__rerun());
  await page.waitForTimeout(100);
  await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
  const b = await page.evaluate(() => Array.from(window.__state.result.fusedRgb8));
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  check(d === 0, `重复运行结果逐字节相同（差异 ${d}）`);

  // 同样参数导出的项目 JSON 逐字节相同
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#exportProjectBtn')]);
  await dl1.saveAs('/tmp/fps-e2e-project-a.json');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exportProjectBtn')]);
  await dl2.saveAs('/tmp/fps-proj-b.json');
  const ja = await readFile('/tmp/fps-e2e-project-a.json');
  const jb = await readFile('/tmp/fps-proj-b.json');
  check(Buffer.compare(ja, jb) === 0, '相同输入与参数导出的项目 JSON 逐字节相同');
}

// ---------- 9. 低纹理样例 ----------
{
  await page.selectOption('#caseSelect', 'constant-2');
  await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
  const info = await page.evaluate(() => {
    const r = window.__state.result;
    let maxDev = 0;
    let nan = 0;
    for (let i = 0; i < r.width * r.height; i++) {
      for (const w of r.weights) {
        if (!Number.isFinite(w[i])) nan++;
        maxDev = Math.max(maxDev, Math.abs(w[i] - 0.5));
      }
    }
    return { maxDev, nan, invalid: r.stats.invalidWeightPixels, low: r.stats.lowTexturePixels, px: r.width * r.height };
  });
  check(info.nan === 0 && info.maxDev < 1e-6, `低纹理权重恒为 0.5（偏差 ${info.maxDev}）`);
  check(info.invalid === 0, '低纹理无无效权重');
  check(info.low === info.px, `全图标记为无纹理（${info.low}/${info.px}）`);
  await page.selectOption('#caseSelect', 'focus-3');
  await page.waitForFunction(() => document.getElementById('statusLine').textContent.includes('完成'), { timeout: 15000 });
}

// ---------- 10. 无错误 ----------
check(errors.length === 0, `浏览器无报错（${errors.length ? errors.join(' | ') : '干净'}）`);

await browser.close();
console.log(failures ? `\n${failures} 项失败` : '\n浏览器端到端全部通过');
process.exit(failures ? 1 : 0);
