// Synthetic fMP4 generator for parser coverage. Builds minimal valid files
// (ftyp + moov with trex, moof/mdat fragments) and deliberately-broken variants.
import { writeFile } from "node:fs/promises";

function hdr(type, size) {
  const b = new ArrayBuffer(8);
  const dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  return new Uint8Array(b);
}
function full(type, size, ver, flags) {
  const b = new ArrayBuffer(12);
  const dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  u8[8] = ver;
  u8[9] = (flags >>> 16) & 0xff;
  u8[10] = (flags >>> 8) & 0xff;
  u8[11] = flags & 0xff;
  return new Uint8Array(b);
}
function u32(v) { const b = new ArrayBuffer(4); new DataView(b).setUint32(0, v >>> 0); return new Uint8Array(b); }
function i32(v) { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, v | 0); return new Uint8Array(b); }
function u64(v) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(v)); return new Uint8Array(b); }
function u16(v) { const b = new ArrayBuffer(2); new DataView(b).setUint16(0, v); return new Uint8Array(b); }
function raw(n, seed) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (seed + i) & 0xff; return a; }

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

// Minimal stsd with avc1/mp4a-free sample entry (only outer box required).
function stsdBox(kind) {
  const entryType = kind === "vide" ? "avc1" : "mp4a";
  const entryBody = new Uint8Array(78); // reserved(6)+dri(2)+reserved(16)*... padding
  const entry = concat(hdr(entryType, 8 + entryBody.length), entryBody);
  return concat(full("stsd", 12 + 4 + entry.length, 0, 0), u32(1), entry);
}

function emptyStbl(kind) {
  const stts = concat(full("stts", 12 + 4, 0, 0), u32(0));
  const stsc = concat(full("stsc", 12 + 4, 0, 0), u32(0));
  const stsz = concat(full("stsz", 12 + 8, 0, 0), u32(0), u32(0));
  const stco = concat(full("stco", 12 + 4, 0, 0), u32(0));
  const inner = concat(stsdBox(kind), stts, stsc, stsz, stco);
  return concat(hdr("stbl", 8 + inner.length), inner);
}

function mdhd(ts) {
  // v0: flags, creation, modification, timescale, duration, lang+quality
  const body = concat(u32(0), u32(0), u32(ts), u32(0), new Uint8Array(4));
  return concat(full("mdhd", 12 + body.length, 0, 0), body);
}
function hdlr(kind) {
  const body = concat(u32(0), new TextEncoder().encode(kind), new Uint8Array(12));
  return concat(full("hdlr", 12 + body.length, 0, 0), body);
}
function mediaHeader(type, flags, bodyLen) {
  return concat(full(type, 12 + bodyLen, 0, flags), new Uint8Array(bodyLen));
}
function vmhd() { return mediaHeader("vmhd", 1, 8); }  // graphicsmode + opcolor
function smhd() { return mediaHeader("smhd", 0, 0); }
function dinf() {
  const url = full("url ", 12, 0, 1);
  const dref = concat(full("dref", 12 + 4 + url.length, 0, 0), u32(1), url);
  return concat(hdr("dinf", 8 + dref.length), dref);
}
function minf(kind) {
  const inner = concat(kind === "vide" ? vmhd() : smhd(), dinf(), emptyStbl(kind));
  return concat(hdr("minf", 8 + inner.length), inner);
}
function mdia(kind, ts) {
  const inner = concat(mdhd(ts), hdlr(kind), minf(kind));
  return concat(hdr("mdia", 8 + inner.length), inner);
}
function tkhd(id) {
  // v0 tkhd body: creation(4) modification(4) trackID(4) reserved(4) duration(4)
  // reserved(8) layer+altgroup(4) volume(2) reserved(2) matrix(36) width(4) height(4)
  const body = new Uint8Array(84);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, id);
  // identity matrix at offset 36
  dv.setUint32(36, 0x00010000);
  dv.setUint32(52, 0x00010000);
  return concat(full("tkhd", 12 + body.length, 0, 0x3), body);
}
function trak(id, kind, ts) {
  const inner = concat(tkhd(id), mdia(kind, ts));
  return concat(hdr("trak", 8 + inner.length), inner);
}
function trex(id) {
  const body = concat(u32(id), u32(1), u32(0), u32(0), u32(0));
  return concat(full("trex", 12 + body.length, 0, 0), body);
}
function mvex(ids) {
  const inner = concat(...ids.map(trex));
  return concat(hdr("mvex", 8 + inner.length), inner);
}
function mvhd() {
  const body = new Uint8Array(96);
  return concat(full("mvhd", 12 + body.length, 0, 0), body);
}
function moov(ids, kinds, tss) {
  const inner = concat(mvhd(), ...ids.map((id, i) => trak(id, kinds[i], tss[i])), mvex(ids));
  return concat(hdr("moov", 8 + inner.length), inner);
}
function ftyp() {
  return concat(hdr("ftyp", 24), new TextEncoder().encode("iso5"), u32(1), new TextEncoder().encode("iso5dash"));
}

// Build one fragment.
// opts: {
//   seq, trackId, tfdtVer(0|1), tfdt, baseMode: 'moof'|'explicit',
//   trunVer, dataOffset: number|null, firstSampleFlags?: number,
//   perSample: bool flags (dur,size,sampFlags,cts), tfDefaults,
//   samples: [{dur,size,flags?,cts?}], payloadSeed, broken?: 'overrun'|'overlap'
// }
function fragment(opts) {
  const tfFlags = (opts.baseMode === "moof" ? 0x020000 : 0x000001)
    | (opts.tfDefaults?.duration != null ? 0x08 : 0)
    | (opts.tfDefaults?.size != null ? 0x10 : 0)
    | (opts.tfDefaults?.flags != null ? 0x20 : 0);
  const tfBody = [u32(opts.trackId)];
  // explicit base patched later as placeholder u64
  if (opts.baseMode === "explicit") tfBody.push(new Uint8Array(8));
  if (opts.tfDefaults?.duration != null) tfBody.push(u32(opts.tfDefaults.duration));
  if (opts.tfDefaults?.size != null) tfBody.push(u32(opts.tfDefaults.size));
  if (opts.tfDefaults?.flags != null) tfBody.push(u32(opts.tfDefaults.flags));
  const tfhd = concat(full("tfhd", 12 + concat(...tfBody).length, 0, tfFlags), ...tfBody);

  const tfdtBody = opts.tfdtVer === 1 ? u64(opts.tfdt) : u32(Number(opts.tfdt));
  const tfdt = concat(full("tfdt", 12 + tfdtBody.length, opts.tfdtVer, 0), tfdtBody);

  const pf = opts.perSample || {};
  let trFlags = (opts.dataOffset != null ? 0x01 : 0)
    | (opts.firstSampleFlags != null ? 0x04 : 0)
    | (pf.dur ? 0x100 : 0)
    | (pf.size ? 0x200 : 0)
    | (pf.flags ? 0x400 : 0)
    | (pf.cts ? 0x800 : 0);
  const trHead = [u32(opts.samples.length)];
  if (opts.dataOffset != null) trHead.push(i32(opts.dataOffset));
  if (opts.firstSampleFlags != null) trHead.push(u32(opts.firstSampleFlags));
  const trSamples = opts.samples.map((s, i) =>
    opts.broken === "overrun" && i === opts.samples.length - 1
      ? { ...s, size: s.size + 16 } : s);
  for (const s of trSamples) {
    if (pf.dur) trHead.push(u32(s.dur));
    if (pf.size) trHead.push(u32(s.size));
    if (pf.flags) trHead.push(u32(s.flags ?? 0));
    if (pf.cts) trHead.push(opts.trunVer === 1 ? i32(s.cts ?? 0) : u32(s.cts ?? 0));
  }
  const trun = concat(full("trun", 12 + concat(...trHead).length, opts.trunVer, trFlags), ...trHead);
  const traf = concat(hdr("traf", 8 + tfhd.length + tfdt.length + trun.length), tfhd, tfdt, trun);
  const mfhd = concat(full("mfhd", 16, 0, 0), u32(opts.seq));
  const moof = concat(hdr("moof", 8 + mfhd.length + traf.length), mfhd, traf);

  // Payload always uses the original declared sizes; overrun is expressed only
  // in the trun so the last interval extends past mdat.
  const payload = concat(...opts.samples.map((s, i) => {
    const seed = opts.payloadSeed + i;
    return raw(s.size, seed);
  }));
  const mdat = concat(hdr("mdat", 8 + payload.length), payload);
  return { moof, mdat, payloadLen: payload.length };
}

export async function buildCaseA() {
  // Explicit u64 base, tfdt v0, trun v0 (u32 cts), no data_offset on a 2nd trun,
  // default-value chains via tfhd/trex, first_sample_flags in use.
  const head = concat(ftyp(), moov([1, 2], ["vide", "soun"], [90000, 48000]));
  const s1 = [
    { dur: 3000, size: 100, cts: 0 },
    { dur: 3000, size: 80, cts: 3000 },
    { dur: 3000, size: 70, cts: -1 }, // -1 as u32 => 0xffffffff to test v0 handling
  ];
  const f1v = fragment({
    seq: 1, trackId: 1, tfdtVer: 0, tfdt: 0n, baseMode: "explicit",
    trunVer: 0, dataOffset: 0, // patched: explicit base will point at payload
    firstSampleFlags: 0x02000000,
    perSample: { dur: true, size: true, cts: true },
    samples: s1, payloadSeed: 11,
  });
  const f1a = fragment({
    seq: 1, trackId: 2, tfdtVer: 1, tfdt: 0n, baseMode: "moof",
    trunVer: 1, dataOffset: 100 + 80 + 70,
    tfDefaults: { duration: 1024, size: 40, flags: 0x02000000 },
    perSample: { size: true },
    samples: [{ size: 40 }, { size: 42 }, { size: 38 }],
    payloadSeed: 99,
  });
  // Merge both trafs into one moof manually.
  const trafV = extractBox(f1v.moof, "traf");
  const trafA = extractBox(f1a.moof, "traf");
  const moof1 = concat(hdr("moof", 8 + 16 + trafV.length + trafA.length),
    concat(full("mfhd", 16, 0, 0), u32(1)), trafV, trafA);
  // payload: video samples then audio samples
  const payload1 = concat(
    ...s1.map((s, i) => raw(s.size, 11 + i)),
    raw(40, 99), raw(42, 100), raw(38, 101),
  );
  const mdat1 = concat(hdr("mdat", 8 + payload1.length), payload1);

  // Patch explicit base_data_offset of video tfhd (first u64 after tfhd hdr+trackid).
  const file1 = concat(head, moof1, mdat1);
  const payloadAbs = head.length + moof1.length + 8;
  // locate 'tfhd' in moof1
  const tfhdAt = indexOfFourcc(file1, "tfhd", head.length);
  // fullbox(12) then track_id u32 then base u64
  new DataView(file1.buffer, file1.byteOffset).setBigUint64(tfhdAt + 12 + 4, BigInt(payloadAbs));
  // audio data_offset is relative to its moof start (default-base-is-moof)
  const moof1Start = head.length;
  const trunAAt = indexOfFourcc(file1, "trun", tfhdAt);
  // trun full header 12, sample_count 4, then data_offset i32
  const audioTrunAt = lastIndexOfFourcc(file1, "trun");
  new DataView(file1.buffer, file1.byteOffset).setInt32(audioTrunAt + 12 + 4,
    payloadAbs - moof1Start + 100 + 80 + 70);

  // Fragment 2: tfdt v1, trun v1, two truns in one traf, second without
  // data_offset (must continue at first trun's end).
  const s2a = [{ dur: 3000, size: 60, cts: 0, flags: 0x01000000 }];
  const s2b = [{ dur: 3000, size: 55, cts: -1500 }];
  const f2v1 = fragment({
    seq: 2, trackId: 1, tfdtVer: 1, tfdt: 9000n, baseMode: "moof",
    trunVer: 1, dataOffset: 0, // patched relative
    perSample: { dur: true, size: true, flags: true, cts: true },
    samples: s2a, payloadSeed: 200,
  });
  const f2v2 = fragment({
    seq: 2, trackId: 1, tfdtVer: 1, tfdt: 9000n, baseMode: "moof",
    trunVer: 1, dataOffset: null,
    perSample: { dur: true, size: true, cts: true },
    samples: s2b, payloadSeed: 210,
  });
  // Need a single traf with two truns: build directly from box pieces.
  const trun1 = extractBox(f2v1.moof, "trun");
  const trun2Raw = extractBox(f2v2.moof, "trun"); // dataOffset: null => no offset field
  const tfhd2 = extractBox(f2v1.moof, "tfhd");
  const tfdt2 = extractBox(f2v1.moof, "tfdt");
  const traf2 = concat(hdr("traf", 8 + tfhd2.length + tfdt2.length + trun1.length + trun2Raw.length),
    tfhd2, tfdt2, trun1, trun2Raw);
  const moof2 = concat(hdr("moof", 8 + 16 + traf2.length),
    concat(full("mfhd", 16, 0, 0), u32(2)), traf2);
  const payload2 = concat(raw(60, 200), raw(55, 210));
  const mdat2 = concat(hdr("mdat", 8 + payload2.length), payload2);
  const file2 = concat(file1, moof2, mdat2);
  const p2abs = file1.length + moof2.length + 8;
  const trun1At = indexOfFourcc(file2, "trun", file1.length);
  new DataView(file2.buffer, file2.byteOffset).setInt32(trun1At + 12 + 4,
    p2abs - file1.length);

  await writeFile("/tmp/syn_valid.mp4", file2);
  return { path: "/tmp/syn_valid.mp4", bytes: file2 };
}

export async function buildBroken(kind) {
  const head = concat(ftyp(), moov([1], ["vide"], [90000]));
  const samples = [{ dur: 3000, size: 100, cts: 0 }, { dur: 3000, size: 100, cts: 0 }];
  const f = fragment({
    seq: 1, trackId: 1, tfdtVer: 0, tfdt: 0n, baseMode: "moof",
    trunVer: 1, dataOffset: 0,
    perSample: { dur: true, size: true, cts: true },
    samples, payloadSeed: 7, broken: kind,
  });
  let file = concat(head, f.moof, f.mdat);
  const payloadAbs = head.length + f.moof.length + 8;
  const trunAt = indexOfFourcc(file, "trun");
  new DataView(file.buffer, file.byteOffset).setInt32(trunAt + 12 + 4,
    payloadAbs - head.length);

  if (kind === "overlap") {
    // Two truns, the second pointing back into the first sample's range.
    const tr2 = fragment({
      seq: 1, trackId: 1, tfdtVer: 0, tfdt: 6000n, baseMode: "moof",
      trunVer: 1, dataOffset: 40, // overlaps sample 1 [0,100) -> [40,140)
      perSample: { dur: true, size: true, cts: true },
      samples: [{ dur: 3000, size: 100, cts: 0 }],
      payloadSeed: 30,
    });
    const trafOrig = extractBox(f.moof, "traf");
    const tr2Box = extractBox(tr2.moof, "trun");
    const tfhdB = extractBox(f.moof, "tfhd");
    const tfdtB = concat(full("tfdt", 12 + 4, 0, 0), u32(6000));
    const trafNew = concat(
      hdr("traf", 8 + tfhdB.length + tfdtB.length + tr2Box.length),
      tfhdB, tfdtB, tr2Box);
    const moofNew = concat(
      hdr("moof", 8 + 16 + trafOrig.length + trafNew.length),
      concat(full("mfhd", 16, 0, 0), u32(1)), trafOrig, trafNew);
    const payload = concat(raw(100, 7), raw(100, 8));
    const mdatNew = concat(hdr("mdat", 8 + payload.length), payload);
    file = concat(head, moofNew, mdatNew);
    // patch both trun data_offsets relative to moof start
    const truns = allIndexOfFourcc(file, "trun", head.length);
    const dv = new DataView(file.buffer, file.byteOffset);
    dv.setInt32(truns[0] + 12 + 4, moofNew.length + 8);
    dv.setInt32(truns[1] + 12 + 4, moofNew.length + 8 + 40);
  }

  const path = `/tmp/syn_${kind}.mp4`;
  await writeFile(path, file);
  return { path, bytes: file };
}

function indexOfFourcc(bytes, type, from = 0) {
  const key = new TextEncoder().encode(type);
  for (let i = from; i <= bytes.length - 4; i++) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] && bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) return i - 4;
  }
  throw new Error("fourcc not found: " + type);
}
function lastIndexOfFourcc(bytes, type) {
  const key = new TextEncoder().encode(type);
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] && bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) return i - 4;
  }
  throw new Error("fourcc not found: " + type);
}
function allIndexOfFourcc(bytes, type, from = 0) {
  const key = new TextEncoder().encode(type);
  const out = [];
  for (let i = from; i <= bytes.length - 4; i++) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] && bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) out.push(i - 4);
  }
  return out;
}
function findBox(bytes, type) {
  // relative offset of the box (header start) within bytes
  return indexOfFourcc(bytes, type) + 4;
}

// Extract a complete child box (header included) by fourcc.
function extractBox(bytes, type) {
  const key = new TextEncoder().encode(type);
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] &&
        bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) {
      const start = i - 4;
      const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(start);
      return bytes.subarray(start, start + size);
    }
  }
  throw new Error("box not found: " + type);
}
