// sRGB <-> 线性 RGB。PNG 按 sRGB 解码，全部加权与合成在线性空间，导出按 sRGB 编码。
(function (global) {
  'use strict';

  function srgbChannelToLinear(v) {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }

  function linearToSrgbChannel(x) {
    x = Math.min(1, Math.max(0, x));
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  }

  function srgbBytesToLinear(r, g, b) {
    return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
  }

  // GLSL 片段（与 CPU 实现严格一致）
  const GLSL = `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
             step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = 12.92 * c;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
`;

  global.ColorUtil = {
    srgbChannelToLinear,
    linearToSrgbChannel,
    srgbBytesToLinear,
    GLSL
  };
})(typeof window !== 'undefined' ? window : globalThis);
