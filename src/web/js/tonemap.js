/*
 * 显示用的曝光与色调映射。
 *
 * 重要：这些只影响预览像素，不进入积分，也不进入导出的系数。
 * 积分始终用 PFM 读出的线性辐亮度 W/(m²·sr)。
 */

export const TONE_MODES = Object.freeze([
  { id: 'linear-clip', label: '线性截断', hint: 'x·exposure，超过 1 截断' },
  { id: 'reinhard', label: 'Reinhard', hint: 'x/(1+x)，白点前按曝光缩放' },
  { id: 'aces', label: 'ACES 近似', hint: 'Narkowicz 拟合，保留高光层次' },
  { id: 'false-color', label: '伪彩（对数）', hint: '对数亮度映射到单色相深蓝→浅，配合曝光读分布' },
]);

export const DEFAULT_EXPOSURE = 1;

/** 标量函数：把线性亮度映射到 [0,1] 显示值。 */
export function toneMapScalar(value, exposure, mode) {
  const x = Math.max(0, value * exposure);
  switch (mode) {
    case 'reinhard':
      return x / (1 + x);
    case 'aces': {
      const a = 2.51;
      const b = 0.03;
      const c = 2.43;
      const d = 0.59;
      const e = 0.14;
      const y = (x * (a * x + b)) / (x * (c * x + d) + e);
      return Math.min(1, Math.max(0, y));
    }
    case 'false-color':
      return falseColorLuminance(x);
    case 'linear-clip':
    default:
      return Math.min(1, x);
  }
}

/** 伪彩：对数亮度 -> [0,1] 的标量（再由调用方套色带）。 */
function falseColorLuminance(x) {
  const l = Math.log2(1 + x);
  return Math.min(1, l / Math.log2(1 + 64));
}

/**
 * 伪彩色带：单色相顺序色带（深蓝 → 浅蓝），高亮 = 更亮。
 * 不用彩虹色带：单色相才读得出“量”。
 */
export function falseColorRamp(t) {
  const stops = [
    [0.0, [13, 54, 107]], // #0d366b
    [0.25, [37, 106, 191]], // #256abf
    [0.5, [85, 152, 231]], // #5598e7
    [0.75, [158, 197, 244]], // #9ec5f4
    [1.0, [236, 244, 253]], // 接近白
  ];
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * 把 RGB 线性值映射到 0..255 的 sRGB 编码显示值。
 * @param {number[]} rgb 线性辐亮度
 * @param {number} exposure
 * @param {string} mode
 * @param {number[]} out 长度 3 的输出缓冲
 */
export function displayRgb(rgb, exposure, mode, out) {
  if (mode === 'false-color') {
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const t = falseColorLuminance(Math.max(0, lum * exposure));
    const c = falseColorRamp(t);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    return out;
  }
  for (let k = 0; k < 3; k++) {
    const v = toneMapScalar(rgb[k], exposure, mode);
    // sRGB 传输函数
    const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    out[k] = Math.round(Math.min(255, Math.max(0, srgb * 255)));
  }
  return out;
}

/** sRGB 0..255 → 0..1 线性（用于把显示像素转回线性做说明）。 */
export function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export const DEFAULT_TONE = Object.freeze({ exposure: DEFAULT_EXPOSURE, mode: 'reinhard' });
