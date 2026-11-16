// core.js — geometry, validation and CPU stereo rendering.
//
// Pure module: no DOM and no worker APIs, so the page, the render worker and
// the Node test suite all import the same code.
//
// Conventions (from the sample pack):
//   depth        per-row float32 little-endian, no header, metres
//   camera       x right, y down, z forward
//   pixel (c,r)  centre at (c+.5, r+.5)
//   X = (c+.5-cx)*Z/fx,  Y = (r+.5-cy)*Z/fy
//   eye eyeX     left = -b/2, right = +b/2
//   u = fx*(X-eyeX)/Z + cx + fx*eyeX/Z0
//   v = fy*Y/Z + cy
// Substituting X and Y, for a mesh vertex on pixel (c,r) with depth Z:
//   u = c+.5 + fx*eyeX*(1/Z0 - 1/Z),  v = r+.5
// so a source vertex moves horizontally by fx*eyeX*(1/Z0-1/Z) and never
// vertically.  The left/right pair therefore has disparity
//   d(Z) = fx * b * (1/Z - 1/Z0)
// (positive = nearer than the zero-parallax plane = crossed parallax).
//
// The mesh is the pixel grid itself: cell (c,r) owns corners
// 00=(c,r) 10=(c+1,r) 11=(c+1,r+1) 01=(c,r+1), triangles [00,10,11] and
// [00,11,01].  A triangle is kept only when its three vertex depths are
// finite, > 0, and max-min <= jump.  Triangle order is row-major cell, first
// triangle then second; that order is the deterministic tie-break when two
// fragments have equal depth.
//
// Rendering is half-space rasterisation at output pixel centres with a depth
// buffer: smaller positive Z wins, equal Z falls back to the lower source
// triangle index.  Colour is bilinearly sampled from the source image at the
// perspective-correct source coordinate of each fragment.  Coverage alone
// defines the raw hole mask (255 = hole, 0 = covered); a black pixel is
// covered and is not a hole.

export const LIMITS = { maxWidth: 1024, maxHeight: 768 };
export const DEFAULTS = { eyeDistance: 0.1, zeroPlane: 4, jump: 0.5, fillMaxGap: 24 };
export const FILL_STRATEGY = '水平补洞：逐行找出空洞段；段长不超过上限时，用两侧覆盖像素中深度更远' +
  '（Z 更大）那一侧的颜色整段填充，两侧一样远时取左侧；只有一端有覆盖时取该端颜色；' +
  '贯穿整行或超过上限的空洞保持透明。补洞只作用于预览图，原始遮罩与未补洞 RGBA 不受影响。';
export const DISP_FORMULA = 'd(Z) = fx * b * (1/Z - 1/Z0)';
export const STEREO_FORMULA = 'u = fx*(X-eyeX)/Z + cx + fx*eyeX/Z0, v = fy*Y/Z + cy, ' +
  'eyeX = -b/2 (left) or +b/2 (right)';

const PATH_SEP = /[\\/\x00]/;

export class RenderCancelled extends Error {
  constructor() { super('渲染已取消'); this.name = 'RenderCancelled'; }
}

export function isValidDepth(z) {
  return typeof z === 'number' && Number.isFinite(z) && z > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Case description validation
// ---------------------------------------------------------------------------

// Validate the JSON description.  depthBytes / colorDims are optional so the
// same function can check the JSON before files finish loading; the page
// passes them once both are known.
export function validateCaseMeta(input, opts = {}) {
  const { depthBytes = null, colorDims = null } = opts;
  const errors = [];
  const warnings = [];
  const meta = {};

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['JSON 顶层必须是对象'], warnings, meta: null };
  }

  const width = input.width;
  const height = input.height;
  if (!Number.isInteger(width) || width < 1 || width > LIMITS.maxWidth) {
    errors.push(`width 必须是 1..${LIMITS.maxWidth} 的整数（收到 ${JSON.stringify(width)}）`);
  }
  if (!Number.isInteger(height) || height < 1 || height > LIMITS.maxHeight) {
    errors.push(`height 必须是 1..${LIMITS.maxHeight} 的整数（收到 ${JSON.stringify(height)}）`);
  }

  if (!isFiniteNumber(input.fx) || input.fx <= 0) errors.push('fx 必须是有限正数');
  if (!isFiniteNumber(input.fy) || input.fy <= 0) errors.push('fy 必须是有限正数');
  if (!isFiniteNumber(input.cx)) errors.push('cx 必须是有限数');
  if (!isFiniteNumber(input.cy)) errors.push('cy 必须是有限数');

  for (const key of ['color', 'depth']) {
    const v = input[key];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${key} 必须是非空文件名`);
    else if (PATH_SEP.test(v)) errors.push(`${key} 不能包含路径分隔符（收到 ${JSON.stringify(v)}）`);
  }

  const eyeDistance = input.eye_distance === undefined ? DEFAULTS.eyeDistance : input.eye_distance;
  const zeroPlane = input.zero_plane === undefined ? DEFAULTS.zeroPlane : input.zero_plane;
  const jump = input.jump === undefined ? DEFAULTS.jump : input.jump;
  if (!isFiniteNumber(eyeDistance) || eyeDistance <= 0) errors.push('eye_distance 必须是有限正数');
  if (!isFiniteNumber(zeroPlane) || zeroPlane <= 0) errors.push('zero_plane 必须是有限正数');
  if (!isFiniteNumber(jump) || jump < 0) errors.push('jump 必须是有限非负数');

  const sizeOK = !errors.some((e) => e.startsWith('width') || e.startsWith('height'));
  if (sizeOK && depthBytes !== null) {
    const expected = width * height * 4;
    if (!Number.isFinite(depthBytes)) errors.push('深度文件长度不可读');
    else if (depthBytes < expected) {
      errors.push(`深度文件被截断：需要 ${expected} 字节（${width}×${height}×4），实际只有 ${depthBytes} 字节，缺少 ${expected - depthBytes} 字节`);
    } else if (depthBytes > expected) {
      errors.push(`深度文件长度不符：需要 ${expected} 字节（${width}×${height}×4），实际 ${depthBytes} 字节，多出 ${depthBytes - expected} 字节`);
    }
  }
  if (sizeOK && colorDims) {
    if (colorDims.width !== width || colorDims.height !== height) {
      errors.push(`原图尺寸不符：JSON 声明 ${width}×${height}，颜色 PNG 是 ${colorDims.width}×${colorDims.height}`);
    }
  }

  if (typeof input.depth === 'string' && !/\.(f32|bin)$/i.test(input.depth)) {
    warnings.push(`depth 文件扩展名为 "${input.depth}"，内容仍按 float32 小端解释`);
  }

  const extraKeys = Object.keys(input).filter((k) => ![
    'width', 'height', 'fx', 'fy', 'cx', 'cy', 'color', 'depth',
    'eye_distance', 'zero_plane', 'jump',
  ].includes(k));
  if (extraKeys.length) warnings.push(`忽略未知字段：${extraKeys.join(', ')}`);

  Object.assign(meta, {
    width, height,
    fx: input.fx, fy: input.fy, cx: input.cx, cy: input.cy,
    color: input.color, depth: input.depth,
    eyeDistance, zeroPlane, jump, extraKeys,
  });

  return { ok: errors.length === 0, errors, warnings, meta: errors.length ? null : meta };
}

// Decode the depth blob into a Float32Array of width*height values.  Length
// must match exactly: a truncated or oversized file is rejected, never
// partially used.
export function decodeDepth(blob, width, height, fileName = 'depth') {
  const bytes = blob instanceof ArrayBuffer
    ? new Uint8Array(blob)
    : new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  const expected = width * height * 4;
  if (bytes.byteLength < expected) {
    throw new Error(`${fileName} 被截断：需要 ${expected} 字节，实际 ${bytes.byteLength} 字节，缺少 ${expected - bytes.byteLength} 字节`);
  }
  if (bytes.byteLength > expected) {
    throw new Error(`${fileName} 长度不符：需要 ${expected} 字节，实际 ${bytes.byteLength} 字节，多出 ${bytes.byteLength - expected} 字节`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry and disparity
// ---------------------------------------------------------------------------

export function eyeOffsetX(eyeDistance, eye) {
  if (eye === 'left') return -eyeDistance / 2;
  if (eye === 'right') return eyeDistance / 2;
  throw new Error(`unknown eye: ${eye}`);
}

// Horizontal displacement of a source pixel centre for one eye, in pixels.
export function pixelShift(fx, eyeDistance, zeroPlane, z, eye) {
  if (!isValidDepth(z) || !(zeroPlane > 0)) return NaN;
  return fx * eyeOffsetX(eyeDistance, eye) * (1 / zeroPlane - 1 / z);
}

// Theoretical disparity (left u − right u) in pixels at depth z.
export function disparityPixels(fx, eyeDistance, zeroPlane, z) {
  if (!isValidDepth(z) || !(zeroPlane > 0) || !(fx > 0)) return NaN;
  return fx * eyeDistance * (1 / z - 1 / zeroPlane);
}

export function projectPixel(c, r, z, params, eye) {
  return {
    u: c + 0.5 + pixelShift(params.fx, params.eyeDistance, params.zeroPlane, z, eye),
    v: r + 0.5,
  };
}

// Build the triangle index list.  Vertices are pixel ids (r*width+c); depth
// and source coordinates are looked up from the depth map, so only indices
// are stored.
export function buildMesh(depth, width, height, jump) {
  if (!(jump >= 0) || !Number.isFinite(jump)) throw new Error('jump 必须是有限非负数');
  const cellsX = width - 1;
  const cellsY = height - 1;
  const d = depth;

  const triOK = (i0, i1, i2) => {
    const a = d[i0], b = d[i1], c = d[i2];
    if (!isValidDepth(a) || !isValidDepth(b) || !isValidDepth(c)) return false;
    return Math.max(a, b, c) - Math.min(a, b, c) <= jump;
  };

  let count = 0;
  for (let r = 0; r < cellsY; r++) {
    const row = r * width;
    for (let c = 0; c < cellsX; c++) {
      const i00 = row + c;
      if (triOK(i00, i00 + 1, i00 + 1 + width)) count++;
      if (triOK(i00, i00 + 1 + width, i00 + width)) count++;
    }
  }

  const indices = new Uint32Array(count * 3);
  let at = 0;
  for (let r = 0; r < cellsY; r++) {
    const row = r * width;
    for (let c = 0; c < cellsX; c++) {
      const i00 = row + c;
      const i10 = i00 + 1;
      const i11 = i10 + width;
      const i01 = i00 + width;
      if (triOK(i00, i10, i11)) {
        indices[at++] = i00; indices[at++] = i10; indices[at++] = i11;
      }
      if (triOK(i00, i11, i01)) {
        indices[at++] = i00; indices[at++] = i11; indices[at++] = i01;
      }
    }
  }

  return { indices, triCount: count, cells: cellsX * cellsY, vertices: width * height };
}

// ---------------------------------------------------------------------------
// Rasterisation (split into a target object so a worker can run it in chunks)
// ---------------------------------------------------------------------------

const EDGE_EPS = 1e-7;

function edgeArea(ax, ay, bx, by, px, py) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

// tx, ty are texel-index coordinates (texel (c,r) centre = (c,r)).
function sampleBilinear(color, width, height, tx, ty, dst) {
  let x0 = Math.floor(tx);
  let y0 = Math.floor(ty);
  let fx = tx - x0;
  let fy = ty - y0;
  if (x0 < 0) { fx = 0; x0 = 0; }
  if (y0 < 0) { fy = 0; y0 = 0; }
  if (x0 > width - 1) { fx = 0; x0 = width - 1; }
  if (y0 > height - 1) { fy = 0; y0 = height - 1; }
  const x1 = x0 + 1 < width ? x0 + 1 : width - 1;
  const y1 = y0 + 1 < height ? y0 + 1 : height - 1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  dst[0] = color[i00] * w00 + color[i10] * w10 + color[i01] * w01 + color[i11] * w11;
  dst[1] = color[i00 + 1] * w00 + color[i10 + 1] * w10 + color[i01 + 1] * w01 + color[i11 + 1] * w11;
  dst[2] = color[i00 + 2] * w00 + color[i10 + 2] * w10 + color[i01 + 2] * w01 + color[i11 + 2] * w11;
}

// Create the buffers for one eye.  params: fx, fy, cx, cy, eyeDistance,
// zeroPlane, eye.  fy/cx/cy do not enter the rasterisation (v is identity,
// u is a pure shift) but are kept so a caller can report the full camera.
export function createEyeTarget(width, height, params) {
  const target = {
    width,
    height,
    params,
    k: params.fx * eyeOffsetX(params.eyeDistance, params.eye),
    iz0: 1 / params.zeroPlane,
    rgba: new Uint8ClampedArray(width * height * 4),
    mask: new Uint8Array(width * height),
    zbuf: new Float32Array(width * height),
    triBuf: new Int32Array(width * height),
    srcX: new Float32Array(width * height),
    srcY: new Float32Array(width * height),
    next: 0,
  };
  target.mask.fill(255);
  target.zbuf.fill(Infinity);
  target.triBuf.fill(0x7fffffff);
  target.srcX.fill(NaN);
  target.srcY.fill(NaN);
  return target;
}

// Rasterise triangles [t0, t1) of the mesh into the target.  Returns the index
// one past the last triangle processed (t1).
export function rasterRange(target, mesh, depth, color, t0, t1) {
  const { width: w, height: h, rgba, mask, zbuf, triBuf, srcX, srcY } = target;
  const indices = mesh.indices;
  const k = target.k;
  const iz0 = target.iz0;
  const d = depth;
  const sample = new Float32Array(3);

  const end = Math.min(t1, mesh.triCount);
  for (let t = t0; t < end; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const iz0v = 1 / d[i0];
    let iz1v = 1 / d[i1];
    let iz2v = 1 / d[i2];

    let ax = (i0 % w) + 0.5 + k * (iz0 - iz0v);
    let ay = ((i0 / w) | 0) + 0.5;
    let bx = (i1 % w) + 0.5 + k * (iz0 - iz1v);
    let by = ((i1 / w) | 0) + 0.5;
    let cx = (i2 % w) + 0.5 + k * (iz0 - iz2v);
    let cy = ((i2 / w) | 0) + 0.5;

    // Source coordinates keep the unshifted vertex positions.
    let sxa = (i0 % w) + 0.5, sya = ay;
    let sxb = (i1 % w) + 0.5, syb = by;
    let sxc = (i2 % w) + 0.5, syc = cy;

    let area = edgeArea(ax, ay, bx, by, cx, cy);
    if (area === 0) continue;
    if (area < 0) {
      let tx = bx, ty = by, ts = sxb, tu = syb, ti = iz1v;
      bx = cx; by = cy; sxb = sxc; syb = syc; iz1v = iz2v;
      cx = tx; cy = ty; sxc = ts; syc = tu; iz2v = ti;
      area = -area;
    }

    let px0 = Math.ceil(Math.min(ax, bx, cx) - 0.5);
    let px1 = Math.floor(Math.max(ax, bx, cx) - 0.5);
    let py0 = Math.ceil(Math.min(ay, by, cy) - 0.5);
    let py1 = Math.floor(Math.max(ay, by, cy) - 0.5);
    if (px0 < 0) px0 = 0;
    if (py0 < 0) py0 = 0;
    if (px1 > w - 1) px1 = w - 1;
    if (py1 > h - 1) py1 = h - 1;

    // E(a,b,P): d/dx = b.y-a.y, d/dy = -(b.x-a.x).
    const dx0 = cy - by, dx1 = ay - cy, dx2 = by - ay;

    for (let py = py0; py <= py1; py++) {
      const yc = py + 0.5;
      let e0 = edgeArea(bx, by, cx, cy, px0 + 0.5, yc);
      let e1 = edgeArea(cx, cy, ax, ay, px0 + 0.5, yc);
      let e2 = edgeArea(ax, ay, bx, by, px0 + 0.5, yc);
      let p = py * w + px0;

      for (let px = px0; px <= px1; px++, p++, e0 += dx0, e1 += dx1, e2 += dx2) {
        // Inclusive edges with a numeric slack: a pixel centre exactly on an
        // edge (shared edges between cells, or the mesh border at y = r + 0.5)
        // is inside, and float noise must not make that depend on the sign of
        // a ~1e-13 residual.  Pixels just outside stay outside by orders of
        // magnitude more than EDGE_EPS.
        if (e0 < -EDGE_EPS || e1 < -EDGE_EPS || e2 < -EDGE_EPS) continue;

        const l0 = e0 / area;
        const l1 = e1 / area;
        const l2 = e2 / area;
        const iw = l0 * iz0v + l1 * iz1v + l2 * iz2v;
        if (!(iw > 0)) continue;
        const z = 1 / iw;

        // Depths within one float32 ULP band (1e-6 relative) are "equal": the
        // input itself cannot distinguish them, and the tie must go to the
        // lower source triangle index.  Anything meaningfully nearer wins.
        const zb = zbuf[p];
        const tol = zb * 1e-6;
        if (z > zb + tol) continue;                 // farther loses
        if (z >= zb - tol && t >= triBuf[p]) continue;

        const sx = (l0 * sxa * iz0v + l1 * sxb * iz1v + l2 * sxc * iz2v) / iw;
        const sy = (l0 * sya * iz0v + l1 * syb * iz1v + l2 * syc * iz2v) / iw;

        sampleBilinear(color, w, h, sx - 0.5, sy - 0.5, sample);
        const o = p * 4;
        rgba[o] = sample[0];
        rgba[o + 1] = sample[1];
        rgba[o + 2] = sample[2];
        rgba[o + 3] = 255;
        mask[p] = 0;
        zbuf[p] = z;
        triBuf[p] = t;
        srcX[p] = sx;
        srcY[p] = sy;
      }
    }
  }
  target.next = end;
  return end;
}

export function finalizeEye(target) {
  let covered = 0;
  for (let i = 0; i < target.mask.length; i++) if (target.mask[i] === 0) covered++;
  const pixels = target.width * target.height;
  return {
    rgba: target.rgba,
    mask: target.mask,
    zbuf: target.zbuf,
    srcX: target.srcX,
    srcY: target.srcY,
    width: target.width,
    height: target.height,
    stats: { covered, holes: pixels - covered, pixels },
  };
}

// Synchronous single-eye render (tests and small cases).
export function renderEye(mesh, depth, color, width, height, params, progress) {
  const target = createEyeTarget(width, height, params);
  const step = 65536;
  for (let t = 0; t < mesh.triCount; t += step) {
    if (progress) progress(t / Math.max(1, mesh.triCount));
    rasterRange(target, mesh, depth, color, t, t + step);
  }
  if (progress) progress(1);
  return finalizeEye(target);
}

// ---------------------------------------------------------------------------
// Horizontal hole filling (preview only)
// ---------------------------------------------------------------------------

// See FILL_STRATEGY for the exact rule.  Never mutates mask / zbuf / rgba;
// returns a fresh RGBA copy plus statistics.
export function fillHoles(rgba, mask, zbuf, width, height, maxGap) {
  const out = new Uint8ClampedArray(rgba);
  const w = width;
  const limit = Math.max(0, Math.floor(Number(maxGap) || 0));
  let filled = 0;
  let runs = 0;
  let filledRuns = 0;
  let skippedRuns = 0;
  let longestRun = 0;

  for (let y = 0; y < height; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (mask[row + x] === 0) { x++; continue; }
      const a = x;
      while (x < w && mask[row + x] !== 0) x++;
      const b = x - 1;
      runs++;
      const len = b - a + 1;
      if (len > longestRun) longestRun = len;

      const hasL = a > 0;
      const hasR = b < w - 1;
      if (!hasL && !hasR) { skippedRuns++; continue; }
      if (limit <= 0 || len > limit) { skippedRuns++; continue; }

      let from;
      if (hasL && hasR) {
        const zl = zbuf[row + a - 1];
        const zr = zbuf[row + b + 1];
        from = zl >= zr ? a - 1 : b + 1; // farther surface wins; tie goes left
      } else {
        from = hasL ? a - 1 : b + 1;
      }
      const so = (row + from) * 4;
      const r = out[so], g = out[so + 1], bl = out[so + 2];
      for (let i = a; i <= b; i++) {
        const o = (row + i) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = 255;
      }
      filled += len;
      filledRuns++;
    }
  }

  return {
    rgba: out,
    stats: { filled, runs, filledRuns, skippedRuns, longestRun, maxGap: limit },
  };
}

// ---------------------------------------------------------------------------
// Composite helpers
// ---------------------------------------------------------------------------

// Red = left eye, cyan (green+blue) = right eye.  A pixel that is a hole in
// one eye only shows the other eye's channel, so holes read as ghosts rather
// than black.  Holes in both eyes stay transparent.
export function makeAnaglyph(leftRGBA, rightRGBA, leftMask, rightMask, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lHole = leftMask[i] !== 0;
    const rHole = rightMask[i] !== 0;
    if (lHole && rHole) continue;
    out[o] = lHole ? 0 : leftRGBA[o];
    out[o + 1] = rHole ? 0 : rightRGBA[o + 1];
    out[o + 2] = rHole ? 0 : rightRGBA[o + 2];
    out[o + 3] = 255;
  }
  return out;
}

const VIRIDIS = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
];

export function depthRange(depth) {
  let min = Infinity;
  let max = -Infinity;
  let invalid = 0;
  let valid = 0;
  for (let i = 0; i < depth.length; i++) {
    const z = depth[i];
    if (isValidDepth(z)) {
      valid++;
      if (z < min) min = z;
      if (z > max) max = z;
    } else invalid++;
  }
  if (!valid) return { min: NaN, max: NaN, invalid, valid, hasRange: false };
  return { min, max, invalid, valid, hasRange: true };
}

// Depth preview: viridis near-to-far, invalid / zero depth in magenta.
export function colorizeDepth(depth, width, height) {
  const range = depthRange(depth);
  const out = new Uint8ClampedArray(width * height * 4);
  const min = range.min;
  const span = range.max - min;
  const flat = !(span > 0);
  for (let i = 0; i < depth.length; i++) {
    const o = i * 4;
    const z = depth[i];
    if (!isValidDepth(z)) {
      out[o] = 224; out[o + 1] = 52; out[o + 2] = 150; out[o + 3] = 255;
      continue;
    }
    let t = flat ? 0.5 : (z - min) / span;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const s = t * (VIRIDIS.length - 1);
    const i0 = Math.min(VIRIDIS.length - 2, Math.floor(s));
    const f = s - i0;
    const a = VIRIDIS[i0], b = VIRIDIS[i0 + 1];
    out[o] = a[0] + (b[0] - a[0]) * f;
    out[o + 1] = a[1] + (b[1] - a[1]) * f;
    out[o + 2] = a[2] + (b[2] - a[2]) * f;
    out[o + 3] = 255;
  }
  return { rgba: out, range };
}

// Screen preview of a raw mask: holes light red on near-black.
export function maskPreview(mask, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const v = mask[i];
    out[o] = v ? 235 : 8;
    out[o + 1] = v ? 70 : 10;
    out[o + 2] = v ? 70 : 12;
    out[o + 3] = 255;
  }
  return out;
}

// Both raw masks at once: red = hole in the left eye only, cyan = right eye
// only, white = hole in both, dark = covered by both.  Purely a display helper;
// the exported masks are the untouched per-eye buffers.
export function maskComparePreview(leftMask, rightMask, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < leftMask.length; i++) {
    const o = i * 4;
    const l = leftMask[i] !== 0;
    const r = rightMask[i] !== 0;
    out[o] = l ? (r ? 235 : 235) : (r ? 30 : 8);
    out[o + 1] = r ? 225 : (l ? 70 : 10);
    out[o + 2] = r ? 235 : (l ? 70 : 12);
    out[o + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One-shot stereo render used by tests and small synchronous callers
// ---------------------------------------------------------------------------

// options: { depth, color, width, height, jump, params, onProgress, cancelCheck }
// params:  { fx, fy, cx, cy, eyeDistance, zeroPlane, fillMaxGap }
export function renderStereo({ depth, color, width, height, jump, params, onProgress, cancelCheck }) {
  const check = () => { if (cancelCheck && cancelCheck()) throw new RenderCancelled(); };
  const mesh = buildMesh(depth, width, height, jump);
  const common = {
    fx: params.fx, fy: params.fy, cx: params.cx, cy: params.cy,
    eyeDistance: params.eyeDistance, zeroPlane: params.zeroPlane,
  };

  const eyes = {};
  for (const eye of ['left', 'right']) {
    check();
    const base = eye === 'left' ? 0 : 0.45;
    eyes[eye] = renderEye(mesh, depth, color, width, height, { ...common, eye }, (f) => {
      if (onProgress) onProgress(base + f * 0.45);
    });
  }
  check();
  if (onProgress) onProgress(0.9);

  const fill = {};
  for (const eye of ['left', 'right']) {
    const e = eyes[eye];
    fill[eye] = fillHoles(e.rgba, e.mask, e.zbuf, width, height, params.fillMaxGap);
  }
  if (onProgress) onProgress(0.97);

  const anaglyph = makeAnaglyph(
    eyes.left.rgba, eyes.right.rgba, eyes.left.mask, eyes.right.mask, width, height,
  );
  const range = depthRange(depth);
  if (onProgress) onProgress(1);

  return {
    width, height,
    triangleCount: mesh.triCount,
    cellCount: mesh.cells,
    left: eyes.left,
    right: eyes.right,
    fillLeft: fill.left,
    fillRight: fill.right,
    anaglyph,
    depthRange: range,
    stats: {
      triangleCount: mesh.triCount,
      cellCount: mesh.cells,
      pixels: width * height,
      leftCovered: eyes.left.stats.covered,
      leftHoles: eyes.left.stats.holes,
      rightCovered: eyes.right.stats.covered,
      rightHoles: eyes.right.stats.holes,
      leftFill: fill.left.stats,
      rightFill: fill.right.stats,
      depthRange: range,
    },
  };
}

// FNV-1a 32-bit over bytes; used for data fingerprints in exported params.
export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hex32(v) {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0');
}
