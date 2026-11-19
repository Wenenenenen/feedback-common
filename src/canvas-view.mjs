// 画布渲染：灰度底图 + 掩膜外提示 + 节点区域高亮 + 选点标记 + 阈值差异。
import { state, nodeRegionPixels } from './app-state.mjs';

const HIGHLIGHT = { r: 38, g: 132, b: 255 };   // 节点区域
const SELECT = { r: 255, g: 176, b: 32 };       // 选点
const DIFF_UP = { r: 34, g: 160, b: 110 };      // 过滤后灰度上升（max 树被压暗的反义）
const DIFF_DOWN = { r: 220, g: 88, b: 72 };     // 过滤后灰度下降

function putGray(ImageDataCtor, ctx, gray, width, height) {
  const img = new ImageDataCtor(width, height);
  const d = img.data;
  for (let i = 0; i < width * height; i++) {
    const v = gray[i];
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 渲染底图（原图或过滤图），掩膜外画斜纹灰 */
export function renderBase(canvas, which) {
  const { width, height, gray, mask, filtered } = state;
  if (!gray) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const src = which === 'filtered' ? filtered : gray;
  putGray(ImageData, ctx, src, width, height);
  if (mask) {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    for (let p = 0; p < width * height; p++) {
      if (!mask[p]) {
        const stripe = ((p % width) + ((p / width) | 0)) & 1;
        const v = stripe ? 48 : 72;
        d[p * 4] = v; d[p * 4 + 1] = v; d[p * 4 + 2] = v; d[p * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** 在叠加层画节点区域与选点 */
export function renderOverlay(canvas) {
  const t = state.tree;
  if (!t) return;
  const { width, height } = t;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const img = ctx.createImageData(width, height);
  const d = img.data;

  if (state.selectedNode !== null) {
    const region = new Set(nodeRegionPixels(state.selectedNode));
    // 淡填充（保留底图灰度细节）+ 区域边界描边
    for (const p of region) {
      d[p * 4] = HIGHLIGHT.r; d[p * 4 + 1] = HIGHLIGHT.g; d[p * 4 + 2] = HIGHLIGHT.b; d[p * 4 + 3] = 64;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = `rgba(${HIGHLIGHT.r},${HIGHLIGHT.g},${HIGHLIGHT.b},0.95)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of region) {
      const x = p % width, y = (p / width) | 0;
      // 区域边界：四邻存在不属于该区域的像素即描边
      const outside = (nx, ny) =>
        nx < 0 || ny < 0 || nx >= width || ny >= height || !region.has(ny * width + nx);
      if (outside(x, y - 1)) { ctx.moveTo(x + 0.5, y + 0.5); ctx.lineTo(x + 1.5, y + 0.5); }
      if (outside(x, y + 1)) { ctx.moveTo(x + 0.5, y + 1.5); ctx.lineTo(x + 1.5, y + 1.5); }
      if (outside(x - 1, y)) { ctx.moveTo(x + 0.5, y + 0.5); ctx.lineTo(x + 0.5, y + 1.5); }
      if (outside(x + 1, y)) { ctx.moveTo(x + 1.5, y + 0.5); ctx.lineTo(x + 1.5, y + 1.5); }
    }
    ctx.stroke();
  } else {
    ctx.putImageData(img, 0, 0);
  }

  // 选点十字标记
  if (state.selectedPixel) {
    const [x, y] = state.selectedPixel;
    ctx.strokeStyle = `rgb(${SELECT.r},${SELECT.g},${SELECT.b})`;
    ctx.lineWidth = Math.max(1, Math.min(width, height) / 256);
    const r = Math.max(3, Math.min(width, height) / 64);
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.stroke();
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
  }
}

/** 差异叠加：当前过滤结果相对对比阈值的变化像素 */
export function renderDiff(canvas) {
  const t = state.tree;
  if (!t || !state.compareFiltered) return;
  const { width, height } = t;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;
  const { filtered } = state;
  let changed = 0;
  for (let p = 0; p < width * height; p++) {
    const a = state.compareFiltered[p];
    const b = filtered[p];
    if (a === b) continue;
    changed++;
    const c = b > a ? DIFF_UP : DIFF_DOWN;
    d[p * 4] = c.r; d[p * 4 + 1] = c.g; d[p * 4 + 2] = c.b; d[p * 4 + 3] = 150;
  }
  ctx.putImageData(img, 0, 0);
  return changed;
}

/** 事件坐标 -> 图像像素坐标 */
export function eventToPixel(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * canvas.height);
  return [x, y];
}
