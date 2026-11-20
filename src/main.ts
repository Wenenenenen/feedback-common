import { buildCornerUvStream, buildExportJson, exportFileName } from './core/export.js';
import { parameterize } from './core/parameterize.js';
import { suggestSeamPath } from './core/suggest.js';
import type { ParameterizeResult } from './core/types.js';
import {
  renderCharts,
  renderDiagnostics,
  renderExportSummary,
  renderInspector,
  renderOverview,
  renderSeams,
} from './ui/panels.js';
import { store } from './ui/state.js';
import { ThreeView } from './ui/three-view.js';
import { UvView } from './ui/uv-view.js';
import './styles.css';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const sampleSelect = $<HTMLSelectElement>('sample-select');
const fileInput = $<HTMLInputElement>('file-input');

const ui = {
  badge: $('validity-badge'),
  stats: $('stats'),
  meta: $('mesh-meta'),
  seamList: $('seam-list'),
  seamCount: $('seam-count'),
  chartList: $('chart-list'),
  chartCount: $('chart-count'),
  diagList: $('diag-list'),
  diagCount: $('diag-count'),
  inspect: $('inspect'),
  inspectTag: $('inspect-tag'),
  exportSummary: $('export-summary'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  statusTiming: $('status-timing'),
  foot3d: $('foot3d'),
};

const three = new ThreeView({
  wrap: $('wrap3d'),
  canvas: $<HTMLCanvasElement>('view3d'),
  hud: $('hud3d'),
  legend: $('legend3d'),
  empty: $('empty3d'),
  store,
});

const uv = new UvView({
  wrap: $('wrapuv'),
  canvas: $<HTMLCanvasElement>('viewuv'),
  hud: $('huduv'),
  legend: $('legenduv'),
  empty: $('emptyuv'),
  store,
});

let recomputeQueued = false;

function computeNow(): void {
  if (!store.input) return;
  const t0 = performance.now();
  let result: ParameterizeResult;
  try {
    result = parameterize({
      vertices: store.input.vertices,
      faces: store.input.faces,
      seams: store.seams,
    });
  } catch (error) {
    store.setStatus('error', `计算异常：${(error as Error).message}`);
    // eslint-disable-next-line no-console
    console.error(error);
    return;
  }
  const elapsed = performance.now() - t0;
  store.setResult(result);
  if (result.valid) {
    store.setStatus(
      'ok',
      `${result.stats.charts} 个图表 · ${result.stats.cutVertices} cut 顶点 · 残差 ${result.stats.maxResidual.toExponential(1)}`,
      `${elapsed.toFixed(1)} ms`,
    );
  } else {
    const first = result.errors[0];
    store.setStatus(
      'error',
      first ? `${first.message}` : '无法展开',
      `${elapsed.toFixed(1)} ms`,
    );
  }
  if (result.stats.flippedFaces > 0) {
    ui.foot3d.textContent = `检测到 ${result.stats.flippedFaces} 个翻转面（红色）与 ${result.stats.nearZeroFaces} 个近零面（黄色），见诊断页`;
  } else {
    ui.foot3d.textContent = '左键点击边：切换切缝 · Shift+点击：选择面 · 拖拽旋转 · 滚轮缩放';
  }
}

/** Debounced so rapid seam clicks stay responsive while still recomputing per change. */
function recompute(): void {
  if (recomputeQueued) return;
  recomputeQueued = true;
  requestAnimationFrame(() => {
    recomputeQueued = false;
    computeNow();
  });
}

function renderAll(): void {
  renderOverview(ui.stats, ui.badge, ui.meta, store);
  renderSeams(ui.seamList, ui.seamCount, store, setSeams, (edge) => {
    three.highlightSeam(edge);
  });
  renderCharts(ui.chartList, ui.chartCount, store);
  renderDiagnostics(ui.diagList, ui.diagCount, store);
  renderInspector(ui.inspect, ui.inspectTag, store);
  renderExportSummary(ui.exportSummary, store);
  syncControls();
}

function setSeams(seams: [number, number][]): void {
  store.setSeams(seams);
}

function syncControls(): void {
  const flags = store.flags;
  $<HTMLInputElement>('tg-wire').checked = flags.wire;
  $<HTMLInputElement>('tg-chart').checked = flags.chartColor;
  $<HTMLInputElement>('tg-boundary').checked = flags.boundary;
  $<HTMLInputElement>('tg-split').checked = flags.split;
  $<HTMLInputElement>('tg-residual').checked = flags.residual;
  $<HTMLInputElement>('tg-uvgrid').checked = flags.uvGrid;
  $<HTMLInputElement>('tg-uvres').checked = flags.uvResidual;
}

function bindToggle(id: string, key: keyof typeof store.flags): void {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    store.setFlags({ [key]: input.checked });
  });
}

bindToggle('tg-wire', 'wire');
bindToggle('tg-chart', 'chartColor');
bindToggle('tg-boundary', 'boundary');
bindToggle('tg-split', 'split');
bindToggle('tg-residual', 'residual');
bindToggle('tg-uvgrid', 'uvGrid');
bindToggle('tg-uvres', 'uvResidual');

$('btn-fit3d').addEventListener('click', () => three.fit());
$('btn-fituv').addEventListener('click', () => uv.fit());

$('btn-clear-seams').addEventListener('click', () => {
  setSeams([]);
});

$('btn-auto-seam').addEventListener('click', () => {
  const input = store.input;
  if (!input) return;
  const mesh = { vertices: input.vertices, faces: input.faces, seams: store.seams };
  // The suggestion pass runs the same split logic; keep it off the main frame.
  window.setTimeout(() => {
    try {
      const suggestion = suggestSeamPath(mesh);
      if (!suggestion.allDisks) {
        store.setStatus('error', suggestion.reason);
        return;
      }
      if (suggestion.seams.length === 0) {
        store.setStatus('ok', suggestion.reason);
        return;
      }
      setSeams([...store.seams, ...suggestion.seams]);
      store.setStatus('ok', suggestion.reason);
    } catch (error) {
      store.setStatus('error', `自动切缝失败：${(error as Error).message}`);
    }
  }, 0);
});

$('btn-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  await loadFile(file);
});

sampleSelect.addEventListener('change', async () => {
  const name = sampleSelect.value;
  if (!name) return;
  await loadSample(name);
});

exportButton($('btn-export'));
exportButton($('btn-export-2'));

function exportButton(button: HTMLElement): void {
  button.addEventListener('click', () => {
    if (!store.result) {
      store.setStatus('error', '没有可导出的结果');
      return;
    }
    const json = buildExportJson(store.result);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    store.setStatus('ok', `已导出 ${a.download}`);
  });
}

$('btn-copy-uv').addEventListener('click', async () => {
  if (!store.result) return;
  const stream = buildCornerUvStream(store.result);
  const text = JSON.stringify({ format: 'corner-uv/v1', order: '3*face+corner', values: stream });
  try {
    await navigator.clipboard.writeText(text);
    store.setStatus('ok', '逐角 UV 已复制到剪贴板');
  } catch {
    store.setStatus('error', '剪贴板不可用');
  }
});

async function loadFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    loadData(parsed, file.name);
    sampleSelect.value = '';
  } catch (error) {
    store.setStatus('error', `无法读取 ${file.name}：${(error as Error).message}`);
  }
}

async function loadSample(name: string): Promise<void> {
  try {
    const base = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const response = await fetch(`${base}samples/${name}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    loadData(parsed, `${name}.json`);
  } catch (error) {
    store.setStatus('error', `无法加载样例 ${name}：${(error as Error).message}`);
  }
}

function loadData(raw: unknown, name: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    store.setStatus('error', 'JSON 顶层必须是对象');
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.vertices) || !Array.isArray(obj.faces)) {
    store.setStatus('error', 'JSON 缺少 vertices / faces 数组');
    return;
  }
  const vertices: [number, number, number][] = [];
  for (const v of obj.vertices) {
    if (!Array.isArray(v) || v.length !== 3) {
      store.setStatus('error', '存在不是 [x, y, z] 的顶点');
      return;
    }
    vertices.push([Number(v[0]), Number(v[1]), Number(v[2])]);
  }
  const faces: [number, number, number][] = [];
  for (const f of obj.faces) {
    if (!Array.isArray(f) || f.length !== 3) {
      store.setStatus('error', '存在不是三个索引的面');
      return;
    }
    faces.push([Number(f[0]), Number(f[1]), Number(f[2])]);
  }
  const seams: [number, number][] = [];
  if (Array.isArray(obj.seams)) {
    for (const s of obj.seams) {
      if (!Array.isArray(s) || s.length !== 2) continue;
      const a = Number(s[0]);
      const b = Number(s[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      seams.push(a < b ? [a, b] : [b, a]);
    }
  }
  store.setInput({ vertices, faces, seams }, name);
  const option = [...sampleSelect.options].find((o) => `${o.value}.json` === name);
  if (option) sampleSelect.value = option.value;
  three.resetCamera();
  uv.fit();
}

// ---------------------------------------------------------------- wiring

store.subscribe((event) => {
  if (event === 'input') {
    renderAll();
    recompute();
  } else if (event === 'seams') {
    renderSeams(ui.seamList, ui.seamCount, store, setSeams, (edge) => three.highlightSeam(edge));
    recompute();
  } else if (event === 'result') {
    renderAll();
  } else if (event === 'selection') {
    renderInspector(ui.inspect, ui.inspectTag, store);
  } else if (event === 'view') {
    // toggles only change rendering
  } else if (event === 'status') {
    ui.statusText.textContent = store.status.text;
    ui.statusTiming.textContent = store.status.timing;
    ui.statusDot.className = `dot ${store.status.kind === 'idle' ? '' : store.status.kind}`.trim();
  }
});

// Initial state: load the worked example so the tool is useful immediately.
renderAll();
store.setStatus('idle', '就绪 · 导入 JSON 或选择样例');
sampleSelect.value = 'cylinder-cut';
loadSample('cylinder-cut').catch(() => undefined);

// Keep the seam list highlighted when hovering in the 3D view.


// Expose for debugging in the browser console.
(window as unknown as { cutChart: unknown }).cutChart = { store, parameterize, three, uv };
