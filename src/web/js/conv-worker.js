/*
 * 卷积 Worker。常驻单实例，音频数据只在初始化时复制一次。
 *
 * 消息协议：
 *   -> {type:'audio', audioId, dryL, dryR, irs, sampleRate}
 *   -> {type:'analyze', id, params}
 *   -> {type:'render', id, params, startFrame, endFrame}
 *   -> {type:'export', id, params}
 *   -> {type:'cancel', id}
 *   <- {type:'progress', id, progress}
 *   <- {type:'result', id, ...} | {type:'error', id, message} | {type:'cancelled', id}
 *
 * 长任务按块处理，每块之间让出事件循环，保证取消消息能在计算中处理。
 */

import {
  MatrixConvolver,
  CancelledError,
  buildIrSpectra,
  chooseBlockSize,
} from './dsp/convolver.js';
import { getFFT } from './dsp/fft.js';
import { renderRange } from './dsp/render-range.js';
import { encodeWav24 } from './wav.js';

let audio = null; // { dryL, dryR, irs, sampleRate, audioId }
const cancelled = new Set();

// 试听按段渲染时参数可视为不变：缓存与音频数据绑定的频谱
const spectrumCache = { key: '', irSpectra: null, block: 0, fftSize: 0, fft: null };

function cachedSpectra() {
  const key = String(audio.audioId);
  if (spectrumCache.key === key) return spectrumCache;
  const maxIr = audio.irs.reduce((m, ir) => Math.max(m, ir.length), 0);
  const block = chooseBlockSize(maxIr);
  const fftSize = block * 2;
  const fft = getFFT(fftSize);
  spectrumCache.key = key;
  spectrumCache.block = block;
  spectrumCache.fftSize = fftSize;
  spectrumCache.fft = fft;
  spectrumCache.irSpectra = buildIrSpectra(audio.irs, fft, fftSize);
  return spectrumCache;
}

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

function checkCancelled(id) {
  if (cancelled.has(id)) {
    cancelled.delete(id);
    throw new CancelledError();
  }
}

function buildConvolver(params) {
  if (!audio) throw new Error('音频数据尚未加载');
  return new MatrixConvolver({
    dryL: audio.dryL,
    dryR: audio.dryR,
    irs: audio.irs,
    predelayFrames: params.predelayFrames,
    wetRatio: params.wetRatio,
  });
}

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === 'audio') {
    audio = {
      dryL: msg.dryL,
      dryR: msg.dryR,
      irs: msg.irs,
      sampleRate: msg.sampleRate,
      audioId: msg.audioId,
    };
    spectrumCache.key = '';
    self.postMessage({ type: 'audio-ready', audioId: msg.audioId });
    return;
  }

  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }

  const { id } = msg;
  if (!id) return;

  const run = async () => {
    try {
      if (msg.type === 'analyze') await runAnalyze(id, msg.params);
      else if (msg.type === 'render') await runRender(id, msg.params, msg.startFrame, msg.endFrame);
      else if (msg.type === 'export') await runExport(id, msg.params);
      else throw new Error(`未知任务类型：${msg.type}`);
    } catch (err) {
      if (err instanceof CancelledError) {
        self.postMessage({ type: 'cancelled', id });
      } else {
        self.postMessage({ type: 'error', id, message: err?.message || String(err) });
      }
    } finally {
      cancelled.delete(id);
    }
  };
  run();
};

async function runAnalyze(id, params) {
  const conv = buildConvolver(params);
  const total = conv.totalFrames;
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  conv.renderDry(left, right);

  const blocks = conv.blockCount;
  const startTime = Date.now();
  const yieldEvery = 4;

  for (let n = 0; n < blocks; n++) {
    conv.processBlock(n, left, right);
    if (blocks <= 8 || (n + 1) % yieldEvery === 0 || n === blocks - 1) {
      const done = Math.min(total, (n + 1) * conv.block);
      self.postMessage({ type: 'progress', id, progress: total ? done / total : 1 });
      await yieldToEventLoop();
      checkCancelled(id);
    }
  }

  // 全部块完成后再统一扫描：湿声被预延迟平移，不能按块范围扫描
  const bins = Math.max(1, Math.min(params.envelopeBins || 4096, Math.max(1, total)));
  const envL = new Float32Array(bins);
  const envR = new Float32Array(bins);
  const binScale = bins / Math.max(1, total);

  let peak = 0;
  let overL = 0;
  let overR = 0;
  for (let i = 0; i < total; i++) {
    const a = left[i] < 0 ? -left[i] : left[i];
    const b = right[i] < 0 ? -right[i] : right[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    if (a > 1) overL++;
    if (b > 1) overR++;
    let bin = (i * binScale) | 0;
    if (bin >= bins) bin = bins - 1;
    if (a > envL[bin]) envL[bin] = a;
    if (b > envR[bin]) envR[bin] = b;
  }
  checkCancelled(id);

  self.postMessage(
    {
      type: 'result',
      id,
      totalFrames: total,
      wetFrames: conv.wetFrames,
      dryFrames: conv.dryFrames,
      maxIrFrames: conv.maxIrFrames,
      predelayFrames: conv.predelayFrames,
      peak,
      overL,
      overR,
      overCount: overL + overR,
      envelope: { bins, total, left: envL, right: envR },
      elapsedMs: Date.now() - startTime,
    },
    [envL.buffer, envR.buffer],
  );
}

async function runRender(id, params, startFrame, endFrame) {
  const spectra = cachedSpectra();
  const dryFrames = Math.max(audio.dryL.length, audio.dryR.length);
  const maxIrFrames = audio.irs.reduce((m, ir) => Math.max(m, ir.length), 0);
  const totalFrames = dryFrames + maxIrFrames - 1 + params.predelayFrames;
  const start = Math.max(0, Math.min(startFrame, totalFrames));
  const end = Math.max(start, Math.min(endFrame, totalFrames));

  const { outL, outR } = renderRange({
    dryL: audio.dryL,
    dryR: audio.dryR,
    irSpectra: spectra.irSpectra,
    fftSize: spectra.fftSize,
    block: spectra.block,
    totalFrames,
    wetRatio: params.wetRatio,
    predelayFrames: params.predelayFrames,
    start,
    end,
    fft: spectra.fft,
  });

  const bufL = new Float32Array(outL.length);
  const bufR = new Float32Array(outR.length);
  for (let i = 0; i < outL.length; i++) {
    bufL[i] = outL[i];
    bufR[i] = outR[i];
  }
  checkCancelled(id);

  self.postMessage(
    {
      type: 'result',
      id,
      sampleRate: audio.sampleRate,
      startFrame: start,
      endFrame: end,
      left: bufL,
      right: bufR,
    },
    [bufL.buffer, bufR.buffer],
  );
}

async function runExport(id, params) {
  const conv = buildConvolver(params);
  const total = conv.totalFrames;
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  conv.renderDry(left, right);

  const blocks = conv.blockCount;
  const startTime = Date.now();
  const yieldEvery = 4;
  for (let n = 0; n < blocks; n++) {
    conv.processBlock(n, left, right);
    if ((n + 1) % yieldEvery === 0 || n === blocks - 1) {
      self.postMessage({ type: 'progress', id, progress: total ? Math.min(total, (n + 1) * conv.block) / total : 1 });
      await yieldToEventLoop();
      checkCancelled(id);
    }
  }

  const encoded = encodeWav24([left, right], audio.sampleRate);
  checkCancelled(id);
  self.postMessage(
    {
      type: 'result',
      id,
      totalFrames: total,
      sampleRate: audio.sampleRate,
      peak: encoded.peak,
      overL: encoded.overPerChannel[0],
      overR: encoded.overPerChannel[1],
      overCount: encoded.overCount,
      clampCount: encoded.clampCount,
      wav: encoded.buffer,
      elapsedMs: Date.now() - startTime,
    },
    [encoded.buffer],
  );
}
