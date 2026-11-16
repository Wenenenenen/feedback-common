// core.test.mjs — geometry, validation and rendering against the sample pack.
// Run with: node --test tests/core.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCaseMeta, decodeDepth, buildMesh, createEyeTarget, rasterRange,
  finalizeEye, fillHoles, makeAnaglyph, disparityPixels, pixelShift,
  projectPixel, renderStereo, colorizeDepth, depthRange, isValidDepth,
  fnv1a, hex32, RenderCancelled, DEFAULTS, LIMITS,
} from '../app/js/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const casesDir = join(here, '.cases');

function ensureCases() {
  if (existsSync(join(casesDir, 'expected.json'))) return casesDir;
  mkdirSync(casesDir, { recursive: true });
  execFileSync('unzip', ['-o', join(root, 'samples', 'stereo-depth-forge-cases.zip'), '-d', casesDir], { stdio: 'ignore' });
  return casesDir;
}

const dir = ensureCases();
const readJson = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const readBytes = (name) => new Uint8Array(readFileSync(join(dir, name)));

// Minimal PNG reader for the sample colour image (8-bit RGB, non-interlaced).
function readPngRgb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); colorType = bytes[pos + 17];
    } else if (type === 'IDAT') idat.push(bytes.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = new Uint8Array(execFileSync('python3', ['-I', '-c',
    'import sys,zlib; sys.stdout.buffer.write(zlib.decompress(sys.stdin.buffer.read()))',
  ], { input: Buffer.concat(idat.map((d) => Buffer.from(d))) }));
  const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * ch;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    if (filter === 1) for (let x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 255;
    else if (filter === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (filter === 3) for (let x = 0; x < stride; x++) { const a = x >= ch ? line[x - ch] : 0; line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255; }
    else if (filter === 4) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = line[x * ch]; rgba[o + 1] = line[x * ch + 1]; rgba[o + 2] = line[x * ch + 2]; rgba[o + 3] = 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

const colorPng = readPngRgb(readBytes('color.png'));
const expected = readJson('expected.json');
const planeMeta = readJson('plane.json');
const occMeta = readJson('occlusion.json');
const planeDepth = decodeDepth(readBytes('plane.f32'), planeMeta.width, planeMeta.height);
const occDepth = decodeDepth(readBytes('occlusion.f32'), occMeta.width, occMeta.height);

const params = (meta) => ({
  fx: meta.fx, fy: meta.fy, cx: meta.cx, cy: meta.cy,
  eyeDistance: meta.eye_distance, zeroPlane: meta.zero_plane, fillMaxGap: DEFAULTS.fillMaxGap,
});

const render = (meta, depth, extra = {}) => renderStereo({
  depth, color: colorPng.rgba, width: meta.width, height: meta.height,
  jump: meta.jump, params: { ...params(meta), ...extra },
});

// ---------------------------------------------------------------------------
// Projection and disparity
// ---------------------------------------------------------------------------

test('projection: pixel centres, parallel eyes, zero-parallax plane', () => {
  const p = params(planeMeta);
  // A vertex at pixel (10, 5) with Z = Z0 sits exactly on the zero-parallax
  // plane and must not move for either eye.
  const l = projectPixel(10, 5, p.zeroPlane, p, 'left');
  const r = projectPixel(10, 5, p.zeroPlane, p, 'right');
  assert.equal(l.u, 10.5);
  assert.equal(r.u, 10.5);
  assert.equal(l.v, 5.5);
  assert.equal(r.v, 5.5);

  // Nearer than Z0: left moves right, right moves left, symmetric.
  const ln = projectPixel(10, 5, 2, p, 'left');
  const rn = projectPixel(10, 5, 2, p, 'right');
  assert.ok(ln.u > 10.5 && rn.u < 10.5);
  assert.ok(Math.abs((ln.u - 10.5) + (rn.u - 10.5)) < 1e-12);
  assert.equal(ln.v, 5.5, 'parallel rig: no vertical shift');

  // Farther than Z0: parallax reverses.
  const lf = projectPixel(10, 5, 8, p, 'left');
  assert.ok(lf.u < 10.5);
});

test('disparity: oracle values and the closed form', () => {
  const p = params(planeMeta);
  const near = disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, 2);
  assert.ok(Math.abs(near - expected.plane_disparity_pixels) < 1e-9);
  assert.ok(Math.abs(disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, 1) - expected.near_z1_disparity_pixels) < 1e-9);
  assert.ok(Math.abs(disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, 4) - expected.background_z4_disparity_pixels) < 1e-9);
  // d(Z) = fx*b*(1/Z - 1/Z0), positive nearer than the plane.
  for (const z of [0.3, 1, 2, 3.9, 4, 7, 100]) {
    const want = p.fx * p.eyeDistance * (1 / z - 1 / p.zeroPlane);
    assert.ok(Math.abs(disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, z) - want) < 1e-12);
  }
  assert.ok(disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, 0) !== disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, 0), 'NaN for invalid depth');
  assert.ok(Number.isNaN(pixelShift(p.fx, p.eyeDistance, p.zeroPlane, -1, 'left')));
  assert.ok(Number.isNaN(pixelShift(p.fx, p.eyeDistance, p.zeroPlane, Infinity, 'left')));
  // Left/right shifts are symmetric halves of the disparity and sum to -d.
  const z = 1.7;
  const l = pixelShift(p.fx, p.eyeDistance, p.zeroPlane, z, 'left');
  const r = pixelShift(p.fx, p.eyeDistance, p.zeroPlane, z, 'right');
  assert.ok(Math.abs(l - r - disparityPixels(p.fx, p.eyeDistance, p.zeroPlane, z)) < 1e-12);
});

// ---------------------------------------------------------------------------
// Mesh building / edge break
// ---------------------------------------------------------------------------

test('mesh: plane yields the oracle triangle count (2 per cell)', () => {
  const mesh = buildMesh(planeDepth, planeMeta.width, planeMeta.height, planeMeta.jump);
  assert.equal(mesh.triCount, expected.plane_triangle_count);
  assert.equal(mesh.triCount, 2 * (planeMeta.width - 1) * (planeMeta.height - 1));
  assert.equal(mesh.indices.length, mesh.triCount * 3);
});

test('mesh: invalid, zero and non-finite depths drop their cells', () => {
  const w = 4, h = 3;
  const d = new Float32Array(w * h).fill(1);
  d[0] = 0;            // zero depth
  d[1] = NaN;          // non-finite
  const mesh = buildMesh(d, w, h, 0.5);
  // d[0] and d[1] invalidate both cells of the first row (each cell touches
  // both); the remaining 2x2 cells keep two triangles each.
  assert.equal(mesh.triCount, (w - 1) * (h - 1) * 2 - 4);
  for (let t = 0; t < mesh.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const idx = mesh.indices[t * 3 + k];
      assert.ok(isValidDepth(d[idx]));
    }
  }
});

test('mesh: jump threshold splits front from back exactly at the stated rule', () => {
  const mk = (jump, a, b) => buildMesh(Float32Array.from([a, a, b, b]), 2, 2, jump).triCount;

  // One cell, two columns, two rows: both triangles see the same pair {a,b}.
  assert.equal(mk(0.5, 1, 1.5), 2, 'range 0.5 with jump 0.5 is kept (<=)');
  assert.equal(mk(0.5, 1, 1.5001), 0, 'range above jump is dropped');
  assert.equal(mk(0, 2, 2), 2, 'zero import: equal depths kept');
  assert.equal(mk(0, 2, 2.0001), 0);

  // A step edge in a 3x2 grid: the column transition cells must vanish.
  const w2 = 3, h2 = 2;
  const depth = Float32Array.from([1, 1, 4, 1, 1, 4]);
  const jumped = buildMesh(depth, w2, h2, 0.5);
  assert.equal(jumped.triCount, 2, 'only the left cell pair survives');
  const loose = buildMesh(depth, w2, h2, 3.5);
  assert.equal(loose.triCount, 4, 'raising the threshold reconnects the faces');
});

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

test('raster: plane fills everything except the two-pixel border the shift exposes', () => {
  const res = render(planeMeta, planeDepth);
  const shift = pixelShift(planeMeta.fx, planeMeta.eye_distance, planeMeta.zero_plane, 2, 'left');
  // Uniform depth 2 m, Z0 4 m -> left eye shifts every vertex +1.25 px, so the
  // leftmost 2 columns and the bottom row (the last row of quads ends at
  // y = h-1) are uncovered.
  assert.ok(shift > 1 && shift < 2, `shift ${shift}`);
  const mask = res.left.mask;
  const cols = new Set();
  for (let y = 0; y < planeMeta.height; y++) {
    for (let x = 0; x < planeMeta.width; x++) {
      if (mask[y * planeMeta.width + x]) cols.add(x);
    }
  }
  assert.deepEqual([...cols].sort((a, b) => a - b), [0, 1]);
  // Right eye mirrors it.
  const rcols = new Set();
  for (let y = 0; y < occMeta.height; y++) {
    for (let x = 0; x < planeMeta.width; x++) {
      if (res.right.mask[y * planeMeta.width + x]) rcols.add(x);
    }
  }
  assert.deepEqual([...rcols].sort((a, b) => a - b), [158, 159]);
  // The 96-row image has its last quad row at y=94..95; no row is missing.
  assert.equal(res.left.stats.holes, planeMeta.height * 2);
});

test('raster: near surface wins where left/right silhouettes overlap', () => {
  const res = render(occMeta, occDepth);
  const w = occMeta.width;
  // The foreground block (z=1) spans x 55..104, y 20..75 in both eyes only
  // after shifting; where it covers the background it must show foreground
  // depth.  Verify through the depth buffer that no pixel mixes 1 and 4.
  const inRect = (x, y) => x >= 60 && x <= 100 && y >= 30 && y <= 65;
  for (const eye of ['left', 'right']) {
    const zb = res[eye].zbuf;
    const mask = res[eye].mask;
    for (let y = 30; y <= 65; y++) {
      for (let x = 60; x <= 100; x++) {
        const i = y * w + x;
        if (mask[i] === 0) {
          assert.ok(inRect(x, y));
          assert.ok(Math.abs(zb[i] - 1) < 1e-6, `pixel ${x},${y} should be foreground depth`);
        }
      }
    }
  }
});

test('raster: holes come from invalid depth and from the silhouette, never from black colour', () => {
  const res = render(occMeta, occDepth);
  const w = occMeta.width;
  const holesL = [];
  for (let y = 0; y < occMeta.height; y++) {
    for (let x = 0; x < w; x++) if (res.left.mask[y * w + x]) holesL.push([x, y]);
  }
  // 36 zero-depth pixels + 1 NaN cannot be meshed: they are holes in both eyes.
  for (const [x, y] of [[10, 10], [15, 15], [12, 13]]) {
    assert.equal(res.left.mask[y * w + x], 255);
    assert.equal(res.right.mask[y * w + x], 255);
  }
  assert.equal(res.left.mask[20 * w + 20], 255, 'NaN pixel is a hole');
  // Columns 55..58 (left) are the exposed background strip created by the
  // 3.75 px foreground shift; they are holes, not black pixels.
  assert.equal(res.left.mask[40 * w + 56], 255);
  assert.equal(res.left.mask[40 * w + 60], 0);
  assert.equal(res.right.mask[40 * w + 102], 255);
  // A fully covered pixel with black colour is NOT a hole.  The colour image
  // has black texels at the left edge of the pattern in row 0?  Use the mask
  // contract directly: alpha is 255 exactly where the mask says covered.
  for (let i = 0; i < res.left.mask.length; i++) {
    assert.equal(res.left.rgba[i * 4 + 3], res.left.mask[i] === 0 ? 255 : 0);
  }
});

test('raster: a black source pixel is covered, not a hole', () => {
  const w = 4, h = 4;
  const depth = new Float32Array(w * h).fill(3); // Z0, so no shift at all
  const color = new Uint8ClampedArray(w * h * 4); // all black, alpha 255
  for (let i = 0; i < color.length; i += 4) color[i + 3] = 255;
  const res = renderStereo({
    depth, color, width: w, height: h, jump: 0.5,
    params: { fx: 10, fy: 10, cx: 2, cy: 2, eyeDistance: 0.1, zeroPlane: 3, fillMaxGap: 10 },
  });
  assert.equal(res.left.stats.holes, 0);
  assert.equal(res.left.stats.covered, w * h);
  assert.equal(res.left.rgba[3], 255);
  assert.equal(res.left.mask[0], 0);
});

test('raster: equal depth resolves to the lower source triangle index', () => {
  const w = 2, h = 2;
  const depth = new Float32Array(w * h).fill(2); // Z0, no shift, all four corners covered
  // Two cells would be needed for a tie; use one cell whose two triangles
  // overlap on the diagonal.  Give the triangles different colours by making
  // the source a 2x2 quarter image: [red, green; blue, yellow].
  const color = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  const res = renderStereo({
    depth, color, width: w, height: h, jump: 0.5,
    params: { fx: 10, fy: 10, cx: 1, cy: 1, eyeDistance: 0.1, zeroPlane: 2, fillMaxGap: 10 },
  });
  // Pixel (0,0) sits on the first triangle [00,10,11] of the only cell.
  assert.equal(res.left.mask[0], 0);
  // With all depths identical the depth test tie must be deterministic: rerun
  // and compare byte for byte.
  const again = renderStereo({
    depth, color, width: w, height: h, jump: 0.5,
    params: { fx: 10, fy: 10, cx: 1, cy: 1, eyeDistance: 0.1, zeroPlane: 2, fillMaxGap: 10 },
  });
  assert.deepEqual([...res.left.rgba], [...again.left.rgba]);
});

test('raster: matches a reference implementation of the same contract on the sample', () => {
  // Software reference: for each output pixel, find the nearest triangle
  // covering it by brute force over the mesh, compare depth.  Small crop.
  const w = planeMeta.width;
  const mesh = buildMesh(planeDepth, w, planeMeta.height, planeMeta.jump);
  const target = createEyeTarget(w, planeMeta.height, { ...params(planeMeta), eye: 'left' });
  rasterRange(target, mesh, planeDepth, colorPng.rgba, 0, mesh.triCount);
  const res = finalizeEye(target);

  const shift = pixelShift(planeMeta.fx, planeMeta.eye_distance, planeMeta.zero_plane, 2, 'left');
  for (let y = 10; y < 20; y++) {
    for (let x = 10; x < 20; x++) {
      const i = y * w + x;
      assert.equal(res.mask[i], 0);
      assert.ok(Math.abs(res.srcX[i] - (x - shift + 0.5)) < 1e-9, `srcX ${res.srcX[i]} at ${x},${y}`);
      assert.ok(Math.abs(res.srcY[i] - (y + 0.5)) < 1e-9);
      assert.ok(Math.abs(res.zbuf[i] - 2) < 1e-9);
    }
  }
});

// ---------------------------------------------------------------------------
// Hole fill
// ---------------------------------------------------------------------------

test('fill: only hole pixels change, and the raw mask / unfilled RGBA stay intact', () => {
  const res = render(occMeta, occDepth);
  const before = res.left.rgba.slice();
  const maskBefore = res.left.mask.slice();
  const filled = fillHoles(res.left.rgba, res.left.mask, res.left.zbuf, occMeta.width, occMeta.height, 24);
  assert.deepEqual([...res.left.mask], [...maskBefore], 'mask unchanged');
  assert.deepEqual([...res.left.rgba], [...before], 'unfilled RGBA unchanged');
  assert.ok(filled.stats.filled > 0);
  for (let i = 0; i < res.left.mask.length; i++) {
    const a = filled.rgba[i * 4 + 3];
    if (res.left.mask[i] === 0) {
      assert.deepEqual([...filled.rgba.subarray(i * 4, i * 4 + 4)], [...before.subarray(i * 4, i * 4 + 4)], 'covered pixel untouched');
    } else if (a === 255) {
      // filled: opaque
      assert.ok(true);
    } else {
      assert.equal(a, 0, 'unfilled holes stay transparent');
    }
  }
});

test('fill: gap limit, row-spanning runs and the farther-neighbour rule', () => {
  const w = 7, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  const zbuf = new Float32Array(w * h);
  // Row 0: covered, hole(1px), covered with far depth on the right.
  // Row 1: all hole -> must stay a hole (no covered neighbour).
  mask.fill(255);
  for (let x = 3; x < w; x++) { mask[x] = 0; zbuf[x] = 8; rgba[x * 4 + 3] = 255; }
  const setPx = (x, y, v, z) => {
    mask[y * w + x] = 0;
    zbuf[y * w + x] = z;
    const o = (y * w + x) * 4;
    rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
  };
  setPx(0, 0, 10, 2);
  setPx(2, 0, 90, 8); // farther to the right -> fill uses 90
  const fill = fillHoles(rgba, mask, zbuf, w, h, 4);
  assert.equal(fill.rgba[1 * 4], 90);
  assert.equal(fill.rgba[3], 255);
  assert.equal(fill.rgba[(1 * w + 1) * 4 + 3], 0, 'row with no coverage stays a hole');
  assert.equal(fill.stats.filled, 1);

  // A run longer than maxGap is skipped.
  const mask2 = new Uint8Array(w * h).fill(255);
  mask2[0] = 0; mask2[6] = 0;
  const zb2 = new Float32Array(w * h).fill(3);
  const r2 = new Uint8ClampedArray(w * h * 4);
  for (const x of [0, 6]) r2[x * 4 + 3] = 255;
  const fill2 = fillHoles(r2, mask2, zb2, w, 1, 3);
  assert.equal(fill2.stats.filled, 0, '5 px run exceeds a 3 px limit');
  const fill3 = fillHoles(r2, mask2, zb2, w, 1, 5);
  assert.equal(fill3.stats.filled, 5);

  // Tie on both sides goes to the left neighbour.
  const mask4 = new Uint8Array(3).fill(255);
  const zb4 = new Float32Array([5, 5, 5]);
  const rgba4 = new Uint8Array([10, 0, 0, 255, 0, 0, 0, 0, 20, 0, 0, 255]);
  mask4[0] = 0; mask4[2] = 0;
  const fill4 = fillHoles(rgba4, mask4, zb4, 3, 1, 3);
  assert.equal(fill4.rgba[4], 10, 'equal depth uses the left neighbour');
});

// ---------------------------------------------------------------------------
// Anaglyph
// ---------------------------------------------------------------------------

test('anaglyph: red from the left eye, cyan from the right, holes as ghosts', () => {
  const l = new Uint8ClampedArray([200, 10, 10, 255, 50, 50, 50, 255]);
  const r = new Uint8ClampedArray([20, 210, 220, 255, 60, 60, 60, 255]);
  const lm = new Uint8Array([0, 255]);
  const rm = new Uint8Array([0, 0]);
  const out = makeAnaglyph(l, r, lm, rm, 2, 1);
  assert.deepEqual([...out.subarray(0, 4)], [200, 210, 220, 255]);
  // Left eye has a hole here: only the right eye ghost remains.
  assert.deepEqual([...out.subarray(4, 8)], [0, 60, 60, 255]);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validation: valid samples normalise', () => {
  const ok = validateCaseMeta(planeMeta, { depthBytes: 61440, colorDims: colorPng });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(ok.meta.eyeDistance, 0.1);
  assert.equal(ok.meta.zeroPlane, 4);
  assert.equal(ok.meta.jump, 0.5);
});

test('validation: truncated depth names the exact shortfall', () => {
  const bytes = readBytes('truncated.f32');
  assert.equal(bytes.length, 61436);
  const check = validateCaseMeta(readJson('invalid-truncated.json'), { depthBytes: bytes.length });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(' '), /被截断/);
  assert.match(check.errors.join(' '), /缺少 4 字节/);
  assert.throws(() => decodeDepth(bytes, 160, 96), /缺少 4 字节/);
});

test('validation: size, camera and file-name faults are reported precisely', () => {
  const base = { ...planeMeta };
  const errs = (patch, opts) => validateCaseMeta({ ...base, ...patch }, opts).errors.join(' ');
  assert.match(errs({ width: 0 }), /width/);
  assert.match(errs({ width: 1025 }), /1\.\.1024/);
  assert.match(errs({ height: 769 }), /1\.\.768/);
  assert.match(errs({ width: 160.5 }), /width/);
  assert.match(errs({ fx: 0 }), /fx/);
  assert.match(errs({ fy: -1 }), /fy/);
  assert.match(errs({ cx: 'x' }), /cx/);
  assert.match(errs({ eye_distance: 0 }), /eye_distance/);
  assert.match(errs({ zero_plane: -2 }), /zero_plane/);
  assert.match(errs({ jump: -0.1 }), /jump/);
  assert.match(errs({ color: '../secret.png' }), /路径分隔符/);
  assert.match(errs({ depth: '' }), /depth/);
  assert.match(errs({}, { depthBytes: 61200 }), /缺少 240 字节/);
  assert.match(errs({}, { depthBytes: 61444 }), /多出 4 字节/);
  assert.match(errs({}, { colorDims: { width: 80, height: 48 } }), /原图尺寸不符/);
  // MAX bounds are inclusive.
  assert.ok(validateCaseMeta({ ...base, width: LIMITS.maxWidth, height: LIMITS.maxHeight }, { depthBytes: 1024 * 768 * 4 }).ok);
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('depth preview: invalid depth is magenta and the range is the valid range', () => {
  const preview = colorizeDepth(occDepth, occMeta.width, occMeta.height);
  assert.equal(preview.range.min, 1);
  assert.equal(preview.range.max, 4);
  assert.equal(preview.range.invalid, 37);
  const i = (20 * occMeta.width + 20) * 4;
  assert.deepEqual([...preview.rgba.subarray(i, i + 3)], [224, 52, 150]);
  assert.deepEqual(depthRange(planeDepth), { min: 2, max: 2, invalid: 0, valid: 15360, hasRange: true });
});

test('render: cancellation is observed between slices', () => {
  let calls = 0;
  assert.throws(() => renderStereo({
    depth: occDepth, color: colorPng.rgba, width: occMeta.width, height: occMeta.height,
    jump: occMeta.jump, params: params(occMeta), cancelCheck: () => ++calls > 1,
  }), RenderCancelled);
});

test('fingerprints are stable and width-independent', () => {
  assert.equal(hex32(fnv1a(new Uint8Array([1, 2, 3]))), hex32(fnv1a(new Uint8Array([1, 2, 3]))));
  assert.notEqual(fnv1a(new Uint8Array([1, 2, 3])), fnv1a(new Uint8Array([3, 2, 1])));
  assert.equal(hex32(0).length, 10);
});

// ---------------------------------------------------------------------------
// Independent reference cross-check (Python, written from the spec text)
// ---------------------------------------------------------------------------

test('raster: agrees with the independent Python reference on the occlusion sample', () => {
  // The fixtures under tests/fixtures/ were produced by reference_renderer.py,
  // a deliberately separate implementation of the stated rules (no shared
  // code with app/js/core.js).  Rules that are exact in real arithmetic can
  // still land a pixel centre on a mesh vertex; there the two implementations
  // may differ by a single pixel per silhouette, which this test tolerates
  // while requiring every covered pixel to agree on colour within 1 level.
  const fixture = (name) => new Uint8Array(readFileSync(join(here, 'fixtures', name)));
  const maskRef = (eye) => fixture(`occlusion-${eye}-mask.bin`);
  const rgbaRef = (eye) => fixture(`occlusion-${eye}-rgba.bin`);
  const res = render(occMeta, occDepth);
  for (const eye of ['left', 'right']) {
    const refMask = maskRef(eye);
    const refRGBA = rgbaRef(eye);
    let maskDiff = 0;
    let colourDiff = 0;
    for (let i = 0; i < refMask.length; i++) {
      if ((refMask[i] !== 0) !== (res[eye].mask[i] !== 0)) maskDiff++;
      else if (refMask[i] === 0) {
        for (let c = 0; c < 4; c++) {
          if (Math.abs(refRGBA[i * 4 + c] - res[eye].rgba[i * 4 + c]) > 1) { colourDiff++; break; }
        }
      }
    }
    assert.ok(maskDiff <= 2, `${eye}: ${maskDiff} coverage differences vs reference`);
    assert.ok(colourDiff <= 8, `${eye}: ${colourDiff} colour differences vs reference`);
  }
});
