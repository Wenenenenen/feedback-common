// 法线 PNG 解码与采样。
// 规则：不做 sRGB 解码，按 2*byte/255-1 解码并归一化，零向量回退 [0,0,1]。
// UV 原点左下，最近邻采样、边界钳位；PNG 左上为存储起点。
import { v3 } from './math.js';

export async function decodeNormalPNG(blob) {
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const w = bmp.width, h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data }; // RGBA，行从 PNG 顶部开始
}

// 最近邻 + 边界钳位；v=0 对应图像底部（UV 原点左下）
export function sampleNormalMap(tex, u, v) {
  const x = Math.min(tex.width - 1, Math.max(0, Math.round(u * (tex.width - 1))));
  const y = Math.min(tex.height - 1, Math.max(0, Math.round((1 - v) * (tex.height - 1))));
  const i = (y * tex.width + x) * 4;
  const n = [
    (2 * tex.data[i]) / 255 - 1,
    (2 * tex.data[i + 1]) / 255 - 1,
    (2 * tex.data[i + 2]) / 255 - 1,
  ];
  const l = v3.len(n);
  return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
}
