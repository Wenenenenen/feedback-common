// Dense optical flow core: coarse-to-fine windowed Lucas-Kanade with
// independent forward/backward estimation and forward-backward consistency.
// No external optical-flow / registration / matching APIs — only typed arrays
// and hand-written 2x2 linear solves.
//
// Convention (matches sample README):
//   forward flow (u,v) at pixel p means  A(p)  <->  B(p + (u,v))
// x right, y down, pixel-center coordinates.

export const DEFAULT_PARAMS = {
  windowRadius: 2,     // window side = 2*r+1 (UI exposes odd side 3..15)
  levels: 3,           // pyramid levels 1..5
  iterations: 10,      // LK iterations per level 1..30
  fbThreshold: 1.0,    // forward-backward consistency threshold in pixels
  eigenThreshold: 4.0, // min eigenvalue of window structure tensor (texture gate)
  medianFilter: true,  // 3x3 median flow coupling between iterations
};

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function buildPrefix(src, W, H) {
  // Prefix sums with a zero border row/col: index (y+1)*(W+1)+(x+1).
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    const rowBase = (y + 1) * (W + 1);
    const prevBase = y * (W + 1);
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      S[rowBase + x + 1] = S[prevBase + x + 1] + row;
    }
  }
  return S;
}

function rectSum(S, W, H, x0, y0, x1, y1) {
  // inclusive rectangle, coords already guaranteed inside the image
  const stride = W + 1;
  return S[(y1 + 1) * stride + (x1 + 1)] - S[y0 * stride + (x1 + 1)]
       - S[(y1 + 1) * stride + x0] + S[y0 * stride + x0];
}

// Bilinear sample. Returns null when the four required pixels are not all
// inside the image — edge clamping is never used as a fake correspondence.
function sampleBilinear(img, W, H, fx, fy) {
  if (!(fx >= 0 && fy >= 0 && fx <= W - 1 && fy <= H - 1)) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 >= W - 1 || y0 >= H - 1) {
    // Exactly on the last row/col: the pixel center itself is a valid sample.
    if (x0 <= W - 1 && y0 <= H - 1 && Number.isInteger(fx) && Number.isInteger(fy)) {
      return img[y0 * W + x0];
    }
    return null;
  }
  const tx = fx - x0, ty = fy - y0;
  const i00 = y0 * W + x0, i10 = i00 + 1, i01 = i00 + W, i11 = i01 + 1;
  return img[i00] * (1 - tx) * (1 - ty) + img[i10] * tx * (1 - ty)
       + img[i01] * (1 - tx) * ty + img[i11] * tx * ty;
}

// Bilinear sample of a vector field plus an all-or-nothing validity gate.
// Returns null if any of the four corners is invalid / out of the image.
function sampleVectorBilinear(u, v, valid, W, H, fx, fy) {
  if (!(fx >= 0 && fy >= 0 && fx <= W - 1 && fy <= H - 1)) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 >= W - 1 || y0 >= H - 1) {
    if (x0 <= W - 1 && y0 <= H - 1 && Number.isInteger(fx) && Number.isInteger(fy)) {
      const i = y0 * W + x0;
      return valid[i] ? { u: u[i], v: v[i] } : null;
    }
    return null;
  }
  const tx = fx - x0, ty = fy - y0;
  const i00 = y0 * W + x0, i10 = i00 + 1, i01 = i00 + W, i11 = i01 + 1;
  if (!(valid[i00] && valid[i10] && valid[i01] && valid[i11])) return null;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty),
        w01 = (1 - tx) * ty, w11 = tx * ty;
  return {
    u: u[i00] * w00 + u[i10] * w10 + u[i01] * w01 + u[i11] * w11,
    v: v[i00] * w00 + v[i10] * w10 + v[i01] * w01 + v[i11] * w11,
  };
}

// ---------------------------------------------------------------------------
// Pyramid: 2x block-average downsampling
// ---------------------------------------------------------------------------

function downsample2x(img, W, H) {
  const nW = Math.floor(W / 2), nH = Math.floor(H / 2);
  const out = new Float32Array(nW * nH);
  for (let y = 0; y < nH; y++) {
    for (let x = 0; x < nW; x++) {
      const sx = x * 2, sy = y * 2;
      let sum = img[sy * W + sx];
      let cnt = 1;
      if (sx + 1 < W) { sum += img[sy * W + sx + 1]; cnt++; }
      if (sy + 1 < H) { sum += img[(sy + 1) * W + sx]; cnt++; }
      if (sx + 1 < W && sy + 1 < H) { sum += img[(sy + 1) * W + sx + 1]; cnt++; }
      out[y * nW + x] = sum / cnt;
    }
  }
  return { data: out, W: nW, H: nH };
}

function buildPyramid(img, W, H, levels) {
  const pyr = [{ data: Float32Array.from(img), W, H }];
  let maxLevels = 1;
  let w = W, h = H;
  while (w >= 8 && h >= 8) { maxLevels++; w = Math.floor(w / 2); h = Math.floor(h / 2); }
  const L = Math.max(1, Math.min(levels, maxLevels));
  for (let l = 1; l < L; l++) pyr.push(downsample2x(pyr[l - 1].data, pyr[l - 1].W, pyr[l - 1].H));
  return pyr;
}

// Central-difference gradients of the first image (one-sided at borders).
function gradients(img, W, H) {
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    gx[i] = x > 0 && x < W - 1 ? (img[i + 1] - img[i - 1]) * 0.5
           : x === 0 ? img[i + 1] - img[i] : img[i] - img[i - 1];
    gy[i] = y > 0 && y < H - 1 ? (img[i + W] - img[i - W]) * 0.5
           : y === 0 ? img[i + W] - img[i] : img[i] - img[i - W];
  }
  return { gx, gy };
}

// 3x3 component-wise median filter over a flow component. Pixels marked
// invalid contribute their current value but are skipped as outputs only when
// the caller passes a validity gate; here we smooth the field spatially so
// neighboring windows converge together (standard dense-LK regularization).
function medianFilter3(field, w, h, gate) {
  const out = new Float32Array(w * h);
  const buf = new Float64Array(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (gate && !gate[i]) { out[i] = field[i]; continue; }
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      buf[n++] = field[yy * w + xx];
    }
    const s = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
    out[i] = s[n >> 1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-direction flow: A -> B
// ---------------------------------------------------------------------------

export function estimateDirectionalFlow(a, b, W, H, params, shouldCancel = () => false, onProgress = null) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pyrA = buildPyramid(a, W, H, p.levels);
  const pyrB = buildPyramid(b, W, H, p.levels);
  const L = pyrA.length;

  let u = null, v = null, valid = null;
  const eigenMap = new Float32Array(W * H); // filled at the finest level

  for (let level = L - 1; level >= 0; level--) {
    const { W: w, H: h, data: A } = pyrA[level];
    const B = pyrB[level].data;
    const scale = 1 << level; // coordinate scale relative to finest level

    // Initialize flow at this level.
    let uL, vL, validL;
    if (u === null) {
      uL = new Float32Array(w * h);
      vL = new Float32Array(w * h);
      validL = new Uint8Array(w * h);
    } else {
      uL = new Float32Array(w * h);
      vL = new Float32Array(w * h);
      validL = new Uint8Array(w * h);
      // Bilinear upsample of the coarser flow. A coarse pixel center maps to
      // twice its coordinates at the fine level (pixel-center convention),
      // and flow magnitudes double because pixel size halves.
      const cW = pyrA[level + 1].W, cH = pyrA[level + 1].H;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cx = x / 2, cy = y / 2;
        const x0 = Math.floor(cx), y0 = Math.floor(cy);
        const tx = cx - x0, ty = cy - y0;
        let su = 0, sv = 0, sw = 0, anyValid = 0;
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
          const xx = x0 + dx, yy = y0 + dy;
          if (xx < 0 || yy < 0 || xx >= cW || yy >= cH) continue;
          const wi = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
          const ci = yy * cW + xx;
          su += u[ci] * wi; sv += v[ci] * wi; sw += wi;
          if (valid[ci]) anyValid = 1;
        }
        const i = y * w + x;
        if (sw > 0) { uL[i] = 2 * su / sw; vL[i] = 2 * sv / sw; validL[i] = anyValid; }
      }
      // Clean outliers inherited from the coarser level before refining.
      if (p.medianFilter !== false) {
        const mu = medianFilter3(uL, w, h, null);
        const mv = medianFilter3(vL, w, h, null);
        uL = mu; vL = mv;
      }
    }

    const { gx, gy } = gradients(A, w, h);
    // Inverse-compositional LK (Baker & Matthews): the structure tensor is
    // built ONCE from gradients of the template A. The warp update each
    // iteration is  w <- w o DeltaW^{-1}, i.e. the flow accumulates -delta.
    const gxx = new Float32Array(w * h), gxy = new Float32Array(w * h), gyy = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gxx[i] = gx[i] * gx[i]; gxy[i] = gx[i] * gy[i]; gyy[i] = gy[i] * gy[i];
    }
    const pXX = buildPrefix(gxx, w, h), pXY = buildPrefix(gxy, w, h), pYY = buildPrefix(gyy, w, h);

    const r = Math.min(p.windowRadius, Math.floor(Math.min(w, h) / 2) - 1);
    const inBounds = new Uint8Array(w * h);
    const it = new Float32Array(w * h);

    for (let iter = 0; iter < p.iterations; iter++) {
      if (shouldCancel()) return { canceled: true };

      // Template residual: e(x) = B(x + flow) - A(x), sampled bilinearly.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const fx = x + uL[i], fy = y + vL[i];
        // The whole (2r+1) window around the warped center must stay inside.
        if (!(fx - r >= 0 && fy - r >= 0 && fx + r <= w - 1 && fy + r <= h - 1)
            || !Number.isFinite(fx) || !Number.isFinite(fy)) {
          inBounds[i] = 0;
          continue;
        }
        inBounds[i] = 1;
        const s = sampleBilinear(B, w, h, fx, fy);
        it[i] = s - A[i];
      }

      // IC right-hand side: sum over the template window of grad(A) * e.
      const hx = new Float32Array(w * h), hy = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        hx[i] = gx[i] * it[i];
        hy[i] = gy[i] * it[i];
      }
      const pHx = buildPrefix(hx, w, h), pHy = buildPrefix(hy, w, h);

      // G * delta = sum grad(A) e, with G = sum grad(A) grad(A)^T.
      // Then the warp is updated by the INVERSE delta: flow += -delta.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!inBounds[i]) continue;
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        const G11 = rectSum(pXX, w, h, x0, y0, x1, y1);
        const G12 = rectSum(pXY, w, h, x0, y0, x1, y1);
        const G22 = rectSum(pYY, w, h, x0, y0, x1, y1);
        const b1 = rectSum(pHx, w, h, x0, y0, x1, y1);
        const b2 = rectSum(pHy, w, h, x0, y0, x1, y1);
        const det = G11 * G22 - G12 * G12;
        if (!(Math.abs(det) > 1e-9)) continue;
        const dxu = (b1 * G22 - G12 * b2) / det;
        const dxv = (G11 * b2 - G12 * b1) / det;
        if (!Number.isFinite(dxu) || !Number.isFinite(dxv)) { inBounds[i] = 0; continue; }
        uL[i] -= dxu;
        vL[i] -= dxv;
        if (Math.abs(uL[i]) > w || Math.abs(vL[i]) > h) inBounds[i] = 0; // divergence guard
      }

      // Spatial median coupling: remove outlier updates and keep neighboring
      // windows coherent. Diverged pixels are carried at their previous value.
      if (p.medianFilter !== false) {
        const mf = medianFilter3(uL, w, h, inBounds);
        const mf2 = medianFilter3(vL, w, h, inBounds);
        for (let i = 0; i < w * h; i++) if (inBounds[i]) { uL[i] = mf[i]; vL[i] = mf2[i]; }
      }

      if (onProgress) {
        onProgress((((L - 1 - level) + (iter + 1) / p.iterations) / L) * 0.9);
      }
    }

    // Texture gate: smallest eigenvalue of the structure tensor, plus the
    // in-bounds requirement from the final warp.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      // A window itself must be fully inside the image too.
      const aWindowInside = x - r >= 0 && x + r < w && y - r >= 0 && y + r < h;
      const G11 = rectSum(pXX, w, h, x0, y0, x1, y1);
      const G12 = rectSum(pXY, w, h, x0, y0, x1, y1);
      const G22 = rectSum(pYY, w, h, x0, y0, x1, y1);
      const tr = G11 + G22;
      const disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - (G11 * G22 - G12 * G12)));
      const lambdaMin = tr * 0.5 - disc;
      if (level === 0) eigenMap[i] = lambdaMin;
      // Hard observability floor: a (near-)singular structure tensor means the
      // displacement is fundamentally unobservable (flat/1D-texture window),
      // independent of the user-tunable threshold. This keeps a textureless
      // frame from ever reporting confident zero motion.
      const OBSERVABILITY_EPS = 1e-6;
      const gate = Math.max(OBSERVABILITY_EPS, p.eigenThreshold);
      validL[i] = inBounds[i] && aWindowInside && lambdaMin >= gate ? 1 : 0;
      if (!validL[i]) { uL[i] = 0; vL[i] = 0; }
    }

    u = uL; v = vL; valid = validL;
  }

  return { u, v, valid, eigen: eigenMap, levelsUsed: L, canceled: false };
}

// ---------------------------------------------------------------------------
// Forward-backward consistency
// F: A->B on the A grid; Bk: B->A on the B grid.
// err(p) = || F(p) + Bk(p + F(p)) || with bilinear sampling of Bk and its
// validity; any invalid participating corner invalidates p.
// ---------------------------------------------------------------------------

export function forwardBackwardConsistency(F, Bk, W, H, fbThreshold) {
  const fbErr = new Float32Array(W * H);
  const reproj = new Float32Array(W * H);
  const outValid = Uint8Array.from(F.valid);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!F.valid[i]) { fbErr[i] = NaN; reproj[i] = NaN; continue; }
    const qx = x + F.u[i], qy = y + F.v[i];
    const b = sampleVectorBilinear(Bk.u, Bk.v, Bk.valid, W, H, qx, qy);
    if (b === null) {
      outValid[i] = 0;
      fbErr[i] = NaN;
      continue;
    }
    const err = Math.hypot(F.u[i] + b.u, F.v[i] + b.v);
    fbErr[i] = err;
    if (err > fbThreshold) outValid[i] = 0;
  }
  return { valid: outValid, fbErr };
}

// Windowed mean absolute photometric residual at the final flow.
export function reprojectionResidual(a, b, W, H, u, v, valid, windowRadius) {
  const r = windowRadius;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!valid[i]) { out[i] = NaN; continue; }
    let sum = 0, cnt = 0, bad = 0;
    for (let dy = -r; dy <= r && !bad; dy++) for (let dx = -r; dx <= r; dx++) {
      const s = sampleBilinear(b, W, H, x + u[i] + dx, y + v[i] + dy);
      if (s === null) { bad = 1; break; }
      sum += Math.abs(s - a[(y + dy) * W + (x + dx)]);
      cnt++;
    }
    out[i] = bad ? NaN : sum / cnt;
  }
  return out;
}

// Full pipeline for one direction label. Direction 'forward': A->B,
// 'backward': B->A. The two directions are estimated independently.
export async function computeDenseFlow(a, b, W, H, params, direction,
                                       shouldCancel = () => false, onProgress = () => {}) {
  const swap = direction === 'backward';
  const img1 = swap ? b : a;
  const img2 = swap ? a : b;

  onProgress({ stage: 'forward-estimate', frac: 0 });
  const fwd = estimateDirectionalFlow(img1, img2, W, H, params, shouldCancel,
    frac => onProgress({ stage: 'primary-estimate', frac: frac * 0.45 }));
  if (fwd.canceled) return { canceled: true };

  onProgress({ stage: 'backward-estimate', frac: 0.45 });
  const bwd = estimateDirectionalFlow(img2, img1, W, H, params, shouldCancel,
    frac => onProgress({ stage: 'reverse-estimate', frac: 0.45 + frac * 0.45 }));
  if (bwd.canceled) return { canceled: true };

  onProgress({ stage: 'consistency', frac: 0.92 });
  const fb = forwardBackwardConsistency(fwd, bwd, W, H, params.fbThreshold ?? DEFAULT_PARAMS.fbThreshold);
  const reproj = reprojectionResidual(img1, img2, W, H, fwd.u, fwd.v, fb.valid,
    params.windowRadius ?? DEFAULT_PARAMS.windowRadius);

  // Export rule: invalid pixels carry zero flow; validity lives in the mask.
  const uOut = Float32Array.from(fwd.u), vOut = Float32Array.from(fwd.v);
  for (let i = 0; i < W * H; i++) if (!fb.valid[i]) { uOut[i] = 0; vOut[i] = 0; }

  onProgress({ stage: 'done', frac: 1 });
  return {
    canceled: false,
    direction,
    W, H,
    u: uOut, v: vOut, valid: fb.valid,
    rawValidDirectional: fwd.valid,
    fbErr: fb.fbErr, reproj,
    eigen: fwd.eigen,
    reverse: bwd,
    levelsUsed: fwd.levelsUsed,
    params: { ...DEFAULT_PARAMS, ...params },
  };
}
