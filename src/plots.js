// 手写 Canvas 绘图：频谱、滤波器响应、STFT 谱图、波形。无第三方库。
// 颜色用语义角色（CSS 变量），随明暗主题切换。

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, Math.floor(rect.width));
  const h = Math.max(160, Math.floor(rect.height));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const PAD = { l: 58, r: 16, t: 16, b: 34 };

function niceTicks(min, max, count) {
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(v);
  }
  return ticks;
}

function freqLabel(f) {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k`;
  return `${Math.round(f)}`;
}

/**
 * 通用线图（多系列）。
 * series: [{x:Float64Array, y:Float64Array, color:var, label, dash?}]
 */
export function drawLineChart(canvas, series, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const ink = cssVar('--ink', '#c3c2b7');
  const muted = cssVar('--muted', '#898781');
  const grid = cssVar('--grid', '#2c2c2a');
  const surface = cssVar('--surface-1', '#1a1a19');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  const xMin = opts.xMin ?? Math.min(...series.map((s) => s.x[0]));
  const xMax = opts.xMax ?? Math.max(...series.map((s) => s.x[s.x.length - 1]));
  const yMin = opts.yMin ?? -120;
  const yMax = opts.yMax ?? 5;

  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;
  const X = (x) => PAD.l + ((x - xMin) / (xMax - xMin)) * plotW;
  const Y = (y) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * plotH;

  // 网格 + 轴标签
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  const yTicks = niceTicks(yMin, yMax, 6);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yTicks) {
    if (t < yMin || t > yMax) continue;
    const yy = Y(t);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(PAD.l, yy);
    ctx.lineTo(w - PAD.r, yy);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(`${t}`, PAD.l - 7, yy);
  }
  const xTicks = niceTicks(xMin, xMax, 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) {
    if (t < xMin || t > xMax) continue;
    const xx = X(t);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(xx, PAD.t);
    ctx.lineTo(xx, h - PAD.b);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(opts.xFormatter ? opts.xFormatter(t) : freqLabel(t), xx, h - PAD.b + 6);
  }

  // 参考竖线（通带边沿/奈奎斯特等）
  if (opts.markers) {
    opts.markers.forEach((mk, mi) => {
      const xx = X(mk.x);
      ctx.strokeStyle = cssVar(mk.colorVar, mk.color || '#898781');
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(xx, PAD.t);
      ctx.lineTo(xx, h - PAD.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar(mk.colorVar, mk.color || '#898781');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // 标签上下错开，避免相邻标记重叠
      const labelY = PAD.t + 2 + (mi % 2) * 14;
      ctx.fillText(mk.label, Math.min(Math.max(xx, PAD.l + 28), w - PAD.r - 28), labelY);
    });
  }

  // 数据曲线
  for (const s of series) {
    ctx.strokeStyle = cssVar(s.colorVar, s.color);
    ctx.lineWidth = s.width ?? 1.6;
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.beginPath();
    let started = false;
    const step = Math.max(1, Math.floor(s.x.length / (plotW * 2)));
    for (let i = 0; i < s.x.length; i += step) {
      const xx = X(s.x[i]);
      const yy = Y(Math.max(yMin, Math.min(yMax, s.y[i])));
      if (!started) {
        ctx.moveTo(xx, yy);
        started = true;
      } else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 图例
  if (series.length > 1) {
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lx = PAD.l + 8;
    const ly = PAD.t + 2;
    for (const s of series) {
      const col = cssVar(s.colorVar, s.color);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 18, ly);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.fillText(s.label, lx + 24, ly);
      lx += 24 + ctx.measureText(s.label).width + 22;
    }
  }

  // 轴标题
  ctx.fillStyle = muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(opts.xTitle || '频率 (Hz)', PAD.l + plotW / 2, h - 6);
  ctx.save();
  ctx.translate(13, PAD.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(opts.yTitle || '幅度 (dBFS)', 0, 0);
  ctx.restore();

  // 保存坐标映射供 hover 使用
  canvas._plot = { xMin, xMax, yMin, yMax, PAD, plotW, plotH };
}

/** STFT 谱图（热力图），单色蓝阶 + 主频轨迹叠加。 */
export function drawSpectrogram(canvas, stftData, track, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const { matrix, times, freqs } = stftData;
  const frames = matrix.length;
  const bins = matrix[0].length;
  const fMax = opts.fMax ?? freqs[freqs.length - 1];
  const dBMin = opts.dbMin ?? -110;
  const dBMax = opts.dbMax ?? -20;

  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;
  const img = ctx.createImageData(frames, bins);
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < bins; b++) {
      const t = Math.max(0, Math.min(1, (matrix[f][b] - dBMin) / (dBMax - dBMin)));
      // 蓝阶：暗底到亮蓝；行 (bins-1-b) 使 bin 0（直流）位于图像底部
      const r = Math.floor(10 + t * 47);
      const g = Math.floor(14 + t * 120);
      const bl = Math.floor(25 + t * 205);
      const idx = ((bins - 1 - b) * frames + f) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = bl;
      img.data[idx + 3] = 255;
    }
  }
  // 离屏 canvas 放大绘制
  const off = document.createElement('canvas');
  off.width = frames;
  off.height = bins;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, PAD.l, PAD.t, plotW, plotH);

  // 主频轨迹
  if (track) {
    ctx.strokeStyle = cssVar('--series-2', '#d95926');
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let f = 0; f < frames; f++) {
      const xx = PAD.l + (times[f] / times[times.length - 1]) * plotW;
      const yy = PAD.t + (1 - Math.min(track[f], fMax) / fMax) * plotH;
      if (f === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }

  const muted = cssVar('--muted', '#898781');
  const grid = cssVar('--grid', '#2c2c2a');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(0, fMax, 5)) {
    const yy = PAD.t + (1 - t / fMax) * plotH;
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(freqLabel(t), PAD.l - 7, yy);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of niceTicks(0, times[times.length - 1], 6)) {
    const xx = PAD.l + (t / times[times.length - 1]) * plotW;
    ctx.fillStyle = muted;
    ctx.fillText(`${t.toFixed(1)}s`, xx, h - PAD.b + 6);
  }
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  ctx.fillText('时间 (s)', PAD.l + plotW / 2, h - 6);
  ctx.save();
  ctx.translate(13, PAD.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('频率 (Hz)', 0, 0);
  ctx.restore();
}

/** 波形概览（首尾边界对齐检查用）。 */
export function drawWaveform(canvas, channelData, rate, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const ink = cssVar('--ink', '#c3c2b7');
  const grid = cssVar('--grid', '#2c2c2a');
  const muted = cssVar('--muted', '#898781');
  const surface = cssVar('--surface-1', '#1a1a19');
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);
  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;
  const N = channelData.length;
  const samplesPerPx = Math.max(1, Math.floor(N / plotW));
  ctx.strokeStyle = cssVar('--series-1', '#3987e5');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = 0; px < plotW; px++) {
    const start = px * samplesPerPx;
    let mn = 1, mx = -1;
    for (let i = start; i < Math.min(N, start + samplesPerPx); i++) {
      const v = channelData[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const x = PAD.l + px;
    const yHi = PAD.t + (1 - (mx + 1) / 2) * plotH;
    const yLo = PAD.t + (1 - (mn + 1) / 2) * plotH;
    ctx.moveTo(x, yHi);
    ctx.lineTo(x, yLo);
  }
  ctx.stroke();
  // 零轴
  ctx.strokeStyle = grid;
  const y0 = PAD.t + plotH / 2;
  ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(w - PAD.r, y0); ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`样本 0 … ${N - 1}（${(N / rate).toFixed(2)}s）`, PAD.l + plotW / 2, h - 6);
}
