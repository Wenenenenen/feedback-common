// 单文件 artifact 构建脚本：把 src/lib 的核心算法内联进一个自包含 HTML。
// 核心算法文件原样使用（仅转换 ESM 语法），保证与测试通过的代码同源。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// --- 核心库：去掉 import/export 关键字，拼成一个模块作用域 ---
const stripModuleSyntax = (code) =>
  code
    .replace(/export\s+class\s+/g, 'class ')
    .replace(/export\s+function\s+/g, 'function ')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s*\{[^}]*\};?/g, '')
    .replace(/^import[^;]+;?/gm, '');

const heat = stripModuleSyntax(read('src/lib/heat-method.js'));
const parsers = stripModuleSyntax(read('src/lib/parsers.js'));
const colormap = stripModuleSyntax(read('src/lib/colormap.js'));
const exportLib = stripModuleSyntax(read('src/lib/export.js')).replace(
  /function downloadJSON[\s\S]*?\n}\n/,
  ''
); // 沙箱下载失效，移除浏览器下载函数

const coreBundle = `// ===== 内联核心算法（与 src/lib 同源，由 build-artifact.mjs 打包）=====
${heat}
${parsers}
${colormap}
${exportLib}
export {
  analyzeMesh, HeatSolver, extractIsolines, compareFields, MeshRejectError,
  parseMeshText, ParseError, fieldColors, turboCss,
  buildDistanceExport, buildIsolineExport, buildDiagnosticExport,
};
`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });

const appJs = read('.work/artifact-src/app.js')
  .replace(/^import[\s\S]*?;\n/m, '')
  .replace(/^const HM = \{[\s\S]*?\};\nwindow\.HM = HM;\n/m,
    `const HM = { analyzeMesh, HeatSolver, compareFields, extractIsolines, parseMeshText, ParseError, fieldColors, turboCss, buildDistanceExport, buildIsolineExport, buildDiagnosticExport };
window.HM = HM;`);

// --- 页面骨架：暗色系工程工具风格，明暗双 token ---
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="claude:viewport-fit-sides" content="cover" />
<title>热方法曲面测距台</title>
<style>
/* 设计令牌：暗色优先的工程仪器风格，Turbo 热图作为主视觉，蓝绿为操作色 */
:root {
  --bg: #101319; --panel: #171b23; --card: #1e232d; --line: #2c333f;
  --fg: #e8ebf1; --muted: #99a2b3; --accent: #5b8def; --accent2: #3ddc97;
  --warn: #f2b134; --error: #ef6461; --radius: 10px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f6fa; --panel: #ffffff; --card: #f7f9fc; --line: #dfe4ec;
    --fg: #1c2230; --muted: #5d6678; --accent: #2f6be0; --accent2: #0e9f6e;
    --warn: #b7791f; --error: #c53030; color-scheme: light;
  }
}
:root[data-theme="light"] {
  --bg: #f4f6fa; --panel: #ffffff; --card: #f7f9fc; --line: #dfe4ec;
  --fg: #1c2230; --muted: #5d6678; --accent: #2f6be0; --accent2: #0e9f6e;
  --warn: #b7791f; --error: #c53030; color-scheme: light;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  background: var(--bg); color: var(--fg); font-size: 13px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
#app { display: flex; height: 100%; gap: 14px; padding-block: 14px; }
#panel {
  width: 330px; min-width: 300px; height: 100%; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px; display: flex; flex-direction: column; gap: 12px;
}
header h1 { font-size: 18px; margin: 0 0 2px; }
.subtitle { color: var(--muted); font-size: 11px; margin: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.card h2 { font-size: 13px; margin: 0 0 10px; color: var(--accent2); letter-spacing: .5px; }
.row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.check input { accent-color: var(--accent); }
input[type="file"] {
  width: 100%; font-size: 12px; color: var(--muted); background: var(--bg);
  border: 1px dashed var(--line); border-radius: 8px; padding: 8px;
}
button {
  background: var(--accent); color: #fff; border: none; border-radius: 8px;
  padding: 7px 12px; font-size: 12px; cursor: pointer;
}
button:hover:not(:disabled) { filter: brightness(1.12); }
button:disabled { background: var(--line); color: var(--muted); cursor: not-allowed; }
button.secondary { background: var(--line); color: var(--fg); }
.slider { display: block; margin: 10px 0 4px; }
.slider > span { display: block; margin-bottom: 6px; }
.slider input[type="range"] { width: 100%; accent-color: var(--accent); }
.slider small { color: var(--muted); }
.hint { color: var(--muted); font-size: 11px; line-height: 1.5; margin: 8px 0 0; }
.kv { font-size: 12px; line-height: 1.7; color: var(--muted); margin-top: 8px; }
.kv b { color: var(--fg); font-weight: 600; }
.sourcelist { color: var(--accent2); font-size: 11px; word-break: break-all; }
.error { background: color-mix(in srgb, var(--error) 14%, transparent); border: 1px solid var(--error); color: var(--error); border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-size: 12px; line-height: 1.5; }
.warnbox { background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid var(--warn); border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-size: 12px; }
.warnbox ul { margin: 6px 0 0; padding-left: 18px; max-height: 110px; overflow-y: auto; }
.infobox { background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-size: 12px; }
.hidden { display: none !important; }
.diag { font-size: 11.5px; line-height: 1.7; color: var(--muted); }
.diag table { width: 100%; border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
.diag th, .diag td { border-bottom: 1px solid var(--line); padding: 3px 4px; text-align: right; }
.diag th:first-child, .diag td:first-child { text-align: left; }
.diag .good { color: var(--accent2); }
.diag .bad { color: var(--error); }
.legend { margin-top: auto; }
.legend-bar { height: 12px; border-radius: 6px; background: linear-gradient(90deg,
  rgb(48,18,59), rgb(100,40,150), rgb(34,90,225), rgb(10,175,225),
  rgb(40,225,120), rgb(180,245,50), rgb(245,200,30), rgb(230,110,20), rgb(170,30,10)); }
.legend-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
.legend-note { font-size: 11px; color: var(--muted); margin-top: 3px; }
#viewport { flex: 1; position: relative; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--bg); }
#gl { width: 100%; height: 100%; display: block; }
.empty-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); pointer-events: none; font-size: 14px; text-align: center; padding: 20px; }
.tooltip { position: absolute; pointer-events: none; background: color-mix(in srgb, var(--bg) 92%, transparent); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 12px; line-height: 1.6; max-width: 260px; z-index: 10; }
.tooltip b { color: var(--accent2); }
.tooltip .null { color: var(--error); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); width: min(720px, 100%); max-height: 82%; display: flex; flex-direction: column; padding: 16px; gap: 10px; }
.modal h3 { margin: 0; font-size: 14px; }
.modal textarea { flex: 1; min-height: 240px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; resize: none; }
.modal .row { justify-content: flex-end; margin: 0; }
@media (max-width: 820px) {
  #app { flex-direction: column; }
  #panel { width: 100%; min-width: 0; height: 46%; }
}
</style>
</head>
<body>
<div id="app">
  <aside id="panel">
    <header>
      <h1>热方法曲面测距台</h1>
      <p class="subtitle">Heat Method Geodesic Distance · 手工组装离散算子，无测地线库</p>
    </header>
    <section class="card">
      <h2>1 · 网格导入</h2>
      <input type="file" id="fileInput" accept=".json,.obj,.ply" />
      <p class="hint">支持样例 JSON / OBJ / ASCII PLY，最多 10000 面。</p>
      <div class="row"><button id="loadSampleBtn" class="secondary">载入内置平面样例</button></div>
      <div id="meshInfo" class="kv"></div>
      <div id="rejectMsg" class="error hidden"></div>
      <div id="excludedBox" class="warnbox hidden"><strong>已排除退化面 <span id="excludedCount"></span> 个：</strong><ul id="excludedList"></ul></div>
      <div id="obtuseBox" class="infobox hidden">钝角三角形 <span id="obtuseCount"></span> 个（负 cot 权重保留）；边界边 <span id="boundaryCount"></span> 条。</div>
    </section>
    <section class="card">
      <h2>2 · 源点与热时间</h2>
      <div class="row"><label class="check"><input type="checkbox" id="multiMode" /> 多源模式（累加选点）</label></div>
      <div class="row"><button id="clearSourcesBtn" class="secondary">清空源点</button><span id="sourceList" class="sourcelist"></span></div>
      <label class="slider"><span>热时间 τ = <b id="tauVal">1.00</b> <small>（0.1–10）</small></span><input type="range" id="tauSlider" min="0.1" max="10" step="0.05" value="1" /></label>
      <p class="hint">t = τ ×（分量平均有效边长）²。移动源点复用热分解；改 τ 只重建热分解。</p>
    </section>
    <section class="card">
      <h2>3 · 等值线</h2>
      <label class="slider"><span>间距 = <b id="isoVal">1.00</b></span><input type="range" id="isoSlider" min="0.05" max="5" step="0.05" value="1" /></label>
      <div class="row">
        <label class="check"><input type="checkbox" id="isoToggle" checked /> 显示等值线</label>
        <label class="check"><input type="checkbox" id="meshToggle" checked /> 显示网格线</label>
      </div>
    </section>
    <section class="card">
      <h2>4 · 同拓扑对比</h2>
      <input type="file" id="fileInputB" accept=".json,.obj,.ply" />
      <div id="meshBInfo" class="kv"></div>
      <div class="row">
        <button id="compareBtn" disabled>计算距离场差异</button>
        <button id="clearCompareBtn" class="secondary" disabled>退出对比</button>
      </div>
      <div id="compareResult" class="kv"></div>
    </section>
    <section class="card">
      <h2>5 · 导出</h2>
      <div class="row" style="flex-wrap:wrap">
        <button id="exportDistBtn" class="secondary" disabled>顶点距离</button>
        <button id="exportIsoBtn" class="secondary" disabled>等值线段</button>
        <button id="exportDiagBtn" class="secondary" disabled>计算诊断</button>
      </div>
      <p class="hint">在弹窗中预览 JSON 并复制保存。</p>
    </section>
    <section class="card">
      <h2>计算诊断</h2>
      <div id="diagBox" class="diag">尚未求解。</div>
    </section>
    <footer class="legend hidden" id="legend">
      <div class="legend-bar"></div>
      <div class="legend-labels"><span>0</span><span id="legendMax">max</span></div>
      <div class="legend-note">灰色 = 不可达分量</div>
    </footer>
  </aside>
  <main id="viewport">
    <canvas id="gl"></canvas>
    <div id="tooltip" class="tooltip hidden"></div>
    <div id="emptyHint" class="empty-hint">导入网格后点击顶点选择源点 · 左键旋转 / 滚轮缩放 / 右键平移</div>
  </main>
</div>
<div id="modal" class="modal-mask hidden">
  <div class="modal">
    <h3 id="modalTitle">导出</h3>
    <textarea id="modalText" readonly></textarea>
    <div class="row">
      <button id="copyBtn">复制到剪贴板</button>
      <button id="closeModal" class="secondary">关闭</button>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/controls/OrbitControls.js"></script>
<script type="module">
${coreBundle}
// ===== 界面与渲染（与 src/app.js 同源）=====
${appJs}
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, 'dist/index.html'), html);
console.log('artifact built:', join(ROOT, 'dist/index.html'), `(${(html.length / 1024).toFixed(1)} KB)`);
