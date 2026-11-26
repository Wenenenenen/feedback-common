/*
 * draw.js — 时间轴 Canvas：左右声道到达能量、到达计数、输出振幅、耳位关键点。
 * 光标由 DOM 覆盖层绘制（见 app.js），这里只画静态背景，避免播放时每帧重绘。
 * 每泳道按自身峰值归一化，并标注实际峰值，避免小幅信号看不见。
 */

const COLORS = {
  gridMinor: "#1f2833",
  left: "#5ec8e0",
  right: "#ff9d5c",
  count: "#4b6b88",
  ear: "#7b8cff",
  text: "#8a97a8",
  panel: "rgba(255,255,255,0.015)",
};

export function drawTimeline(ctx, state) {
  const rect = ctx.canvas.getBoundingClientRect();
  const W = rect.width;
  const H = 220;
  ctx.clearRect(0, 0, W, H);
  if (!state.scene) {
    ctx.fillStyle = COLORS.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("导入轨迹后显示时间轴", W / 2, H / 2);
    return;
  }

  const N = state.scene.frames;
  const r = state.rendered;
  const padL = 8;
  const padR = 8;
  const plotW = W - padL - padR;
  const top = 18;

  const laneGap = 8;
  const laneH = (H - top - 22 - laneGap * 2) / 3;
  const laneTop = (i) => top + i * (laneH + laneGap);

  // 竖向网格 + 时间标签
  ctx.strokeStyle = COLORS.gridMinor;
  ctx.lineWidth = 1;
  const ticks = 10;
  for (let i = 0; i <= ticks; i++) {
    const x = padL + (i / ticks) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, top - 2);
    ctx.lineTo(x, H - 16);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
    ctx.fillText(fmtTime((N - 1) * (i / ticks)), x, H - 4);
  }

  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(padL, laneTop(i), plotW, laneH);
  }

  if (r) {
    const ePeak = Math.max(peak(r.energyL, N), peak(r.energyR, N), 1);
    const cPeak = Math.max(peak(r.countL, N), peak(r.countR, N), 1);
    const pPeak = Math.max(maxAbs(r.left, N), maxAbs(r.right, N), 1);
    drawCurves(ctx, r.energyL, r.energyR, N, padL, plotW, laneTop(0), laneH, ePeak);
    drawCurves(ctx, r.countL, r.countR, N, padL, plotW, laneTop(1), laneH, cPeak);
    drawWave(ctx, r.left, r.right, N, padL, plotW, laneTop(2), laneH, pPeak);
    laneLabel(ctx, "到达能量 L/R", `${fmtNum(ePeak)}`, padL, laneTop(0));
    laneLabel(ctx, "到达计数", `${Math.round(cPeak)}`, padL, laneTop(1));
    laneLabel(ctx, "输出振幅 L/R", `±${fmtNum(pPeak)}`, padL, laneTop(2));
  } else {
    laneLabel(ctx, "到达能量 L/R", "", padL, laneTop(0));
    laneLabel(ctx, "到达计数", "", padL, laneTop(1));
    laneLabel(ctx, "输出振幅 L/R", "", padL, laneTop(2));
  }

  // 耳位关键点
  ctx.fillStyle = COLORS.ear;
  for (const e of state.scene.ears) {
    if (e.t < 0 || e.t >= N) continue;
    const x = padL + (e.t / Math.max(1, N - 1)) * plotW;
    ctx.beginPath();
    ctx.arc(x, 8, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function laneLabel(ctx, name, value, x, y) {
  ctx.textAlign = "left";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = COLORS.text;
  ctx.fillText(name, x + 5, y + 11);
  if (value) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#6f8093";
    ctx.fillText(value, x + 5 + 160, y + 11);
  }
}

function fmtTime(frame) {
  return `${(frame / 48000).toFixed(1)}s`;
}

function fmtNum(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function peak(arr, N) {
  let m = 0;
  const step = Math.max(1, Math.floor(N / 8000));
  for (let i = 0; i < N; i += step) if (arr[i] > m) m = arr[i];
  return m;
}

function maxAbs(arr, N) {
  let m = 0;
  const step = Math.max(1, Math.floor(N / 8000));
  for (let i = 0; i < N; i += step) {
    const v = arr[i] < 0 ? -arr[i] : arr[i];
    if (v > m) m = v;
  }
  return m;
}

/** 两条正向曲线（到达能量/计数），每列取最大值。 */
function drawCurves(ctx, a, b, N, x0, w, y0, h, scale) {
  const cols = Math.max(1, Math.ceil(w));
  const per = Math.max(1, Math.ceil(N / cols));
  for (let pass = 0; pass < 2; pass++) {
    const arr = pass === 0 ? a : b;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const s0 = c * per;
      if (s0 >= N) break;
      const s1 = Math.min(N, s0 + per);
      let m = 0;
      for (let i = s0; i < s1; i++) if (arr[i] > m) m = arr[i];
      const x = x0 + (c / cols) * w;
      const yy = y0 + h - Math.min(1, m / scale) * (h - 4);
      if (c === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = pass === 0 ? COLORS.left : COLORS.right;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 双极性波形（输出振幅），每列取 min/max。 */
function drawWave(ctx, left, right, N, x0, w, y0, h, scale) {
  const mid = y0 + h / 2;
  const half = h / 2 - 2;
  const cols = Math.max(1, Math.ceil(w));
  const per = Math.max(1, Math.ceil(N / cols));
  for (let pass = 0; pass < 2; pass++) {
    const arr = pass === 0 ? left : right;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const s0 = c * per;
      if (s0 >= N) break;
      const s1 = Math.min(N, s0 + per);
      let mn = 0;
      let mx = 0;
      for (let i = s0; i < s1; i++) {
        const v = arr[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const x = x0 + (c / cols) * w;
      ctx.moveTo(x, mid - Math.max(-1, Math.min(1, mx / scale)) * half);
      ctx.lineTo(x, mid - Math.max(-1, Math.min(1, mn / scale)) * half);
    }
    ctx.strokeStyle = pass === 0 ? COLORS.left : COLORS.right;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
