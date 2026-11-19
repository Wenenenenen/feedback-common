// worker.js — 后台线程执行解析/检测/伸缩，避免 60s 文件卡死页面，支持取消。
// DSP 函数通过 yieldHook 定期 await 让出事件循环，worker 借此处理取消消息。
import { parseWav, encodeWav } from './wav-codec.js';
import { detectTransients } from './transient-detect.js';
import { timeStretch } from './time-stretch.js';

let cancelled = false;
let runToken = 0;
const nextTick = () => new Promise((res) => setTimeout(res, 0));

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type !== 'process') return;
  const token = ++runToken;
  cancelled = false;

  const throwIfCancelled = () => {
    if (cancelled || token !== runToken) throw new Error('__CANCELLED__');
  };
  // 每次让步：先让事件循环处理积压消息（含 cancel），恢复后检查取消标志
  const yieldHook = async () => { await nextTick(); throwIfCancelled(); };
  const onProgress = (p) => {
    throwIfCancelled();
    self.postMessage({ type: 'progress', value: p });
  };

  (async () => {
    try {
      onProgress(0.02);
      const audio = parseWav(msg.buffer);
      await yieldHook();

      const mono = new Float32Array(audio.frames);
      for (let i = 0; i < audio.frames; i++) {
        let s = 0;
        for (let c = 0; c < audio.channels; c++) s += audio.samples[c][i];
        mono[i] = s / audio.channels;
      }
      const anchorsIn = await detectTransients(mono, audio.rate,
        (p) => onProgress(0.05 + 0.25 * p), yieldHook);
      onProgress(0.3);

      const { out, anchorsOut, Nout } = await timeStretch(
        audio.samples, msg.speed, anchorsIn, audio.rate,
        (p) => onProgress(0.3 + 0.65 * p), yieldHook
      );
      onProgress(0.98);

      const blob = encodeWav(out, audio.rate, audio.bits);
      throwIfCancelled();

      self.postMessage({
        type: 'done',
        token,
        result: {
          rate: audio.rate,
          bits: audio.bits,
          channels: audio.channels,
          frames: audio.frames,
          Nout,
          speed: msg.speed,
          input: audio.samples,
          output: out,
          anchorsIn: Array.from(anchorsIn),
          anchorsOut: Array.from(anchorsOut),
          wavBlob: blob,
        },
      });
    } catch (err) {
      if (err && err.message === '__CANCELLED__') {
        self.postMessage({ type: 'cancelled', token });
      } else {
        self.postMessage({ type: 'error', token, message: err.message || String(err) });
      }
    }
  })();
};
