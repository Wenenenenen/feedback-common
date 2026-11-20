// 显示着色与交互覆盖层绘制。
// 图像本身按灰阶渲染；权重与组系数使用有序的单色阶（不出现彩虹色），
// 亮缝/零权重等异常另有状态色标记。

export function groupScale(width, height) {
  return Math.min(24, Math.max(2, Math.floor(300 / Math.max(width, height))));
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function isDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

// 单色阶两端：浅色模式“浅 = 小、深 = 大”；深色模式翻转锚点，
// 让“接近零”始终向所在模式的表面色退去。
const LIGHT_RAMP = [
  [244, 249, 255],
  [183, 211, 246],
  [134, 182, 239],
  [85, 152, 231],
  [42, 120, 214],
  [28, 92, 171],
  [13, 54, 107],
];
const DARK_RAMP = [
  [24, 79, 149],
  [37, 106, 191],
  [42, 120, 214],
  [85, 152, 231],
  [134, 182, 239],
  [183, 211, 246],
  [205, 226, 251],
];

// 权重着色：以 p02–p98 分位拉伸到 0–1，单色蓝阶，避免少数大权重压平对比。
export function weightLUT(w, stats) {
  const lo = stats && Number.isFinite(stats.p02) ? stats.p02 : 0;
  const hi = stats && Number.isFinite(stats.p98) ? stats.p98 : 1;
  const span = hi - lo;
  // 权重恒定时画色阶中点，避免被误读成“最低权重”
  const t = span > 0 ? clamp((w - lo) / span, 0, 1) : 0.5;
  const stops = isDark() ? DARK_RAMP : LIGHT_RAMP;
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  return [
    Math.round(stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f),
    Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f),
    Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f),
  ];
}

export function drawGrayToCanvas(canvas, values, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = values ? clamp(Math.round(values[i]), 0, 255) : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function drawWeightToCanvas(canvas, weights, width, height, stats, options = {}) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const w = weights ? weights[i] : 0;
    // uniform（σ=0）时权重恒为 1，用色阶中点表示“无聚合差异”，不伪装成最大值。
    let [r, g, b] = weightLUT(w, options.uniform ? { p02: 1, p98: 1 } : stats);
    if (!(w > 0)) {
      // 未覆盖像素用状态红明确标出，而不是悄悄画成 0
      r = isDark() ? 230 : 208;
      g = isDark() ? 103 : 59;
      b = isDark() ? 103 : 59;
    }
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// 2D 系数矩阵热图。组系数与增益量级差异大，用对数拉伸 + 单色阶；
// 增益按 0..1 线性。保留/阈值剔除用单元标记叠加表示，不只靠颜色。
export function drawMatrixHeatmap(canvas, matrix, p, options = {}) {
  const { mode = 'signed', keep = null, gap = 2 } = options;
  const cell = Math.max(12, Math.floor(200 / p));
  const total = p * cell + (p + 1) * gap;
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext('2d');
  const dark = isDark();
  const surface = dark ? '#1a1a19' : '#fcfcfb';
  const neutral = dark ? [56, 56, 53] : [240, 239, 236];
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, total, total);

  let maxAbs = 0;
  for (let i = 0; i < p * p; i++) maxAbs = Math.max(maxAbs, Math.abs(matrix[i]));
  // 增益热图按“组内最大增益”归一化，否则小增益组会整片贴在同一色，
  // 看不出组内差异；图例同时给出绝对值，避免误读。
  const gainMax = mode === 'gain' ? Math.max(1e-9, maxAbs) : 1;

  for (let y = 0; y < p; y++) {
    for (let x = 0; x < p; x++) {
      const v = matrix[y * p + x];
      let r;
      let g;
      let b;
      if (mode === 'gain') {
        // 平方根拉伸：小增益也可见，同时保持 0 → 1 的单调与端点
        const t = Math.sqrt(clamp(v / gainMax, 0, 1));
        const [rr, gg, bb] = weightLUT(t, { p02: 0, p98: 1 });
        r = rr;
        g = gg;
        b = bb;
      } else {
        // 有符号：蓝正 / 红负，中点灰
        const t = maxAbs > 0 ? clamp(v / maxAbs, -1, 1) : 0;
        if (t >= 0) {
          r = Math.round(240 + (33 - 240) * t);
          g = Math.round(239 + (102 - 239) * t);
          b = Math.round(236 + (172 - 236) * t);
        } else {
          const u = -t;
          r = Math.round(240 + (208 - 240) * u);
          g = Math.round(239 + (59 - 239) * u);
          b = Math.round(236 + (59 - 236) * u);
        }
      }
      const cx = gap + x * (cell + gap);
      const cy = gap + y * (cell + gap);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.roundRect(cx, cy, cell, cell, 3);
      ctx.fill();
      if (keep && !keep[y * p + x]) {
        ctx.strokeStyle = dark ? 'rgba(240,239,236,0.35)' : 'rgba(11,11,11,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 3, cy + 3);
        ctx.lineTo(cx + cell - 3, cy + cell - 3);
        ctx.stroke();
      }
    }
  }
  // 轴：k（列）与 l（行）
  ctx.fillStyle = '#898781';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x < p; x++) {
    ctx.fillText(String(x), gap + x * (cell + gap) + cell / 2, total - 2);
  }
  return { canvas, maxAbs };
}

// 在叠加层上标出当前选中的图块。x/y/size 均为显示像素，
// 由调用方按画布的实际放大比例换算，线条粗细不随图像缩放变化。
export function drawSelectionOutline(canvas, x, y, size) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width) return;
  const dark = isDark();
  ctx.save();
  // 与图像内容形成对比的双层描边：浅色内圈 + 深色外圈
  ctx.lineWidth = 3;
  ctx.strokeStyle = dark ? 'rgba(240,239,236,0.35)' : 'rgba(11,11,11,0.25)';
  ctx.strokeRect(x - 1.5, y - 1.5, size + 3, size + 3);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = dark ? '#3987e5' : '#2a78d6';
  ctx.strokeRect(x, y, size, size);
  // 四角短刻度，小图块也醒目
  const tick = Math.max(3, Math.min(10, size / 4));
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + size, y, -1, 1],
    [x, y + size, 1, -1],
    [x + size, y + size, -1, -1],
  ]) {
    ctx.moveTo(cx + dx * 1, cy + dy * 1);
    ctx.lineTo(cx + dx * tick, cy + dy * 1);
    ctx.moveTo(cx + dx * 1, cy + dy * 1);
    ctx.lineTo(cx + dx * 1, cy + dy * tick);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawGroupLayout(canvas, group, width, height, p, options = {}) {
  const scale = options.scale || groupScale(width, height);
  const w = width * scale;
  const h = height * scale;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const dark = isDark();
  const palette = {
    ref: dark ? '#3987e5' : '#2a78d6',
    first: dark ? '#199e70' : '#1baf7a',
    member: dark ? '#d95926' : '#eb6834',
    halo: dark ? '#0d0d0d' : '#fcfcfb',
  };
  ctx.fillStyle = dark ? '#1a1a19' : '#fcfcfb';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  if (group.thumbnail) {
    ctx.drawImage(group.thumbnail, 0, 0, w, h);
  }
  const half = p >> 1;
  const drawRect = (y, x, color, lineWidth, fill) => {
    const px = (x - half) * scale;
    const py = (y - half) * scale;
    const size = p * scale;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(px, py, size, size);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
  };
  const members = group.members || [];
  // 当前查看的组员先画一圈底色描边（在成员框之下），起聚焦作用而不遮挡。
  if (Number.isInteger(options.activeIndex) && members[options.activeIndex]) {
    const mem = members[options.activeIndex];
    drawRect(mem.y, mem.x, palette.halo, 3, null);
  }
  for (let i = 1; i < members.length; i++) {
    drawRect(members[i].y, members[i].x, palette.member, 1.5, dark ? 'rgba(217,89,38,0.22)' : 'rgba(235,104,52,0.12)');
  }
  if (members.length) {
    drawRect(members[0].y, members[0].x, palette.first, 2, dark ? 'rgba(25,158,112,0.24)' : 'rgba(27,175,122,0.16)');
  }
  // 参考位置用虚线框，避免与组员实线框混淆
  ctx.strokeStyle = palette.ref;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  const rx = (group.refX - half) * scale;
  const ry = (group.refY - half) * scale;
  ctx.strokeRect(rx + 1, ry + 1, p * scale - 2, p * scale - 2);
  ctx.setLineDash([]);
}
