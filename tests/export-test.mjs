// Byte-level APNG export validation: CRC correctness, sequence continuity,
// and near-identity rebuild when nothing was edited.
import { readFileSync } from 'node:fs';
import { parseApng } from '../src/apng-parser.js';
import { exportApng } from '../src/apng-exporter.js';
import { crc32 } from '../src/crc32.js';

const DIR = '/tmp/apng-sample-extract';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log(`FAIL ${n} ${x}`)); };

function walk(bytes) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  let off = 8;
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const bodyEnd = off + 8 + len;
    const stored = dv.getUint32(bodyEnd);
    const calc = crc32(bytes, off + 4, bodyEnd);
    out.push({ type, off, len, stored, calc, bodyStart: off + 8 });
    off = bodyEnd + 4;
  }
  return out;
}

for (const name of ['included.apng', 'poster-excluded.apng', 'first-previous.apng']) {
  const orig = new Uint8Array(readFileSync(`${DIR}/${name}`));
  const parsed = parseApng(orig);
  const rebuilt = exportApng(parsed, { numPlays: parsed.numPlays, frames: {} });

  const oc = walk(orig), rc = walk(rebuilt);
  check(`${name} same chunk count`, oc.length === rc.length, `${oc.length} vs ${rc.length}`);
  check(`${name} same chunk types/order`, oc.every((c, i) => c.type === rc[i].type));
  check(`${name} all rebuilt CRCs valid`, rc.every((c) => c.stored === c.calc));

  // sequence numbers: fcTL and fdAT share one continuous space starting at 0
  let expected = 0; let seqOk = true;
  const dv = new DataView(rebuilt.buffer, rebuilt.byteOffset);
  for (const c of rc) {
    if (c.type === 'fcTL' || c.type === 'fdAT') {
      const seq = dv.getUint32(c.bodyStart);
      if (seq !== expected) seqOk = false;
      expected++;
    }
  }
  check(`${name} continuous sequence 0..${expected - 1}`, seqOk);

  // image data bytes must be untouched: IDAT bodies identical, fdAT payloads (after 4 seq bytes) identical
  let imageOk = true;
  const oi = oc.filter((c) => c.type === 'IDAT' || c.type === 'fdAT');
  const ri = rc.filter((c) => c.type === 'IDAT' || c.type === 'fdAT');
  for (let i = 0; i < oi.length; i++) {
    const a = oi[i], b = ri[i];
    const skip = a.type === 'fdAT' ? 4 : 0;
    const aBody = orig.subarray(a.bodyStart + skip, a.bodyStart + a.len);
    const bBody = rebuilt.subarray(b.bodyStart + skip, b.bodyStart + b.len);
    if (aBody.length !== bBody.length) imageOk = false;
    else for (let j = 0; j < aBody.length; j++) if (aBody[j] !== bBody[j]) imageOk = false;
  }
  check(`${name} image streams byte-identical`, imageOk);

  // IHDR/IEND bodies identical; whole file differs only in framing/seq bytes
  const ihdrO = oc.find((c) => c.type === 'IHDR');
  const ihdrR = rc.find((c) => c.type === 'IHDR');
  check(`${name} IHDR body identical`,
    Buffer.from(orig.subarray(ihdrO.bodyStart, ihdrO.bodyStart + 13)).equals(
      Buffer.from(rebuilt.subarray(ihdrR.bodyStart, ihdrR.bodyStart + 13))));

  // edited export: only edited fcTL + acTL change, data chunks stay
  const edited = exportApng(parsed, {
    numPlays: 7,
    frames: { 1: { disposeOp: 0, blendOp: 0, delayNum: 3, delayDen: 100 } },
  });
  const ec = walk(edited);
  check(`${name} edited CRCs all valid`, ec.every((c) => c.stored === c.calc));
  const reparsed = parseApng(edited);
  check(`${name} edited num_plays=7`, reparsed.numPlays === 7);
  check(`${name} edited frame1`,
    reparsed.frames[1].disposeOp === 0 && reparsed.frames[1].blendOp === 0 &&
    reparsed.frames[1].delayNum === 3 && reparsed.frames[1].delayDen === 100);
  check(`${name} other frames untouched by edit`,
    reparsed.frames[0].disposeOp === parsed.frames[0].disposeOp &&
    (parsed.frames.length < 3 || reparsed.frames[2].delayNum === parsed.frames[2].delayNum));

  // re-export of the edited file converges (idempotent rebuild)
  const second = exportApng(reparsed, {
    numPlays: 7,
    frames: { 1: { disposeOp: 0, blendOp: 0, delayNum: 3, delayDen: 100 } },
  });
  check(`${name} re-export idempotent`, Buffer.from(edited).equals(Buffer.from(second)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
