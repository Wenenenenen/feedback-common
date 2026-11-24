// render.js — 画布渲染：分段身份条 + 双声道列波形
// 振幅域固定为 16 位满量程 [-32768,32767]，任何缩放下幅值可直接比较，便于核对剪辑点。
import { trackHex, isDark } from './colors.js';

const FULL_SCALE = 32768;

export function setupCanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function sourceIndexOf(timeline, sourceId) {
  // sources Map 的插入顺序即导入顺序（0..7）；调用方预建索引后走 O(1) 查表
  return timeline._sourceIndex?.get(sourceId) ?? 0;
}

// 静音纹理：稀疏 45° 斜线（第二编码，不喧宾夺主）
let mutePattern = null;
function getMutePattern(ctx) {
  if (mutePattern) return mutePattern;
  const c = document.createElement('canvas');
  c.width = 14; c.height = 14;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(128,128,128,0.4)';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(-4, 18); g.lineTo(18, -4);
  g.stroke();
  mutePattern = ctx.createPattern(c, 'repeat');
  return mutePattern;
}

/**
 * 分段身份条：每段按源轨身份色填充，倒序画左向三角，静音叠纹理。
 * view = { start, end }（拼接帧坐标）
 */
export function drawSegmentStrip(ctx, w, h, timeline, view, selectedIndex) {
  ctx.clearRect(0, 0, w, h);
  const dark = isDark();
  const span = Math.max(1, view.end - view.start);
  const xOf = (f) => ((f - view.start) / span) * w;
  const ring = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2a78d6';
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim() || '#898781';

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const s0 = timeline.offsets[i];
    const s1 = s0 + (seg.srcEnd - seg.srcStart);
    if (s1 <= view.start || s0 >= view.end) continue;
    const x0 = Math.max(0, xOf(Math.max(s0, view.start)));
    const x1 = Math.min(w, xOf(Math.min(s1, view.end)));
    if (x1 - x0 < 0.3) continue;
    const color = trackHex(sourceIndexOf(timeline, seg.sourceId), dark);
    ctx.fillStyle = seg.muted ? color + '55' : color;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);

    if (seg.muted) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.clip();
      ctx.fillStyle = getMutePattern(ctx);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.restore();
    }
    if (seg.reverse && x1 - x0 > 10) {
      // 左向双三角，提示倒序（颜色之外的形状编码）
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      const bx = x0 + 5, by = h / 2, t = Math.min(5, h / 3);
      for (const dx of [0, 6]) {
        ctx.beginPath();
        ctx.moveTo(bx + dx, by);
        ctx.lineTo(bx + dx + t, by - t);
        ctx.lineTo(bx + dx + t, by + t);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (i === selectedIndex) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = ring;
      ctx.strokeRect(x0 + 1, 1, Math.max(1, x1 - x0 - 2), h - 2);
    }
  }
  // 空轨提示
  if (timeline.segments.length === 0) {
    ctx.fillStyle = ink;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('空拼接轨：导入源轨后从“添加段”开始', 12, h / 2);
  }
}

/**
 * 双声道列波形：上半 L、下半 R，零轴居中。
 * columns 来自 timeline.columnStats；空列留空，静音画零轴+纹理。
 */
export function drawColumns(ctx, w, h, timeline, columns, view) {
  ctx.clearRect(0, 0, w, h);
  const dark = isDark();
  const B = columns.length;
  const colW = w / B;
  const zeroY = h / 2;
  const halfH = h / 2 - 6;
  const grid = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || '#e1e0d9';
  const baseline = getComputedStyle(document.documentElement).getPropertyValue('--baseline').trim() || '#c3c2b7';

  // 零轴、半区参考线与声道标签
  ctx.strokeStyle = baseline;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, zeroY + 0.5); ctx.lineTo(w, zeroY + 0.5); ctx.stroke();
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(0, 6.5); ctx.lineTo(w, 6.5);
  ctx.moveTo(0, h - 6.5); ctx.lineTo(w, h - 6.5);
  ctx.stroke();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim();
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('L', 4, 2);
  ctx.fillText('R', 4, zeroY + 2);

  // 柱体：以零轴为基准，min/max 按幅值映射；L 向上、R 向下，几何对称
  const drawBar = (st, ch) => {
    const topVal = st.max; // 离零轴“最远正向”
    const botVal = st.min; // 离零轴“最远负向”
    if (ch === 0) {
      const yTop = zeroY - (topVal / FULL_SCALE) * halfH;
      const yBot = zeroY - (botVal / FULL_SCALE) * halfH;
      return { y: Math.min(yTop, yBot), height: Math.max(1, Math.abs(yBot - yTop)) };
    }
    const yTop = zeroY + (-botVal / FULL_SCALE) * halfH; // min 越负，向下越远
    const yBot = zeroY + (topVal / FULL_SCALE) * halfH;
    return { y: Math.min(yTop, yBot), height: Math.max(1, Math.abs(yBot - yTop)) };
  };

  for (let j = 0; j < B; j++) {
    const col = columns[j];
    const x = j * colW;
    const barW = Math.max(1, colW - 1);
    if (col.end === col.start) continue; // 空列：最值为空，不画
    const loc = timeline.locate(col.start);
    const color = loc ? trackHex(sourceIndexOf(timeline, loc.seg.sourceId), dark) : '#888';
    ctx.fillStyle = color;

    for (let ch = 0; ch < 2; ch++) {
      const st = col.stats[ch];
      if (!st) continue;
      if (st.max === 0 && st.min === 0) {
        // 静音/零：零轴上一根细线（仍计入 count）
        ctx.fillRect(x, ch === 0 ? zeroY - 1 : zeroY, barW, 1);
        continue;
      }
      const { y, height } = drawBar(st, ch);
      ctx.fillRect(x, y, barW, height);
    }

    // 静音列叠稀疏纹理
    if (loc && loc.seg.muted) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, Math.max(1, colW), h);
      ctx.clip();
      ctx.fillStyle = getMutePattern(ctx);
      ctx.fillRect(x, 0, Math.max(1, colW), h);
      ctx.restore();
    }
  }

  // 顶/底网格淡线
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(0, 0.5); ctx.lineTo(w, 0.5);
  ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5);
  ctx.stroke();
}

/** 画布横坐标 → 拼接帧 */
export function frameAtX(x, canvasWidth, view) {
  const span = Math.max(1, view.end - view.start);
  return view.start + Math.floor((x / canvasWidth) * span);
}

/** 拼接帧 → 画布横坐标 */
export function xOfFrame(frame, canvasWidth, view) {
  const span = Math.max(1, view.end - view.start);
  return ((frame - view.start) / span) * canvasWidth;
}
