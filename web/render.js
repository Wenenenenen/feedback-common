// 浏览器端渲染工具：线性 0..1 数据 -> sRGB 显示；最近邻放大；CFA 采样点叠加。

// 线性光 -> sRGB 传递函数（仅影响显示，不参与 PSNR 与导出）
export function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// 把交织的 16 位 RGB 绘入 ImageData；可选只显示单通道（其余置 0）
export function renderRgb16(ctx, rgb16, width, height, { channel = -1, zoom = 1 } = {}) {
  const canvas = ctx.canvas;
  canvas.width = width * zoom;
  canvas.height = height * zoom;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const sy = Math.min(height - 1, Math.floor(y / zoom));
    for (let x = 0; x < canvas.width; x++) {
      const sx = Math.min(width - 1, Math.floor(x / zoom));
      const si = (sy * width + sx) * 3;
      const di = (y * canvas.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        if (channel !== -1 && c !== channel) {
          img.data[di + c] = 0;
        } else {
          const lin = rgb16[si + c] / 65535;
          img.data[di + c] = Math.round(Math.min(1, Math.max(0, linearToSrgb(lin))) * 255);
        }
      }
      img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// 原始 CFA 采样位置视图：每个像素只画它实际采样的那个通道（最近邻放大）
export function renderCfa(ctx, planes64, mask, width, height, { channel = -1, zoom = 1 } = {}) {
  const canvas = ctx.canvas;
  canvas.width = width * zoom;
  canvas.height = height * zoom;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const sy = Math.min(height - 1, Math.floor(y / zoom));
    for (let x = 0; x < canvas.width; x++) {
      const sx = Math.min(width - 1, Math.floor(x / zoom));
      const idx = sy * width + sx;
      const c = mask[idx];
      const di = (y * canvas.width + x) * 4;
      if (channel === -1 || channel === c) {
        const lin = Math.min(1, Math.max(0, planes64[c][idx]));
        img.data[di + c] = Math.round(linearToSrgb(lin) * 255);
      }
      img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// 在已放大的 CFA 画布上叠加该颜色采样格的边框，方便辨认 2x2 周期
export function overlayCfaGrid(ctx, width, height, zoom, channel, cfa) {
  if (zoom < 4) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cfa[y & 1][x & 1] === channel) {
        ctx.strokeRect(x * zoom + 0.5, y * zoom + 0.5, zoom - 1, zoom - 1);
      }
    }
  }
  ctx.restore();
}

// 16 位值 -> 8 位显示（用于参考图画布，参考图本身已经是 sRGB 编码的 PNG）
export function renderPngRef(ctx, ref16, width, height, { channel = -1, zoom = 1 } = {}) {
  const canvas = ctx.canvas;
  canvas.width = width * zoom;
  canvas.height = height * zoom;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const sy = Math.min(height - 1, Math.floor(y / zoom));
    for (let x = 0; x < canvas.width; x++) {
      const sx = Math.min(width - 1, Math.floor(x / zoom));
      const si = (sy * width + sx) * 3;
      const di = (y * canvas.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[di + c] = channel !== -1 && c !== channel ? 0 : ref16[si + c] >> 8;
      }
      img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
