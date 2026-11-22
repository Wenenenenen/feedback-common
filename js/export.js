/**
 * 导出：
 *  - 线性像素数据（小端 float64 / float32 裸 .bin，默认 RGB 交错，可选附权重组）
 *  - 预览 PNG（sRGB 传输编码后的 8 位 RGB）
 *  - 参数与分段 JSON
 */
import { encodePng } from './png.js';
import { linearToSrgb } from './shutter.js';

/** 把线性 RGB float 数组序列化为小端裸二进制。 */
export function packLinear(data, W, H, float32 = false) {
  const n = W * H * 3;
  const bytesPer = float32 ? 4 : 8;
  const buf = new ArrayBuffer(n * bytesPer);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    if (float32) dv.setFloat32(i * 4, data[i], true);
    else dv.setFloat64(i * 8, data[i], true);
  }
  return new Uint8Array(buf);
}

/** 把线性 RGB 编码成 8 位 sRGB，返回 Uint8Array（RGB 交错）。 */
export function toSrgb8(data, W, H) {
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) {
    const v = linearToSrgb(data[i]);
    out[i] = Math.round(v * 255);
  }
  return out;
}

/** 生成预览 PNG（sRGB 8 位）。 */
export async function makePreviewPng(data, W, H, checker = false) {
  const bytes = toSrgb8(data, W, H);
  if (checker) {
    // 透明度提示：把纯黑背景画成棋盘格（仅用于肉眼区分“黑”与“无”）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        if (bytes[o] === 0 && bytes[o + 1] === 0 && bytes[o + 2] === 0) {
          const v = (x + y) % 2 ? 40 : 64;
          bytes[o] = v;
          bytes[o + 1] = v;
          bytes[o + 2] = v;
        }
      }
    }
  }
  return encodePng(W, H, bytes, 3);
}

/** 触发浏览器下载。 */
export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
