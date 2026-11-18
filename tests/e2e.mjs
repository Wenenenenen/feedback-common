/*
 * tests/e2e.mjs — Playwright 端到端：真实浏览器里走完整管线
 *   node tests/e2e.mjs
 * 覆盖：导入(含拖放 API 等价的 input 注入)、表格、参考帧切换、阈值/ EV / key、
 *       五种视图、对比模式、三种导出下载内容校验、边界黑/白用例。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 兼容全局安装的 playwright
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = await import(path.join(globalRoot, 'playwright', 'index.mjs')));
}
const require = createRequire(import.meta.url);
const HDR = require('../hdr-engine.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const sample = path.join(root, 'sample-data');
const page0 = 'file://' + path.join(root, 'dist', 'hdr-standalone.html');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

// 拦截下载
const downloads = [];
page.on('download', async d => {
  const tmp = path.join(here, '_dl-' + d.suggestedFilename());
  await d.saveAs(tmp);
  downloads.push({ name: d.suggestedFilename(), path: tmp });
});

async function setFiles(fileInput, names){
  await fileInput.setInputFiles(names.map(n => path.join(sample, n)));
  await page.waitForTimeout(150);
}

// ---------- 场景 1：正常三档 + 清单 ----------
console.log('\n[e2e 1] manifest.json 正常合成');
await page.goto(page0);
await setFiles(page.locator('#fileInput'), ['frame-0.png','frame-1.png','frame-2.png','manifest.json']);
await page.waitForSelector('#stats .stat');

const rows = await page.locator('#frameBody tr').count();
check('表格 3 帧', rows === 3, 'rows=' + rows);
const statsText = (await page.locator('#stats').textContent()).replace(/\s+/g, '');
check('显示输出尺寸 75×57', statsText.includes('75×57'), statsText);
check('运动像素 0', /运动像素0\(0\.0%\)/.test(statsText), statsText);
const cropText = await page.locator('#cropReadout').innerText();
check('裁剪矩形 [3,1] [78,58]', cropText.includes('[3, 1]') && cropText.includes('[78, 58]'));

// 主画布尺寸
const mainSize = await page.locator('#mainCanvas').evaluate(c => [c.width, c.height]);
check('主画布 75x57', mainSize[0] === 75 && mainSize[1] === 57, JSON.stringify(mainSize));

// 曝光/偏移来自清单
const exp0 = await page.locator('.f-exp').first().inputValue();
const dx1 = await page.locator('.f-dx').nth(1).inputValue();
check('清单曝光/偏移已应用', exp0 === '0.25' && dx1 === '3', exp0 + '/' + dx1);

// 各视图可切换且不报错
for (const v of ['raw','contrib','motion','winner','clean']) {
  await page.locator('.vbtn[data-view=' + v + ']').click();
  await page.waitForTimeout(60);
}
check('视图切换无控制台错误', consoleErrors.length === 0, consoleErrors.join('; '));

// 对比模式
await page.locator('.vbtn[data-view=compare]').click();
await page.waitForTimeout(60);
const cmpVisible = await page.locator('#compareGrid').isVisible();
check('对比网格可见', cmpVisible);
const cleanCanvas = await page.locator('#cleanCanvas').evaluate(c => [c.width, c.height]);
check('对比画布尺寸正确', cleanCanvas[0] === 75 && cleanCanvas[1] === 57);
await page.locator('.vbtn[data-view=clean]').click();

// 换参考帧（帧 1）：裁剪应变 [0,3,75,60]
await page.locator('#frameBody tr:nth-child(2) .radio-ref').check();
await page.waitForTimeout(100);
const crop2 = await page.locator('#cropReadout').innerText();
check('换参考帧裁剪 [0,3] [75,60]', crop2.includes('[0, 3]') && crop2.includes('[75, 60]'), crop2.replace(/\n/g,' | '));
await page.locator('#frameBody tr:nth-child(1) .radio-ref').check();
await page.waitForTimeout(100);

// EV / key 调整不重新导入：改 EV 后映射像素应变化
const pxBefore = await page.locator('#mainCanvas').evaluate(c => {
  const x = c.getContext('2d').getImageData(10, 10, 1, 1).data; return [...x];
});
await page.locator('#ev').fill('2');
await page.waitForTimeout(80);
const pxAfter = await page.locator('#ev').evaluate(() => true); // ensure handled
const pxEv = await page.locator('#mainCanvas').evaluate(c => [...c.getContext('2d').getImageData(10,10,1,1).data]);
check('调 EV 改变映射输出', JSON.stringify(pxBefore) !== JSON.stringify(pxEv), JSON.stringify(pxBefore) + ' vs ' + JSON.stringify(pxEv));
await page.locator('#ev').fill('0');
await page.locator('#key').fill('0.36');
await page.waitForTimeout(80);
const pxKey = await page.locator('#mainCanvas').evaluate(c => [...c.getContext('2d').getImageData(10,10,1,1).data]);
check('调 key 改变映射输出', JSON.stringify(pxBefore) !== JSON.stringify(pxKey));
await page.locator('#key').fill('0.18');

// 导出三文件
const beforeCount = downloads.length;
await page.locator('#expPfm').click();
await page.locator('#expPng').click();
await page.locator('#expJson').click();
await page.waitForTimeout(300);
check('触发 3 个下载', downloads.length - beforeCount === 3, 'n=' + (downloads.length - beforeCount));

const pfmDl = downloads.find(d => d.name.endsWith('.pfm'));
const pngDl = downloads.find(d => d.name.endsWith('.png'));
const jsonDl = downloads.find(d => d.name.endsWith('.json'));
check('三个下载文件齐全', !!(pfmDl && pngDl && jsonDl));

{
  const buf = fs.readFileSync(pfmDl.path);
  const head = buf.subarray(0, 20).toString('ascii');
  check('PFM 头 PF/75/57/-1.0', head.startsWith('PF\n75 57\n-1.0\n'), head.replace(/\n/g,'|'));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const headLen = 'PF\n75 57\n-1.0\n'.length;
  const allFinite = (() => {
    for (let o = headLen; o < buf.length; o += 4) if (!Number.isFinite(dv.getFloat32(o, true))) return false;
    return true;
  })();
  check('PFM 全部有限 float32（小端）', allFinite && buf.length === headLen + 75 * 57 * 12);
}
{
  const info = HDR.validatePNG(new Uint8Array(fs.readFileSync(pngDl.path)));
  check('导出 PNG 头合法 75x57', info.width === 75 && info.height === 57);
}
{
  const meta = JSON.parse(fs.readFileSync(jsonDl.path, 'utf8'));
  check('JSON 裁剪坐标', meta.crop.x0 === 3 && meta.crop.y0 === 1 && meta.crop.x1 === 78 && meta.crop.y1 === 58);
  check('JSON 参数 key=0.18', meta.parameters.key === 0.18 && meta.parameters.motion_threshold_ev === 1);
  check('JSON 含帧贡献与文件名', meta.frames.length === 3 && typeof meta.frames[0].mean_weight_share === 'number');
}

// ---------- 场景 2：运动物体 ----------
console.log('\n[e2e 2] moving.json 运动剔除与前后对比');
await page.locator('#clearBtn').click();
await page.waitForTimeout(80);
await setFiles(page.locator('#fileInput'), ['frame-0.png','frame-1.png','moving-frame.png','moving.json']);
await page.waitForSelector('#stats .stat');
const stats2 = (await page.locator('#stats').textContent()).replace(/\s+/g, '');
check('检出 100 个运动像素', /运动像素100\(2\.3%\)/.test(stats2), stats2);

// 阈值滑块调大 -> 运动像素归零
await page.locator('#thr').fill('10');
await page.waitForTimeout(100);
const stats3 = (await page.locator('#stats').textContent()).replace(/\s+/g, '');
check('阈值 10EV 时运动归零', /运动像素0\(0\.0%\)/.test(stats3), stats3);
await page.locator('#thr').fill('1');
await page.waitForTimeout(100);

// 运动视图红色像素存在
await page.locator('.vbtn[data-view=motion]').click();
await page.waitForTimeout(60);
const redCount = await page.locator('#mainCanvas').evaluate(c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 130) n++;
  return n;
});
check('运动视图红色像素=100', redCount === 100, 'n=' + redCount);

// 对比视图下剔除前后画布像素存在差异
await page.locator('.vbtn[data-view=compare]').click();
await page.waitForTimeout(60);
const diffs = await page.evaluate(() => {
  const a = document.getElementById('rawCanvas').getContext('2d').getImageData(0, 0, 75, 57).data;
  const b = document.getElementById('cleanCanvas').getContext('2d').getImageData(0, 0, 75, 57).data;
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n / 4;
});
check('剔除前后预览存在差异像素', diffs >= 100, 'diffPx=' + diffs);

// ---------- 场景 3：全黑 / 全白边界 ----------
console.log('\n[e2e 3] black/white 边界用例（整组饱和与全黑）');
await page.locator('#clearBtn').click();
await page.waitForTimeout(80);
await setFiles(page.locator('#fileInput'), ['black.png','white.png']);
await page.waitForSelector('#stats .stat');
const statsBw = (await page.locator('#stats').textContent()).replace(/\s+/g, '');
check('无有效帧像素=64', /无有效帧64\(100\.0%\)/.test(statsBw), statsBw);
check('运动像素=0（无有效帧不计运动）', /运动像素0\(0\.0%\)/.test(statsBw));
const bwCanvasOk = await page.locator('#mainCanvas').evaluate(c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i])) return false;
  return true;
});
check('边界用例画布渲染确定无 NaN', bwCanvasOk);
// 仍然可以导出
await page.locator('#expPfm').click();
await page.waitForTimeout(200);
check('边界用例可导出 PFM', downloads.some(d => d.name.endsWith('.pfm')));

// ---------- 场景 4：非法输入 ----------
console.log('\n[e2e 4] 非法输入处理');
await page.locator('#clearBtn').click();
// 帧数不足：只导一张，导出按钮应禁用
await setFiles(page.locator('#fileInput'), ['black.png']);
await page.waitForTimeout(100);
const expDisabled = await page.locator('#expPfm').isDisabled();
check('单帧时导出禁用', expDisabled);

// 尺寸不一致
await setFiles(page.locator('#fileInput'), ['black.png','frame-0.png']);
await page.waitForTimeout(200);
const toastText = await page.locator('#toast').innerText();
check('尺寸不一致被拒绝并提示', toastText.includes('尺寸不一致'), toastText);
check('错误未产生控制台异常', consoleErrors.length === 0, consoleErrors.join('; '));

// ---------- 收尾 ----------
for (const d of downloads) { try { fs.unlinkSync(d.path); } catch(e){} }
console.log('\n' + (failures === 0 ? '✅ E2E 全部通过' : '❌ ' + failures + ' 项失败') + '\n');
await browser.close();
process.exit(failures ? 1 : 0);
