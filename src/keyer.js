// Chroma-key matte extraction + polygon overrides + despill.
// All math runs in linear-light space on 8-bit sRGB input; the same code
// serves interactive preview and ZIP export.

import { srgbToLinear, linearToSrgbByte, makeSrgbToLinearLut, makeLinearToSrgbLut } from './color.js';

const LUT_S2L = makeSrgbToLinearLut();
const LUT_L2S = makeLinearToSrgbLut();

// Point-in-polygon by pixel-center sampling (ray casting).
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Rasterize polygon lists into byte masks. Pixel centers (x+0.5, y+0.5) are
// sampled so an integer-coordinate polygon covers exactly (width x height) px.
export function rasterizePolygons(width, height, polygons) {
  const mask = new Uint8Array(width * height);
  if (!polygons || polygons.length === 0) return mask;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      for (const poly of polygons) {
        if (poly.length >= 3 && pointInPolygon(px, py, poly)) {
          mask[y * width + x] = 1;
          break;
        }
      }
    }
  }
  return mask;
}

// Separable box blur for a float matte. radius is in pixels (0 disables).
// Edge softness only reshapes transitional alpha; 0 and 1 values stay clamped.
export function boxBlurMatte(matte, width, height, radius) {
  if (!radius || radius <= 0) return matte;
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return matte;
  const tmp = new Float32Array(matte.length);
  const out = new Float32Array(matte.length);
  // horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += matte[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      const xOut = Math.min(width - 1, Math.max(0, x - r));
      const xIn = Math.min(width - 1, Math.max(0, x + r + 1));
      sum += matte[row + xIn] - matte[row + xOut];
    }
  }
  // vertical
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / (2 * r + 1);
      const yOut = Math.min(height - 1, Math.max(0, y - r));
      const yIn = Math.min(height - 1, Math.max(0, y + r + 1));
      sum += tmp[yIn * width + x] - tmp[yOut * width + x];
    }
  }
  return out;
}

// Greenness distance: how much the green channel dominates the strongest
// non-green channel, measured in linear light. Key color defines the distance
// treated as "fully background".
function greenness(r, g, b) {
  return g - Math.max(r, b);
}

// Build a float32 matte (0..1) for an 8-bit RGB sRGB frame.
// params: { keyColor:[r,g,b] sRGB bytes, inner, outer, softness,
//           protectPolygons:[], removePolygons:[] }
// inner/outer are absolute greenness thresholds in linear light:
//   greenness <= inner  -> alpha 1 (foreground)
//   greenness >= outer  -> alpha 0 (background)
//   between them        -> linear ramp
// outer is clamped to the sampled key color's own greenness.
// Rasterize the sequence-wide polygon masks once. Remove wins over protect at
// apply time. Returns null masks when no polygons are defined.
export function buildPolygonMasks(width, height, params) {
  const protectMask = rasterizePolygons(width, height, params.protectPolygons);
  const removeMask = rasterizePolygons(width, height, params.removePolygons);
  return { protectMask, removeMask };
}

export function computeMatte(rgb, width, height, params, masks) {
  const { keyColor, inner = 0.01, outer = 0.63, softness = 0 } = params;
  const kr = LUT_S2L[keyColor[0]];
  const kg = LUT_S2L[keyColor[1]];
  const kb = LUT_S2L[keyColor[2]];
  // A non-green picked color would invert the ramp; fall back to a sane floor.
  const keyGreenness = Math.max(0.05, greenness(kr, kg, kb));
  const dOuter = Math.min(outer, keyGreenness);
  const dInner = Math.max(0, Math.min(inner, dOuter - 1e-6));

  const matte = new Float32Array(width * height);
  for (let p = 0, i = 0; p < matte.length; p++, i += 3) {
    const r = LUT_S2L[rgb[i]];
    const g = LUT_S2L[rgb[i + 1]];
    const b = LUT_S2L[rgb[i + 2]];
    const d = greenness(r, g, b);
    let a;
    if (d <= dInner) a = 1;
    else if (d >= dOuter) a = 0;
    else a = 1 - (d - dInner) / Math.max(1e-6, dOuter - dInner);
    matte[p] = a;
  }

  const softened = boxBlurMatte(matte, width, height, softness);

  // Polygon overrides apply to the whole sequence. Remove wins over protect.
  const { protectMask, removeMask } = masks ?? buildPolygonMasks(width, height, params);
  for (let p = 0; p < softened.length; p++) {
    if (protectMask[p]) softened[p] = 1;
    if (removeMask[p]) softened[p] = 0;
  }
  // Expose the masks so callers (e.g. despill) do not re-rasterize.
  softened.protectMask = protectMask;
  softened.removeMask = removeMask;
  return softened;
}

// Despill: suppress green channel contamination on foreground pixels without
// touching protected-polygon pixels (whose original color must be preserved).
// strength in [0,1]. Returns a new RGB Uint8ClampedArray (sRGB bytes).
export function despill(rgb, matte, width, height, strength, protectMask) {
  const out = new Uint8ClampedArray(rgb);
  const s = Math.min(1, Math.max(0, strength));
  if (s === 0) return out;
  for (let p = 0, i = 0; p < matte.length; p++, i += 3) {
    if (protectMask && protectMask[p]) continue; // protected: original color
    const a = matte[p];
    if (a <= 0) continue;
    const rl = LUT_S2L[rgb[i]];
    const gl = LUT_S2L[rgb[i + 1]];
    const bl = LUT_S2L[rgb[i + 2]];
    const cap = Math.max(rl, bl);
    if (gl <= cap) continue;
    // Only the green spill above the strongest non-green channel is removed;
    // scale by strength and fade the correction toward fully opaque cores so
    // solid foreground keeps its natural color.
    const edgeWeight = 1 - a;
    const gFixed = gl - (gl - cap) * s * (0.25 + 0.75 * edgeWeight);
    out[i + 1] = LUT_L2S[Math.round(Math.max(0, Math.min(1, gFixed)) * 4096)];
  }
  return out;
}

// Compose foreground RGB (despilled sRGB bytes) over an RGB background using
// straight alpha in linear light, then encode back to sRGB. No premultiplied
// RGB is ever produced, so alpha cannot be applied twice ("dark fringe").
export function compositeLinear(rgbFg, matte, rgbBg, width, height) {
  const out = new Uint8ClampedArray(width * height * 3);
  for (let p = 0, i = 0; p < matte.length; p++, i += 3) {
    const a = matte[p];
    for (let c = 0; c < 3; c++) {
      const fl = LUT_S2L[rgbFg[i + c]];
      const bl = LUT_S2L[rgbBg[i + c]];
      const cl = fl * a + bl * (1 - a);
      out[i + c] = LUT_L2S[Math.round(Math.max(0, Math.min(1, cl)) * 4096)];
    }
  }
  return out;
}

// Straight-alpha RGBA: transparent pixels must carry zero RGB. The byte alpha
// is rounded once; anything that rounds to 0 is treated as fully transparent.
export function buildRgba(rgbFg, matte, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0, o = 0; p < matte.length; p++, i += 3, o += 4) {
    const aByte = Math.round(matte[p] * 255);
    if (aByte === 0) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    out[o] = rgbFg[i];
    out[o + 1] = rgbFg[i + 1];
    out[o + 2] = rgbFg[i + 2];
    out[o + 3] = aByte;
  }
  return out;
}

export function buildMatteBytes(matte) {
  const out = new Uint8ClampedArray(matte.length);
  for (let p = 0; p < matte.length; p++) out[p] = Math.round(matte[p] * 255);
  return out;
}

export { srgbToLinear, linearToSrgbByte };
