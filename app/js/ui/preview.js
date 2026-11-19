// 预览渲染：拼接结果、内外点、拼接边界、各层覆盖、重叠区差异。
// 全部用 Canvas2D 手工绘制，不依赖任何现成拼接/配准接口。

const LAYER_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80'];

// 把 RGBA 字节画到 canvas（考虑高 DPI 与缩放）
function paintRgba(canvas, rgba, w, h) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
  ctx.putImageData(img, 0, 0);
}

// 棋盘格背景，便于查看透明区域
function paintChecker(canvas, w, h) {
  const ctx = canvas.getContext('2d');
  const s = 16;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      ctx.fillStyle = ((x / s + y / s) & 1) ? '#e2e8f0' : '#f8fafc';
      ctx.fillRect(x, y, s, s);
    }
  }
}

function cornerPath(ctx, corners) {
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
  ctx.closePath();
}

// 计算每张图在画布上的四角
export function layerCorners(result) {
  const { canvas, toCanvas } = result;
  return result.bounds.map((b, i) => {
    const H = toCanvas[i];
    const img = result.layerSizes[i];
    const corners = [[0, 0], [img[0] - 1, 0], [img[0] - 1, img[1] - 1], [0, img[1] - 1]];
    return corners.map(([x, y]) => {
      const w = H[6] * x + H[7] * y + H[8];
      return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    });
  });
}

// mode: result | points | seams | layers | overlap
export function renderPreview(canvas, result, mode, viewOptions = {}) {
  const { width: w, height: h } = result.canvas;
  const ctx = canvas.getContext('2d');
  paintChecker(canvas, w, h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), w, h), 0, 0);

  const corners = layerCorners(result);

  if (mode === 'seams') {
    // 拼接边界：每层有效区的轮廓（用四角多边形近似透视边界）
    corners.forEach((poly, i) => {
      cornerPath(ctx, poly);
      ctx.strokeStyle = LAYER_COLORS[i % LAYER_COLORS.length];
      ctx.lineWidth = Math.max(1, w / 600);
      ctx.stroke();
    });
  }

  if (mode === 'layers') {
    // 各层：半透明色块 + 边界 + 层号
    corners.forEach((poly, i) => {
      cornerPath(ctx, poly);
      ctx.fillStyle = LAYER_COLORS[i % LAYER_COLORS.length] + '33';
      ctx.fill();
      ctx.strokeStyle = LAYER_COLORS[i % LAYER_COLORS.length];
      ctx.lineWidth = Math.max(1, w / 500);
      ctx.stroke();
      const cx = poly.reduce((s, p) => s + p[0], 0) / 4;
      const cy = poly.reduce((s, p) => s + p[1], 0) / 4;
      ctx.font = `bold ${Math.max(14, w / 30)}px sans-serif`;
      ctx.fillStyle = LAYER_COLORS[i % LAYER_COLORS.length];
      ctx.fillText(String(i), cx, cy);
    });
  }

  if (mode === 'overlap') {
    paintOverlapHeatmap(ctx, result);
  }

  if (mode === 'points') {
    paintPoints(ctx, result, corners);
  }
}

// 重叠区差异：对覆盖层数≥2 的像素，比较各层直线光颜色与加权融合结果
function paintOverlapHeatmap(ctx, result) {
  const { width: w, height: h } = result.canvas;
  const n = w * h;
  const { layers } = result;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    const contributors = [];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      if (L.valid[i] && L.alpha[i] > 0) {
        contributors.push([L.pR[i] / L.alpha[i], L.pG[i] / L.alpha[i], L.pB[i] / L.alpha[i]]);
      }
    }
    const o = i * 4;
    if (contributors.length >= 2) {
      // 层间最大欧氏差异（直线光，0..√3）
      let maxDiff = 0;
      for (let a = 0; a < contributors.length; a++) {
        for (let b = a + 1; b < contributors.length; b++) {
          const d = Math.hypot(
            contributors[a][0] - contributors[b][0],
            contributors[a][1] - contributors[b][1],
            contributors[a][2] - contributors[b][2]
          );
          maxDiff = Math.max(maxDiff, d);
        }
      }
      const t = Math.min(1, maxDiff / 0.5); // 0.5 直线光差即满量程
      img.data[o] = Math.round(255 * t);
      img.data[o + 1] = Math.round(80 * (1 - t));
      img.data[o + 2] = Math.round(120 * (1 - t));
      img.data[o + 3] = Math.round(120 + 100 * t);
    } else {
      img.data[o + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintPoints(ctx, result, corners) {
  const { toCanvas, edgeResults, canvas } = result;
  // 先画层边界作参照
  corners.forEach((poly, i) => {
    cornerPath(ctx, poly);
    ctx.strokeStyle = LAYER_COLORS[i % LAYER_COLORS.length] + 'aa';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  const r = Math.max(3, canvas.width / 250);
  for (const e of edgeResults) {
    const inlierSet = new Set(e.inliers);
    e.pairs.forEach((pair, idx) => {
      const inlier = inlierSet.has(idx);
      for (const side of ['a', 'b']) {
        const imgIdx = e[side];
        const H = toCanvas[imgIdx];
        const [x, y] = side === 'a' ? pair[0] : pair[1];
        const ww = H[6] * x + H[7] * y + H[8];
        const X = (H[0] * x + H[1] * y + H[2]) / ww;
        const Y = (H[3] * x + H[4] * y + H[5]) / ww;
        ctx.beginPath();
        ctx.arc(X, Y, r, 0, Math.PI * 2);
        ctx.fillStyle = inlier ? '#22c55e' : '#ef4444';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
    });
  }
}

// 单张图的对应点编辑叠加层（在源图坐标上画点，支持命中检测）
export function drawSourcePoints(canvas, image, points, selectedIdx) {
  const ctx = canvas.getContext('2d');
  canvas.width = image.width;
  canvas.height = image.height;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  points.forEach((p, idx) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], idx === selectedIdx ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = idx === selectedIdx ? '#f59e0b' : '#38bdf8';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(String(idx), p[0] + 7, p[1] - 6);
  });
}

export function hitTestPoint(points, x, y, tol = 8) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (Math.hypot(points[i][0] - x, points[i][1] - y) <= tol) return i;
  }
  return -1;
}
