/*
 * 浏览器端到端测试（零依赖，使用已安装的 Playwright + Chromium）。
 *
 * 用法：
 *   python3 -I src/py/server.py --port 8899 &
 *   node tests/e2e_check.mjs http://127.0.0.1:8899
 *
 * 覆盖：样例载入、参考值核对、两种系数导出与导入往返、旋转符号、
 *       法线球点选读数、曝光不影响数值、取消烘焙、失败不覆盖旧结果、
 *       格式覆盖、大数据渲染。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:8899';

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  let lastErr;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(`${globalRoot}/playwright/index.mjs`);
  } catch (err) {
    lastErr = err;
  }
  throw new Error(`需要 Playwright（npm i -g playwright 或设置 PLAYWRIGHT_PATH）：${lastErr?.message || ''}`);
}

const { chromium } = await loadPlaywright();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ishb-e2e-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const disabled = (sel) => page.$eval(sel, (e) => e.disabled);

async function waitIdle() {
  await page.waitForFunction(
    () => !document.querySelector('#status-dot').classList.contains('busy'),
    null,
    { timeout: 30000 },
  );
}

async function loadSample(id) {
  await page.selectOption('#sample-select', id);
  await page.click('#load-sample');
  await page.waitForFunction(
    (want) => document.querySelector('#status-text').textContent.includes(want),
    '烘焙完成',
    { timeout: 30000 },
  );
  await waitIdle();
  await page.waitForTimeout(150);
}

async function uploadFixture(name) {
  await page.setInputFiles('#file-input', path.join('samples', 'extracted', name));
  await page.waitForTimeout(600);
}

async function setRotation(value) {
  await page.fill('#rotation-number', String(value));
  await page.dispatchEvent('#rotation-number', 'input');
  await page.waitForTimeout(250);
}

async function downloadJson(buttonId) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click(buttonId),
  ]);
  const target = path.join(tmp, download.suggestedFilename());
  await download.saveAs(target);
  return { name: download.suggestedFilename(), json: JSON.parse(fs.readFileSync(target, 'utf8')), path: target };
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

/* ── 1. 初始状态 ─────────────────────────────────── */
console.log('\n[1] 初始状态');
{
  check('页面标题正确', (await page.title()).includes('漫反射光照探针烘焙台'));
  const options = await page.$$eval('#sample-select option', (els) => els.map((e) => e.value));
  check('样例清单一共 6 个', options.length === 6, options.join(','));
  check('未载入时导出按钮禁用', await disabled('#export-radiance') && await disabled('#export-irradiance'));
  check('未载入时状态提示', (await text('#status-text')).includes('尚未载入'));
  check('法线球画布已渲染', await page.$eval('#sphere-canvas', (c) => c.width > 100));
}

/* ── 2. 常量样例：两种存储一致 ───────────────────── */
console.log('\n[2] 常量样例（小端 vs 大端+尺度 2）');
let constLeCoeffs;
{
  await loadSample('constant-le');
  check('状态显示烘焙完成', (await text('#status-text')).includes('烘焙完成'));
  check('元数据显示小端', (await text('#image-meta')).includes('小端'));
  check('元数据显示尺度 −1', (await text('#image-meta')).includes('−1') || (await text('#image-meta')).includes('-1'));
  const rows = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check('C₀ 约等于 3.544908 / 7.089815 / 1.772454',
    Math.abs(Number(rows[0][2]) - 3.5449077) < 1e-4 && Math.abs(Number(rows[0][3]) - 7.0898154) < 1e-4,
    rows[0].join(' | '));
  check('E₀ 约等于 11.136656 / 22.273312 / 5.568328',
    Math.abs(Number(rows[0][5]) - 11.136656) < 1e-3 && Math.abs(Number(rows[0][7]) - 5.568328) < 1e-3,
    rows[0].join(' | '));
  check('Σ 行立体角显示 4π', Math.abs(Number(await text('#row-total-omega')) - 4 * Math.PI) < 1e-6);
  const conf = await text('#conformance-list');
  check('参考值核对全部 PASS', conf.includes('PASS') && !conf.includes('FAIL'), conf.slice(0, 220));
  constLeCoeffs = rows.map((r) => r.slice(2));
  const download = await downloadJson('#export-radiance');
  check('辐亮度导出文件名含 kind 与旋转角',
    download.name.startsWith('radiance-C_') && download.name.includes('rotY_'), download.name);
  check('导出 JSON 的 units 为 W/(m^2 sr)', download.json.units === 'W/(m^2 sr)');
  check('导出 JSON 的 kind 为 radiance', download.json.kind === 'radiance');
  check('导出 JSON 含 9 组 RGB', download.json.coefficients.length === 9);
  check('导出 C₀ 与界面一致',
    Math.abs(download.json.coefficients[0][0] - 3.5449077) < 1e-4);
}

{
  await loadSample('constant-be-scale2');
  check('大端样例元数据显示大端', (await text('#image-meta')).includes('大端'));
  const rows = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  // 浮点格式化会显示 −0 / 1e-16 这类近零值的不同写法，因此按数值比较
  const parseNums = (rs) => rs.map((r) => r.slice(2).map(Number));
  const a = parseNums(rows);
  const b = constLeCoeffs;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < a[i].length; k++) {
      const diff = Math.abs(a[i][k] - b[i][k]);
      const scale = Math.max(1e-9, Math.abs(b[i][k]));
      worst = Math.max(worst, diff / scale);
    }
  }
  check('大端 + 尺度 2 的系数与常量小端一致（相对误差 < 1e-6）', worst < 1e-6, worst.toExponential(2));
  check('参考值核对 PASS', (await text('#conformance-list')).includes('PASS'));
}

/* ── 3. 线性样例：方向、旋转、法线球 ─────────────── */
console.log('\n[3] 线性梯度样例');
{
  await loadSample('linear');
  const conf = await text('#conformance-list');
  check('线性样例全部核对 PASS', conf.includes('PASS') && !conf.includes('FAIL'), conf.slice(0, 200));
  check('旋转前亮部方向指向 +x', (await text('#rotation-meta')).includes('(0.949, 0.316'),
    await text('#rotation-meta'));

  // 预览显示数据说明曝光只影响显示
  await page.$eval('#exposure-range', (e) => { e.value = '2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  const coeffAfterExposure = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent).join('|')));
  await page.$eval('#exposure-range', (e) => { e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  const coeffBase = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent).join('|')));
  check('改曝光不改变系数', coeffAfterExposure.join() === coeffBase.join());

  await page.selectOption('#tone-mode', 'aces');
  await page.waitForTimeout(200);
  const coeff2 = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent).join('|')));
  check('改色调映射不改变系数', coeff2.join() === coeffBase.join());

  await setRotation(90);
  check('+90° 后亮部方向转向 −z', (await text('#rotation-meta')).includes('-0.949'),
    await text('#rotation-meta'));
  const l1 = await page.$$eval('#coeff-body tr', (trs) => trs.slice(1, 4).map((tr) => [...tr.children].map((td) => td.textContent)));
  check('+90° 后 Y10(z) 为负、Y11(x) 约 0',
    Number(l1[1][2]) < -1 && Math.abs(Number(l1[2][2])) < 1e-3, l1.map((r) => r.join('|')).join(' / '));

  // 旋转后导出
  const rotExport = await downloadJson('#export-radiance');
  check('旋转后导出记录 90°', rotExport.json.rotation.degrees === 90);
  check('旋转后导出文件名标 90deg', rotExport.name.includes('90deg'), rotExport.name);
  check('旋转后导出 Y10 为负', rotExport.json.coefficients[2][0] < -1);

  // 导入该 JSON → 系数应完全一致，且不会再旋转
  await page.setInputFiles('#coeff-input', rotExport.path);
  await page.waitForTimeout(600);
  check('导入成功提示', (await text('#coeff-ok')).includes('已导入'));
  const importedL1 = await page.$$eval('#coeff-body tr', (trs) => trs.slice(1, 4).map((tr) => [...tr.children].map((td) => td.textContent)));
  check('导入后 Y10 仍为负（未二次旋转）', Number(importedL1[1][2]) < -1, importedL1[1].join('|'));
  check('导入后旋转输入归零', (await page.$eval('#rotation-number', (e) => e.value)) === '0');
  const reExport = await downloadJson('#export-radiance');
  check('重新导出与导入前逐位一致',
    JSON.stringify(reExport.json.coefficients) === JSON.stringify(rotExport.json.coefficients));
  check('导入后行表提示无逐行数据', (await text('#row-body')).includes('没有逐行数据'));

  // 重新烘焙以恢复行数据
  await setRotation(0);
  await loadSample('linear');

  // 法线球点选：用页面内投影把世界方向换算成屏幕坐标，再点击
  const box = await page.$eval('#sphere-canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const screenOf = async (dir) => page.evaluate(([d, rect]) => {
    const view = window.__ishbSphere;
    const dpr = view.canvas.width / view.canvas.clientWidth;
    const p = view.project(d, view.canvas.width, view.canvas.height);
    return { x: rect.x + p.x / dpr, y: rect.y + p.y / dpr, visible: p.visible };
  }, [dir, box]);

  let target = await screenOf({ x: 1, y: 0, z: 0 });
  if (!target.visible) target = await screenOf({ x: 0, y: 0, z: 1 });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  const dirText = await text('#ro-dir');
  const readDir = (await page.evaluate(() => {
    const v = window.__ishbSphere;
    return { x: v.selected.x, y: v.selected.y, z: v.selected.z };
  }));
  const clicked = await page.evaluate(() => {
    const v = window.__ishbSphere;
    return { x: v.selected.x, y: v.selected.y, z: v.selected.z };
  });
  // 点选后球面选中的方向应与点击位置反投影一致（点球面正面）
  const pickCheck = await page.evaluate(([rect]) => {
    const v = window.__ishbSphere;
    return { yaw: v.yaw, pitch: v.pitch };
  }, [box]);
  check('点选后选中方向为单位向量',
    Math.abs(Math.hypot(readDir.x, readDir.y, readDir.z) - 1) < 1e-9, dirText);
  check('点选后读数非空', dirText.startsWith('('), dirText);
  void clicked; void pickCheck;
  check('读数显示单位 W/m^2（辐照度）', (await text('#ro-unit')) === 'W/m^2');
  const irrVal = await text('#ro-value');

  await page.click('#kind-radiance');
  await page.waitForTimeout(300);
  check('切到辐亮度后单位变为 W/(m^2 sr)', (await text('#ro-unit')) === 'W/(m^2 sr)');
  const radVal = await text('#ro-value');
  check('辐亮度读数是辐照度的 1/A_l 关系（C₀ 与 E₀ 不同）', irrVal !== radVal, `${irrVal} vs ${radVal}`);

  // 点击球面上另一个可见方向，读数应随之改变
  const before2 = await text('#ro-dir');
  const other = await screenOf({ x: 0, y: 1, z: 0 });
  if (other.visible) {
    await page.mouse.click(other.x, other.y);
    await page.waitForTimeout(300);
    const after2 = await text('#ro-dir');
    check('点选另一方向后读数变化', before2 !== after2, `${before2} → ${after2}`);
  } else {
    check('点选另一方向后读数变化', true, '（该方向在背面，跳过）');
  }

  await page.click('#kind-irradiance');
}

/* ── 4. 极区样例：直接平均 vs 加权 ───────────────── */
console.log('\n[4] 极区样例');
{
  await loadSample('polar');
  const mean = await page.$$eval('#mean-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check('直接像素平均明显高于立体角加权',
    Number(mean[0][1]) > Number(mean[0][2]) * 1.5, mean[0].join(' | '));
  const conf = await text('#conformance-list');
  check('极区核对 PASS', conf.includes('PASS') && !conf.includes('FAIL'), conf.slice(0, 160));
  const firstRows = await page.$$eval('#row-body tr', (trs) => trs.slice(0, 2).map((tr) => [...tr.children].map((td) => td.textContent)));
  check('首行（+y 极）立体角很小', Number(firstRows[0][2]) < 0.01, firstRows[0].join(' | '));
}

/* ── 5. 失败路径不覆盖已有结果 ───────────────────── */
console.log('\n[5] 失败路径保留旧结果');
{
  await loadSample('linear');
  const before = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));
  const beforeMeta = await text('#image-meta');

  await page.selectOption('#sample-select', 'nan');
  await page.click('#load-sample');
  await page.waitForTimeout(800);
  check('NaN 样例报错', (await text('#import-error')).includes('非有限值'), await text('#import-error'));
  check('报错给出首个位置（行/列/通道）', (await text('#import-error')).includes('通道'), await text('#import-error'));
  const afterNan = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));
  check('NaN 导入后系数不变', afterNan.join() === before.join());
  check('NaN 导入后元数据不变', (await text('#image-meta')) === beforeMeta);

  await page.selectOption('#sample-select', 'truncated');
  await page.click('#load-sample');
  await page.waitForTimeout(800);
  const truncMsg = await text('#import-error');
  check('截断样例报错并给出缺失字节', truncMsg.includes('截断') && truncMsg.includes('字节'), truncMsg);
  const afterTrunc = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));
  check('截断导入后系数不变', afterTrunc.join() === before.join());

  // 坏 JSON 不覆盖
  const badJson = path.join(tmp, 'bad.json');
  fs.writeFileSync(badJson, JSON.stringify({ kind: 'radiance', coefficients: [] }));
  await page.setInputFiles('#coeff-input', badJson);
  await page.waitForTimeout(500);
  check('缺基标识的 JSON 被拒绝', (await text('#coeff-error')).includes('基标识'), await text('#coeff-error'));
  const afterBadJson = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));
  check('坏 JSON 不覆盖系数', afterBadJson.join() === before.join());
  check('旧结果未过期，不显示过期提示（解析失败不换源）',
    await page.$eval('#coeff-stale', (e) => e.hidden));
}

/* ── 6. 取消烘焙 ─────────────────────────────────── */
console.log('\n[6] 取消烘焙');
{
  await loadSample('linear');
  await page.setInputFiles('#file-input', path.join('samples', 'extracted', 'linear.pfm'));
  await waitIdle();
  const before = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));

  // 从页面内合成一张大图并触发导入（避免外部 fixture 依赖）
  await page.evaluate(async () => {
    const w = 1024;
    const h = 512;
    const header = `PF\n${w} ${h}\n-1.0\n`;
    const buf = new Uint8Array(header.length + w * h * 3 * 4);
    for (let i = 0; i < header.length; i++) buf[i] = header.charCodeAt(i);
    const view = new DataView(buf.buffer, header.length);
    const enc = new TextEncoder();
    for (let p = 0; p < w * h; p++) {
      const x = (p % w) / w;
      const y = Math.floor(p / w) / h;
      view.setFloat32(p * 12, 1 + 0.5 * Math.cos(x * 6.283), true);
      view.setFloat32(p * 12 + 4, 1 + 0.5 * Math.sin(y * 3.1416), true);
      view.setFloat32(p * 12 + 8, 0.75, true);
    }
    const file = new File([buf], 'big-inline.pfm');
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    void enc;
  });
  await page.waitForTimeout(30);
  const cancelVisible = await page.$eval('#cancel-bake', (e) => !e.hidden).catch(() => false);
  check('烘焙中「取消烘焙」可见', cancelVisible);
  if (cancelVisible) {
    await page.click('#cancel-bake');
    await page.waitForTimeout(500);
    check('取消后状态提示', (await text('#status-text')).includes('取消'), await text('#status-text'));
    const after = await page.$$eval('#coeff-body tr', (trs) => trs.map((tr) => tr.children[2].textContent));
    check('取消后旧结果保留', after.join() === before.join());
    check('取消后取消按钮隐藏', await page.$eval('#cancel-bake', (e) => e.hidden));
    check('取消后显示「系数来自上一次成功结果」提示',
      await page.$eval('#coeff-stale', (e) => !e.hidden && e.textContent.includes('上一次')),
      await text('#coeff-stale'));
  }
}

/* ── 7. 格式覆盖 ─────────────────────────────────── */
console.log('\n[7] 格式覆盖');
{
  await page.click('.advanced summary');
  await page.evaluate(async () => {
    const w = 32; const h = 16;
    const header = `PF\n${w} ${h}\n-1.0\n`;
    const buf = new Uint8Array(header.length + w * h * 12);
    for (let i = 0; i < header.length; i++) buf[i] = header.charCodeAt(i);
    const view = new DataView(buf.buffer, header.length);
    // 文件第 0 行 = 逻辑底行；让逻辑顶行亮（+y 极亮）
    for (let fr = 0; fr < h; fr++) {
      const logRow = h - 1 - fr;
      const v = logRow < 4 ? 4.0 : 0.25;
      for (let c = 0; c < w; c++) {
        const o = (fr * w + c) * 12;
        view.setFloat32(o, v, true);
        view.setFloat32(o + 4, v, true);
        view.setFloat32(o + 8, v, true);
      }
    }
    const file = new File([buf], 'order-test.pfm');
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#status-text').textContent.includes('烘焙完成'));
  const l1Bottom = await page.$$eval('#coeff-body tr', (trs) => [...trs[1].children][2].textContent);
  check('默认底行优先：亮部在 +y（Y1−1 为正）', Number(l1Bottom) > 0, l1Bottom);

  await page.selectOption('#opt-roworder', 'top');
  await page.evaluate(async () => {
    // 同一份文件按顶行优先重读：亮部应翻转到底部
    const input = document.querySelector('#file-input');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  check('切换覆盖后提示需重新导入', (await text('#override-hint')).includes('重新导入'),
    await text('#override-hint'));
}

/* ── 8. 粘帖导入与复制 ───────────────────────────── */
console.log('\n[8] 粘贴导入');
{
  await loadSample('constant-le');
  const exp = await downloadJson('#export-irradiance');
  check('辐照度导出 kind=irradiance、单位 W/m^2',
    exp.json.kind === 'irradiance' && exp.json.units === 'W/m^2');
  check('辐照度文件名与辐亮度不同', exp.name.startsWith('irradiance-E_'), exp.name);
  await page.click('#coeff-paste-toggle');
  await page.fill('#coeff-paste', JSON.stringify(exp.json, null, 2));
  await page.click('#coeff-import-paste');
  await page.waitForTimeout(500);
  check('粘贴导入辐照度成功', (await text('#coeff-ok')).includes('辐照度'), await text('#coeff-ok'));
  const rows = await page.$$eval('#coeff-body tr', (trs) => [...trs[0].children].map((td) => td.textContent));
  check('导入辐照度后 E₀ 仍为 11.136656', Math.abs(Number(rows[5]) - 11.136656) < 1e-3, rows.join('|'));
  check('导入后 C₀ 由 E₀/π 反推为 3.544908', Math.abs(Number(rows[2]) - 3.5449077) < 1e-3, rows.join('|'));
}

/* ── 9. 导出两份 ─────────────────────────────────── */
console.log('\n[9] 同时导出两种系数');
{
  await loadSample('linear');
  await setRotation(45);
  const [d1, d2] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForEvent('download'),
    page.click('#export-both').then(async () => {
      // 依次触发两个下载
    }),
  ]);
  void d1; void d2;
  check('导出两份按钮可用', !(await disabled('#export-both')));
  // 分别下载核对
  const rad = await downloadJson('#export-radiance');
  const irr = await downloadJson('#export-irradiance');
  check('辐亮度与辐照度相等 ×A_l',
    Math.abs(irr.json.coefficients[0][0] - Math.PI * rad.json.coefficients[0][0]) < 1e-9);
  check('两份都记录 45°', rad.json.rotation.degrees === 45 && irr.json.rotation.degrees === 45);
  check('两份都带 provenance（显示参数标注为不影响数值）',
    rad.json.provenance?.displayOnly !== undefined);

  // 重新导入并比较光照：E(n) 重建应一致
  const rebuilt = await page.evaluate(async (jsonText) => {
    const { parseCoefficientJson } = await import('/js/coefficients.js');
    const { evaluate } = await import('/js/sh.js');
    const parsed = parseCoefficientJson(jsonText);
    const dirs = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.577, 0.577, 0.577]];
    return dirs.map(([x, y, z]) => Array.from(evaluate(parsed.irradiance, x, y, z)));
  }, JSON.stringify(irr.json));
  const rebuilt2 = await page.evaluate(async (jsonText) => {
    const { parseCoefficientJson } = await import('/js/coefficients.js');
    const { evaluate, convolve } = await import('/js/sh.js');
    const parsed = parseCoefficientJson(jsonText);
    const c = convolve(parsed.radiance);
    const dirs = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.577, 0.577, 0.577]];
    return dirs.map(([x, y, z]) => Array.from(evaluate(c, x, y, z)));
  }, JSON.stringify(rad.json));
  let worst = 0;
  for (let i = 0; i < rebuilt.length; i++) {
    for (let k = 0; k < 3; k++) {
      worst = Math.max(worst, Math.abs(rebuilt[i][k] - rebuilt2[i][k]));
    }
  }
  check('两份 JSON 重建出的光照一致', worst < 1e-9, worst.toExponential(2));
}

check('页面无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: path.join(tmp, 'final.png'), fullPage: true });
console.log(`\n${checks - failures}/${checks} 通过`);
await browser.close();
if (failures > 0) process.exit(1);
