// compositor.js — Frame-by-frame APNG raster compositor.
// Semantics follow https://www.w3.org/TR/png-3/ with the package conventions:
//   - straight (non-premultiplied) alpha OVER, rounded to 8 bits per compositing step;
//   - each play starts from a fully transparent canvas;
//   - before = canvas before drawing, shown = after blending, after = after disposal.
import { inflate as pakoInflate } from '../lib/pako.esm.mjs';

export const DISPOSE = { NONE: 0, BACKGROUND: 1, PREVIOUS: 2 };
export const BLEND = { SOURCE: 0, OVER: 1 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Inflate a frame's reassembled zlib stream and undo PNG row filtering on an 8-bit
// non-interlaced RGBA image of size fw×fh. Mixed filter types per row are supported.
export function inflateFramePixels(zstream, fw, fh) {
  let raw;
  try {
    raw = pakoInflate(zstream);
  } catch (e) {
    throw new Error(`帧 zlib 流解压失败（流跨多个数据块拼接）：${e.message}`);
  }
  const channels = 4;
  const stride = fw * channels;
  const expected = fh * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`帧图像数据截断：解压得到 ${raw.length} 字节，需要 ${expected} 字节（${fw}×${fh} RGBA）`);
  }
  const rgba = new Uint8ClampedArray(fw * fh * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < fh; y++) {
    const filter = raw[rp++];
    line.set(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`未知行过滤器类型 ${filter}（帧内第 ${y} 行）`);
      }
      line[i] = v & 0xff;
    }
    prev.set(line);
    rgba.set(line, y * stride);
  }
  return rgba;
}

// straight-alpha OVER, rounded to 8 bits at each compositing step (package convention).
function blendOver(sr, sg, sb, sa, dr, dg, db, da) {
  if (sa === 0) return [dr, dg, db, da];
  if (sa === 255) return [sr, sg, sb, 255];
  const invSa = 255 - sa;
  const outA = sa + Math.round((da * invSa) / 255);
  if (outA === 0) return [0, 0, 0, 0];
  const blend = (s, d) => {
    // out = (s*sa + d*da*(255-sa)/255) / outA, 四舍五入
    const v = Math.round((s * sa + (d * da * invSa) / 255) / outA);
    return Math.max(0, Math.min(255, v));
  };
  return [blend(sr, dr), blend(sg, dg), blend(sb, db), Math.min(255, outA)];
}

function clone(buf) {
  const c = new Uint8ClampedArray(buf.length);
  c.set(buf);
  return c;
}

// Decode every frame once; pixels never change under edits (only timing/disposal do).
export function decodeAllFrames(parsed, frameZlibStream) {
  return parsed.frames.map((f, i) => {
    const z = frameZlibStream(parsed, f);
    let pixels;
    try {
      pixels = inflateFramePixels(z, f.width, f.height);
    } catch (e) {
      throw new Error(`第 ${i} 帧（fcTL @${f.fctlOffset}）解码失败：${e.message}`);
    }
    return pixels;
  });
}

// Composite the full animation with the current editable parameters.
// edits: per-frame optional { delayNum, delayDen, disposeOp, blendOp }, plus numPlays.
// Returns one state per frame: { before, shown, after, pixels, frame, cumulativeMs, frameMs }
export function compositeAnimation(parsed, framePixels, edits = {}) {
  const { width, height, frames } = parsed;
  const size = width * height * 4;
  let canvas = new Uint8ClampedArray(size); // every play starts fully transparent
  const states = [];
  let cumulativeMs = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const ed = edits[i] || {};
    const disposeOp = ed.disposeOp ?? f.disposeOp;
    const blendOp = ed.blendOp ?? f.blendOp;
    const delayNum = ed.delayNum ?? f.delayNum;
    const delayDen = ed.delayDen ?? f.delayDen;

    const before = clone(canvas);
    const shown = clone(canvas);
    const pixels = framePixels[i];

    for (let yy = 0; yy < f.height; yy++) {
      for (let xx = 0; xx < f.width; xx++) {
        const gx = f.x + xx;
        const gy = f.y + yy;
        const si = (yy * f.width + xx) * 4;
        const di = (gy * width + gx) * 4;
        const sr = pixels[si], sg = pixels[si + 1], sb = pixels[si + 2], sa = pixels[si + 3];
        if (blendOp === BLEND.SOURCE) {
          shown[di] = sr; shown[di + 1] = sg; shown[di + 2] = sb; shown[di + 3] = sa;
        } else {
          const [r, g, b, a] = blendOver(sr, sg, sb, sa,
            shown[di], shown[di + 1], shown[di + 2], shown[di + 3]);
          shown[di] = r; shown[di + 1] = g; shown[di + 2] = b; shown[di + 3] = a;
        }
      }
    }

    const after = clone(shown);
    if (disposeOp === DISPOSE.BACKGROUND) {
      for (let yy = 0; yy < f.height; yy++) {
        for (let xx = 0; xx < f.width; xx++) {
          const di = ((f.y + yy) * width + (f.x + xx)) * 4;
          after[di] = 0; after[di + 1] = 0; after[di + 2] = 0; after[di + 3] = 0;
        }
      }
    } else if (disposeOp === DISPOSE.PREVIOUS) {
      // restore the region to what it was before this frame was rendered
      for (let yy = 0; yy < f.height; yy++) {
        for (let xx = 0; xx < f.width; xx++) {
          const di = ((f.y + yy) * width + (f.x + xx)) * 4;
          after[di] = before[di]; after[di + 1] = before[di + 1];
          after[di + 2] = before[di + 2]; after[di + 3] = before[di + 3];
        }
      }
    }

    const { frameMs, effectiveDen } = frameDurationMs(delayNum, delayDen);
    cumulativeMs += frameMs;
    states.push({
      index: i,
      before, shown, after,
      frameMs,
      effectiveDen,
      cumulativeMs,
      delayNum, delayDen, disposeOp, blendOp,
    });
    canvas = after;
  }
  return states;
}

// Package timing convention: delay_den == 0 is read as 100; the rational value is kept
// exact for cumulative timing; delay_num == 0 gets a 10 ms playback floor (export keeps
// the original numerator/denominator).
export function frameDurationMs(delayNum, delayDen) {
  const den = delayDen === 0 ? 100 : delayDen;
  let ms = (delayNum / den) * 1000;
  if (delayNum === 0) ms = 10; // tool playback floor only
  return { frameMs: ms, effectiveDen: den };
}
