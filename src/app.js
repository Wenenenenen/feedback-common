// 主应用：文件加载、参数、分块处理、测量、绘图、导出、取消。
import { decodeWav, encodeWav, downloadBlob, WavError } from './wav-codec.js';
import { designResampler, reduceRatio } from './filter.js';
import { resampleStreamed } from './runner.js';
import {
  runMeasurements, detectSweep, measureFilterResponse,
} from './measurements.js';
import { drawLineChart, drawSpectrogram, drawWaveform } from './plots.js';

const $ = (id) => document.getElementById(id);
const state = {
  wav: null,
  fileName: '',
  design: null,
  out: null,
  outRate: null,
  measurements: null,
  isSweep: false,
  signal: { cancelled: false },
  running: false,
};

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status' + (isError ? ' error' : '');
}

function fmtDb(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '> 120 dB' : '< -120 dB';
  return `${v.toFixed(digits)} dB`;
}
function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '> 120' : '< -120';
  return v.toFixed(digits);
}

// ---------- 主题 ----------
$('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const cur = root.getAttribute('data-theme');
  root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
});

// ---------- 文件加载 ----------
const drop = $('drop');
const fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  setStatus('');
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const wav = decodeWav(buf);
    state.wav = wav;
    state.fileName = file.name;
    state.out = null;
    state.design = null;
    state.measurements = null;
    showInputMeta(wav, file);
    // 默认目标率：与输入不同的常用率
    const preferred = wav.rate === 44100 ? 48000 : 44100;
    $('targetRate').value = String(preferred);
    $('runBtn').disabled = false;
    $('resultCard').classList.add('hidden');
    $('chartCard').classList.add('hidden');
    $('exportCard').classList.add('hidden');
    updateRatioBadge();
    setStatus(`已加载 ${file.name}`);
  } catch (err) {
    state.wav = null;
    state.out = null;
    state.design = null;
    state.measurements = null;
    $('runBtn').disabled = true;
    $('inputMeta').classList.add('hidden');
    $('resultCard').classList.add('hidden');
    $('chartCard').classList.add('hidden');
    $('exportCard').classList.add('hidden');
    $('ratioBadge').textContent = '比例 L/M = —';
    $('filterBadge').textContent = '滤波器 —';
    if (err instanceof WavError) setStatus(`不支持的文件：${err.message}`, true);
    else setStatus(`读取失败：${err.message}`, true);
  }
}

function showInputMeta(wav, file) {
  const rows = [
    ['文件名', file.name],
    ['采样率 fᵢ', `${wav.rate} Hz`],
    ['位深', `${wav.bits} 位整数 PCM`],
    ['声道数', wav.channels === 1 ? '单声道' : '双声道'],
    ['每声道帧数', wav.frames.toLocaleString()],
    ['时长', `${(wav.frames / wav.rate).toFixed(3)} 秒`],
  ];
  $('metaTable').innerHTML = rows.map(([k, v]) =>
    `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  $('inputMeta').classList.remove('hidden');
}

// ---------- 参数徽章 ----------
function updateRatioBadge() {
  if (!state.wav) { $('ratioBadge').textContent = '比例 L/M = —'; return; }
  const fo = Number($('targetRate').value);
  const { L, M } = reduceRatio(state.wav.rate, fo);
  const Nout = Math.ceil((state.wav.frames * L) / M);
  $('ratioBadge').textContent = `比例 L/M = ${L}/${M} · 输出 ${Nout.toLocaleString()} 帧`;
}
$('targetRate').addEventListener('change', updateRatioBadge);

// ---------- 处理 ----------
$('runBtn').addEventListener('click', runProcessing);
$('cancelBtn').addEventListener('click', () => { state.signal.cancelled = true; });

async function runProcessing() {
  if (!state.wav || state.running) return;
  state.running = true;
  state.signal = { cancelled: false };
  $('runBtn').disabled = true;
  $('cancelBtn').classList.remove('hidden');
  $('progWrap').classList.remove('hidden');
  $('progBar').style.width = '0%';

  try {
    const wav = state.wav;
    const fo = Number($('targetRate').value);
    const P = Number($('taps').value);
    const attenDb = Number($('atten').value);
    const cutoffRatio = Number($('cutoff').value);
    const chunkSize = Number($('chunkSize').value);

    if (fo === wav.rate) {
      // 仍允许 1:1，用于验证恒等
    }
    if (!(P >= 8 && P % 2 === 0)) throw new Error('每分支抽头数必须是不小于 8 的偶数');
    if (!(chunkSize >= 1)) throw new Error('分块大小必须 ≥ 1');

    setStatus('设计 Kaiser 多相滤波器…');
    const design = designResampler(wav.rate, fo, { tapsPerBranch: P, attenDb, cutoffRatio });
    state.design = design;
    state.outRate = fo;
    $('filterBadge').textContent =
      `β=${design.beta.toFixed(2)} · 原型 ${design.prototypeLength.toLocaleString()} 抽头 · 预测阻带 ${design.achievedAttenDb.toFixed(0)}dB`;

    setStatus('分块重采样处理中…');
    const t0 = performance.now();
    const out = await resampleStreamed(design, wav.channelData, {
      chunkSize,
      signal: state.signal,
      onProgress: (p) => {
        $('progBar').style.width = `${(p * 100).toFixed(1)}%`;
      },
    });
    const elapsed = performance.now() - t0;
    state.out = out;

    setStatus('执行测量与频谱分析…');
    await new Promise((r) => setTimeout(r, 0));
    state.isSweep = detectSweep(wav.channelData[0], wav.rate);
    const measurements = runMeasurements({
      inData: wav.channelData,
      outData: out,
      fi: wav.rate,
      fo,
      design,
      channels: wav.channels,
      isSweep: state.isSweep,
    });
    measurements.processing = {
      elapsedMs: elapsed,
      chunkSize,
      inputFrames: wav.frames,
      outputFrames: out[0].length,
      expectedFrames: Math.ceil((wav.frames * design.L) / design.M),
      lengthExact: out[0].length === Math.ceil((wav.frames * design.L) / design.M),
    };
    state.measurements = measurements;

    renderMetrics(measurements, design, wav, fo);
    renderCharts();
    $('resultCard').classList.remove('hidden');
    $('chartCard').classList.remove('hidden');
    $('exportCard').classList.remove('hidden');
    $('specTab').classList.toggle('hidden', !state.isSweep);
    if (state.isSweep) switchTab('spectrogram');
    setStatus(`完成，用时 ${(elapsed / 1000).toFixed(2)} 秒，输出 ${out[0].length.toLocaleString()} 帧`);
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('处理已取消，未生成输出。', true);
      $('progBar').style.width = '0%';
    } else {
      setStatus(`处理失败：${err.message}`, true);
    }
  } finally {
    state.running = false;
    $('runBtn').disabled = false;
    $('cancelBtn').classList.add('hidden');
  }
}

// ---------- 指标卡片 ----------
function renderMetrics(m, design, wav, fo) {
  const f = m.filter;
  const cards = [];
  const add = (name, val, sub = '', cls = '') => cards.push(
    `<div class="metric"><div class="name">${name}</div><div class="val ${cls}">${val}</div><div class="sub">${sub}</div></div>`);

  add('通带纹波', fmtNum(f.passRippleDb, 4), `平坦区 ≤ ${(f.passEdgeHz * 0.95).toFixed(0)} Hz`,
    f.passRippleDb <= 0.1 ? 'pass' : 'fail');
  const stopShown = Number.isFinite(f.stopAttenMinDb) ? f.stopAttenMinDb.toFixed(1) : '> 120';
  add('实测阻带衰减', `${stopShown} dB`,
    `≥ ${f.stopEdgeHz.toFixed(0)} Hz`, f.stopAttenMinDb >= design.attenDb ? 'pass' : 'fail');
  add('-3dB 截止频率', `${f.minus3dbHz.toFixed(0)} Hz`,
    `过渡带 ${f.passEdgeHz.toFixed(0)}–${f.stopEdgeHz.toFixed(0)}`);
  add('Kaiser β', design.beta.toFixed(3), `目标衰减 ${design.attenDb} dB`);

  if (m.suppressedDb !== null) {
    // 输入主音高于输出奈奎斯特，应被滤除
    add('带外主音抑制', `${m.suppressedDb.toFixed(1)} dB`,
      `输入 ${m.inTone.toneFreq.toFixed(0)}Hz 高于 fₒ/2`,
      m.suppressedDb <= -80 ? 'pass' : 'fail');
  } else if (m.toneGainDb !== null) {
    add('主音增益变化', `${m.toneGainDb.toFixed(3)} dB`,
      `输入 ${m.inTone.toneFreq?.toFixed(1)}Hz → 输出 ${m.outTone.toneFreq?.toFixed(1)}Hz`,
      Math.abs(m.toneGainDb) <= 0.1 ? 'pass' : 'warn');
  }
  if (m.outTone.sfdrDb !== null) {
    add('输出 SFDR', `${m.outTone.sfdrDb.toFixed(1)} dB`, '主峰对最高杂散',
      m.outTone.sfdrDb >= 80 ? 'pass' : 'warn');
  }
  if (m.outTone.spurs && m.outTone.spurs.length) {
    const worst = m.outTone.spurs.reduce((a, b) => (b.db > a.db ? b : a), m.outTone.spurs[0]);
    add(worst.kind === 'alias' ? '最强混叠分量' : '最强镜像分量',
      `${worst.db.toFixed(1)} dBFS`, `${worst.freqHz.toFixed(0)} Hz（相对主峰 ${worst.relativeDb.toFixed(1)}dB）`,
      worst.db < -80 ? 'pass' : 'fail');
  } else if (m.outTone.floorMedianDb !== null) {
    add('杂散/噪声底', `${m.outTone.floorMedianDb.toFixed(1)} dBFS`, '无分立杂散分量',
      m.outTone.floorMedianDb < -80 ? 'pass' : 'warn');
  }

  if (m.groupDelay) {
    add('群延迟', `${m.groupDelay.delayOutputSamples.toFixed(4)} 样本`,
      `峰值 ${m.groupDelay.peakOutputIndex.toFixed(2)} / 理论 ${m.groupDelay.theoreticalPeakIndex.toFixed(2)}`,
      Math.abs(m.groupDelay.delayOutputSamples) < 0.25 ? 'pass' : 'warn');
  } else {
    add('群延迟', '0（设计值）', '零延迟多相结构，无整体样本偏移');
  }

  add('输出长度', m.processing.lengthExact ? '精确符合' : '不符',
    `${m.processing.outputFrames.toLocaleString()} = ⌈N·fₒ/fᵢ⌉`,
    m.processing.lengthExact ? 'pass' : 'fail');

  if (m.sweep) {
    const mx = m.sweep.output.maxAliasDb;
    if (mx === null) {
      cards.push(
        `<div class="metric"><div class="name">扫频混叠</div><div class="val pass">无混叠</div>` +
        `<div class="sub">全程低于输出奈奎斯特，谱图无折叠亮线</div></div>`);
    } else {
      add('扫频最大混叠', `${mx.toFixed(1)} dBFS`,
        'STFT 折叠位置能量', mx < -80 ? 'pass' : 'fail');
    }
  }

  $('metrics').innerHTML = cards.join('');
  $('jsonView').textContent = JSON.stringify(buildExportJson(), null, 2);
}

function buildExportJson() {
  const wav = state.wav;
  const m = state.measurements;
  const d = state.design;
  return {
    tool: 'polyphase-resample-bench',
    generatedAt: new Date().toISOString(),
    input: {
      file: state.fileName,
      sampleRate: wav.rate,
      bits: wav.bits,
      channels: wav.channels,
      frames: wav.frames,
      durationSec: wav.frames / wav.rate,
    },
    output: {
      sampleRate: state.outRate,
      bits: wav.bits,
      channels: wav.channels,
      frames: state.out[0].length,
      lengthFormula: 'Nout = ceil(N * fo / fi)',
    },
    ratio: {
      L: d.L, M: d.M, reduced: `${d.L}/${d.M}`,
      fo_over_fi: d.fo / d.fi,
    },
    filter: {
      type: 'Kaiser-windowed sinc polyphase, zero group delay',
      tapsPerBranch: d.P,
      prototypeLength: d.prototypeLength,
      kaiserBeta: d.beta,
      targetStopbandDb: d.attenDb,
      cutoffRatio: d.cutoffRatio,
      passEdgeHz: d.passHz,
      stopEdgeHz: d.stopHz,
      transitionHz: d.transitionHz,
      measuredPassbandRippleDb: m.filter.passRippleDb,
      measuredStopAttenuationDb: m.filter.stopAttenMinDb,
      minus3dbHz: m.filter.minus3dbHz,
    },
    measurements: {
      inputToneFreqHz: m.inTone.toneFreq,
      inputToneDbfs: m.inTone.toneDb,
      outputToneFreqHz: m.outTone.toneFreq,
      outputToneDbfs: m.outTone.toneDb,
      toneGainDb: m.toneGainDb,
      sfdrDb: m.outTone.sfdrDb,
      spurs: m.outTone.spurs,
      noiseFloorMedianDbfs: m.outTone.floorMedianDb,
      groupDelay: m.groupDelay,
      sweepAlias: m.sweep ? {
        maxAliasDbfs: m.sweep.output.maxAliasDb,
        meanAliasDbfs: m.sweep.output.meanAliasDb,
      } : null,
    },
    processing: m.processing,
  };
}

// ---------- 图表 ----------
function switchTab(tab) {
  document.querySelectorAll('#chartTabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-pane]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.pane !== tab));
  // 切到该页时重绘（canvas 尺寸依赖可见性）
  requestAnimationFrame(() => renderCharts(tab));
}
document.querySelectorAll('#chartTabs button').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

function renderCharts(only) {
  if (!state.out) return;
  const wav = state.wav;
  const m = state.measurements;
  const doAll = !only;

  if (doAll || only === 'spectrum') {
    const sIn = m.inTone.spectrum;
    const sOut = m.outTone.spectrum;
    drawLineChart($('spectrumCanvas'), [
      { x: sIn.freqs, y: sIn.magDb, colorVar: '--series-1', label: `输入 ${wav.rate}Hz` },
      { x: sOut.freqs, y: sOut.magDb, colorVar: '--series-2', label: `输出 ${state.outRate}Hz` },
    ], {
      yMin: -120, yMax: 5,
      xTitle: '频率 (Hz)', yTitle: '幅度 (dBFS)',
      markers: [
        { x: wav.rate / 2, label: `fᵢ/2 ${wav.rate / 2 / 1000}k`, colorVar: '--series-1' },
        { x: state.outRate / 2, label: `fₒ/2 ${state.outRate / 2 / 1000}k`, colorVar: '--series-2' },
      ],
    });
  }

  if (doAll || only === 'filter') {
    const r = m.filter.resp;
    drawLineChart($('filterCanvas'), [
      { x: r.freqsLow, y: r.magDb, colorVar: '--series-3', label: '原型低通响应' },
    ], {
      yMin: -120, yMax: 5,
      xMax: state.design.fsLow / 2,
      xTitle: '物理频率 (Hz)', yTitle: '增益 (dB)',
      markers: [
        { x: state.design.passHz, label: '通带边沿', colorVar: '--series-4' },
        { x: state.design.stopHz, label: '奈奎斯特', colorVar: '--bad' },
      ],
    });
  }

  if (doAll || only === 'waveform') {
    drawWaveform($('waveCanvas'), state.out[0], state.outRate);
  }

  if ((doAll || only === 'spectrogram') && state.isSweep && m.sweep) {
    drawSpectrogram($('specCanvas'), m.sweep.output.stft, m.sweep.output.mainTrack, {
      fMax: state.outRate / 2,
    });
    const mx = m.sweep.output.maxAliasDb;
    $('specStatus').textContent = mx !== null
      ? `扫频混叠最大电平 ${mx.toFixed(1)} dBFS（要求 < -80 dBFS）；橙线为主频轨迹，混叠亮线应明显低于主频。`
      : '未检测到分立混叠分量。';
  }
}

window.addEventListener('resize', () => {
  if (state.out) {
    const active = document.querySelector('#chartTabs button.active')?.dataset.tab;
    renderCharts(active);
  }
});

// ---------- 导出 ----------
$('exportWavBtn').addEventListener('click', () => {
  if (!state.out) return;
  const bytes = encodeWav(state.out, state.outRate, state.wav.bits);
  const base = state.fileName.replace(/\.wav$/i, '');
  downloadBlob(bytes, `${base}_${state.outRate}Hz.wav`, 'audio/wav');
});

$('exportJsonBtn').addEventListener('click', () => {
  if (!state.measurements) return;
  const json = JSON.stringify(buildExportJson(), null, 2);
  const base = state.fileName.replace(/\.wav$/i, '');
  downloadBlob(new TextEncoder().encode(json), `${base}_measurements.json`, 'application/json');
});
