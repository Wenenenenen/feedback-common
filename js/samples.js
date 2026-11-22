/* Built-in sample cases — mirrors samples/film-stack-cases.json.
   Embedded so the page also works when opened directly via file://. */
(function (global) {
  'use strict';

  const WAVELENGTHS = [
    400, 410, 420, 430, 440, 450, 460, 470, 480, 490, 500, 510, 520, 530, 540, 550,
    560, 570, 580, 590, 600, 610, 620, 630, 640, 650, 660, 670, 680, 690, 700
  ];

  // [R, G, B] channel weights per wavelength (triangular response curves)
  const WEIGHTS = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.16666666666666663, 0.33333333333333337, 0.5, 0.6666666666666667, 0.8333333333333334, 1.0, 0.8333333333333334, 0.6666666666666667, 0.5, 0.33333333333333337, 0.16666666666666663, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.16666666666666663, 0.33333333333333337, 0.5, 0.6666666666666667, 0.8333333333333334, 1.0, 0.8333333333333334, 0.6666666666666667, 0.5, 0.33333333333333337, 0.16666666666666663, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0.16666666666666663, 0.33333333333333337, 0.5, 0.6666666666666667, 0.8333333333333334, 1.0, 0.8333333333333334, 0.6666666666666667, 0.5, 0.33333333333333337, 0.16666666666666663, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ];

  // Each layer: [thickness nm, n, k]
  const CASES = [
    { id: 'glass', label: '裸玻璃基底', n0: 1, ns: 1.5, layers: [], angle: 0 },
    { id: 'brewster', label: '布儒斯特角', n0: 1, ns: 1.5, layers: [], angle: 56.309932474020215 },
    { id: 'tir', label: '全反射', n0: 1.5, ns: 1, layers: [], angle: 60 },
    { id: 'ar', label: '四分之一波增透膜', n0: 1, ns: 1.5, layers: [[112.26827987756234, 1.224744871391589, 0]], angle: 0 },
    {
      id: 'absorb', label: '16 层厚吸收膜', n0: 1, ns: 1.5, angle: 0,
      layers: Array.from({ length: 16 }, () => [5000, 1.5, 2])
    },
    { id: 'coherent', label: '相干三层膜', n0: 1, ns: 1.5, layers: [[85, 2, 0], [110, 1.4, 0], [60, 1.9, 0.05]], angle: 40 }
  ];

  const SAMPLE_DATA = { wavelengths: WAVELENGTHS, weights: WEIGHTS, cases: CASES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SAMPLE_DATA;
  } else {
    global.FILM_SAMPLES = SAMPLE_DATA;
  }
})(typeof window !== 'undefined' ? window : globalThis);
