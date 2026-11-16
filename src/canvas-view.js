// canvas-view.js — Pixel-accurate scaled canvas rendering with checkerboard and pixel picking.
function drawChecker(ctx, w, h, scale, cell = 8) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w * scale, h * scale);
  ctx.fillStyle = '#cfd6dd';
  const cellsX = Math.ceil(w / cell);
  const cellsY = Math.ceil(h / cell);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      if ((cx + cy) % 2 === 0) {
        ctx.fillRect(cx * cell * scale, cy * cell * scale, cell * scale, cell * scale);
      }
    }
  }
}

// Render an RGBA buffer (full-canvas size) onto a canvas at integer zoom.
export function renderCanvas(canvas, rgba, imgW, imgH, scale, checker, highlightRect) {
  canvas.width = imgW * scale;
  canvas.height = imgH * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (checker) drawChecker(ctx, imgW, imgH, scale);
  const imageData = ctx.createImageData(imgW, imgH);
  imageData.data.set(rgba);
  // draw at 1:1 then scale without smoothing
  const tmp = document.createElement('canvas');
  tmp.width = imgW;
  tmp.height = imgH;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, imgW * scale, imgH * scale);

  if (highlightRect) {
    ctx.lineWidth = Math.max(1, scale / 4);
    ctx.strokeStyle = 'rgba(255, 82, 124, 0.95)';
    ctx.strokeRect(
      highlightRect.x * scale + 0.5,
      highlightRect.y * scale + 0.5,
      highlightRect.width * scale - 1,
      highlightRect.height * scale - 1);
  }
}

// Render a frame's own raw pixels (frame-rectangle sized, not full canvas).
export function renderRawFrame(canvas, rgba, fw, fh, scale, checker) {
  renderCanvas(canvas, rgba, fw, fh, scale, checker, null);
}

// Pick an RGBA value from a full-canvas buffer given mouse event coordinates.
export function pickPixel(canvas, event, rgba, imgW, imgH, scale) {
  const rect = canvas.getBoundingClientRect();
  const cssScaleX = canvas.width / rect.width;
  const cssScaleY = canvas.height / rect.height;
  const px = Math.floor(((event.clientX - rect.left) * cssScaleX) / scale);
  const py = Math.floor(((event.clientY - rect.top) * cssScaleY) / scale);
  if (px < 0 || py < 0 || px >= imgW || py >= imgH) return null;
  const i = (py * imgW + px) * 4;
  return { x: px, y: py, r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a: rgba[i + 3] };
}
