// Frame processing + ZIP export. processFrame() is the single pipeline used
// by both the interactive preview and the exporter, which is what makes the
// preview/export consistency guarantee structural rather than aspirational.

import { computeMatte, buildPolygonMasks, despill, compositeLinear, buildRgba, buildMatteBytes } from './keyer.js';
import { encodePNG } from './png.js';
import { writeZip } from './zip.js';

// Produce every representation of one frame from its source sRGB RGB bytes.
// params: { keyColor, inner, outer, softness, despillStrength,
//           protectPolygons, removePolygons }
// background: { rgb } sRGB RGB bytes at the same dimensions.
// masks: optional pre-rasterized polygon masks (shared across the sequence).
export function processFrame(rgb, width, height, params, background, masks) {
  const matte = computeMatte(rgb, width, height, params, masks);
  const protectMask = matte.protectMask;
  const despilled = despill(rgb, matte, width, height, params.despillStrength ?? 0.5, protectMask);
  const rgba = buildRgba(despilled, matte, width, height);
  const matteBytes = buildMatteBytes(matte);
  if (!background) throw new Error('合成背景缺失');
  const composite = compositeLinear(despilled, matte, background.rgb, width, height);
  return { matte, despilled, rgba, matteBytes, composite };
}

export async function encodeFramePNGs(width, height, out) {
  const [rgbaPng, mattePng, compositePng] = await Promise.all([
    encodePNG(width, height, 4, out.rgba),
    encodePNG(width, height, 1, out.matteBytes),
    encodePNG(width, height, 3, out.composite),
  ]);
  return { rgbaPng, mattePng, compositePng };
}

// Build the export ZIP: rgba/ matte/ composite/ directories, original frame
// file names (numeric frame numbers preserved), original dimensions.
export async function exportZip(frames, width, height, params, background) {
  const entries = [];
  const masks = buildPolygonMasks(width, height, params);
  for (const frame of frames) {
    const out = processFrame(frame.rgb, width, height, params, background, masks);
    const pngs = await encodeFramePNGs(width, height, out);
    entries.push({ name: `rgba/${frame.name}`, bytes: pngs.rgbaPng });
    entries.push({ name: `matte/${frame.name}`, bytes: pngs.mattePng });
    entries.push({ name: `composite/${frame.name}`, bytes: pngs.compositePng });
  }
  return writeZip(entries);
}
