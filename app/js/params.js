// params.js — parameter snapshot, archive description and export naming.
//
// Kept separate from the page so exports can be unit-tested without a DOM.
// The exported parameter JSON is the complete recipe: every number the
// renderer reads, plus fingerprints of the inputs it read them from.

import { FILL_STRATEGY, DISP_FORMULA, STEREO_FORMULA } from './core.js';

export function quantize(v) {
  const q = Math.round(v * 1e6) / 1e6;
  return q === 0 ? 0 : q; // normalise -0 so serialised params compare cleanly
}

// A stable key for the geometry-affecting subset of parameters.  The worker
// caches eye buffers under this key, so changing only fill settings never
// re-rasterises.
export function geometryKey({ fx, fy, cx, cy, eyeDistance, zeroPlane, jump }) {
  return [fx, fy, cx, cy, eyeDistance, zeroPlane, jump].map(quantize).join('|');
}

export function snapshotParams(state) {
  return {
    eyeDistance: quantize(state.eyeDistance),
    zeroPlane: quantize(state.zeroPlane),
    jump: quantize(state.jump),
    fillDisplayed: !!state.fillEnabled,
    fillMaxGap: Math.round(state.fillMaxGap),
    fillStrategy: FILL_STRATEGY,
  };
}

export function buildParamsJson({ state, meta, dataset, result }) {
  const p = snapshotParams(state);
  const triangles = result ? result.triangleCount : null;
  return {
    format: 'stereo-depth-forge/v1',
    generated: new Date().toISOString(),
    source: {
      case: dataset && dataset.caseName ? dataset.caseName : null,
      width: meta.width,
      height: meta.height,
      fx: meta.fx, fy: meta.fy, cx: meta.cx, cy: meta.cy,
      colorFile: meta.color,
      depthFile: meta.depth,
      colorFnv1a: dataset ? dataset.colorHash || null : null,
      depthFnv1a: dataset ? dataset.depthHash || null : null,
      depthBytes: dataset ? dataset.depthBytes : null,
      invalidDepthCount: result && result.depthRange ? result.depthRange.invalid : null,
      depthRangeM: result && result.depthRange && result.depthRange.hasRange
        ? [quantize(result.depthRange.min), quantize(result.depthRange.max)] : null,
    },
    params: p,
    derived: {
      baselineM: state.eyeDistance,
      eyeXLeft: quantize(-state.eyeDistance / 2),
      eyeXRight: quantize(state.eyeDistance / 2),
      disparityFormula: DISP_FORMULA,
      projection: STEREO_FORMULA,
      disparityAtZeroPlanePx: 0,
      disparityAtNearM: result && result.depthRange && result.depthRange.hasRange
        ? quantize(meta.fx * state.eyeDistance * (1 / result.depthRange.min - 1 / state.zeroPlane)) : null,
    },
    render: {
      mesh: 'pixel-grid, triangles [00,10,11] and [00,11,01] per cell',
      keepTriangle: 'all three vertex depths finite, > 0, and max-min <= jump',
      depthTest: 'smaller positive Z wins; equal Z -> lower source triangle index',
      sampling: 'bilinear from the source colour image at the perspective-correct source coordinate',
      coverageMask: '255 = hole, 0 = covered; black pixels count as covered',
      outputSize: [meta.width, meta.height],
      triangleCount: triangles,
      leftHoles: result && result.stats ? result.stats.leftHoles : null,
      rightHoles: result && result.stats ? result.stats.rightHoles : null,
      leftCovered: result && result.stats ? result.stats.leftCovered : null,
      rightCovered: result && result.stats ? result.stats.rightCovered : null,
      fillPreview: 'always exported as left-filled.png / right-filled.png; never replaces left.png / right.png',
      fillStats: result && result.stats
        ? { left: result.stats.leftFill, right: result.stats.rightFill } : null,
    },
    files: {
      'left.png': 'unfilled left eye, RGBA (alpha 255 where covered, 0 in holes)',
      'right.png': 'unfilled right eye, RGBA',
      'left-filled.png': 'horizontal hole fill preview, left eye, RGBA (preview only)',
      'right-filled.png': 'horizontal hole fill preview, right eye, RGBA',
      'left-mask.png': 'raw hole mask, 8-bit grayscale, 255 = hole / 0 = covered',
      'right-mask.png': 'raw hole mask, 8-bit grayscale',
      'params.json': 'this file',
    },
  };
}

export function archiveName(meta, stamp = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const name = (meta && meta.caseName) ? meta.caseName.replace(/[^A-Za-z0-9_.-]+/g, '_') : 'stereo';
  return `${name}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.zip`;
}
