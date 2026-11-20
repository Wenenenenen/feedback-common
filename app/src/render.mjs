// render.mjs — 画布渲染与导出（纯前端，无外部依赖）
import { Reason, REASON_META, linearToSrgb } from './core.mjs';

// 把线性 RGB 浮点数组绘制到 canvas（最近邻，内部分辨率=原生分辨率）
function paintLinear(ctx, w, h, colorArr, pixelCount) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let p = 0; p < pixelCount; p++) {
    d[p * 4] = Math.round(linearToSrgb(colorArr[p * 3]) * 255);
    d[p * 4 + 1] = Math.round(linearToSrgb(colorArr[p * 3 + 1]) * 255);
    d[p * 4 + 2] = Math.round(linearToSrgb(colorArr[p * 3 + 2]) * 255);
    d[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function paintReasons(ctx, w, h, reasonArr, pixelCount) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const palette = REASON_META.map((m) => m.color);
  for (let p = 0; p < pixelCount; p++) {
    const [r, g, b] = palette[reasonArr[p]];
    d[p * 4] = r;
    d[p * 4 + 1] = g;
    d[p * 4 + 2] = b;
    d[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// 把 canvas 配置为原生分辨率
export function configureCanvas(canvas, w, h) {
  canvas.width = w;
  canvas.height = h;
}

// view: 'current' | 'accumulated' | 'reason'
// currentFlat: 当前帧预展开的线性 RGB Float64Array（避免每帧展开嵌套数组）
export function renderView(canvas, view, seq, frameIndex, frameData, pixelCount, currentFlat) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const w = seq.width;
  const h = seq.height;
  if (view === 'current') {
    paintLinear(ctx, w, h, currentFlat, pixelCount);
  } else if (view === 'accumulated') {
    paintLinear(ctx, w, h, frameData.color, pixelCount);
  } else {
    paintReasons(ctx, w, h, frameData.reason, pixelCount);
  }
}

// 把嵌套 [[r,g,b],...] 展开为 Float64Array（加载 / 切换序列时调用一次）
export function flattenColors(nested) {
  const out = new Float64Array(nested.length * 3);
  for (let i = 0; i < nested.length; i++) {
    out[i * 3] = nested[i][0];
    out[i * 3 + 1] = nested[i][1];
    out[i * 3 + 2] = nested[i][2];
  }
  return out;
}

// 在画布上叠加选中像素与历史位置标记（原生像素坐标）
export function drawMarkers(canvas, marker) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (!marker) return;
  const { x, y, historyX, historyY, samples } = marker;
  // 当前像素：白色描边 + 黑色外框
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000';
  strokePixelRect(ctx, x, y);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(x + 0.15, y + 0.15, 0.7, 0.7);

  if (historyX === null || historyX === undefined) return;
  // 历史位置：青色十字
  ctx.strokeStyle = '#00e5ff';
  ctx.beginPath();
  ctx.moveTo(historyX - 0.8, historyY);
  ctx.lineTo(historyX + 0.8, historyY);
  ctx.moveTo(historyX, historyY - 0.8);
  ctx.lineTo(historyX, historyY + 0.8);
  ctx.stroke();
  // 四个采样点：有效绿色 / 无效红色
  if (samples) {
    for (const s of samples) {
      if (!s.inside) continue;
      ctx.fillStyle = s.valid ? 'rgba(0,255,120,0.9)' : 'rgba(255,70,70,0.9)';
      ctx.fillRect(s.x + 0.3, s.y + 0.3, 0.4, 0.4);
    }
  }
}

function strokePixelRect(ctx, x, y) {
  ctx.strokeRect(x + 0.05, y + 0.05, 0.9, 0.9);
}

// 点击坐标 → 像素坐标（考虑 CSS 缩放，最近邻）
export function eventToPixel(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(fx * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(fy * canvas.height)));
  return { x, y };
}

// 导出 PNG：在离屏 canvas 上按原生分辨率重绘
export async function exportPNG(canvas, filename) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  downloadBlob(blob, filename);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text, filename, mime = 'application/json') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

// 线性浮点结果导出（约定：须含尺寸、帧号、参数、颜色和计数）
export function buildFloatPayload(seq, frameIndex, frameData, params) {
  const n = seq.width * seq.height;
  const color = new Array(n);
  for (let p = 0; p < n; p++) {
    color[p] = [frameData.color[p * 3], frameData.color[p * 3 + 1], frameData.color[p * 3 + 2]];
  }
  return {
    width: seq.width,
    height: seq.height,
    frame: frameIndex,
    params: { tau: params.tau, historyWeight: params.historyWeight, cap: params.cap },
    color,
    count: Array.from(frameData.count),
  };
}

export const REASON_LEGEND = REASON_META.map((m) => ({
  id: m.id, label: m.label, css: `rgb(${m.color[0]},${m.color[1]},${m.color[2]})`,
})).filter((m) => m.id !== Reason.ACCEPTED || true);
