/*
 * 等距柱状预览图：把 PFM 读出（也可选旋转后的）环境渲染到 canvas。
 *
 * 显示专用的曝光/色调映射只在这里生效，绝不参与积分。
 * 旋转预览按「Lr(n) = L(R⁻¹n)」逐像素采样原图，与系数旋转使用同一约定；
 * 这样用户能直接看出亮部旋转方向是否正确，而不是看被算错的系数。
 */

import { displayRgb } from './tonemap.js';

/**
 * 把逻辑行序（顶行在前）的 RGB 浮点图渲染为 ImageData。
 * @param {Float32Array} values
 * @param {number} width
 * @param {number} height
 * @param {{exposure:number, mode:string, rotationDeg:number}} params
 * @param {ImageData} [target]
 */
export function renderEquirect(values, width, height, params, target) {
  const { exposure, mode, rotationDeg = 0 } = params;
  const image = target && target.width === width && target.height === height
    ? target
    : new ImageData(width, height);
  const data = image.data;
  const out = [0, 0, 0];

  if (Math.abs(rotationDeg) < 1e-9) {
    for (let p = 0; p < width * height; p++) {
      const o = p * 3;
      out[0] = values[o];
      out[1] = values[o + 1];
      out[2] = values[o + 2];
      const rgb = displayRgb(out, exposure, mode, TMP);
      const d = p * 4;
      data[d] = rgb[0];
      data[d + 1] = rgb[1];
      data[d + 2] = rgb[2];
      data[d + 3] = 255;
    }
    return image;
  }

  const theta = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let r = 0; r < height; r++) {
    const th = (Math.PI * (r + 0.5)) / height;
    const sinT = Math.sin(th);
    const y = Math.cos(th);
    for (let col = 0; col < width; col++) {
      const ph = (2 * Math.PI * (col + 0.5)) / width;
      const x = sinT * Math.cos(ph);
      const z = sinT * Math.sin(ph);
      // R⁻¹n：绕 y 的逆旋转（R(θ) 把 +x 送到 −z，故 R⁻¹ = R(−θ)）
      const xi = c * x - s * z;
      const zi = s * x + c * z;
      sampleNearest(values, width, height, xi, y, zi, out);
      const rgb = displayRgb(out, exposure, mode, TMP);
      const d = (r * width + col) * 4;
      data[d] = rgb[0];
      data[d + 1] = rgb[1];
      data[d + 2] = rgb[2];
      data[d + 3] = 255;
    }
  }
  return image;
}

const TMP = [0, 0, 0];

/** 方向 → 最近邻像素（双线性会抹掉高频脉冲，这里保持可核对）。 */
export function sampleNearest(values, width, height, x, y, z, out) {
  const theta = Math.acos(Math.min(1, Math.max(-1, y)));
  let phi = Math.atan2(z, x);
  if (phi < 0) phi += 2 * Math.PI;
  const r = Math.min(height - 1, Math.floor((theta / Math.PI) * height));
  const c = Math.min(width - 1, Math.floor((phi / (2 * Math.PI)) * width));
  const o = (r * width + c) * 3;
  out[0] = values[o];
  out[1] = values[o + 1];
  out[2] = values[o + 2];
  return out;
}

/** 画到 canvas，自动按容器宽度等比缩放。 */
export function paintCanvas(canvas, image, { showPoles = true } = {}) {
  if (!canvas) return;
  const cssWidth = Math.max(1, Math.round(canvas.clientWidth || image.width));
  const aspect = image.height / image.width;
  const cssHeight = Math.max(1, Math.round(cssWidth * aspect));
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const pxWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pxHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
    canvas.width = pxWidth;
    canvas.height = pxHeight;
  }
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, pxWidth, pxHeight);

  if (image.width === pxWidth && image.height === pxHeight) {
    ctx.putImageData(image, 0, 0);
  } else {
    const off = getOffscreen(image.width, image.height);
    off.ctx.putImageData(image, 0, 0);
    ctx.drawImage(off.canvas, 0, 0, image.width, image.height, 0, 0, pxWidth, pxHeight);
  }

  // 经纬网格与主角线
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, dpr);
  for (let i = 1; i < 8; i++) {
    const gx = (pxWidth * i) / 8;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, pxHeight);
    ctx.stroke();
  }
  for (let i = 1; i < 4; i++) {
    const gy = (pxHeight * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(pxWidth, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, pxHeight / 2);
  ctx.lineTo(pxWidth, pxHeight / 2);
  ctx.stroke();
  // 赤道处标注方位：u = φ/2π，故 u=0 → +x，u=1/4 → +z，u=1/2 → −x，u=3/4 → −z
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const labelY = pxHeight / 2 + 4 * dpr;
  ctx.fillText('+x', 16 * dpr, labelY);
  ctx.fillText('+z', pxWidth / 4, labelY);
  ctx.fillText('−x', pxWidth / 2, labelY);
  ctx.fillText('−z', (pxWidth * 3) / 4, labelY);
  ctx.fillText('+x', pxWidth - 16 * dpr, labelY);
  ctx.textAlign = 'left';
  if (showPoles) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('+y 顶', 6 * dpr, 4 * dpr);
    ctx.textBaseline = 'bottom';
    ctx.fillText('−y 底', 6 * dpr, pxHeight - 4 * dpr);
  }
  ctx.restore();
}

let offscreen = null;
function getOffscreen(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    if (!offscreen || offscreen.canvas.width !== w || offscreen.canvas.height !== h) {
      const canvas = new OffscreenCanvas(w, h);
      offscreen = { canvas, ctx: canvas.getContext('2d') };
    }
    return offscreen;
  }
  if (!offscreen || offscreen.canvas.width !== w || offscreen.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    offscreen = { canvas, ctx: canvas.getContext('2d') };
  }
  return offscreen;
}
