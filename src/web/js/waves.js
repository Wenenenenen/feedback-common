/*
 * Canvas 波形绘制（无外部依赖）。
 * 立体声以共享零线镜像绘制：左声道向上，右声道向下。
 * 数据来自降采样峰值包络（每个像素列取区间最大绝对值）。
 */

const COLORS = {
  left: '#3987e5',
  right: '#d95926',
  grid: '#2c2c2a',
  axis: '#4a4a48',
  muted: '#898781',
  fillL: 'rgba(57,135,229,0.22)',
  fillR: 'rgba(217,89,38,0.22)',
  clip: '#d03b3b',
  tail: '#fab219',
};

/** 从整段 PCM 生成峰值包络。 */
export function envelopeFromPcm(channel, bins) {
  const n = channel.length;
  const count = Math.max(1, Math.min(bins, n || 1));
  const out = new Float32Array(count);
  if (!n) return out;
  const scale = count / n;
  for (let i = 0; i < n; i++) {
    const a = channel[i] < 0 ? -channel[i] : channel[i];
    const bin = Math.min(count - 1, Math.floor(i * scale));
    if (a > out[bin]) out[bin] = a;
  }
  return out;
}

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

/**
 * 绘制镜像立体声波形。
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Float32Array} options.left 包络（0..1 绝对值）
 * @param {Float32Array} options.right
 * @param {string} [options.mode] 'envelope' | 'line'
 * @param {number} [options.tailFraction] 干声结束位置（0..1），画分隔线
 * @param {number} [options.playhead] 播放位置（0..1）
 * @param {number} [options.peak] 峰值，用于 ±1 参考线与缩放
 */
export function drawMirroredWaveform(canvas, options) {
  const { ctx, w, h } = setupCanvas(canvas);
  const {
    left,
    right,
    tailFraction = null,
    playhead = null,
    clipMark = true,
    showAxis = true,
  } = options;

  const mid = h / 2;
  const lanePad = 8;
  const amp = mid - lanePad;

  // 峰值超过 1 时按峰值缩放，并画出 ±1 满刻度线；否则按 ±1 满刻度显示
  const peak = Number.isFinite(options.peak) ? options.peak : 0;
  // 显示上限：峰值超过 1 时取 1.5 倍（超限幅度可见），否则固定 ±1 满刻度。
  // 1.0 的振幅在两种情况下都落在 ±amp 以内。
  const displayMax = peak > 1 ? Math.max(1.25, Math.min(peak * 1.02, 4)) : 1;
  const over = peak > 1;
  const scale = amp / displayMax; // 每单位振幅对应的像素数
  const oneY = scale * 1; // ±1 在画布上的像素高度

  // 背景网格：零线、半量程线（按同一比例）
  if (showAxis) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (const frac of [-1, -0.5, 0.5, 1]) {
      const y = Math.round(mid + frac * amp);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();
  }


  if (!left || !left.length) return { mid, amp, w, h };

  // 左声道向上，右声道向下；0..1 满刻度对应 1 倍 amp
  // 峰值包络以 1px 竖线逐列绘制；重叠区域用 2px 半透明底线托出体积
  const columnPeak = (env, x) => {
    const n = env.length;
    const i0 = Math.floor((x * n) / w);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / w));
    let v = 0;
    for (let i = i0; i < Math.min(i1, n); i++) if (env[i] > v) v = env[i];
    return Math.max(0, v) * scale; // 已换算为像素
  };

  const drawChannel = (env, dir, color, glow) => {
    // 柔光底：2px 低透明度，避免孤立尖峰过细
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const hh = columnPeak(env, x);
      if (hh <= 0) continue;
      ctx.moveTo(x + 0.5, mid);
      ctx.lineTo(x + 0.5, mid + dir * hh);
    }
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const hh = columnPeak(env, x);
      if (hh <= 0) continue;
      ctx.moveTo(x + 0.5, mid);
      ctx.lineTo(x + 0.5, mid + dir * hh);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };

  drawChannel(left, -1, COLORS.left, COLORS.fillL);
  if (right && right.length) drawChannel(right, 1, COLORS.right, COLORS.fillR);

  // ±1 满刻度线：画在波形之上，超限时用红色虚线标出裁剪边界
  if (clipMark) {
    ctx.save();
    ctx.strokeStyle = over ? COLORS.clip : COLORS.grid;
    ctx.globalAlpha = over ? 0.85 : 0.9;
    if (over) ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid - oneY) + 0.5);
    ctx.lineTo(w, Math.round(mid - oneY) + 0.5);
    ctx.moveTo(0, Math.round(mid + oneY) + 0.5);
    ctx.lineTo(w, Math.round(mid + oneY) + 0.5);
    ctx.stroke();
    ctx.restore();

    if (over) {
      ctx.save();
      ctx.fillStyle = COLORS.clip;
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.globalAlpha = 0.9;
      ctx.fillText('±1', w - 20, Math.round(mid - oneY) - 4);
      ctx.restore();
    }
  }

  // 干声结束 / 尾段起点
  if (tailFraction != null && tailFraction > 0 && tailFraction < 1) {
    const x = Math.round(tailFraction * w) + 0.5;
    ctx.save();
    ctx.strokeStyle = COLORS.tail;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(20,20,19,0.85)';
    ctx.fillRect(x + 3, 4, 46, 15);
    ctx.fillStyle = COLORS.tail;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('尾段', x + 8, 15);
    ctx.restore();
  }

  // 播放头
  if (playhead != null && playhead >= 0 && playhead <= 1) {
    const x = Math.round(playhead * w) + 0.5;
    ctx.strokeStyle = '#f0efec';
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // L / R 标记
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('L', 5, 12);
  ctx.fillText('R', 5, h - 5);

  return { mid, amp, w, h };
}

/** 热力图风格的 IR 小图（单声道，居中对称）。 */
export function drawMonoWaveform(canvas, envelope, peak) {
  const { ctx, w, h } = setupCanvas(canvas);
  const mid = h / 2;
  const amp = mid - 3;

  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(mid) + 0.5);
  ctx.lineTo(w, Math.round(mid) + 0.5);
  ctx.stroke();

  if (!envelope || !envelope.length) {
    return { mid, amp, w, h };
  }

  const n = envelope.length;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((x * n) / w);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / w));
    let v = 0;
    for (let i = i0; i < Math.min(i1, n); i++) if (envelope[i] > v) v = envelope[i];
    const hh = Math.min(1, v) * amp;
    ctx.moveTo(x + 0.5, mid - hh);
    ctx.lineTo(x + 0.5, mid + hh);
  }
  ctx.strokeStyle = '#6f9edb';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.95;
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (peak > 1) {
    ctx.strokeStyle = COLORS.clip;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(w, 1);
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  return { mid, amp, w, h };
}

