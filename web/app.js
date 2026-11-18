// 页面主逻辑：状态 -> Worker 重算 -> 画布渲染 -> 导出。
import { decodePng, encodePng16 } from '../lib/png.js';
import { renderRgb16, renderCfa, renderPngRef, overlayCfaGrid } from './render.js';
import { parseRaw, normalizePlanes } from '../lib/raw.js';

const $ = (id) => document.getElementById(id);
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const CH_NAME = ['R', 'G', 'B'];

const state = {
  cases: [],                 // 服务端内置样例
  reference: null,
  rawBytes: null,
  wbDefault: null,
  wb: null,
  caseName: null,
  isLocalFile: false,
  algorithm: 'bilinear',
  channel: -1,
  zoom: 2,
  result: null,              // Worker 最近一次成功结果
  truth16: null,
  truthSize: null,
  reqSeq: 0,
  pan: { x: 0, y: 0 },       // 放大区域左上角（全图像素坐标）
};

const worker = new Worker(new URL('/web/worker.js', location.origin), { type: 'module' });
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.id !== state.reqSeq) return; // 过期结果丢弃
  document.body.classList.remove('busy');
  if (!msg.ok) {
    setStatus(`重算失败：${msg.error}`, true);
    return;
  }
  state.result = msg;
  $('elapsed').textContent = `${msg.elapsedMs.toFixed(1)} ms`;
  if (msg.metrics) {
    $('psnrOverall').textContent = fmtPsnr(msg.metrics.overall);
    $('psnrR').textContent = fmtPsnr(msg.metrics.perChannel[0]);
    $('psnrG').textContent = fmtPsnr(msg.metrics.perChannel[1]);
    $('psnrB').textContent = fmtPsnr(msg.metrics.perChannel[2]);
  } else {
    $('psnrOverall').textContent = '—';
    $('psnrR').textContent = '—';
    $('psnrG').textContent = '—';
    $('psnrB').textContent = '—';
  }
  setStatus('完成');
  renderAll();
  $('exportPngBtn').disabled = false;
  $('exportJsonBtn').disabled = false;
};

const fmtPsnr = (v) => (v === Infinity ? '∞ dB' : `${v.toFixed(3)} dB`);
function setStatus(t, bad = false) {
  const el = $('statusLine');
  el.textContent = '';
  const s = document.createElement('strong');
  s.textContent = t;
  if (bad) s.style.color = 'var(--r)';
  el.appendChild(s);
}

// ---------- 数据加载 ----------
async function loadCases() {
  const payload = await (await fetch('/api/cases')).json();
  state.cases = payload.cases;
  state.reference = payload.reference;
  const sel = $('caseSelect');
  for (const c of payload.cases) {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = `${c.name}（${payload.reference[c.name].width}×${payload.reference[c.name].height} / ${payload.reference[c.name].pattern}）`;
    sel.appendChild(opt);
  }
  sel.onchange = () => selectCase(sel.value);
  await selectCase(payload.cases[0].name);
}

async function selectCase(name) {
  const c = state.cases.find((x) => x.name === name);
  state.caseName = name;
  state.isLocalFile = false;
  state.rawBytes = b64ToBytes(c.rawBase64);
  state.wbDefault = { ...c.wb };
  state.wb = { ...c.wb };
  const truth = await decodePng(b64ToBytes(c.truthBase64));
  state.truth16 = truth.data;
  state.truthSize = { width: truth.width, height: truth.height };
  syncWbInputs();
  fillRawMeta();
  state.pan = { x: 0, y: 0 };
  scheduleRecompute();
}

function fillRawMeta() {
  const raw = parseRaw(state.rawBytes);
  $('rawMeta').innerHTML = `
    <span>尺寸</span><b>${raw.width} × ${raw.height}</b>
    <span>位深</span><b>${raw.bits} bit</b>
    <span>排列</span><b>${raw.patternName}</b>
    <span>黑/白电平</span><b>${raw.black} / ${raw.white}</b>`;
  $('cfaName').textContent = raw.patternName;
}

function syncWbInputs() {
  $('wbR').value = state.wb.r;
  $('wbG').value = state.wb.g;
  $('wbB').value = state.wb.b;
}

// ---------- 重算（防抖 + 序列号丢弃过期结果） ----------
let timer = null;
function scheduleRecompute() {
  clearTimeout(timer);
  setStatus('计算中…');
  document.body.classList.add('busy');
  $('exportPngBtn').disabled = true;
  $('exportJsonBtn').disabled = true;
  // 立即占号：切换样例后任何在途的旧结果都会因 seq 不匹配被丢弃
  const id = ++state.reqSeq;
  timer = setTimeout(() => {
    worker.postMessage({
      id,
      rawBytes: state.rawBytes,
      wb: state.wb,
      algorithm: state.algorithm,
      truth16: state.truth16,
    });
  }, 120);
}

// ---------- 渲染 ----------
function renderAll() {
  const r = state.result;
  if (!r) return;
  const zoom = state.zoom;
  const ch = state.channel;

  renderRgb16($('curCanvas').getContext('2d'), r.rgb16, r.width, r.height, { channel: ch, zoom });
  if (state.truth16) {
    renderPngRef($('refCanvas').getContext('2d'), state.truth16, state.truthSize.width, state.truthSize.height, { channel: ch, zoom });
  } else {
    const ctx = $('refCanvas').getContext('2d');
    ctx.canvas.width = r.width * zoom;
    ctx.canvas.height = r.height * zoom;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#93a3b5';
    ctx.font = '16px sans-serif';
    ctx.fillText('本地文件无 truth 参考图', 16, 32);
  }
  renderCfa($('cfaCanvas').getContext('2d'), r.planes, r.mask, r.width, r.height, { channel: ch, zoom });
  if ($('gridToggle').checked && zoom >= 4 && ch !== -1) {
    overlayCfaGrid($('cfaCanvas').getContext('2d'), r.width, r.height, zoom, ch, r.cfa);
  }
  $('curTitle').textContent = `${$('algoSelect').selectedOptions[0].textContent} 结果`;
  renderNav();
  syncScrolls();
}

// 导航缩略图（1× 全图）+ 放大区域框
function renderNav() {
  const r = state.result;
  const nav = $('navCanvas');
  renderRgb16(nav.getContext('2d'), r.rgb16, r.width, r.height, { channel: state.channel, zoom: 1 });
  const scale = nav.clientWidth / r.width;
  const viewW = Math.ceil($('curScroll').clientWidth / state.zoom);
  const viewH = Math.ceil($('curScroll').clientHeight / state.zoom);
  const rect = $('navRect');
  rect.style.width = `${Math.min(nav.clientWidth, viewW * scale)}px`;
  rect.style.height = `${Math.min(nav.clientHeight, viewH * scale)}px`;
  updateNavRect(scale);
}

function updateNavRect(scale) {
  const rect = $('navRect');
  rect.style.left = `${state.pan.x * scale}px`;
  rect.style.top = `${state.pan.y * scale}px`;
}

// 两个放大窗与 CFA 窗滚动位置联动
function syncScrolls() {
  const r = state.result;
  const z = state.zoom;
  $('curScroll').scrollLeft = state.pan.x * z;
  $('curScroll').scrollTop = state.pan.y * z;
  $('refScroll').scrollLeft = state.pan.x * z;
  $('refScroll').scrollTop = state.pan.y * z;
  $('cfaScroll').scrollLeft = state.pan.x * z;
  $('cfaScroll').scrollTop = state.pan.y * z;
}

function bindScroll(el) {
  el.addEventListener('scroll', () => {
    state.pan.x = Math.round(el.scrollLeft / state.zoom);
    state.pan.y = Math.round(el.scrollTop / state.zoom);
    const nav = $('navCanvas');
    updateNavRect(nav.clientWidth / state.result.width);
    // 联动另外两个窗（避免回环：只在来源非自己时设置）
    for (const other of [$('curScroll'), $('refScroll'), $('cfaScroll')]) {
      if (other !== el) {
        other.scrollLeft = el.scrollLeft;
        other.scrollTop = el.scrollTop;
      }
    }
  }, { passive: true });
}

// 导航图点击/拖拽定位
function bindNav() {
  const nav = $('navCanvas');
  const jump = (ev) => {
    if (!state.result) return;
    const box = nav.getBoundingClientRect();
    const px = (ev.clientX - box.left) / box.width * state.result.width;
    const py = (ev.clientY - box.top) / box.height * state.result.height;
    const viewW = Math.ceil($('curScroll').clientWidth / state.zoom);
    const viewH = Math.ceil($('curScroll').clientHeight / state.zoom);
    state.pan.x = Math.max(0, Math.min(state.result.width - viewW, Math.round(px - viewW / 2)));
    state.pan.y = Math.max(0, Math.min(state.result.height - viewH, Math.round(py - viewH / 2)));
    syncScrolls();
  };
  let dragging = false;
  nav.addEventListener('pointerdown', (e) => { dragging = true; nav.setPointerCapture(e.pointerId); jump(e); });
  nav.addEventListener('pointermove', (e) => dragging && jump(e));
  nav.addEventListener('pointerup', () => { dragging = false; });
}

// ---------- 控件绑定 ----------
function bindControls() {
  $('algoSelect').onchange = (e) => { state.algorithm = e.target.value; scheduleRecompute(); };
  $('channelSelect').onchange = (e) => { state.channel = Number(e.target.value); renderAll(); };
  $('zoomSelect').onchange = (e) => { state.zoom = Number(e.target.value); renderAll(); };
  $('gridToggle').onchange = () => renderAll();

  for (const [key, id] of [['r', 'wbR'], ['g', 'wbG'], ['b', 'wbB']]) {
    $(id).oninput = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        state.wb[key] = v;
        scheduleRecompute();
      }
    };
  }
  $('resetWbBtn').onclick = () => { state.wb = { ...state.wbDefault }; syncWbInputs(); scheduleRecompute(); };

  $('rawFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    try {
      const raw = parseRaw(buf); // 先校验，失败不切换状态
      state.rawBytes = buf;
      state.caseName = file.name.replace(/\.raw$/i, '');
      state.isLocalFile = true;
      state.wbDefault = { r: 1, g: 1, b: 1 };
      state.wb = { r: 1, g: 1, b: 1 };
      syncWbInputs();
      fillRawMeta();
      // 本地文件无 truth：null 表示无参考，Worker 跳过 PSNR
      state.truth16 = null;
      state.truthSize = { width: raw.width, height: raw.height };
      state.pan = { x: 0, y: 0 };
      $('caseSelect').value = '';
      setStatus('本地文件无 truth 参考，PSNR 不适用', false);
      scheduleRecompute();
    } catch (err) {
      alert(`RAW 文件无法解析：${err.message}`);
      e.target.value = '';
    }
  };

  $('exportPngBtn').onclick = exportPng;
  $('exportJsonBtn').onclick = exportJson;
  window.addEventListener('resize', () => state.result && renderNav());
}

function download(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function exportPng() {
  const r = state.result;
  const png = await encodePng16(r.width, r.height, r.rgb16);
  download(png, `${state.caseName}-${state.algorithm}-16bit.png`, 'image/png');
}

async function exportJson() {
  const r = state.result;
  const raw = parseRaw(state.rawBytes);
  const report = {
    case: state.caseName,
    source: state.isLocalFile ? 'local-upload' : 'built-in-sample',
    algorithm: state.algorithm,
    generatedAt: new Date().toISOString(),
    raw: {
      width: raw.width, height: raw.height, bits: raw.bits,
      pattern: raw.patternName, blackLevel: raw.black, whiteLevel: raw.white,
    },
    whiteBalance: state.wb,
    processing: {
      order: 'normalization -> white-balance -> clamp(0,1) -> demosaic -> 16bit quantize',
      boundary: 'mirror（-1->1, w->w-2），未裁剪',
      quantization: 'floor(v*65535+0.5)',
    },
    metrics: state.isLocalFile
      ? { note: '本地文件无 truth 参考，未计算 PSNR' }
      : {
          psnrDb: Number(r.metrics.overall.toFixed(4)),
          perChannelPsnrDb: {
            r: Number(r.metrics.perChannel[0].toFixed(4)),
            g: Number(r.metrics.perChannel[1].toFixed(4)),
            b: Number(r.metrics.perChannel[2].toFixed(4)),
          },
          definition: '10*log10(65535^2/MSE)，三通道全部像素',
          reference: `truth/${state.caseName}.png`,
          sampleExpected: state.reference?.[state.caseName]?.bilinearPsnr ?? null,
        },
    elapsedMs: Number(r.elapsedMs.toFixed(2)),
  };
  download(JSON.stringify(report, null, 2), `${state.caseName}-${state.algorithm}-metrics.json`, 'application/json');
}

// ---------- 启动 ----------
bindControls();
bindNav();
bindScroll($('curScroll'));
bindScroll($('refScroll'));
bindScroll($('cfaScroll'));
loadCases().catch((e) => setStatus(`样例加载失败：${e.message}`, true));
