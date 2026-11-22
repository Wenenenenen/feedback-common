// Scale/perf test: 300k samples with a large u64 DTS origin, B-frame cts,
// optional audio. Measures index time, memory, and repack time.
import { writeFile, readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { parseFile, cleanMoov, isKeyframe } from "../public/mp4/parse.js";
import { buildOutput } from "../public/mp4/write.js";

function hdr(type, size) {
  const b = new ArrayBuffer(8), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
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
function i32(v) { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, v | 0); return new Uint8Array(b); }
function u64(v) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(v)); return new Uint8Array(b); }
function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

// Minimal head reusing the proven synth layout inline.
function head() {
  const ftyp = concat(hdr("ftyp", 24), new TextEncoder().encode("iso5"), u32(1), new TextEncoder().encode("iso5dash"));
  const mvhd = concat(full("mvhd", 108, 0, 0), new Uint8Array(96));
  const tkhdBody = new Uint8Array(84);
  new DataView(tkhdBody.buffer).setUint32(8, 1);
  new DataView(tkhdBody.buffer).setUint32(36, 0x00010000);
  new DataView(tkhdBody.buffer).setUint32(52, 0x00010000);
  const tkhd = concat(full("tkhd", 96, 0, 3), tkhdBody);
  const mdhdBody = concat(u32(0), u32(0), u32(12288), u32(0), new Uint8Array(4));
  const mdhd = concat(full("mdhd", 32, 0, 0), mdhdBody);
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
  const stbl = concat(hdr("stbl", 8 + stsd.length + stts.length + stsc.length + stsz.length + stco.length),
    stsd, stts, stsc, stsz, stco);
  const vmhd = concat(full("vmhd", 20, 0, 1), new Uint8Array(8));
  const minf = concat(hdr("minf", 8 + vmhd.length + dinf.length + stbl.length), vmhd, dinf, stbl);
  const mdia = concat(hdr("mdia", 8 + mdhd.length + hdlr.length + minf.length), mdhd, hdlr, minf);
  const trak = concat(hdr("trak", 8 + tkhd.length + mdia.length), tkhd, mdia);
  const trexBody = concat(u32(1), u32(1), u32(0), u32(0), u32(0));
  const trex = concat(full("trex", 32, 0, 0), trexBody);
  const mvex = concat(hdr("mvex", 8 + trex.length), trex);
  const moov = concat(hdr("moov", 8 + mvhd.length + trak.length + mvex.length), mvhd, trak, mvex);
  return concat(ftyp, moov);
}

// Build one fragment of n samples directly into one preallocated buffer.
function fragment(seq, startDts, n, sampleSize, gop) {
  const samplesPerTrun = n;
  // trun: full(12) count(4) data_offset(4) + n*(dur,size,flags,cts)*4
  const trunSize = 20 + samplesPerTrun * 16;
  const tfhd = concat(full("tfhd", 16, 0, 0x020000), u32(1));
  const tfdt = concat(full("tfdt", 20, 1, 0), u64(startDts));
  const trun = new Uint8Array(trunSize);
  {
    const dv = new DataView(trun.buffer);
    dv.setUint32(0, trunSize);
    const tag = new TextEncoder().encode("trun");
    trun.set(tag, 4);
    trun[8] = 1; // version 1: signed i32 cts offsets
    trun[9] = 0x00;
    trun[10] = 0x0f;
    trun[11] = 0x01; // flags: data-offset + dur/size/flags/cts
    dv.setUint32(12, n);
    // data_offset patched after moof size known (relative to moof)
    for (let i = 0; i < n; i++) {
      const at = 20 + i * 16;
      dv.setUint32(at, 512);
      dv.setUint32(at + 4, sampleSize);
      const key = i % gop === 0;
      dv.setUint32(at + 8, key ? 0 : 0x00010000); // non-key sample_depends_on bit
      // cts pattern emulating B frames: 0,1024,-512,-512,512...
      const pat = [0, 1024, -512, -512, 512][i % 5];
      dv.setInt32(at + 12, pat);
    }
  }
  const traf = concat(hdr("traf", 8 + tfhd.length + tfdt.length + trun.length), tfhd, tfdt, trun);
  const mfhd = concat(full("mfhd", 16, 0, 0), u32(seq));
  const moof = concat(hdr("moof", 8 + mfhd.length + traf.length), mfhd, traf);
  // payload: distinct fill bytes per fragment
  const payload = new Uint8Array(n * sampleSize);
  for (let i = 0; i < payload.length; i++) payload[i] = (seq * 31 + i) & 0xff;
  const mdat = concat(hdr("mdat", 8 + payload.length), payload);
  // patch data_offset = moof size + 8
  const trunAt = moof.length - trun.length;
  new DataView(moof.buffer, moof.byteOffset).setInt32(trunAt + 12 + 4, moof.length + 8);
  return { moof, mdat };
}

async function main() {
  const totalSamples = 300000;
  const perFrag = 5000;
  const sampleSize = 128;
  const gop = 250;
  const frags = totalSamples / perFrag;
  const dtsOrigin = 1n << 60n;

  const t0 = performance.now();
  const parts = [head()];
  let dts = dtsOrigin;
  for (let f = 0; f < frags; f++) {
    const { moof, mdat } = fragment(f + 1, dts, perFrag, sampleSize, gop);
    parts.push(moof, mdat);
    dts += BigInt(perFrag * 512);
  }
  const bytes = concat(...parts);
  const t1 = performance.now();
  console.log(`生成文件: ${(bytes.length / 1048576).toFixed(1)} MiB, ${frags} 片段, 用时 ${(t1 - t0).toFixed(0)} ms`);

  const memBefore = process.memoryUsage().heapUsed;
  const file = new File([bytes], "big.mp4");
  const t2 = performance.now();
  const model = await parseFile(file);
  const t3 = performance.now();
  const memAfter = process.memoryUsage().heapUsed;
  const v = model.tracks.get(1);
  console.log(`索引解析: ${(t3 - t2).toFixed(0)} ms（要求 < 8000 ms），样本 ${v.count}`);
  console.log(`堆增量: ${((memAfter - memBefore) / 1048576).toFixed(1)} MiB`);
  console.log(`首 DTS=${v.dts[0]} (期望 ${dtsOrigin})，末 DTS=${v.dts[v.count - 1]}`);
  let keyCount = 0;
  for (let i = 0; i < v.count; i++) if (isKeyframe(v, i)) keyCount++;
  console.log(`关键帧 ${keyCount}，负 CTS 样本 ${v.cts.some((x) => x < 0) ? "存在" : "无"}`);

  // display order build time
  const t4 = performance.now();
  const order = v.displayOrder;
  const t5 = performance.now();
  console.log(`显示顺序索引就绪: ${(t5 - t4).toFixed(0)} ms, 首位=${order[0]}`);

  // repack at every keyframe
  model.moovClean = await cleanMoov(model.moovBytes);
  const cuts = [];
  for (let i = 0; i < v.count; i++) if (isKeyframe(v, i)) cuts.push(i);
  const bounds = cuts.map((i) => v.dts[i]);
  const t6 = performance.now();
  const blob = await buildOutput(model, bounds, cuts);
  const t7 = performance.now();
  console.log(`重封装 ${cuts.length} 段: ${(t7 - t6).toFixed(0)} ms, 输出 ${(blob.size / 1048576).toFixed(1)} MiB`);

  // verify output re-parses and matches
  const outBytes = new Uint8Array(await blob.arrayBuffer());
  const model2 = await parseFile(new File([outBytes], "out.mp4"));
  const v2 = model2.tracks.get(1);
  let bad = 0;
  for (let i = 0; i < v.count; i++) {
    if (v2.dts[i] !== v.dts[i] || v2.cts[i] !== v.cts[i] ||
        v2.duration[i] !== v.duration[i] || v2.size[i] !== v.size[i] ||
        v2.sampleFlags[i] !== v.sampleFlags[i]) bad++;
  }
  console.log(`重解析校验: ${bad === 0 ? "全部样本字段一致" : bad + " 处不符"}，段数 ${model2.fragments.length}`);
  console.log(`总文件 Blob 数模式：输出大小 ${(blob.size / 1048576).toFixed(1)} MiB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
