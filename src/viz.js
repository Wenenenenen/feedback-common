// Visualization helpers: perceptually smooth depth colormap and status colors.

// Compact viridis look-up table (32 stops), interpolated linearly.
const VIRIDIS = [
  [68, 1, 84], [72, 20, 103], [72, 36, 117], [69, 51, 127], [63, 67, 135],
  [56, 82, 139], [50, 96, 141], [44, 110, 141], [39, 123, 140], [34, 137, 137],
  [31, 150, 132], [34, 163, 124], [46, 175, 113], [67, 188, 99], [93, 199, 84],
  [122, 209, 69], [153, 217, 55], [184, 223, 41], [213, 227, 33], [238, 230, 36],
];

function lerp(a, b, t) { return a + (b - a) * t; }

export function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  const scaled = t * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [
    Math.round(lerp(a[0], b[0], f)),
    Math.round(lerp(a[1], b[1], f)),
    Math.round(lerp(a[2], b[2], f)),
  ];
}

// Deterministic, well-separated component colors via golden-angle hue spacing.
export function componentColor(id, anchored) {
  if (!anchored) return [120, 120, 128];
  const hue = (id * 137.508) % 360;
  return hslToRgb(hue / 360, 0.55, 0.6);
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Render an RGB ImageData from the 16-bit depth map.
// mm=0 renders as the "missing" color; values map through viridis on [vmin,vmax].
export function renderDepth(width, height, mm, { vmin, vmax, missingColor = [18, 18, 22] }) {
  const img = new ImageData(width, height);
  const span = Math.max(1, vmax - vmin);
  for (let i = 0; i < width * height; i++) {
    const v = mm[i];
    let rgb;
    if (v === 0) rgb = missingColor;
    else rgb = viridis((v - vmin) / span);
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

export const STATUS_COLORS = {
  0: [40, 40, 46],       // outside
  64: [200, 80, 80],     // unanchored component
  128: [80, 170, 110],   // completed
  255: [240, 220, 90],   // anchor
};

export function renderStatus(width, height, status) {
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const rgb = STATUS_COLORS[status[i]] || [255, 0, 255];
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

export function renderComponents(width, height, graph, solution) {
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    let rgb;
    if (!graph.domain[i]) rgb = [40, 40, 46];
    else {
      const c = graph.compOf[i];
      const anchored = graph.compAnchorCount[c] > 0;
      rgb = componentColor(c, anchored);
    }
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

export function renderGuide(width, height, guide) {
  const img = new ImageData(width, height);
  const ch = guide.channels;
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = guide.samples[i * ch];
    img.data[i * 4 + 1] = guide.samples[i * ch + 1];
    img.data[i * 4 + 2] = guide.samples[i * ch + 2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

// Draw ImageData onto a canvas, scaled with crisp nearest-neighbor pixels.
export function drawImageData(canvas, imgData, displaySize) {
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(imgData, 0, 0);
  canvas.style.width = displaySize + 'px';
  canvas.style.height = (displaySize * (imgData.height / imgData.width)) + 'px';
  canvas.style.imageRendering = 'pixelated';
}

export function depthRange(mm) {
  let vmin = Infinity, vmax = 0;
  for (const v of mm) {
    if (v > 0) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  }
  if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
  if (vmax === vmin) vmax = vmin + 1;
  return { vmin, vmax };
}
