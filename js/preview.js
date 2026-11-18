// 法线贴图预览：原始贴图显示 + 用选中角 TBN 在 CPU 上重算的光照预览。
import { v3 } from './math.js';
import { sampleNormalMap } from './normalmap.js';

export function drawRawMap(canvas, tex) {
  const ctx = canvas.getContext('2d');
  canvas.width = tex.width;
  canvas.height = tex.height;
  const img = ctx.createImageData(tex.width, tex.height);
  img.data.set(tex.data);
  ctx.putImageData(img, 0, 0);
  // CSS 放大时保持最近邻像素感
  canvas.style.imageRendering = 'pixelated';
}

// 用给定 TBN 与固定方向光，对 UV [0,1]² 平面逐像素重算着色。
// flipH=true 时手性取反，用于对比凹凸方向。
export function renderShadingPreview(canvas, tex, frame, lightDir, flipH) {
  const S = 128;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = flipH ? -frame.h : frame.h;
  const B = v3.scale(v3.cross(frame.N, frame.T), h);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = (px + 0.5) / S;
      const v = 1 - (py + 0.5) / S; // 画布上方 = v 大
      const t = sampleNormalMap(tex, u, v);
      const n = v3.normalize([
        frame.T[0] * t[0] + B[0] * t[1] + frame.N[0] * t[2],
        frame.T[1] * t[0] + B[1] * t[1] + frame.N[1] * t[2],
        frame.T[2] * t[0] + B[2] * t[1] + frame.N[2] * t[2],
      ]);
      const diff = Math.max(0, v3.dot(n, lightDir));
      const s = 0.18 + 0.82 * diff;
      const i = (py * S + px) * 4;
      img.data[i] = 191 * s;
      img.data[i + 1] = 184 * s;
      img.data[i + 2] = 173 * s;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  canvas.style.imageRendering = 'pixelated';
}
