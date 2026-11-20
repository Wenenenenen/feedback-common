/**
 * 小型 Canvas 热力图渲染器（最近邻、像素对齐，适合 W,H <= 128 的网格）。
 * 残差用蓝-灰-红发散色阶（0 居中、对称量程）；贡献系数用蓝色顺序色阶。
 * 颜色在代码中按 token 计算，深浅双主题仅改变中性色与标注色。
 */

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
function css(c, a = 1) {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// 发散色阶锚点：蓝（负）→ 中性灰（0）→ 红（正），对应 dataviz 的 diverging pair
const DIV_NEG = [42, 90, 190];
const DIV_MID_LIGHT = [240, 239, 236];
const DIV_MID_DARK = [56, 56, 53];
const DIV_POS = [208, 59, 59];

// 顺序色阶锚点：浅蓝 → 深蓝（同色相单色调）
const SEQ_LO_LIGHT = [205, 226, 251];
const SEQ_HI_LIGHT = [13, 54, 107];
const SEQ_LO_DARK = [24, 40, 66];
const SEQ_HI_DARK = [102, 165, 239];

function divergingColor(t, dark) {
  // t ∈ [-1, 1]
  const mid = dark ? DIV_MID_DARK : DIV_MID_LIGHT;
  if (t < 0) return css(mix(mid, DIV_NEG, Math.min(1, -t)));
  return css(mix(mid, DIV_POS, Math.min(1, t)));
}
function sequentialColor(t, dark) {
  const lo = dark ? SEQ_LO_DARK : SEQ_LO_LIGHT;
  const hi = dark ? SEQ_HI_DARK : SEQ_HI_LIGHT;
  return css(mix(lo, hi, Math.min(1, Math.max(0, t))));
}

/**
 * 渲染发散热力图。
 * @param {HTMLCanvasElement} canvas
 * @param {Float64Array} values W*H
 * @param {number} W
 * @param {number} H
 * @param {number} maxAbs 对称量程；<=0 时自动取最大绝对值
 * @param {Uint8Array|null} zeroMask 非零位置标记掩膜为 0 的像素（画斜纹覆盖）
 */
export function renderDiverging(canvas, values, W, H, maxAbs, zeroMask, dark) {
  const scale = maxAbs > 0 ? maxAbs : Math.max(1e-12, ...values.map((v) => Math.abs(v)));
  renderBase(canvas, values, W, H, (v) => divergingColor(v / scale, dark), zeroMask, dark);
  return scale;
}

/** 顺序热力图（值 >= 0） */
export function renderSequential(canvas, values, W, H, maxVal, dark) {
  const scale = maxVal > 0 ? maxVal : Math.max(1e-12, ...values);
  renderBase(canvas, values, W, H, (v) => sequentialColor(v / scale, dark), null, dark);
  return scale;
}

function renderBase(canvas, values, W, H, colorFor, zeroMask, dark) {
  const dpr = window.devicePixelRatio || 1;
  const parentW = canvas.parentElement.clientWidth - 8;
  const cssW = Math.max(64, parentW);
  const cssH = Math.max(1, Math.round(cssW * (H / W)));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(W, H);
  for (let q = 0; q < W * H; q++) {
    const c = colorFor(values[q]);
    const m = c.match(/\d+/g).map(Number);
    img.data[q * 4] = m[0];
    img.data[q * 4 + 1] = m[1];
    img.data[q * 4 + 2] = m[2];
    img.data[q * 4 + 3] = 255;
  }
  // 先 1:1 画到离屏，再放大，保证整数像素对齐
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(off, 0, 0, W, H, 0, 0, cssW, cssH);

  if (zeroMask) {
    // 掩膜为 0 的像素用 45° 斜纹标出（缺测，不参与拟合）
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(240,239,236,0.55)' : 'rgba(11,11,11,0.45)';
    ctx.lineWidth = 1;
    const cw = cssW / W;
    const ch = cssH / H;
    for (let q = 0; q < W * H; q++) {
      if (!zeroMask[q]) continue;
      const u = q % W;
      const v = Math.floor(q / W);
      ctx.beginPath();
      ctx.moveTo(u * cw, (v + 1) * ch);
      ctx.lineTo((u + 1) * cw, v * ch);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 画选中像素的框（残差图/观测图共用） */
export function drawMarker(canvas, W, H, u, v) {
  const ctx = canvas.getContext('2d');
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const cw = cssW / W;
  const ch = cssH / H;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#eda100';
  ctx.strokeRect(u * cw + 1, v * ch + 1, cw - 2, ch - 2);
  ctx.restore();
}

/** 把指针事件坐标换算为网格像素 */
export function eventToCell(canvas, W, H, ev) {
  const rect = canvas.getBoundingClientRect();
  const u = Math.floor(((ev.clientX - rect.left) / rect.width) * W);
  const v = Math.floor(((ev.clientY - rect.top) / rect.height) * H);
  if (u < 0 || u >= W || v < 0 || v >= H) return null;
  return { u, v };
}

/** 发散色阶图例（SVG 渐变条 + 两端刻度） */
export function divergingLegend(maxAbs, dark) {
  const mid = dark ? DIV_MID_DARK : DIV_MID_LIGHT;
  const stops = [
    `0% ${css(DIV_NEG)}`,
    `50% ${css(mid)}`,
    `100% ${css(DIV_POS)}`,
  ];
  return { stops, label: `±${formatNum(maxAbs)}` };
}

/** 顺序色阶图例 */
export function sequentialLegend(maxVal, dark) {
  const lo = dark ? SEQ_LO_DARK : SEQ_LO_LIGHT;
  const hi = dark ? SEQ_HI_DARK : SEQ_HI_LIGHT;
  return { stops: [`0% ${css(lo)}`, `100% ${css(hi)}`], label: `0 … ${formatNum(maxVal)}` };
}

export function formatNum(x) {
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax >= 1000 || ax < 0.001) return x.toExponential(2);
  return Number(x.toFixed(4)).toString();
}
