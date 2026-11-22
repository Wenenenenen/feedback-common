/* Color utilities: RGB weighting from spectral reflectance, sRGB encoding. */
(function (global) {
  'use strict';

  function srgbEncode(linear) {
    // linear-light sRGB -> sRGB gamma
    if (linear <= 0.0031308) return 12.92 * linear;
    return 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  }

  function srgbDecode(c) {
    if (c <= 0.04045) return c / 12.92;
    return Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /**
   * White-light RGB of the unpolarized reflectance spectrum at one angle.
   * Each channel's weights are normalized to sum 1, then applied to the
   * unpolarized reflectance (average of s and p). Returns gamma-encoded
   * 0..255 channels plus the linear 0..1 triplet.
   */
  function rgbFromSpectrum(reflectUnpol, weights) {
    const linear = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const w = weights[ch];
      let sumW = 0;
      let acc = 0;
      for (let i = 0; i < w.length; i++) {
        sumW += w[i];
        acc += w[i] * reflectUnpol[i];
      }
      linear[ch] = sumW > 0 ? acc / sumW : 0;
      if (!Number.isFinite(linear[ch])) linear[ch] = 0;
      if (linear[ch] < 0) linear[ch] = 0;
      if (linear[ch] > 1) linear[ch] = 1;
    }
    const rgb = linear.map((v) => {
      const g = Math.round(srgbEncode(v) * 255);
      return Math.max(0, Math.min(255, g));
    });
    return { rgb: rgb, linear: linear };
  }

  function rgbCss(rgb, alpha) {
    if (alpha === undefined) return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  global.FilmColor = {
    srgbEncode: srgbEncode,
    srgbDecode: srgbDecode,
    rgbFromSpectrum: rgbFromSpectrum,
    rgbCss: rgbCss
  };
})(typeof window !== 'undefined' ? window : globalThis);
