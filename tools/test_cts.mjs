// Unit tests for trun version grouping under mixed CTS ranges.
// We exercise ctsGroups indirectly through a hand-built tiny model.
import { File } from "node:buffer";
import { parseFile, cleanMoov } from "../public/mp4/parse.js";
import { buildOutput } from "../public/mp4/write.js";

let failures = 0;
const check = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) failures++; };

// Build a minimal single-track fMP4 with trun v0 carrying u32 cts values,
// including a value > INT32_MAX (0x80000000) and a normal value. v0 stores
// them unsigned; the repacker must keep them representable on output.
function hdr(t, s) { const b = new ArrayBuffer(8), dv = new DataView(b), u = new Uint8Array(b); dv.setUint32(0, s); for (let i = 0; i < 4; i++) u[i + 4] = t.charCodeAt(i); return u; }
function full(t, s, v, f) { const b = new ArrayBuffer(12), dv = new DataView(b), u = new Uint8Array(b); dv.setUint32(0, s); for (let i = 0; i < 4; i++) u[i + 4] = t.charCodeAt(i); u[8] = v; u[9] = (f >>> 16) & 0xff; u[10] = (f >>> 8) & 0xff; u[11] = f & 0xff; return u; }
function u32(x) { const b = new ArrayBuffer(4); new DataView(b).setUint32(0, x >>> 0); return new Uint8Array(b); }
function u64(x) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(x)); return new Uint8Array(b); }
function i32(x) { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, x | 0); return new Uint8Array(b); }
function concat(...p) { const l = p.reduce((a, x) => a + x.length, 0), o = new Uint8Array(l); let q = 0; for (const x of p) { o.set(x, q); q += x.length; } return o; }

function buildFile(ctsValues, trunVer) {
  const ftyp = concat(hdr("ftyp", 24), new TextEncoder().encode("iso5"), u32(1), new TextEncoder().encode("iso5dash"));
  const mvhd = concat(full("mvhd", 108, 0, 0), new Uint8Array(96));
  const tkhdB = new Uint8Array(84); new DataView(tkhdB.buffer).setUint32(8, 1);
  new DataView(tkhdB.buffer).setUint32(36, 0x10000); new DataView(tkhdB.buffer).setUint32(52, 0x10000);
  const tkhd = concat(full("tkhd", 96, 0, 3), tkhdB);
  const mdhd = concat(full("mdhd", 32, 0, 0), concat(u32(0), u32(0), u32(90000), u32(0), new Uint8Array(4)));
  const hdlr = concat(full("hdlr", 32, 0, 0), u32(0), new TextEncoder().encode("vide"), new Uint8Array(12));
  const url = full("url ", 12, 0, 1);
  const dref = concat(full("dref", 28, 0, 0), u32(1), url);
  const dinf = concat(hdr("dinf", 36), dref);
  const avc1 = concat(hdr("avc1", 86), new Uint8Array(78));
  const stsd = concat(full("stsd", 16 + avc1.length, 0, 0), u32(1), avc1);
  const stts = concat(full("stts", 16, 0, 0), u32(0));
  const stsc = concat(full("stsc", 16, 0, 0), u32(0));
  const stsz = concat(full("stsz", 20, 0, 0), u32(0), u32(0));
  const stco = concat(full("stco", 16, 0, 0), u32(0));
  const stblInner = concat(stsd, stts, stsc, stsz, stco);
  const stbl = concat(hdr("stbl", 8 + stblInner.length), stblInner);
  const vmhd = concat(full("vmhd", 20, 0, 1), new Uint8Array(8));
  const minf = concat(hdr("minf", 8 + vmhd.length + dinf.length + stbl.length), vmhd, dinf, stbl);
  const mdia = concat(hdr("mdia", 8 + mdhd.length + hdlr.length + minf.length), mdhd, hdlr, minf);
  const trak = concat(hdr("trak", 8 + tkhd.length + mdia.length), tkhd, mdia);
  const trex = concat(full("trex", 32, 0, 0), concat(u32(1), u32(1), u32(0), u32(0), u32(0)));
  const mvex = concat(hdr("mvex", 8 + trex.length), trex);
  const moov = concat(hdr("moov", 8 + mvhd.length + trak.length + mvex.length), mvhd, trak, mvex);

  const n = ctsValues.length;
  const size = 50;
  const trunSize = 20 + n * 16;
  const trun = new Uint8Array(trunSize);
  const dv = new DataView(trun.buffer);
  dv.setUint32(0, trunSize); trun.set(new TextEncoder().encode("trun"), 4);
  trun[8] = trunVer; trun[10] = 0x0f; trun[11] = 0x01;
  dv.setUint32(12, n);
  for (let i = 0; i < n; i++) {
    const at = 20 + i * 16;
    dv.setUint32(at, 3000); dv.setUint32(at + 4, size);
    dv.setUint32(at + 8, i === 0 ? 0 : 0x00010000);
    if (trunVer === 1) dv.setInt32(at + 12, ctsValues[i]); else dv.setUint32(at + 12, ctsValues[i]);
  }
  const tfhd = concat(full("tfhd", 16, 0, 0x020000), u32(1));
  const tfdt = concat(full("tfdt", 20, 1, 0), u64(0));
  const traf = concat(hdr("traf", 8 + tfhd.length + tfdt.length + trun.length), tfhd, tfdt, trun);
  const mfhd = concat(full("mfhd", 16, 0, 0), u32(1));
  const moof = concat(hdr("moof", 8 + mfhd.length + traf.length), mfhd, traf);
  new DataView(moof.buffer, moof.byteOffset).setInt32(moof.length - trun.length + 16, moof.length + 8);
  const payload = new Uint8Array(n * size);
  const mdat = concat(hdr("mdat", 8 + payload.length), payload);
  return concat(ftyp, moov, moof, mdat);
}

async function main() {
  // v0 input: values include one > INT32_MAX and zeros.
  const big = 0x80000000; // 2147483648, valid u32 but not i32 positive
  const bytes0 = buildFile([0, big, 100], 0);
  const m0 = await parseFile(new File([bytes0], "v0.mp4"));
  m0.moovClean = await cleanMoov(m0.moovBytes);
  const t0 = m0.tracks.get(1);
  check(t0.cts[1] === big, `trun v0 超大无符号 CTS 解析为 ${t0.cts[1]}`);
  const blob0 = await buildOutput(m0, [t0.dts[0]], [0]);
  const r0 = await parseFile(new File([await blob0.arrayBuffer()], "o.mp4"));
  check(r0.tracks.get(1).cts[1] === big, "重封装后超大 CTS 精确保留（输出 trun v0）");

  // v1 input with negative cts; output must keep signed representation.
  const bytes1 = buildFile([0, -512, 1024], 1);
  const m1 = await parseFile(new File([bytes1], "v1.mp4"));
  m1.moovClean = await cleanMoov(m1.moovBytes);
  const t1 = m1.tracks.get(1);
  check(t1.cts[1] === -512, "trun v1 负 CTS 解析正确");
  const blob1 = await buildOutput(m1, [t1.dts[0]], [0]);
  const r1 = await parseFile(new File([await blob1.arrayBuffer()], "o2.mp4"));
  check(r1.tracks.get(1).cts[1] === -512, "重封装后负 CTS 精确保留（输出 trun v1）");
  check(r1.rangeErrors.length === 0, "混合 CTS 输出无寻址错误");

  console.log(failures === 0 ? "\nCTS GROUPING PASSED" : `\n${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
