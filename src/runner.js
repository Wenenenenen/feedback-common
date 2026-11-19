// 异步分块处理调度：长文件分块、块边界无毛刺、可取消、带进度。
// 数值与分块大小无关（由 PolyphaseResampler 的流式不变性保证）。
import { PolyphaseResampler } from './resampler.js';

/**
 * 分块重采样。
 * @param {object} design designResampler() 返回值
 * @param {Float64Array[]} channelData 输入每声道
 * @param {object} opts { chunkSize, onProgress, signal }
 *   signal.cancelled 为 true 时抛出取消异常
 */
export async function resampleStreamed(design, channelData, opts = {}) {
  const chunkSize = opts.chunkSize ?? 4096;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal ?? { cancelled: false };
  const channels = channelData.length;
  const N = channelData[0].length;
  const rs = new PolyphaseResampler(design, channels);
  const parts = Array.from({ length: channels }, () => []);
  const totalOut = Math.ceil((N * design.L) / design.M);

  const yieldEvery = 4; // 每处理若干块让出一次事件循环
  let blocks = 0;

  for (let s = 0; s < N; s += chunkSize) {
    if (signal.cancelled) throw new DOMException('处理已取消', 'AbortError');
    const e = Math.min(N, s + chunkSize);
    const chunk = channelData.map((d) => d.subarray(s, e));
    rs.pushInput(chunk);
    const out = rs.pullAvailable();
    for (let c = 0; c < channels; c++) {
      if (out[c].length) parts[c].push(out[c]);
    }
    blocks++;
    if ((blocks & (yieldEvery - 1)) === 0) {
      onProgress(Math.min(0.999, (e / N) * 0.95));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (signal.cancelled) throw new DOMException('处理已取消', 'AbortError');
  const tail = rs.flush();
  for (let c = 0; c < channels; c++) {
    if (tail[c].length) parts[c].push(tail[c]);
  }

  const merged = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float64Array(totalOut);
    let o = 0;
    for (const p of parts[c]) {
      arr.set(p, o);
      o += p.length;
    }
    if (o !== totalOut) {
      throw new Error(`输出长度不一致：得到 ${o}，期望 ${totalOut}`);
    }
    merged.push(arr);
  }
  onProgress(1);
  return merged;
}
