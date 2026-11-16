// apng-exporter.js — Rebuild an APNG after edits.
// Allowed edits per package convention: per-frame delay_num/delay_den/dispose_op/blend_op
// and acTL num_plays. Image bytes and frame rectangles are never altered; chunk CRCs and
// the continuous fcTL/fdAT sequence_number space are regenerated.
import { PNG_SIGNATURE, chunkBytes } from './png-codec.js';

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function u16(v) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff);
  return b;
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fctlBody(frame, seq, edit) {
  const dn = edit.delayNum ?? frame.delayNum;
  const dd = edit.delayDen ?? frame.delayDen;
  const dop = edit.disposeOp ?? frame.disposeOp;
  const bop = edit.blendOp ?? frame.blendOp;
  return concat([
    u32(seq),
    u32(frame.width), u32(frame.height),
    u32(frame.x), u32(frame.y),
    u16(dn), u16(dd),
    new Uint8Array([dop, bop]),
  ]);
}

// edits: { numPlays, frames: { [i]: { delayNum, delayDen, disposeOp, blendOp } } }
export function exportApng(parsed, edits) {
  const frameEdits = edits.frames || {};
  const numPlays = edits.numPlays ?? parsed.numPlays;
  const out = [PNG_SIGNATURE.slice()];
  let seq = 0;

  for (const chunk of parsed.chunks) {
    if (chunk.type === 'acTL') {
      out.push(chunkBytes('acTL', concat([u32(parsed.frames.length), u32(numPlays)])));
      continue;
    }
    if (chunk.type === 'fcTL') {
      const frameIndex = parsed.frames.findIndex((f) => f.fctlOffset === chunk.offset);
      const frame = parsed.frames[frameIndex];
      out.push(chunkBytes('fcTL', fctlBody(frame, seq++, frameEdits[frameIndex] || {})));
      continue;
    }
    if (chunk.type === 'fdAT') {
      const body = parsed.bytes.subarray(chunk.bodyStart + 4, chunk.bodyEnd); // drop old seq
      out.push(chunkBytes('fdAT', concat([u32(seq++), body])));
      continue;
    }
    if (chunk.type === 'IDAT' || chunk.type === 'IHDR' || chunk.type === 'IEND') {
      out.push(chunkBytes(chunk.type, parsed.bytes.subarray(chunk.bodyStart, chunk.bodyEnd)));
      continue;
    }
    // Ancillary chunks (tEXt, gAMA, ...) are preserved byte-for-byte with recomputed framing.
    out.push(chunkBytes(chunk.type, parsed.bytes.subarray(chunk.bodyStart, chunk.bodyEnd)));
  }
  return concat(out);
}
