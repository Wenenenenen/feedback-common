/* jsdom 无头冒烟测试：加载真实 index.html + 两个脚本，验证渲染、交互、非法保留、导出。
   运行: node tests/dom-smoke.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/fr-npm/node_modules/jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'fluorescent-core.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/'
});
const { window } = dom;
window.eval(core);
window.eval(app);
const document = window.document;
const $ = (id) => document.getElementById(id);

// 1. 初始渲染
const swatches = document.querySelectorAll('.swatch');
ok('样例渲染 2 个贴片色板', swatches.length === 2, 'got ' + swatches.length);
ok('状态条显示已求解', $('status-state').textContent.includes('已求解'));
ok('错误横幅隐藏', $('error-banner').hidden === true);
ok('残差显示机器精度', $('status-residual').textContent.includes('e-'));
ok('灯光区 3 个波段控件', document.querySelectorAll('.lamp-cell').length === 3);
ok('SVG 光谱图生成', document.querySelectorAll('svg.chart').length === 1);
ok('数据表 3 行（含表头 4 行）', document.querySelectorAll('#spectra-table tr').length === 4);

// 2. 点选第二个贴片
swatches[1].click();
ok('点击后 panel 激活', document.querySelectorAll('.swatch')[1].classList.contains('active'));
ok('详情标题更新', $('detail-title').textContent.includes('panel'));

// 3. 切到材料标签并改出非法反射率（>1）
document.querySelector('.tab[data-tab="material"]').click();
const reflInputs = document.querySelectorAll('#reflect-editor input');
ok('反射编辑器 3 个输入', reflInputs.length === 3);
const ev = new window.Event('input', { bubbles: true });
reflInputs[0].value = '1.5';
reflInputs[0].dispatchEvent(ev);
ok('非法反射触发横幅', $('error-banner').hidden === false);
ok('横幅指出贴片与波段', $('error-list').textContent.includes('panel') && $('error-list').textContent.includes('410'));
ok('状态条提示保留上次有效结果', $('status-state').textContent.includes('上次有效'));
ok('非法输入框标红', reflInputs[0].classList.contains('invalid'));
// 旧解仍在：色板仍是 2 个、SVG 仍在
ok('旧解保留：色板仍渲染', document.querySelectorAll('.swatch').length === 2);
ok('旧解保留：图表仍在', document.querySelectorAll('svg.chart').length === 1);

// 改回合法
reflInputs[0].value = '0.1';
reflInputs[0].dispatchEvent(ev);
ok('恢复合法后横幅消失', $('error-banner').hidden === true);
ok('恢复已求解状态', $('status-state').textContent.includes('已求解'));

// 4. 非法传播链接：来源合计 > 0.95
document.querySelector('.tab[data-tab="links"]').click();
// panel -> label 现有 0.2，再加 panel -> panel 0.8
$('btn-add-link').click();
const linkRows = document.querySelectorAll('#link-editor .link-row');
const lastRow = linkRows[linkRows.length - 1];
const wInp = lastRow.querySelector('input[type="number"]');
wInp.value = '0.8';
wInp.dispatchEvent(new window.Event('input', { bubbles: true }));
ok('传播来源超 0.95 被指出', $('error-banner').hidden === false && $('error-list').textContent.includes('0.95'));
ok('错误点名来源贴片', $('error-list').textContent.includes('panel'));
wInp.value = '0.1';
wInp.dispatchEvent(new window.Event('input', { bubbles: true }));
ok('改正后横幅消失', $('error-banner').hidden === true);

// 5. 灯光倍数减半，稳态量线性减半
document.querySelector('.tab[data-tab="spectra"]').click();
const tableBefore = document.querySelectorAll('#spectra-table tbody td')[1].textContent; // 第一个数值=直射
const lampInput = document.querySelector('.lamp-cell input[type="number"]');
lampInput.value = '0.5';
lampInput.dispatchEvent(new window.Event('input', { bubbles: true }));
const tableAfter = document.querySelectorAll('#spectra-table tbody td')[1].textContent;
ok('灯光减半后直射减半', Math.abs(parseFloat(tableAfter) - 0.5 * parseFloat(tableBefore)) < 1e-12,
  tableBefore + ' -> ' + tableAfter);

// 6. 导出模态：CSV/JSON 内容与行数
$('btn-export').click();
const modal = document.querySelector('.modal-backdrop');
ok('导出模态打开', !!modal);
const csvBox = modal.querySelector('textarea');
const csvLines = csvBox.value.trim().split('\n');
ok('CSV 含表头 + 2贴片×3波段 = 7 行', csvLines.length === 7, 'got ' + csvLines.length);
ok('CSV 表头字段完整', csvLines[0].includes('incident') && csvLines[0].includes('fluorescent') && csvLines[0].includes('linearR'));
const jsonRadio = modal.querySelector('input[value="json"]');
jsonRadio.checked = true;
jsonRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
let parsed = null;
try { parsed = JSON.parse(csvBox.value); } catch (e) { parsed = null; }
ok('JSON 导出可解析且含每贴片每波段', parsed && parsed.patches.length === 2 && parsed.patches[0].perBand.length === 3);
modal.querySelector('.btn.ghost').click();
ok('模态关闭', !document.querySelector('.modal-backdrop'));

// 7. 大样例（96 贴片 / 16 波段 / 4096 链接）端到端
const big = buildBig();
const v0 = window.FluorescentCore.validate(big);
ok('96/16/4096 规模数据校验通过', v0.ok, v0.errors.join(';'));
const file = new window.File([JSON.stringify(big)], 'big.json', { type: 'application/json' });
const input = $('file-input');
Object.defineProperty(input, 'files', { value: [file], configurable: true });
input.dispatchEvent(new window.Event('change', { bubbles: true }));
setTimeout(function () {
  ok('大样例渲染 96 色板', document.querySelectorAll('.swatch').length === 96);
  ok('大样例 16 灯光控件', document.querySelectorAll('.lamp-cell').length === 16);
  ok('大样例仍成功求解', $('status-state').textContent.includes('已求解'));
  const resid = parseFloat($('status-residual').textContent.replace(/^.*残差\s*/, ''));
  ok('大样例残差 < 1e-10', resid < 1e-10, 'resid=' + resid);
  const saved = JSON.parse(window.localStorage.getItem('fluorescent-relighter-state-v1'));
  ok('状态已持久化', saved && saved.data.patches.length === 96);

  console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
}, 80);

function buildBig() {
  const N = 96, B = 16;
  const bands = [];
  for (let k = 0; k < B; k++) bands.push(380 + k * 20);
  const rng = mulberry(7);
  const patches = [];
  for (let i = 0; i < N; i++) {
    const refl = bands.map(function () { return Math.round(rng() * 0.4 * 1e4) / 1e4; });
    const convert = [];
    for (let s = 0; s < B - 1; s++) {
      const budget1 = 1 - refl[s];
      let used = 0;
      if (rng() < 0.25 && budget1 > 0.05) {
        const t = s + 1 + Math.floor(rng() * (B - s - 1));
        const q = Math.min(budget1 - used - 0.01, 0.05 + rng() * 0.15);
        convert.push([s, t, Math.round(q * 1e4) / 1e4]);
        used += q;
      }
    }
    patches.push({
      id: 'patch-' + String(i).padStart(2, '0'),
      direct: bands.map(function (_, k) { return k === 0 ? Math.round(rng() * 2 * 1e4) / 1e4 : 0; }),
      reflect: refl, convert: convert
    });
  }
  // 有界构造：逐来源、逐去向填充，小权重（0.01~0.03）保证每来源可铺满 96 个去向且合计 ≤ 0.95
  const links = [];
  outer:
  for (let s = 0; s < N; s++) {
    let used = 0;
    for (let d = 0; d < N; d++) {
      if (links.length >= 4096) break outer;
      // 预留 0.002 余量，避免四舍五入到 4 位小数后合计越过 0.95
      const room = 0.948 - used;
      if (room < 0.009) break;
      const w = Math.min(room, 0.01 + rng() * 0.02);
      links.push([patches[s].id, patches[d].id, Math.round(w * 1e4) / 1e4]);
      used += Math.round(w * 1e4) / 1e4;
    }
  }
  if (links.length !== 4096) throw new Error('测试构造失败：只生成 ' + links.length + ' 条链接');
  const observerRGB = bands.map(function () { return [rng(), rng(), rng()]; });
  return { bands: bands, observerRGB: observerRGB, patches: patches, links: links };
}
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
