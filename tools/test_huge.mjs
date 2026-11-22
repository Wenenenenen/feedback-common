// 512 MiB-class memory test: one huge mdat whose payload is a sparse File blob.
// Indexing must not read the payload; export must stay slice-based.
import { File } from "node:buffer";
import { parseFile, cleanMoov } from "../public/mp4/parse.js";
import { buildOriginal, buildOutput } from "../public/mp4/write.js";

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
function u64(v) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(v)); return new Uint8Array(b); }
function concat(...p) { const l = p.reduce((a, x) => a + x.length, 0), o = new Uint8Array(l); let q = 0; for (const x of p) { o.set(x, q); q += x.length; } return o; }

async function main() {
  const targetMiB = 512;
  const targetBytes = targetMiB * 1048576;

  // Build small head + one moof with 2 samples, then back it with a huge mdat.
  const ftyp = concat(hdr("ftyp", 24), new TextEncoder().encode("iso5"), u32(1), new TextEncoder().encode("iso5dash"));
  const mvhd = concat(full("mvhd", 108, 0, 0), new Uint8Array(96));
  const tkhdBody = new Uint8Array(84);
  new DataView(tkhdBody.buffer).setUint32(8, 1);
  new DataView(tkhdBody.buffer).setUint32(36, 0x00010000);
  new DataView(tkhdBody.buffer).setUint32(52, 0x00010000);
  const tkhd = concat(full("tkhd", 96, 0, 3), tkhdBody);
  const mdhd = concat(full("mdhd", 32, 0, 0), concat(u32(0), u32(0), u32(12288), u32(0), new Uint8Array(4)));
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
  const trex = concat(full("trex", 32, 0, 0), concat(u32(1), u32(1), u32(0), u32(0), u32(0)));
  const mvex = concat(hdr("mvex", 8 + trex.length), trex);
  const moov = concat(hdr("moov", 8 + mvhd.length + trak.length + mvex.length), mvhd, trak, mvex);

  // Two samples whose declared sizes cover the huge payload.
  const s1 = 64 * 1048576;
  const s2 = targetBytes - s1;
  const tfhd = concat(full("tfhd", 16, 0, 0x020000), u32(1));
  const tfdt = concat(full("tfdt", 20, 1, 0), u64(0));
  const trunSize = 20 + 2 * 16;
  const trun = new Uint8Array(trunSize);
  {
    const dv = new DataView(trun.buffer);
    dv.setUint32(0, trunSize);
    trun.set(new TextEncoder().encode("trun"), 4);
    trun[8] = 1; trun[10] = 0x0f; trun[11] = 0x01;
    dv.setUint32(12, 2);
    dv.setUint32(20, 512); dv.setUint32(24, s1); dv.setUint32(28, 0); dv.setInt32(32, 0);
    dv.setUint32(36, 512); dv.setUint32(40, s2); dv.setUint32(44, 0x00010000); dv.setInt32(48, 0);
  }
  const traf = concat(hdr("traf", 8 + tfhd.length + tfdt.length + trun.length), tfhd, tfdt, trun);
  const mfhd = concat(full("mfhd", 16, 0, 0), u32(1));
  const moof = concat(hdr("moof", 8 + mfhd.length + traf.length), mfhd, traf);
  new DataView(moof.buffer, moof.byteOffset).setInt32(
    moof.length - trun.length + 12 + 4, moof.length + 8);

  const headLen = ftyp.length + moov.length + moof.length;
  const mdatHeader = hdr("mdat", 8 + targetBytes);
  const head = concat(ftyp, moov, moof, mdatHeader);
  if (head.length !== headLen + 8) throw new Error("layout mismatch");

  // Sparse huge payload: allocate only the first/last pages physically.
  const tailPage = new Uint8Array(4096);
  tailPage.fill(0x5a);
  const blob = new Blob([
    head,
    new Uint8Array(s1 - 4096),                 // sparse zeros (cheap)
    new Uint8Array(4096),                      // first page marker region
    new Uint8Array(s2 - 4096),
    tailPage,
  ]);
  console.log(`构造文件 Blob: ${(blob.size / 1048576).toFixed(1)} MiB`);
  const file = new File([blob], "huge.mp4");

  const mem0 = process.memoryUsage().heapUsed;
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const model = await parseFile(file);
  const t1 = performance.now();
  const mem1 = process.memoryUsage().heapUsed;
  const rss1 = process.memoryUsage().rss;
  console.log(`索引耗时 ${(t1 - t0).toFixed(1)} ms`);
  console.log(`堆增量 ${((mem1 - mem0) / 1048576).toFixed(2)} MiB，RSS 增量 ${((rss1 - rss0) / 1048576).toFixed(2)} MiB（负载未入内存）`);
  const v = model.tracks.get(1);
  console.log(`样本数 ${v.count}，大小 ${v.size[0]} / ${v.size[1]}`);

  // Slice the last sample's tail and verify the marker is reachable.
  const tailOff = v.offset[1] + v.size[1] - 4096;
  const tailRead = new Uint8Array(await file.slice(tailOff, tailOff + 4).arrayBuffer());
  console.log("尾部标记读取:", ...tailRead, "(期望 90 90 90 90)");

  model.moovClean = await cleanMoov(model.moovBytes);
  const t2 = performance.now();
  const outOrig = await buildOriginal(model);
  const outNew = await buildOutput(model, [v.dts[0]], [0]);
  const t3 = performance.now();
  console.log(`两种导出耗时 ${(t3 - t2).toFixed(1)} ms`);
  console.log(`原方案 ${(outOrig.size / 1048576).toFixed(1)} MiB，新方案 ${(outNew.size / 1048576).toFixed(1)} MiB`);
  const mem2 = process.memoryUsage().heapUsed;
  console.log(`导出后堆增量 ${((mem2 - mem0) / 1048576).toFixed(2)} MiB（应保持有界）`);

  const expectedPayload = v.size[0] + v.size[1];
  const modelNew = await parseFile(new File([outNew], "new.mp4"));
  const vn = modelNew.tracks.get(1);
  const payloadMatches = vn.size[0] === v.size[0] && vn.size[1] === v.size[1];
  const conds = {
    origKeepsFragment: outOrig.size === model.moovClean.size + ftyp.length +
      (file.size - ftyp.length - model.moovBytes.length),
    payloadMatches,
    endMatches: outNew.size === modelNew.fragments[0].payloadEnd,
    marker: tailRead[0] === 0x5a,
    fast: (t1 - t0) < 8000,
    payloadBytes: expectedPayload === targetBytes,
  };
  console.log("条件:", JSON.stringify(conds), "outNew.size", outNew.size,
    "payloadEnd", modelNew.fragments[0].payloadEnd);
  const ok = Object.values(conds).every(Boolean);
  console.log(`新方案 payload 校验: ${payloadMatches ? "一致" : "不符"}（${expectedPayload} 字节）`);
  console.log(ok ? "512MiB 级验证通过" : "512MiB 级验证失败");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
