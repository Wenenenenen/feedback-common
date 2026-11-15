/*
 * 旋转 Worker：持有规范序输入，负责整段渲染、监听立体声解码与 WAV 导出。
 *
 * 预览与导出调用同一个 renderCanonical()，旋转曲线与 24-bit 量化完全一致；
 * 导出时重新渲染一遍（而不是复用预览缓存），避免预览与导出因参数顺序不同
 * 而出现两套结果。
 *
 * 主线程 → Worker
 *   {type:'load',    id, planes:[Float32Array×4], inputFormat, sampleRate}
 *   {type:'render',  id, rotation, outputFormat, monitorRows}
 *   {type:'export',  id, rotation, outputFormat}
 *   {type:'compare', id, rotation, reference:[Int32Array×4]}  参考核对，不产出下载
 *   {type:'cancel',  id}
 * Worker → 主线程
 *   {type:'loaded',   id, frames, sampleRate, peak, channelPeaks}
 *   {type:'progress', id, done, total, stage}
 *   {type:'rendered', id, stats, stereo:{left,right,sampleRate}}
 *   {type:'exported', id, buffer, meta}
 *   {type:'compared', id, worst, worstFrame, worstChannel}
 *   {type:'error',    id, message, cancelled?, overflow?, stats?}
 */

import {
  CancelledError,
  formatPlanes,
  renderCanonical,
  toCanonical,
} from './dsp/rotation.js';
import { decodeMonitor, DEFAULT_MONITOR_ROWS } from './player.js';
import { encodeWav24FromInt } from './wav.js';

let source = null; // {canonical, sampleRate, frames, inputFormat}
let lastRender = null; // {planes(规范序 Int32×4), rotation, outputFormat}
const cancelled = new Set();

function post(message, transfer) {
  if (transfer && transfer.length) self.postMessage(message, transfer);
  else self.postMessage(message);
}

/** 监听矩阵来自样例包（外部数据），形状或数值异常时退回内置矩阵。 */
function monitorRowsOrFallback(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) return DEFAULT_MONITOR_ROWS;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4) return DEFAULT_MONITOR_ROWS;
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MONITOR_ROWS;
    }
  }
  return rows;
}

/** 规范序量化平面 → 监听立体声（浮点）。 */
function buildStereo(planes, rows) {
  const frames = planes[0].length;
  const w = new Float32Array(frames);
  const y = new Float32Array(frames);
  const z = new Float32Array(frames);
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    w[i] = planes[0][i] / 8388608;
    y[i] = planes[1][i] / 8388608;
    z[i] = planes[2][i] / 8388608;
    x[i] = planes[3][i] / 8388608;
  }
  return decodeMonitor({ W: w, Y: y, Z: z, X: x }, rows, 0, frames);
}

/**
 * 规范序量化平面 → 四通道包络（每通道 min/max，按桶降采样）。
 * 时间轴按输出格式通道顺序画四条，因此这里也按该顺序返回。
 */
function buildEnvelopes(planes, outputFormat, buckets) {
  const order = outputFormat === 'fuma' ? [0, 3, 1, 2] : [0, 1, 2, 3];
  const frames = planes[0].length;
  const count = Math.max(1, Math.min(buckets, frames));
  const out = [];
  for (const src of order) {
    const p = planes[src];
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const wScale = src === 0 && outputFormat === 'fuma' ? 1 / Math.SQRT2 : 1;
    for (let b = 0; b < count; b++) {
      const from = Math.floor((frames * b) / count);
      const to = Math.max(from + 1, Math.floor((frames * (b + 1)) / count));
      let lo = 0;
      let hi = 0;
      for (let i = from; i < to && i < frames; i++) {
        const v = (p[i] / 8388608) * wScale;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    out.push({ min, max });
  }
  return out;
}

function signalFor(id) {
  return {
    get aborted() {
      return cancelled.has(id);
    },
  };
}

/** 两个 rotation 是否等价（用于复用预览的渲染结果）。 */
function sameRotation(a, b) {
  if (!a || !b || a.mode !== b.mode) return false;
  if (a.mode === 'static') {
    if (a.quat && b.quat) {
      return a.quat.every((v, i) => Math.abs(v - b.quat[i]) < 1e-15);
    }
    return Array.isArray(a.matrix) && Array.isArray(b.matrix)
      && a.matrix.every((v, i) => Math.abs(v - b.matrix[i]) < 1e-15);
  }
  if (a.frames.length !== b.frames.length) return false;
  for (let i = 0; i < a.frames.length; i++) {
    if (a.frames[i] !== b.frames[i]) return false;
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a.quats[i][c] - b.quats[i][c]) > 1e-15) return false;
    }
  }
  return true;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const { type, id } = msg;

  if (type === 'cancel') {
    if (id != null) cancelled.add(id);
    return;
  }

  try {
    if (type === 'load') {
      const planes = msg.planes;
      if (!Array.isArray(planes) || planes.length !== 4) throw new Error('输入不是 4 声道');
      if (!planes.every((p) => p instanceof Float32Array && p.length === planes[0].length)) {
        throw new Error('四个输入声道的长度不一致');
      }
      const frames = planes[0].length;
      if (frames < 1) throw new Error('输入音频为 0 帧');
      const canonical = toCanonical(planes, msg.inputFormat);
      let peak = 0;
      const channelPeaks = [];
      for (const key of ['W', 'Y', 'Z', 'X']) {
        const p = canonical[key];
        let cp = 0;
        for (let i = 0; i < frames; i++) {
          const a = Math.abs(p[i]);
          if (a > cp) cp = a;
        }
        channelPeaks.push(cp);
        if (cp > peak) peak = cp;
      }
      source = {
        canonical,
        frames,
        sampleRate: msg.sampleRate,
        inputFormat: msg.inputFormat,
      };
      // 换音频或换输入格式后，旧的预览缓存不再有效，必须丢弃，
      // 否则导出可能复用上一段音频/上一格式的量化结果。
      lastRender = null;
      post({
        type: 'loaded',
        id,
        frames,
        sampleRate: msg.sampleRate,
        peak,
        channelPeaks,
      });
      return;
    }

    if (type === 'render') {
      if (!source) throw new Error('尚未载入音频');
      if (!msg.rotation || !msg.rotation.mode) throw new Error('缺少旋转参数');
      const outputFormat = msg.outputFormat === 'fuma' ? 'fuma' : 'ambix';
      const rows = monitorRowsOrFallback(msg.monitorRows);

      const result = await renderCanonical(source.canonical, msg.rotation, {
        chunkFrames: 131072,
        yieldBetweenChunks: true,
        signal: signalFor(id),
        onProgress: (done, total) => post({ type: 'progress', id, done, total, stage: 'render' }),
      });
      if (cancelled.has(id)) throw new CancelledError();

      // 预览与导出共用这次渲染：保留规范序量化平面与逐格式统计，导出直接由它派生，
      // 从而保证「预览和导出使用同一条旋转曲线」且逐样点一致。
      lastRender = { planes: result.planes, rotation: msg.rotation, outputFormat, stats: result.stats };

      const stats = result.stats[outputFormat];
      const stereo = buildStereo(result.planes, rows);
      const envelopes = buildEnvelopes(result.planes, outputFormat, 640);
      post({
        type: 'rendered',
        id,
        stats: {
          ...stats,
          nonFiniteCount: result.stats.nonFiniteCount,
          canonicalPeak: result.stats.canonicalPeak,
          outputFormat,
        },
        totalPeak: result.stats[outputFormat].peak,
        stereo: { left: stereo.left, right: stereo.right, sampleRate: source.sampleRate },
        envelopes,
      }, [stereo.left.buffer, stereo.right.buffer]);
      return;
    }

    if (type === 'export') {
      if (!source) throw new Error('尚未载入音频');
      if (!msg.rotation || !msg.rotation.mode) throw new Error('缺少旋转参数');
      const outputFormat = msg.outputFormat === 'fuma' ? 'fuma' : 'ambix';

      // 若预览已用同一 rotation 渲染过，直接复用这份量化结果：导出与预览逐样点一致。
      // 否则（例如未预览就导出）重新渲染。
      let planes;
      let stats;
      if (lastRender && sameRotation(lastRender.rotation, msg.rotation)) {
        planes = lastRender.planes;
        stats = lastRender.stats[outputFormat];
      } else {
        const result = await renderCanonical(source.canonical, msg.rotation, {
          chunkFrames: 131072,
          yieldBetweenChunks: true,
          signal: signalFor(id),
          onProgress: (done, total) => post({ type: 'progress', id, done, total, stage: 'export' }),
        });
        if (cancelled.has(id)) throw new CancelledError();
        planes = result.planes;
        stats = result.stats[outputFormat];
        lastRender = { planes, rotation: msg.rotation, outputFormat, stats: result.stats };
      }

      if (stats.overflowCount > 0 || stats.nonFiniteCount > 0) {
        post({
          type: 'error',
          id,
          message: stats.nonFiniteCount > 0
            ? '渲染结果含非有限数值，已阻止导出'
            : `存在 ${stats.overflowCount.toLocaleString('en-US')} 个超出 [-1, 1) 的样点，已阻止导出`,
          overflow: true,
          stats,
        });
        return;
      }

      const outPlanes = formatPlanes(planes, source.canonical.W, outputFormat);
      const buffer = encodeWav24FromInt(outPlanes, source.sampleRate);
      post({
        type: 'exported',
        id,
        buffer,
        meta: {
          sampleRate: source.sampleRate,
          frames: source.frames,
          outputFormat,
          bitsPerSample: 24,
          channels: 4,
          peak: stats.peak,
          peakChannel: stats.peakChannel,
        },
      }, [buffer]);
      return;
    }

    if (type === 'compare') {
      // 参考核对：用与导出完全相同的渲染，与调用方提供的 24-bit 参考整数比较
      if (!source) throw new Error('尚未载入音频');
      if (!msg.rotation || !msg.rotation.mode) throw new Error('缺少旋转参数');
      const reference = msg.reference;
      if (!Array.isArray(reference) || reference.length !== 4) {
        throw new Error('参考数据必须为 4 声道整数平面');
      }
      if (reference[0].length !== source.frames) {
        throw new Error('参考文件帧数与输入不一致');
      }
      const result = await renderCanonical(source.canonical, msg.rotation, {
        chunkFrames: 131072,
        yieldBetweenChunks: true,
        signal: signalFor(id),
      });
      if (cancelled.has(id)) throw new CancelledError();
      // 参考平面按 AmbiX 文件顺序 [W,Y,Z,X]，规范序平面亦为 [W,Y,Z,X]
      let worst = 0;
      let worstFrame = -1;
      let worstChannel = -1;
      for (let c = 0; c < 4; c++) {
        const a = result.planes[c];
        const b = reference[c];
        for (let f = 0; f < a.length; f++) {
          const d = Math.abs(a[f] - b[f]);
          if (d > worst) {
            worst = d;
            worstFrame = f;
            worstChannel = c;
          }
        }
      }
      post({ type: 'compared', id, worst, worstFrame, worstChannel });
      return;
    }

    throw new Error(`未知消息类型：${type}`);
  } catch (err) {
    if (err instanceof CancelledError || cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: 'error', id, message: '已取消', cancelled: true });
      return;
    }
    post({ type: 'error', id, message: err?.message || String(err) });
  } finally {
    cancelled.delete(id);
  }
};
