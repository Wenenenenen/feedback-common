// Build a self-consistent fMP4 whose last mdat uses 64-bit largesize (size=1),
// so every internal offset/data_offset is correct by construction.
import { writeFile } from "node:fs/promises";
import { File } from "node:buffer";
import { parseFile, cleanMoov } from "../public/mp4/parse.js";
import { buildOriginal, buildOutput } from "../public/mp4/write.js";

function hdr(type, size) {
  const b = new ArrayBuffer(8), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  return u8;
}
function largeHdr(type, size) {
  const b = new ArrayBuffer(16), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, 1);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  dv.setBigUint64(8, BigInt(size));
  return u8;
}
function full(type, size, ver, flags) {
  const b = new ArrayBuffer(12), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  u8[8] = ver; u8[9] = (flags >>> 16) & 0xff; u8[10] = (flags >>> 8) & 0xff; u8[11] = flags & 0xff;
  return u8;
}
function u32(v) { const b = new ArrayBuffer(4); new DataView(b).setUint32(0, v >>> 0); return new Uint8Array(b); }
function u64(v) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(v)); return new Uint8Array(b); }
function i32(v) { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, v | 0); return new Uint8Array(b); }
function concat(...p) { const l = p.reduce((a, x) => a + x.length, 0), o = new Uint8Array(l); let q = 0; for (const x of p) { o.set(x, q); q += x.length; } return o; }

const synth = await import("./synth.mjs");

async function main() {
  // Build the standard valid case, then reconstruct its second fragment's
  // mdat with a largesize header while keeping every offset consistent.
  const built = await synth.buildCaseA();
  const bytes = built.bytes;

  // Locate the final mdat (top-level) by scanning top-level boxes.
  const scanDv = new DataView(bytes.buffer, bytes.byteOffset);
  let p = 0;
  let lastMdat = null;
  while (p < bytes.length) {
    const size = scanDv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (type === "mdat") lastMdat = { at: p, size };
    p += size;
  }
  if (!lastMdat) throw new Error("no mdat found");

  // Rebuild: everything before mdat + largesize header + same payload.
  // The 8-byte larger header shifts the payload start; every trun in the
  // preceding moof that addresses this mdat must add 8 to its data_offset.
  const payloadLen = lastMdat.size - 8;
  const before = bytes.subarray(0, lastMdat.at);
  const payload = bytes.subarray(lastMdat.at + 8, lastMdat.at + 8 + payloadLen);
  const fixedBefore = new Uint8Array(before);
  const fixDv = new DataView(fixedBefore.buffer, fixedBefore.byteOffset);
  const trunTag = new TextEncoder().encode("trun");
  // Only truns inside the moof immediately preceding the rewritten mdat move.
  const lastMoofAt = (() => {
    const tag = new TextEncoder().encode("moof");
    for (let i = fixedBefore.length - 4; i >= 0; i--) {
      if (fixedBefore[i] === tag[0] && fixedBefore[i + 1] === tag[1] &&
          fixedBefore[i + 2] === tag[2] && fixedBefore[i + 3] === tag[3]) return i - 4;
    }
    throw new Error("no moof before target mdat");
  })();
  for (let i = lastMoofAt; i <= fixedBefore.length - 4; i++) {
    if (fixedBefore[i] === trunTag[0] && fixedBefore[i + 1] === trunTag[1] &&
        fixedBefore[i + 2] === trunTag[2] && fixedBefore[i + 3] === trunTag[3]) {
      const flags = (fixedBefore[i + 5] << 16) | (fixedBefore[i + 6] << 8) | fixedBefore[i + 7];
      if (flags & 0x1) fixDv.setInt32(i + 12, fixDv.getInt32(i + 12) + 8);
    }
  }
  const out = concat(fixedBefore, largeHdr("mdat", 16 + payloadLen), payload);
  await writeFile("/tmp/syn_native_largesize.mp4", out);

  let failures = 0;
  const check = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) failures++; };

  const model = await parseFile(new File([out], "ls.mp4"));
  check(model.rangeErrors.length === 0, "原生 largesize 文件解析零越界（" + model.rangeErrors.length + "）");
  check(model.fragments.length === 2, "片段数 2");
  check(model.fragments[1].payloadEnd === out.length, "末段 payloadEnd 对齐文件末尾");

  model.moovClean = await cleanMoov(model.moovBytes);
  const orig = await buildOriginal(model);
  const mOrig = await parseFile(new File([await orig.arrayBuffer()], "o.mp4"));
  check(mOrig.rangeErrors.length === 0, "largesize 原方案导出再解析零错误（" + mOrig.rangeErrors.length + "）");

  const v = model.tracks.get(1);
  const cuts = [];
  for (let i = 0; i < v.count; i++) if ((v.sampleFlags[i] & 0x10000) === 0) cuts.push(i);
  const bounds = cuts.map((i) => v.dts[i]);
  const repacked = await buildOutput(model, bounds, cuts);
  const mNew = await parseFile(new File([await repacked.arrayBuffer()], "n.mp4"));
  check(mNew.rangeErrors.length === 0, "largesize 重封装再解析零错误");
  check(mNew.tracks.get(1).count === v.count, "重封装样本数保持");

  console.log(failures === 0 ? "\nLARGESIZE PASSED" : `\n${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
