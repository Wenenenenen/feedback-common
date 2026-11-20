/**
 * 三类导出：
 *  - PNG：仅展示/导出时截到 [0,1] 再量化到 8 位（迭代与浮点导出均不截断）；
 *  - float64 原始浮点：小端、RGB 逐像素交错，无截断；
 *  - 参数 JSON：完整复现实验所需的全部输入与求解设置。
 */
import { encodePng } from './png-codec.js';

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function clipToUint8(xChannels, GW, GH, channels) {
  const out = new Uint8ClampedArray(GW * GH * channels);
  for (let n = 0; n < GW * GH; n++) {
    for (let ch = 0; ch < channels; ch++) {
      const v = xChannels[ch][n];
      const clipped = v < 0 ? 0 : v > 1 ? 1 : v;
      out[n * channels + ch] = Math.round(clipped * 255);
    }
  }
  return out;
}

export async function exportPng(xChannels, GW, GH, channels, stem) {
  const bytes = clipToUint8(xChannels, GW, GH, channels);
  const png = await encodePng(GW, GH, bytes, channels);
  triggerDownload(new Blob([png], { type: 'image/png' }), `${stem}.png`);
}

export function exportFloat64(xChannels, GW, GH, channels, stem) {
  const count = GW * GH * channels;
  const buf = new ArrayBuffer(count * 8);
  const view = new DataView(buf);
  let k = 0;
  for (let n = 0; n < GW * GH; n++) {
    for (let ch = 0; ch < channels; ch++) {
      view.setFloat64(k * 8, xChannels[ch][n], true); // 小端
      k++;
    }
  }
  triggerDownload(
    new Blob([buf], { type: 'application/octet-stream' }),
    `${stem}-float64le-${GW}x${GH}x${channels}.bin`
  );
}

export function exportParams(params, stem) {
  const text = JSON.stringify(params, null, 2);
  triggerDownload(
    new Blob([text], { type: 'application/json' }),
    `${stem}-params.json`
  );
}

export { clipToUint8 };
