// core.js — volume decoding, camera framing and CPU ray marching.
//
// No DOM here: the same module is imported by the page, by the render worker
// and by the Node unit tests.  All lengths are millimetres.
//
// Conventions (matching samples/说明.txt and samples/oracle.json):
//   * Volume is stored x-fastest: index = x + nx * (y + ny * z).
//   * The physical box spans [0, dim*spacing] per axis; voxel (x,y,z) has its
//     centre at ((x+0.5)*sx, (y+0.5)*sy, (z+0.5)*sz).
//   * A ray is sampled with a fixed step in mm measured along the ray.  The
//     first n-1 segments are exactly `step` long, the final segment is the
//     remainder (which may be shorter) and is always integrated too.  Each
//     segment takes its sample at its midpoint.
//   * Transfer-function alpha is opacity per `refMm` (1 mm by default).  A
//     segment of length L contributes  1 - (1 - alpha)^(L / refMm), so the
//     same material reads the same at any step size and a short final segment
//     gets the correct share.
//   * MIP maps the sampled maximum linearly through `window` to 8-bit grey;
//     it never uses the transfer-function alpha.
//   * Transfer-function colours are linear RGB.  Encoded output (PNG / canvas)
//     is straight alpha + sRGB.

export const MAX_DIM = 128;
export const STEP_MIN = 0.25;
export const STEP_MAX = 4;
export const IMAGE_MIN = 32;
export const IMAGE_MAX = 1024;
export const DEFAULT_REF_MM = 1;
const FRAME_MARGIN = 1.06;

export const VIEW_NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'];

export const VIEW_LABELS = {
  '+x': '沿 +X',
  '-x': '沿 −X',
  '+y': '沿 +Y',
  '-y': '沿 −Y',
  '+z': '沿 +Z',
  '-z': '沿 −Z',
};

// dir = ray direction; up = screen-up.  Screen-right is up × dir, so for the
// +Z view screen-x follows +X and screen-y follows +Y, and for the +X view
// screen-x follows +Y and screen-y follows +Z (the axis order used by the
// sample oracle).
const PRESETS = {
  '+x': { dir: [1, 0, 0], up: [0, 0, 1] },
  '-x': { dir: [-1, 0, 0], up: [0, 0, 1] },
  '+y': { dir: [0, 1, 0], up: [0, 0, 1] },
  '-y': { dir: [0, -1, 0], up: [0, 0, 1] },
  '+z': { dir: [0, 0, 1], up: [0, 1, 0] },
  '-z': { dir: [0, 0, -1], up: [0, 1, 0] },
};

// --------------------------------------------------------------------------
// Small vector helpers
// --------------------------------------------------------------------------

export function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function vcross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }
export function vnorm(a) {
  const l = vlen(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// --------------------------------------------------------------------------
// Transfer functions
// --------------------------------------------------------------------------

export const DEFAULT_WINDOW = [0, 2000];

export const DEFAULT_TF = [
  { value: 0, rgb: [0, 0, 0], alpha: 0 },
  { value: 1000, rgb: [1, 0, 0], alpha: 0.1 },
  { value: 4095, rgb: [1, 1, 1], alpha: 0.4 },
];

/** Sort + validate transfer-function stops; returns {tf, errors, warnings}. */
export function normalizeTransferFunction(input) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(input) || input.length === 0) {
    return { tf: DEFAULT_TF.map(cloneStop), errors: ['传递函数必须是非空数组'], warnings };
  }
  const stops = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`传递函数第 ${i + 1} 项不是对象`);
      continue;
    }
    const value = Number(s.value);
    if (!Number.isFinite(value)) {
      errors.push(`传递函数第 ${i + 1} 项的 value 不是有限数值`);
      continue;
    }
    if (!Array.isArray(s.rgb) || s.rgb.length !== 3 || !s.rgb.every((c) => Number.isFinite(Number(c)))) {
      errors.push(`传递函数第 ${i + 1} 项的 rgb 必须是三个数值`);
      continue;
    }
    const alpha = Number(s.alpha);
    if (!Number.isFinite(alpha)) {
      errors.push(`传递函数第 ${i + 1} 项的 alpha 不是有限数值`);
      continue;
    }
    const rgb = s.rgb.map((c) => Number(c));
    if (rgb.some((c) => c < 0 || c > 1)) warnings.push(`传递函数第 ${i + 1} 项 rgb 超出 0..1，已截断`);
    if (alpha < 0 || alpha > 1) warnings.push(`传递函数第 ${i + 1} 项 alpha=${alpha} 超出 0..1，已截断`);
    stops.push({
      value,
      rgb: rgb.map((c) => clamp(c, 0, 1)),
      alpha: clamp(alpha, 0, 1),
    });
  }
  if (stops.length === 0) {
    errors.push('没有可用的传递函数控制点');
    return { tf: DEFAULT_TF.map(cloneStop), errors, warnings };
  }
  stops.sort((a, b) => a.value - b.value);
  return { tf: stops, errors, warnings };
}

function cloneStop(s) { return { value: s.value, rgb: s.rgb.slice(), alpha: s.alpha }; }

/** Linear-RGB + per-mm alpha at a scalar value (piecewise linear). */
export function evalTransfer(tf, value) {
  const n = tf.length;
  if (n === 0) return { rgb: [0, 0, 0], alpha: 0 };
  if (value <= tf[0].value) return { rgb: tf[0].rgb, alpha: tf[0].alpha };
  if (value >= tf[n - 1].value) return { rgb: tf[n - 1].rgb, alpha: tf[n - 1].alpha };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tf[mid].value <= value) lo = mid; else hi = mid;
  }
  const a = tf[lo];
  const b = tf[hi];
  const span = b.value - a.value;
  const f = span > 0 ? (value - a.value) / span : 0;
  return {
    rgb: [
      a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
      a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
      a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
    ],
    alpha: a.alpha + (b.alpha - a.alpha) * f,
  };
}

// --------------------------------------------------------------------------
// Colour encoding
// --------------------------------------------------------------------------

export function linearToSrgb(c) {
  const x = clamp(c, 0, 1);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbToLinear(c) {
  const x = clamp(c, 0, 1);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function srgbHexToLinear(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}

export function linearToSrgbHex(rgb) {
  const to = (c) => Math.round(clamp(linearToSrgb(c), 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
}

/** Pack straight-alpha linear RGB into 8-bit sRGB RGBA. */
export function encodeSrgbRgba(linear, alpha) {
  const a = clamp(alpha, 0, 1);
  return [
    Math.round(clamp(linearToSrgb(linear[0]), 0, 1) * 255),
    Math.round(clamp(linearToSrgb(linear[1]), 0, 1) * 255),
    Math.round(clamp(linearToSrgb(linear[2]), 0, 1) * 255),
    Math.round(a * 255),
  ];
}

/** Map a scalar value linearly through the window to 8-bit grey. */
export function windowToGray8(value, window) {
  const [lo, hi] = window;
  const span = hi - lo;
  const g = span > 0 ? (value - lo) / span : 0;
  return Math.round(clamp(g, 0, 1) * 255);
}

// --------------------------------------------------------------------------
// Metadata validation + RAW decoding
// --------------------------------------------------------------------------

/**
 * Validate parsed metadata.  `rawByteLength` may be null when the RAW file
 * has not been chosen yet; otherwise the declared byte count must match.
 * Returns { ok, errors, warnings, meta } where meta is normalised.
 */
export function validateMeta(input, rawByteLength = null) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, meta: null });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('元数据必须是 JSON 对象');
    return fail();
  }

  let dims = null;
  if (!Array.isArray(input.dimensions) || input.dimensions.length !== 3) {
    errors.push('dimensions 必须是长度为 3 的数组');
  } else {
    const values = input.dimensions.map(Number);
    const bad = values.findIndex((v) => !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > MAX_DIM);
    if (bad >= 0) {
      errors.push(
        `dimensions[${bad}]=${JSON.stringify(input.dimensions[bad])} 无效（须为 1..${MAX_DIM} 的整数）`
      );
    } else {
      dims = values;
    }
  }

  let spacing = null;
  if (!Array.isArray(input.spacing) || input.spacing.length !== 3) {
    errors.push('spacing 必须是长度为 3 的数组');
  } else {
    const values = input.spacing.map(Number);
    const bad = values.findIndex((v) => !Number.isFinite(v) || v <= 0);
    if (bad >= 0) {
      errors.push(
        `spacing[${bad}]=${JSON.stringify(input.spacing[bad])} 无效（须为大于 0 的有限数值，单位 mm）`
      );
    } else {
      spacing = values;
    }
  }

  let voxelType = null;
  const vt = typeof input.voxelType === 'string' ? input.voxelType.trim().toLowerCase() : '';
  if (vt === 'u8' || vt === 'uint8') voxelType = 'u8';
  else if (vt === 'u16' || vt === 'uint16') voxelType = 'u16';
  else errors.push(`voxelType=${JSON.stringify(input.voxelType)} 无效（只支持 "u8" 或 "u16"）`);

  let endian = null;
  const en = typeof input.endian === 'string' ? input.endian.trim().toLowerCase() : '';
  if (en === 'little' || en === 'le') endian = 'little';
  else if (en === 'big' || en === 'be') endian = 'big';
  else errors.push(`endian=${JSON.stringify(input.endian)} 无效（只支持 "little" 或 "big"）`);
  if (voxelType === 'u8' && endian === 'big') warnings.push('u8 数据没有字节序之分，endian 已忽略');

  if (input.layout !== undefined && input.layout !== 'x-fastest') {
    errors.push(`layout=${JSON.stringify(input.layout)} 不受支持（只支持 "x-fastest"）`);
  }
  if (input.origin !== undefined && input.origin !== 'voxel-box-min') {
    errors.push(`origin=${JSON.stringify(input.origin)} 不受支持（只支持 "voxel-box-min"）`);
  }

  let raw = null;
  if (input.raw !== undefined) {
    if (typeof input.raw !== 'string' || input.raw.length === 0) errors.push('raw 必须是文件名');
    else raw = input.raw;
  }

  if (errors.length > 0 || !dims || !spacing || !voxelType || !endian) return fail();

  const bytesPerVoxel = voxelType === 'u16' ? 2 : 1;
  const voxelCount = dims[0] * dims[1] * dims[2];
  const expectedBytes = voxelCount * bytesPerVoxel;

  if (rawByteLength !== null && rawByteLength !== undefined) {
    if (!Number.isInteger(rawByteLength) || rawByteLength < 0) {
      errors.push('RAW 文件长度无效');
      return fail();
    }
    if (rawByteLength !== expectedBytes) {
      const diff = rawByteLength - expectedBytes;
      errors.push(
        `RAW 长度不符：${dims.join('×')} ${voxelType} 需要 ${expectedBytes} 字节，实际 ${rawByteLength} 字节` +
        `（${diff > 0 ? '多' : '少'} ${Math.abs(diff)} 字节）`
      );
      return fail();
    }
  }

  return {
    ok: true,
    errors,
    warnings,
    meta: {
      dimensions: dims,
      spacing,
      voxelType,
      endian,
      layout: 'x-fastest',
      origin: 'voxel-box-min',
      raw,
      bytesPerVoxel,
      voxelCount,
      expectedBytes,
    },
  };
}

/**
 * Decode RAW bytes according to validated metadata.
 * Returns { values, dataType, min, max } where `values` is a Uint8Array or
 * Uint16Array holding the scalar values (no rescaling).
 */
export function decodeRaw(meta, rawBytes) {
  const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const count = meta.dimensions[0] * meta.dimensions[1] * meta.dimensions[2];
  const width = meta.voxelType === 'u16' ? 2 : 1;
  if (u8.byteLength !== count * width) {
    throw new Error(`RAW 长度不符：需要 ${count * width} 字节，实际 ${u8.byteLength} 字节`);
  }
  let values;
  let min = Infinity;
  let max = -Infinity;
  if (meta.voxelType === 'u8') {
    values = u8.slice(0, count);
    for (let i = 0; i < count; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  } else {
    // DataView handles unaligned buffers and both byte orders without a copy.
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const little = meta.endian === 'little';
    values = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      const v = dv.getUint16(i * 2, little);
      values[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { values, dataType: meta.voxelType, min, max };
}

/** Build the immutable volume record used by the renderer. */
export function buildVolume(rawBytes, meta, sourceName = '', rawName = '') {
  const decoded = decodeRaw(meta, rawBytes);
  const [nx, ny, nz] = meta.dimensions;
  const [sx, sy, sz] = meta.spacing;
  return {
    sourceName,
    rawName,
    meta,
    dims: [nx, ny, nz],
    spacing: [sx, sy, sz],
    ext: [nx * sx, ny * sy, nz * sz],
    invSpacing: [1 / sx, 1 / sy, 1 / sz],
    values: decoded.values,
    dataType: decoded.dataType,
    valueMin: decoded.min,
    valueMax: decoded.max,
    voxelCount: decoded.values.length,
  };
}

// --------------------------------------------------------------------------
// Trilinear sampling
// --------------------------------------------------------------------------

/**
 * Trilinear sample at physical (px, py, pz) mm.  Grid coordinates are clamped
 * to the voxel-centre range, so the outermost voxel extends to the box edge.
 */
export function trilinear(values, nx, ny, nz, invSx, invSy, invSz, px, py, pz) {
  let gx = px * invSx - 0.5;
  let gy = py * invSy - 0.5;
  let gz = pz * invSz - 0.5;
  gx = gx < 0 ? 0 : gx > nx - 1 ? nx - 1 : gx;
  gy = gy < 0 ? 0 : gy > ny - 1 ? ny - 1 : gy;
  gz = gz < 0 ? 0 : gz > nz - 1 ? nz - 1 : gz;

  let x0 = nx > 1 ? (gx | 0) : 0;
  let y0 = ny > 1 ? (gy | 0) : 0;
  let z0 = nz > 1 ? (gz | 0) : 0;
  if (x0 > nx - 2) x0 = nx - 2;
  if (y0 > ny - 2) y0 = ny - 2;
  if (z0 > nz - 2) z0 = nz - 2;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (z0 < 0) z0 = 0;
  const fx = nx > 1 ? gx - x0 : 0;
  const fy = ny > 1 ? gy - y0 : 0;
  const fz = nz > 1 ? gz - z0 : 0;
  const x1 = nx > 1 ? x0 + 1 : 0;
  const y1 = ny > 1 ? y0 + 1 : 0;
  const z1 = nz > 1 ? z0 + 1 : 0;

  const s0 = y0 * nx;
  const s1 = y1 * nx;
  const b0 = z0 * nx * ny;
  const b1 = z1 * nx * ny;
  const c000 = values[b0 + s0 + x0];
  const c100 = values[b0 + s0 + x1];
  const c010 = values[b0 + s1 + x0];
  const c110 = values[b0 + s1 + x1];
  const c001 = values[b1 + s0 + x0];
  const c101 = values[b1 + s0 + x1];
  const c011 = values[b1 + s1 + x0];
  const c111 = values[b1 + s1 + x1];

  const c00 = c000 + (c100 - c000) * fx;
  const c10 = c010 + (c110 - c010) * fx;
  const c01 = c001 + (c101 - c001) * fx;
  const c11 = c011 + (c111 - c011) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

/** Trilinearly sample the volume at physical position (x, y, z) in mm. */
export function sampleVolume(volume, x, y, z) {
  const [nx, ny, nz] = volume.dims;
  return trilinear(
    volume.values, nx, ny, nz,
    volume.invSpacing[0], volume.invSpacing[1], volume.invSpacing[2],
    x, y, z
  );
}

/** Physical centre of voxel (ix, iy, iz) in mm. */
export function voxelCenter(volume, ix, iy, iz) {
  return [(ix + 0.5) * volume.spacing[0], (iy + 0.5) * volume.spacing[1], (iz + 0.5) * volume.spacing[2]];
}

// --------------------------------------------------------------------------
// Camera
// --------------------------------------------------------------------------

export function presetView(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`未知视图 ${name}`);
  return { dir: p.dir.slice(), up: p.up.slice(), zoom: 1, pan: [0, 0], preset: name };
}

/** Closest named preset for a view direction, or null when oblique. */
export function matchPreset(view, toleranceDeg = 0.5) {
  const d = vnorm(view.dir);
  const limit = Math.cos((toleranceDeg * Math.PI) / 180);
  for (const name of VIEW_NAMES) {
    if (vdot(d, PRESETS[name].dir) >= limit) return name;
  }
  return null;
}

function rotateVector(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = vdot(axis, v);
  const cr = vcross(axis, v);
  return [
    v[0] * c + cr[0] * s + axis[0] * k * (1 - c),
    v[1] * c + cr[1] * s + axis[1] * k * (1 - c),
    v[2] * c + cr[2] * s + axis[2] * k * (1 - c),
  ];
}

/**
 * Orbit the view: `yawDeg` turns the ray direction around the current screen
 * up axis; `pitchDeg` tilts it around the current screen right axis.  `up` is
 * rotated too, then re-orthogonalised against `dir`, so the basis never
 * degenerates when the pitch approaches ±90°.
 */
export function orbitView(view, yawDeg, pitchDeg) {
  let dir = vnorm(view.dir);
  let up = vnorm(view.up);
  let right = vcross(up, dir);
  if (vlen(right) < 1e-9) {
    right = vcross(Math.abs(dir[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], dir);
  }
  right = vnorm(right);
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  if (yaw !== 0) dir = rotateVector(dir, up, yaw);
  if (pitch !== 0) {
    dir = rotateVector(dir, right, pitch);
    up = rotateVector(up, right, pitch);
  }
  dir = vnorm(dir);
  // Gram-Schmidt: keep up perpendicular to the new direction
  const k = vdot(up, dir);
  up = vnorm([up[0] - dir[0] * k, up[1] - dir[1] * k, up[2] - dir[2] * k]);
  if (vlen(up) < 1e-9) up = vnorm(vcross(dir, [1, 0, 0]));
  return { dir, up, zoom: view.zoom, pan: view.pan.slice(), preset: null, yawDeg: 0, pitchDeg: 0 };
}

/**
 * Everything the ray generator needs for one frame.
 * Returns { dir, right, up, center, halfW, halfH, backoff, pxPerMm }.
 */
export function computeCamera(volume, view, width, height) {
  const dir = vnorm(view.dir);
  let upRaw = view.up;
  if (!Array.isArray(upRaw) || vlen(upRaw) < 1e-9) upRaw = [0, 0, 1];
  let right = vcross(upRaw, dir);
  if (vlen(right) < 1e-9) {
    right = vcross(Math.abs(dir[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], dir);
  }
  right = vnorm(right);
  const up = vnorm(vcross(dir, right));

  const half = vscale(volume.ext, 0.5);
  let maxU = 0;
  let maxV = 0;
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const v = [sx * half[0], sy * half[1], sz * half[2]];
        maxU = Math.max(maxU, Math.abs(vdot(v, right)));
        maxV = Math.max(maxV, Math.abs(vdot(v, up)));
      }
    }
  }
  const zoom = clamp(view.zoom || 1, 0.05, 50);
  const aspect = width / height;
  const k = (FRAME_MARGIN * Math.max(maxU, maxV * aspect) * 2) / Math.max(width, 1) / zoom;
  const halfW = (k * width) / 2;
  const halfH = (k * height) / 2;
  const pan = Array.isArray(view.pan) ? view.pan : [0, 0];
  const center = vadd(half, vadd(vscale(right, pan[0]), vscale(up, pan[1])));
  const backoff = vlen(volume.ext) + 2 * Math.max(halfW, halfH) + 1;
  const depth = 2 * backoff;
  return { dir, right, up, center, halfW, halfH, backoff, depth, pxPerMm: width / (2 * halfW) };
}

/** Continuous image coordinate (fx, fy in [0,1]) → ray. */
export function rayAt(camera, fx, fy) {
  const sx = (fx * 2 - 1) * camera.halfW;
  const sy = (1 - fy * 2) * camera.halfH;
  const base = vadd(camera.center, vadd(vscale(camera.right, sx), vscale(camera.up, sy)));
  return { origin: vsub(base, vscale(camera.dir, camera.backoff)), dir: camera.dir.slice(), base };
}

/** Inverse of rayAt: world point → continuous image coordinates. */
export function projectPoint(camera, p) {
  const d = vsub(p, camera.center);
  const u = vdot(d, camera.right);
  const v = vdot(d, camera.up);
  return [(u / camera.halfW + 1) / 2, (1 - v / camera.halfH) / 2];
}

/** Slab-method ray/box intersection.  Returns [t0, t1]; t1 < t0 means miss. */
export function rayBoxInterval(origin, dir, ext) {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = origin[a];
    const d = dir[a];
    if (Math.abs(d) < 1e-12) {
      if (o < 0 || o > ext[a]) return [0, -1];
    } else {
      let t1 = -o / d;
      let t2 = (ext[a] - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return [0, -1];
    }
  }
  return [tmin, tmax];
}

// --------------------------------------------------------------------------
// Transfer-function lookup table
// --------------------------------------------------------------------------

const TF_LUT_SIZE = 2048;

/**
 * Pre-sample a transfer function into a lookup table over its value span.
 * Composite rendering evaluates millions of samples; a binary search per
 * sample dominated the run time.  Values outside the span clamp to the
 * end stops (matching evalTransfer), and inside, LUT entries are linearly
 * interpolated so the result stays within a fraction of an 8-bit step.
 */
export function buildTransferLut(tf, size = TF_LUT_SIZE) {
  const stops = tf && tf.length ? tf : DEFAULT_TF;
  const lo = stops[0].value;
  const hi = stops[stops.length - 1].value;
  const span = hi - lo;
  const n = Math.max(2, size | 0);
  const rgb = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const value = span > 0 ? lo + (span * i) / (n - 1) : lo;
    const te = evalTransfer(stops, value);
    rgb[i * 3] = te.rgb[0];
    rgb[i * 3 + 1] = te.rgb[1];
    rgb[i * 3 + 2] = te.rgb[2];
    alpha[i] = te.alpha;
  }
  return { lo, hi, span, n, rgb, alpha };
}

/** Transfer-function sample through the LUT (linear interpolation). */
export function evalTransferLut(lut, value, out) {
  const { lo, hi, span, n, rgb, alpha } = lut;
  let f;
  if (span <= 0 || value <= lo) f = 0;
  else if (value >= hi) f = n - 1;
  else f = ((value - lo) / span) * (n - 1);
  let i0 = f | 0;
  if (i0 > n - 2) i0 = n - 2;
  const t = f - i0;
  const i3 = i0 * 3;
  const j3 = i3 + 3;
  out[0] = rgb[i3] + (rgb[j3] - rgb[i3]) * t;
  out[1] = rgb[i3 + 1] + (rgb[j3 + 1] - rgb[i3 + 1]) * t;
  out[2] = rgb[i3 + 2] + (rgb[j3 + 2] - rgb[i3 + 2]) * t;
  out[3] = alpha[i0] + (alpha[i0 + 1] - alpha[i0]) * t;
  return out;
}

// --------------------------------------------------------------------------
// Segment planning
// --------------------------------------------------------------------------

/**
 * Split an interval of length L into segments of at most `step`; the final
 * segment takes the remainder (possibly 0 < last <= step).  L must be > 0.
 */
export function planSegments(L, step) {
  const count = Math.max(1, Math.ceil(L / step - 1e-9));
  const lastLen = count === 1 ? L : L - step * (count - 1);
  return { count, lastLen, lastIsShort: count > 1 && lastLen < step - 1e-9 };
}

/** Opacity of a segment of length lenMm for a per-refMm alpha. */
export function segmentAlpha(alphaPerMm, lenMm, refMm = DEFAULT_REF_MM) {
  if (!(alphaPerMm > 0)) return 0;
  if (alphaPerMm >= 1) return 1;
  if (lenMm === refMm) return alphaPerMm;
  return 1 - Math.pow(1 - alphaPerMm, lenMm / refMm);
}

// --------------------------------------------------------------------------
// Ray integration
// --------------------------------------------------------------------------

/**
 * Integrate one ray and return the full per-sample trace.  Used by the unit
 * tests, the click-to-probe readout and the composite/MIP reference path.
 */
export function traceRay(volume, origin, dir, opts) {
  const step = clamp(Number(opts.step) || 1, STEP_MIN, STEP_MAX);
  const refMm = opts.refMm > 0 ? opts.refMm : DEFAULT_REF_MM;
  const tf = opts.tf && opts.tf.length ? opts.tf : DEFAULT_TF;
  const mode = opts.mode === 'mip' ? 'mip' : 'composite';
  const window = opts.window || DEFAULT_WINDOW;
  const [t0, t1] = rayBoxInterval(origin, dir, volume.ext);
  const hit = t1 > t0;
  const lengthMm = hit ? t1 - t0 : 0;
  const samples = [];
  let alpha = 0;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let maxValue = -Infinity;
  let maxSample = -1;
  const plan = hit ? planSegments(lengthMm, step) : { count: 0, lastLen: 0 };

  for (let s = 0; s < plan.count; s++) {
    const len = plan.count === 1 ? lengthMm : s === plan.count - 1 ? plan.lastLen : step;
    const t = t0 + s * step + len / 2;
    const p = vadd(origin, vscale(dir, t));
    const value = sampleVolume(volume, p[0], p[1], p[2]);
    const entry = { index: s, t, pos: p, lengthMm: len, value };
    if (mode === 'mip') {
      if (value > maxValue) { maxValue = value; maxSample = s; }
    } else {
      const te = evalTransfer(tf, value);
      const aSeg = segmentAlpha(te.alpha, len, refMm);
      const w = (1 - alpha) * aSeg;
      entry.alphaPerMm = te.alpha;
      entry.rgbLinear = te.rgb;
      entry.alphaSeg = aSeg;
      entry.alphaBefore = alpha;
      entry.weight = w;
      cr += te.rgb[0] * w;
      cg += te.rgb[1] * w;
      cb += te.rgb[2] * w;
      alpha += w;
      entry.alphaAfter = alpha;
    }
    samples.push(entry);
    if (mode === 'composite' && alpha >= 1 - 1e-12) { alpha = 1; break; }
  }

  let final;
  if (!hit) {
    final = { mode, alpha: 0, linear: [0, 0, 0], rgba8: [0, 0, 0, 0], hit: false };
  } else if (mode === 'mip') {
    const gray = windowToGray8(maxValue, window);
    final = {
      mode: 'mip',
      value: maxValue,
      valueSample: maxSample,
      gray8: gray,
      rgba8: [gray, gray, gray, 255],
      alpha: 1,
      linear: [gray / 255, gray / 255, gray / 255],
      hit: true,
    };
  } else {
    const lin = alpha > 0 ? [cr / alpha, cg / alpha, cb / alpha] : [0, 0, 0];
    final = {
      mode: 'composite',
      alpha,
      linear: lin,
      premulLinear: [cr, cg, cb],
      rgba8: encodeSrgbRgba(lin, alpha),
      hit: true,
    };
  }

  return {
    hit,
    mode,
    t0,
    t1,
    entry: hit ? vadd(origin, vscale(dir, t0)) : null,
    exit: hit ? vadd(origin, vscale(dir, t1)) : null,
    lengthMm,
    step,
    refMm,
    segmentCount: plan.count,
    lastSegmentMm: plan.lastLen,
    samples,
    final,
    maxValue: Number.isFinite(maxValue) ? maxValue : null,
  };
}

/**
 * Render rows [rowStart, rowEnd) of a frame into `target` (Uint8ClampedArray
 * RGBA, straight alpha, sRGB).  Splitting the frame into bands lets the worker
 * yield to new messages and abandon stale jobs.
 */
export function renderRows(volume, camera, width, height, rowStart, rowEnd, opts, target) {
  const img = target || new Uint8ClampedArray(width * height * 4);
  const { mode, step, tf, refMm, window } = opts;
  const [nx, ny, nz] = volume.dims;
  const values = volume.values;
  const invSx = volume.invSpacing[0];
  const invSy = volume.invSpacing[1];
  const invSz = volume.invSpacing[2];
  const ext = volume.ext;
  const dir = camera.dir;
  const stepLen = clamp(Number(step) || 1, STEP_MIN, STEP_MAX);
  const ref = refMm > 0 ? refMm : DEFAULT_REF_MM;
  const isMip = mode === 'mip';
  const [winLo, winHi] = window || DEFAULT_WINDOW;
  const winSpan = winHi - winLo;
  const stops = tf && tf.length ? tf : DEFAULT_TF;
  const lut = isMip ? null : buildTransferLut(stops);
  const tfSample = [0, 0, 0, 0];
  // Last (alpha, length) → segment opacity.  Inside a single material most
  // consecutive samples repeat the same values, so one slot avoids nearly all
  // pow() calls at a cost of two comparisons.
  let cacheAlpha = -1;
  let cacheLen = -1;
  let cacheSeg = 0;
  const cx = camera.center[0]; const cy = camera.center[1]; const cz = camera.center[2];
  const rx = camera.right[0]; const ry = camera.right[1]; const rz = camera.right[2];
  const ux = camera.up[0]; const uy = camera.up[1]; const uz = camera.up[2];
  const dx = dir[0]; const dy = dir[1]; const dz = dir[2];
  const backoff = camera.backoff;
  const halfW = camera.halfW;
  const halfH = camera.halfH;
  const start = Math.max(0, rowStart | 0);
  const end = Math.min(height, rowEnd | 0);

  for (let j = start; j < end; j++) {
    const sy = (1 - (j + 0.5) / height * 2) * halfH;
    const baseX = cx + ux * sy - dx * backoff;
    const baseY = cy + uy * sy - dy * backoff;
    const baseZ = cz + uz * sy - dz * backoff;
    let outIdx = j * width * 4;
    for (let i = 0; i < width; i++) {
      const sx = ((i + 0.5) / width * 2 - 1) * halfW;
      const ox = baseX + rx * sx;
      const oy = baseY + ry * sx;
      const oz = baseZ + rz * sx;

      let tmin = -Infinity;
      let tmax = Infinity;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? ox : a === 1 ? oy : oz;
        const d = a === 0 ? dx : a === 1 ? dy : dz;
        if (Math.abs(d) < 1e-12) {
          if (o < 0 || o > ext[a]) { miss = true; break; }
        } else {
          let ta = -o / d;
          let tb = (ext[a] - o) / d;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          if (ta > tmin) tmin = ta;
          if (tb < tmax) tmax = tb;
          if (tmin > tmax) { miss = true; break; }
        }
      }
      if (miss || !(tmax > tmin)) { outIdx += 4; continue; }

      const L = tmax - tmin;
      const count = Math.max(1, Math.ceil(L / stepLen - 1e-9));
      const lastLen = count === 1 ? L : L - stepLen * (count - 1);

      if (isMip) {
        let best = -Infinity;
        for (let s = 0; s < count; s++) {
          const len = s === count - 1 ? lastLen : stepLen;
          const t = tmin + s * stepLen + len / 2;
          const v = trilinear(
            values, nx, ny, nz, invSx, invSy, invSz,
            ox + dx * t, oy + dy * t, oz + dz * t
          );
          if (v > best) best = v;
        }
        const g = winSpan > 0 ? clamp((best - winLo) / winSpan, 0, 1) : 0;
        const g8 = Math.round(g * 255);
        img[outIdx++] = g8;
        img[outIdx++] = g8;
        img[outIdx++] = g8;
        img[outIdx++] = 255;
      } else {
        let A = 0;
        let CR = 0;
        let CG = 0;
        let CB = 0;
        for (let s = 0; s < count; s++) {
          const len = s === count - 1 ? lastLen : stepLen;
          const t = tmin + s * stepLen + len / 2;
          const v = trilinear(
            values, nx, ny, nz, invSx, invSy, invSz,
            ox + dx * t, oy + dy * t, oz + dz * t
          );
          evalTransferLut(lut, v, tfSample);
          const aPerMm = tfSample[3];
          if (aPerMm <= 0) continue;
          let aSeg;
          if (aPerMm >= 1) {
            aSeg = 1;
          } else if (len === stepLen && aPerMm === cacheAlpha) {
            // Memoise only full-length segments: their opacity depends solely
            // on the per-mm alpha, and inside one material consecutive samples
            // repeat it.  Any other segment length (in particular the short
            // tail) is always recomputed, even if it happens to equal a
            // previously cached length.
            if (cacheLen !== -1 && cacheAlpha === aPerMm) {
              aSeg = cacheSeg;
            } else {
              aSeg = 1 - Math.pow(1 - aPerMm, len / ref);
              cacheAlpha = aPerMm;
              cacheLen = len;
              cacheSeg = aSeg;
            }
          } else {
            aSeg = 1 - Math.pow(1 - aPerMm, len / ref);
          }
          const w = (1 - A) * aSeg;
          if (w <= 0) continue;
          CR += tfSample[0] * w;
          CG += tfSample[1] * w;
          CB += tfSample[2] * w;
          A += w;
          if (A >= 0.999999) { A = 1; break; }
        }
        if (A <= 0) { outIdx += 4; continue; }
        img[outIdx++] = Math.round(linearToSrgb(CR / A) * 255);
        img[outIdx++] = Math.round(linearToSrgb(CG / A) * 255);
        img[outIdx++] = Math.round(linearToSrgb(CB / A) * 255);
        img[outIdx++] = Math.round(clamp(A, 0, 1) * 255);
      }
    }
  }
  return img;
}

/**
 * Render a full frame.  Returns Uint8ClampedArray RGBA (straight alpha, sRGB).
 * `onProgress(fraction, rowsDone)` is called periodically.
 */
export function renderImage(params) {
  const { volume, camera, width, height, onProgress } = params;
  const img = new Uint8ClampedArray(width * height * 4);
  const band = Math.max(1, Math.floor(height / 50));
  for (let row = 0; row < height; row += band) {
    const stop = Math.min(height, row + band);
    renderRows(volume, camera, width, height, row, stop, params, img);
    if (onProgress) onProgress(stop / height, stop);
  }
  return img;
}

// --------------------------------------------------------------------------
// Data signatures (for settings round-trips)
// --------------------------------------------------------------------------

export function fnv1aHex(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
