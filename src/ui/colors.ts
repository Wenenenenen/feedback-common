/**
 * Chart colours follow the reference categorical palette (validated for the
 * dark surface on this page). Chart identity is never cycled: past the eighth
 * chart we fold to a neutral "other" hue and rely on the chart list for naming.
 */
export const SERIES = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#0ca30c', // green
  '#9085e9', // violet
  '#e66767', // red
] as const;

export const OVERFLOW = '#6b7280';

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/** Sequential blue ramp (dark-surface steps, low -> high). */
export const SEQUENTIAL = [
  '#184f95',
  '#256abf',
  '#3987e5',
  '#6da7ec',
  '#9ec5f4',
  '#cde2fb',
] as const;

export const INK = {
  primary: '#e6ecf5',
  secondary: '#93a2b8',
  muted: '#66748a',
  grid: '#243044',
  surface: '#0b0f16',
};

export function chartColor(index: number): string {
  return index >= 0 && index < SERIES.length ? SERIES[index] : OVERFLOW;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  const part = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

function linearToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToLinear([L, a, b]: [number, number, number]): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Perceptual colour mix in OKLab; t = 0 -> hexA, t = 1 -> hexB. */
export function mixOklab(hexA: string, hexB: string, t: number): string {
  const a = linearToOklab(hexToRgb(hexA).map(srgbToLinear) as [number, number, number]);
  const b = linearToOklab(hexToRgb(hexB).map(srgbToLinear) as [number, number, number]);
  const k = clamp01(t);
  const lab: [number, number, number] = [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
  const linear = oklabToLinear(lab).map(linearToSrgb) as [number, number, number];
  return rgbToHex(linear);
}

/** Sample the sequential ramp at t in [0, 1]. */
export function rampColor(t: number): string {
  const x = clamp01(t) * (SEQUENTIAL.length - 1);
  const i = Math.min(SEQUENTIAL.length - 2, Math.floor(x));
  return mixOklab(SEQUENTIAL[i], SEQUENTIAL[i + 1], x - i);
}
