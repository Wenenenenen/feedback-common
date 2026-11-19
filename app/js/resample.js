// 逆映射重采样 + 直线光预乘透明度距离权重融合。
// 约定：
//  - 逆映射落在源中心矩形 [0,w-1]x[0,h-1] 外视为无效，内部双线性；
//  - sRGB 分段函数转直线光，先预乘 alpha 再插值；
//  - 每层权重 = 到最近无效像素中心的欧氏距离 + 1，画布外一圈视作无效；
//  - 融合 C = sum(w*alpha*C)/sum(w*alpha)，alpha = sum(w*alpha)/sum(w)。

// ---------- sRGB 传递函数（阈值 0.04045，IEC 61966-2-1） ----------
export function srgbDecode8(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbEncode8(L) {
  const c = L <= 0.0031308 ? 12.92 * L : 1.055 * Math.pow(L, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

// ---------- Felzenszwalb 二值图平方距离变换 ----------
// valid: Uint8Array，1=有效像素中心。返回每个像素到最近无效像素的欧氏距离（画布外一圈无效）。
function edt1d(f, n) {
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k]);
      if (s <= z[k]) k--;
      else break;
    } while (k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

// 距离（非平方）到最近无效像素；画布外一圈按无效处理（在填充网格四周加一圈无效环）。
export function distanceToInvalid(valid, width, height) {
  const INF = 1e18;
  const pw = width + 2, ph = height + 2;
  const g = new Float64Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const border = x === 0 || y === 0 || x === pw - 1 || y === ph - 1;
      g[y * pw + x] = border || !valid[(y - 1) * width + (x - 1)] ? 0 : INF;
    }
  }
  // 先沿列（对每一列做 1D）
  const tmp = new Float64Array(pw);
  const col = new Float64Array(ph);
  for (let x = 0; x < pw; x++) {
    for (let y = 0; y < ph; y++) col[y] = g[y * pw + x];
    const d = edt1d(col, ph);
    for (let y = 0; y < ph; y++) g[y * pw + x] = d[y];
  }
  // 再沿行
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) tmp[x] = g[y * pw + x];
    const d = edt1d(tmp, pw);
    for (let x = 0; x < pw; x++) g[y * pw + x] = d[x];
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = Math.sqrt(g[(y + 1) * pw + (x + 1)]);
    }
  }
  return out;
}

// ---------- 单层逆映射重采样 ----------
// src: { width, height, data: RGBA Uint8ClampedArray }
// H_src_canvas: 源像素中心 -> 画布像素中心 的单应；内部求逆做逆映射。
// 返回 { valid: Uint8Array, premul: Float32Array(planar R,G,B 直线光预乘), alpha: Float32Array,
//        weight: Float32Array(距离+1，仅有效区有意义) }
export function warpLayer(src, canvasW, canvasH, H_src_canvas) {
  const H_canvas_src = invert3Local(H_src_canvas);
  const sw = src.width, sh = src.height;
  const n = canvasW * canvasH;
  const valid = new Uint8Array(n);
  const pR = new Float32Array(n), pG = new Float32Array(n), pB = new Float32Array(n);
  const alpha = new Float32Array(n);

  // 源图预算直线光与预乘值
  const linR = new Float32Array(sw * sh), linG = new Float32Array(sw * sh), linB = new Float32Array(sw * sh);
  const aSrc = new Float32Array(sw * sh);
  const d = src.data;
  for (let i = 0; i < sw * sh; i++) {
    const a = d[i * 4 + 3] / 255;
    aSrc[i] = a;
    linR[i] = srgbDecode8(d[i * 4]) * a;
    linG[i] = srgbDecode8(d[i * 4 + 1]) * a;
    linB[i] = srgbDecode8(d[i * 4 + 2]) * a;
  }

  const h0 = H_canvas_src[0], h1 = H_canvas_src[1], h2 = H_canvas_src[2];
  const h3 = H_canvas_src[3], h4 = H_canvas_src[4], h5 = H_canvas_src[5];
  const h6 = H_canvas_src[6], h7 = H_canvas_src[7], h8 = H_canvas_src[8];

  for (let cy = 0; cy < canvasH; cy++) {
    for (let cx = 0; cx < canvasW; cx++) {
      const w = h6 * cx + h7 * cy + h8;
      const sx = (h0 * cx + h1 * cy + h2) / w;
      const sy = (h3 * cx + h4 * cy + h5) / w;
      const idx = cy * canvasW + cx;
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || w === 0) continue;
      // 源中心矩形外无效
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const tx = sx - x0, ty = sy - y0;
      const i00 = y0 * sw + x0, i01 = y0 * sw + x1, i10 = y1 * sw + x0, i11 = y1 * sw + x1;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty, w11 = tx * ty;
      valid[idx] = 1;
      pR[idx] = w00 * linR[i00] + w01 * linR[i01] + w10 * linR[i10] + w11 * linR[i11];
      pG[idx] = w00 * linG[i00] + w01 * linG[i01] + w10 * linG[i10] + w11 * linG[i11];
      pB[idx] = w00 * linB[i00] + w01 * linB[i01] + w10 * linB[i10] + w11 * linB[i11];
      alpha[idx] = w00 * aSrc[i00] + w01 * aSrc[i01] + w10 * aSrc[i10] + w11 * aSrc[i11];
    }
  }
  const dist = distanceToInvalid(valid, canvasW, canvasH);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) weight[i] = valid[i] ? dist[i] + 1 : 0;
  return { valid, pR, pG, pB, alpha, weight };
}

function invert3Local(m) {
  const a = m[0], b = m[1], c = m[2];
  const dd = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(dd * i - f * g), C = dd * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    throw new Error('逆映射失败：单应不可逆（投影退化）');
  }
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * dd - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * dd) * id,
  ];
}

// ---------- 多层融合 ----------
// layers: warpLayer 的返回数组。输出 RGBA Uint8ClampedArray；全无效处 RGBA 全 0。
export function blendLayers(layers, canvasW, canvasH) {
  const n = canvasW * canvasH;
  const accWA = new Float32Array(n);  // sum(w*alpha)
  const accW = new Float32Array(n);   // sum(w)
  const accR = new Float32Array(n);   // sum(w*alpha*C)
  const accG = new Float32Array(n);
  const accB = new Float32Array(n);
  for (const L of layers) {
    for (let i = 0; i < n; i++) {
      if (!L.valid[i] || L.alpha[i] <= 0) continue;
      const wa = L.weight[i] * L.alpha[i];
      accWA[i] += wa;
      accW[i] += L.weight[i];
      accR[i] += wa * (L.pR[i] / L.alpha[i]); // pR 已是预乘值，除回直线光颜色
      accG[i] += wa * (L.pG[i] / L.alpha[i]);
      accB[i] += wa * (L.pB[i] / L.alpha[i]);
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (accW[i] <= 0 || accWA[i] <= 0) continue; // 全无效/全透明：RGBA 全 0
    const C = accWA[i];
    const linR = accR[i] / C, linG = accG[i] / C, linB = accB[i] / C;
    const a = accWA[i] / accW[i];
    out[i * 4] = srgbEncode8(linR);
    out[i * 4 + 1] = srgbEncode8(linG);
    out[i * 4 + 2] = srgbEncode8(linB);
    out[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return out;
}
