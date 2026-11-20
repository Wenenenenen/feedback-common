// Visualization helpers: direction color wheel (Middlebury-style), vector
// field overlay, validity mask, and heat maps for reprojection / FB error.

// HSV -> RGB, h in [0,360), s,v in [0,1].
function hsvToRgb(h, s, v) {
  const c = v * s, hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Per-pixel direction color. Invalid pixels use a fixed neutral marker so the
// viewer can tell "no correspondence" apart from a genuine zero vector.
export function directionColors(u, v, valid, W, H, maxMag) {
  const img = new ImageData(W, H);
  const d = img.data;
  let magMax = maxMag;
  if (magMax == null) {
    magMax = 1e-6;
    for (let i = 0; i < W * H; i++) if (valid[i]) magMax = Math.max(magMax, Math.hypot(u[i], v[i]));
  }
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (!valid[i]) {
      // dark slate with a faint checker feel handled by overlay instead
      d[p] = 24; d[p + 1] = 27; d[p + 2] = 33; d[p + 3] = 255;
      continue;
    }
    const mag = Math.hypot(u[i], v[i]);
    if (mag < 1e-9) {
      // Valid zero motion: white (the wheel's origin), clearly distinct from
      // the dark invalid marker.
      d[p] = d[p + 1] = d[p + 2] = 255; d[p + 3] = 255;
      continue;
    }
    let ang = Math.atan2(v[i], u[i]) * 180 / Math.PI; // y-down: 0deg = right
    if (ang < 0) ang += 360;
    const sat = 1;
    const val = Math.min(1, 0.35 + 0.65 * (mag / magMax));
    const [r, g, b] = hsvToRgb(ang, sat, val);
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
  }
  return img;
}

// Valid-region mask: green valid, red invalid; optionally hatch invalid.
export function validityColors(valid, W, H) {
  const img = new ImageData(W, H);
  const d = img.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (valid[i]) { d[p] = 46; d[p + 1] = 160; d[p + 2] = 99; d[p + 3] = 255; }
    else { d[p] = 180; d[p + 1] = 60; d[p + 2] = 60; d[p + 3] = 255; }
  }
  return img;
}

// Error heat map (reprojection residual or FB consistency error).
// NaN/invalid -> dark neutral. Uses a blue->green->yellow->red ramp.
export function heatColors(field, valid, W, H, fixedMax) {
  const img = new ImageData(W, H);
  const d = img.data;
  let max = fixedMax;
  if (max == null) {
    max = 1e-6;
    for (let i = 0; i < W * H; i++) if (valid[i] && Number.isFinite(field[i])) max = Math.max(max, field[i]);
  }
  const ramp = (t) => {
    t = Math.max(0, Math.min(1, t));
    // piecewise ramp through blue, cyan, green, yellow, red
    const stops = [[40, 60, 180], [30, 170, 200], [60, 180, 90], [240, 200, 60], [220, 60, 50]];
    const seg = t * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(seg));
    const f = seg - k;
    const a = stops[k], b = stops[k + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (!valid[i] || !Number.isFinite(field[i])) {
      d[p] = 24; d[p + 1] = 27; d[p + 2] = 33; d[p + 3] = 255;
      continue;
    }
    const [r, g, b] = ramp(field[i] / max);
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
  }
  return { img, max };
}

// Draw an image-data into a canvas scaled with nearest-neighbor pixels.
export function paintImageData(ctx, imgData, cssW, cssH) {
  const base = document.createElement('canvas');
  base.width = imgData.width; base.height = imgData.height;
  base.getContext('2d').putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(base, 0, 0, cssW, cssH);
}

// Draw a grayscale source frame onto a context (used for overlays).
export function paintGray(ctx, gray, W, H, cssW, cssH) {
  const img = new ImageData(W, H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = gray[i];
    img.data[p + 3] = 255;
  }
  paintImageData(ctx, img, cssW, cssH);
}

// Vector arrows over a context. step controls grid spacing in source pixels.
export function drawVectors(ctx, u, v, valid, W, H, cssW, cssH, step, scale) {
  const sx = cssW / W, sy = cssH / H;
  ctx.save();
  ctx.lineWidth = 1;
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const i = y * W + x;
    if (!valid[i]) continue;
    const x0 = (x + 0.5) * sx, y0 = (y + 0.5) * sy;
    const x1 = x0 + u[i] * sx * scale, y1 = y0 + v[i] * sy * scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // arrowhead
    const ang = Math.atan2(y1 - y0, x1 - x0), ah = 4;
    ctx.fillStyle = 'rgba(255,235,120,0.95)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ah * Math.cos(ang - 0.45), y1 - ah * Math.sin(ang - 0.45));
    ctx.lineTo(x1 - ah * Math.cos(ang + 0.45), y1 - ah * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// Compact direction color wheel (Middlebury convention: 0deg = right,
// y-down so 90deg = down). Drawn into a square canvas of side `size`.
export function drawColorWheel(canvas, size) {
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const cx = size / 2, cy = size / 2, rad = size / 2 - 1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    const p = (y * size + x) * 4;
    if (dist > rad) { img.data[p + 3] = 0; continue; }
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; if (ang < 0) ang += 360;
    const t = dist / rad;
    const [r, g, b] = hsvToRgb(ang, 1, 0.35 + 0.65 * t);
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Crosshair marker for the clicked correspondence pair.
export function drawMarker(ctx, px, py, cssW, cssH, W, H, color) {
  const x = (px + 0.5) * cssW / W, y = (py + 0.5) * cssH / H;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
  ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
