/*
 * 画布绘制：时间轴、方向示意、电平表。
 * 全部用 2D Canvas，无外部依赖；按 devicePixelRatio 缩放保证清晰。
 */

const AXIS_X = '#fbbf24';
const AXIS_Y = '#f472b6';
const AXIS_Z = '#a3e635';

/** 时间格式化：m:ss.mmm */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 数字格式化：整数加千位分隔。 */
export function formatInt(n) {
  return Number(n).toLocaleString('en-US');
}

/** canvas 按 DPR 适配，返回绘制用的 context 与 CSS 尺寸。 */
export function setupCanvas(canvas) {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const bw = Math.round(width * dpr);
  const bh = Math.round(height * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 时间轴：四条包络（按输出格式通道顺序）、关键帧标记、播放头。
 * @param {HTMLCanvasElement} canvas
 * @param {Object} view
 * @param {number} view.frames
 * @param {number} view.playhead
 * @param {{lane:number, frame:number}[]} view.keyframes
 * @param {string[]} [view.laneLabels] 四条包络对应的通道名（输出格式顺序）
 * @param {number} view.progress 0..1 渲染进度（画在顶部细线）
 */
export function drawTimeline(canvas, view) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const padL = 4;
  const padR = 4;
  const padT = 12;
  const padB = 8;
  const plotW = Math.max(1, width - padL - padR);
  const frames = Math.max(1, view.frames || 1);

  // 背景网格
  ctx.strokeStyle = '#1b2228';
  ctx.lineWidth = 1;
  const lanes = 4;
  const laneH = (height - padT - padB) / lanes;
  for (let i = 1; i < lanes; i++) {
    const y = padT + laneH * i;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(padL + plotW, y + 0.5);
    ctx.stroke();
  }
  // 时间刻度
  const duration = frames / (view.sampleRate || 48000);
  const tickCount = Math.max(2, Math.min(8, Math.floor(width / 110)));
  ctx.fillStyle = '#5f6b74';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= tickCount; i++) {
    const x = padL + (plotW * i) / tickCount;
    ctx.strokeStyle = '#202830';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, padT);
    ctx.lineTo(x + 0.5, height - padB);
    ctx.stroke();
    const label = formatTime((duration * i) / tickCount);
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(x + 2, width - tw - 2), height - padB + 1);
  }

  // 关键帧竖线
  if (view.keyframes && view.keyframes.length) {
    for (const kf of view.keyframes) {
      const x = padL + (kf.frame / (frames - 1 || 1)) * plotW;
      ctx.strokeStyle = 'rgba(94,234,212,.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, padT);
      ctx.lineTo(x + 0.5, height - padB);
      ctx.stroke();
      ctx.fillStyle = '#5eead4';
      roundRect(ctx, x - 2.5, padT - 5, 5, 5, 2);
      ctx.fill();
    }
  }

  // 包络
  if (view.envelopes) {
    const defaultColors = { W: '#7dd3fc', Y: '#f472b6', Z: '#a3e635', X: '#fbbf24' };
    const labels = view.laneLabels || ['W', 'Y', 'Z', 'X'];
    for (let c = 0; c < 4; c++) {
      const env = view.envelopes[c];
      if (!env) continue;
      const name = labels[c] || ['W', 'Y', 'Z', 'X'][c];
      const color = defaultColors[name] || '#7dd3fc';
      const midY = padT + laneH * (c + 0.5);
      const amp = laneH * 0.42;
      ctx.beginPath();
      for (let i = 0; i < env.min.length; i++) {
        const x = padL + (i / Math.max(1, env.min.length - 1)) * plotW;
        const y = midY - env.max[i] * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = env.min.length - 1; i >= 0; i--) {
        const x = padL + (i / Math.max(1, env.min.length - 1)) * plotW;
        ctx.lineTo(x, midY - env.min[i] * amp);
      }
      ctx.closePath();
      ctx.fillStyle = color + '55';
      ctx.fill();
      ctx.strokeStyle = color + 'bb';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, padL + 3, midY - amp * 0.62);
    }
    // 0 线
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let c = 0; c < 4; c++) {
      const y = padT + laneH * (c + 0.5);
      ctx.beginPath();
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(padL + plotW, y + 0.5);
      ctx.stroke();
    }
  }

  // 渲染进度
  if (view.progress > 0 && view.progress < 1) {
    ctx.fillStyle = 'rgba(251,191,36,.6)';
    ctx.fillRect(padL, 0, plotW * view.progress, 2);
  }

  // 播放头
  if (view.playhead != null) {
    const x = padL + (view.playhead / (frames - 1 || 1)) * plotW;
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padT - 3);
    ctx.lineTo(x, height - padB);
    ctx.stroke();
    ctx.fillStyle = '#5eead4';
    ctx.beginPath();
    ctx.moveTo(x, padT - 5);
    ctx.lineTo(x - 4, padT - 10);
    ctx.lineTo(x + 4, padT - 10);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 方向示意：斜投影的单位球，显示声场的「前」方向。
 * 球面上的点 = 原始 +X 方向被旋转后的朝向。同时画原始坐标轴。
 * @param {HTMLCanvasElement} canvas
 * @param {Object} view
 * @param {number[]} view.axes 旋转后的三个轴（各为 3 元向量：X,Y,Z 像）
 * @param {number[]} view.front 旋转后的 +X 方向
 */
export function drawDirection(canvas, view) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2 + 6;
  const scale = Math.min(width, height) * 0.31;

  // 斜投影：X 轴指向右下前方，Y 轴指向左下前方，Z 轴竖直向上。
  // 屏幕 x = (vx − vy)·0.866，屏幕 y = −vz·0.78 + (vx + vy)·0.38
  const project = (v) => [
    cx + (v[0] - v[1]) * 0.866 * scale * 0.62,
    cy - v[2] * scale * 0.78 + (v[0] + v[1]) * 0.38 * scale * 0.62,
  ];

  // 水平面椭圆与球体轮廓
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, scale * 0.78, scale * 0.3, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, scale, 0, Math.PI * 2);
  ctx.stroke();

  // 经纬线
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  for (const el of [-60, -30, 30, 60]) {
    const rad = (el * Math.PI) / 180;
    const r = Math.cos(rad) * scale;
    const yy = cy - Math.sin(rad) * scale * 0.78;
    ctx.beginPath();
    ctx.ellipse(cx, yy, r * 0.866, r * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const az of [0, 45, 90, 135]) {
    ctx.beginPath();
    const rad = (az * Math.PI) / 180;
    // 经线在斜投影下是竖椭圆：横向按方位角压缩，高度取球的竖直半径
    const rx = Math.abs(Math.cos(rad) * scale * 0.866 * 0.62) + 0.5;
    ctx.ellipse(cx, cy, rx, scale * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 原始坐标轴（暗）
  const drawAxis = (v, color, label, width2, dashed) => {
    const [x, y] = project(v);
    ctx.save();
    if (dashed) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    if (label) {
      ctx.fillStyle = color;
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + (x - cx) * 0.12, y + (y - cy) * 0.12);
    }
  };

  drawAxis([1, 0, 0], 'rgba(251,191,36,.32)', '', 1, true);
  drawAxis([0, 1, 0], 'rgba(244,114,182,.32)', '', 1, true);
  drawAxis([0, 0, 1], 'rgba(163,230,53,.3)', '', 1, true);

  // 旋转后的轴
  if (view.axes) {
    drawAxis(view.axes[0], AXIS_X, 'X', 1.6, false);
    drawAxis(view.axes[1], AXIS_Y, 'Y', 1.6, false);
    drawAxis(view.axes[2], AXIS_Z, 'Z', 1.6, false);
  }

  // 声场前向箭头
  if (view.front) {
    const v = view.front;
    const [x, y] = project(v);
    const len = Math.hypot(x - cx, y - cy);
    if (len > 2) {
      const ux = (x - cx) / len;
      const uy = (y - cy) / len;
      const tipX = cx + ux * scale;
      const tipY = cy + uy * scale;
      ctx.strokeStyle = '#e9eef3';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // 箭头头部
      ctx.fillStyle = '#e9eef3';
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * 10 - uy * 5, tipY - uy * 10 + ux * 5);
      ctx.lineTo(tipX - ux * 10 + uy * 5, tipY - uy * 10 - ux * 5);
      ctx.closePath();
      ctx.fill();
      // 点
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#5eead4';
      ctx.fill();
    }
  }

  // 中心
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#5a6772';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.stroke();

  // 图例文字
  ctx.fillStyle = '#5f6b74';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('俯视斜投影 · 实线为旋转后的轴', 10, 8);
}
