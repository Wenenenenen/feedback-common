// sRGB <-> linear-light transfer functions (IEC 61966-2-1).
// Shared by preview rendering and export so both are bit-identical.

export function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function linearToSrgbByte(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 255;
  const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// Precompute lookup tables (length 256) for per-channel work.
export function makeSrgbToLinearLut() {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i);
  return lut;
}

export function makeLinearToSrgbLut() {
  // Fine-grained table: index = round(l * 4096).
  const SIZE = 4097;
  const lut = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) lut[i] = linearToSrgbByte(i / 4096);
  return lut;
}
