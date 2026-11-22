// New-fragment writer. Each output segment is one moof + one mdat. Sample
// payload bytes are taken from the original File via Blob slices (no copies);
// only boxes and trun/tfdt metadata are materialized.

import { ByteWriter } from "./io.js";

const MAX_U32 = 0xffffffff;

function boxHeader(type, size) {
  const h = new ArrayBuffer(8);
  const dv = new DataView(h);
  const u8 = new Uint8Array(h);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  return u8;
}

function fullHeader(type, size, version, flags) {
  const h = new ArrayBuffer(12);
  const dv = new DataView(h);
  const u8 = new Uint8Array(h);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
  u8[8] = version;
  u8[9] = (flags >>> 16) & 0xff;
  u8[10] = (flags >>> 8) & 0xff;
  u8[11] = flags & 0xff;
  return u8;
}

// Split a run's sample indices into trun groups whose cts offsets share a
// representable version:
//   v0 (u32): any non-negative offset, including > INT32_MAX;
//   v1 (i32): negative offsets and positives <= INT32_MAX.
// A new group is opened whenever the running version cannot represent the
// next value (spec permits separate truns when one version cannot fit them all).
const I32_MAX = 0x7fffffff;
function ctsGroups(track, indices) {
  const groups = [];
  let cur = null;
  const versionFor = (cts, currentVersion) => {
    if (cts < 0) return 1;
    if (currentVersion === 1) return cts <= I32_MAX ? 1 : 0;
    return 0;
  };
  for (const gi of indices) {
    const cts = track.cts[gi];
    const version = cur ? versionFor(cts, cur.version) : cts < 0 ? 1 : 0;
    if (!cur || cur.version !== version) {
      cur = { version, indices: [gi] };
      groups.push(cur);
    } else {
      cur.indices.push(gi);
    }
  }
  return groups;
}

function trunSize(groupCount) {
  // header(12) + sample_count(4) + data_offset(4) + per sample:
  // duration(4) + size(4) + flags(4) + cts(4) = 16
  return 20 + groupCount * 16;
}

function tfhdSize() {
  return 12 + 4; // full header + track_id; default-base-is-moof flag only
}

function tfdtSize() {
  return 12 + 8; // always v1 u64
}

function trafSize(groups) {
  return 8 + tfhdSize() + tfdtSize() + groups.reduce((a, g) => a + trunSize(g.indices.length), 0);
}

function moofSize(trafSizes) {
  return 8 + 16 + trafSizes.reduce((a, s) => a + s, 0); // mfhd = 16
}

function writeTrun(group, track, dataOffset) {
  const n = group.indices.length;
  const w = new ByteWriter(trunSize(n));
  // flags: data-offset(0x1) | sample-duration(0x100) | sample-size(0x200)
  //        | sample-flags(0x400) | sample-cts-offsets(0x800)
  w.bytes(fullHeader("trun", trunSize(n), group.version, 0x000f01));
  w.u32(n);
  const dataOffsetAt = w.length;
  w.i32(dataOffset);
  for (const gi of group.indices) {
    w.u32(track.duration[gi]);
    w.u32(track.size[gi]);
    w.u32(track.sampleFlags[gi]);
    const cts = track.cts[gi];
    if (group.version === 1) {
      if (cts < -0x80000000 || cts > I32_MAX) {
        throw new Error(`trun v1 无法表达 CTS 偏移 ${cts}，分组逻辑有误`);
      }
      w.i32(cts);
    } else {
      if (cts < 0 || cts > MAX_U32) {
        throw new Error(`trun v0 无法表达 CTS 偏移 ${cts}，分组逻辑有误`);
      }
      w.u32(cts);
    }
  }
  return { bytes: w.toUint8Array(), dataOffsetAt };
}

// Build one moof for a segment.
//   plan: [{ track, groups: [{version, indices}] }]
function buildMoof(sequence, plan, moofSizeValue) {
  const parts = [];
  const patches = [];
  parts.push(boxHeader("moof", moofSizeValue));
  parts.push(fullHeader("mfhd", 16, 0, 0));
  const seqBuf = new ArrayBuffer(4);
  new DataView(seqBuf).setUint32(0, sequence);
  parts.push(new Uint8Array(seqBuf));
  // First payload byte (relative to moof start): moof size + mdat header.
  let nextDataOffset = moofSizeValue + 8;
  // Payload is laid out in plan order (all of track 1, then track 2, …).
  const groupOffsets = plan.flatMap((entry) =>
    entry.groups.map((group) => {
      const value = nextDataOffset;
      for (const gi of group.indices) nextDataOffset += entry.track.size[gi];
      return value;
    }));

  let cursor = 8 + 16; // moof header + mfhd
  let go = 0;
  for (const entry of plan) {
    const { track, groups } = entry;
    const tSize = trafSize(groups);
    parts.push(boxHeader("traf", tSize));
    parts.push(fullHeader("tfhd", tfhdSize(), 0, 0x020000)); // default-base-is-moof
    const idBuf = new ArrayBuffer(4);
    new DataView(idBuf).setUint32(0, track.meta.id);
    parts.push(new Uint8Array(idBuf));
    parts.push(fullHeader("tfdt", tfdtSize(), 1, 0));
    const firstGi = groups[0].indices[0];
    const tfdtBuf = new ArrayBuffer(8);
    new DataView(tfdtBuf).setBigUint64(0, track.dts[firstGi]);
    parts.push(new Uint8Array(tfdtBuf));
    cursor += 8 + tfhdSize() + tfdtSize();

    for (const group of groups) {
      const dataOffset = groupOffsets[go++];
      const { bytes, dataOffsetAt } = writeTrun(group, track, dataOffset);
      patches.push({ at: cursor + dataOffsetAt, value: dataOffset });
      parts.push(bytes);
      cursor += bytes.length;
    }
  }

  const moof = new Blob(parts);
  return { moof, patches };
}

// Gather the payload Blob slices in track/run/decode order.
function payloadBlobs(file, plan) {
  const blobs = [];
  let total = 0;
  for (const entry of plan) {
    const track = entry.track;
    for (const group of entry.groups) {
      for (const gi of group.indices) {
        const start = track.offset[gi];
        const size = track.size[gi];
        blobs.push(file.slice(start, start + size));
        total += size;
      }
    }
  }
  return { blobs, total };
}

// Assign samples of one track to segments via boundary DTS values.
// Rule: sample belongs to the last segment whose boundary is <= sample DTS;
// equal timestamps go to the later segment ("同刻进后段").
export function assignSegments(track, boundaries) {
  const n = track.count;
  const segCount = boundaries.length;
  const segments = Array.from({ length: segCount }, () => []);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const dts = track.dts[i];
    while (seg + 1 < segCount && dts >= boundaries[seg + 1]) seg++;
    segments[seg].push(i);
  }
  return segments;
}

// Build the full output file.
//   boundaryDts: BigInt[] on the video track timescale, ascending; the first
//                entry equals the first video sample's DTS.
//   videoCuts:   global decode indices of video keyframes that start segments.
export async function buildOutput(model, boundaryDts, videoCutIndices, onProgress) {
  const { file, ftyp, moovClean, tracks, trackOrder, videoId, audioId } = model;
  if (model.rangeErrors && model.rangeErrors.length > 0) {
    const e = model.rangeErrors[0];
    const where = e.kind === "overlap"
      ? `轨 ${e.a.trackId} 样本 #${e.a.sample} 与轨 ${e.b.trackId} 样本 #${e.b.sample}`
      : `轨 ${e.trackId} 样本 #${e.sample}（偏移 ${e.offset}）`;
    throw new Error(`存在样本${e.kind === "overlap" ? "重叠" : "越界"}（${where}），` +
      "无法保证重封装字节完整，请改用「按原方案导出」。");
  }
  const boundaries = boundaryDts.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const videoTrack = tracks.get(videoId);
  const videoSegs = (() => {
    const segs = Array.from({ length: boundaries.length }, () => []);
    let ci = 0;
    for (let s = 0; s < boundaries.length; s++) {
      const end = s + 1 < boundaries.length ? boundaries[s + 1] : null;
      while (ci < videoTrack.count) {
        const d = videoTrack.dts[ci];
        if (end !== null && d >= end) break;
        segs[s].push(ci);
        ci++;
      }
    }
    return segs;
  })();

  let audioSegs = null;
  if (audioId !== null) {
    const audioTrack = tracks.get(audioId);
    audioSegs = assignSegments(audioTrack, boundaries);
  }

  const pieces = [
    new Blob([ftyp]),
    moovClean,
  ];

  for (let s = 0; s < boundaries.length; s++) {
    const plan = [];
    const vGroups = ctsGroups(videoTrack, videoSegs[s]);
    if (videoSegs[s].length > 0) plan.push({ track: videoTrack, groups: vGroups });
    if (audioSegs) {
      const audioTrack = tracks.get(audioId);
      if (audioSegs[s].length > 0) {
        plan.push({ track: audioTrack, groups: ctsGroups(audioTrack, audioSegs[s]) });
      }
    }
    if (plan.length === 0) continue;

    const trafSizes = plan.map((e) => trafSize(e.groups));
    const mSize = moofSize(trafSizes);
    const { moof, patches } = buildMoof(s + 1, plan, mSize);

    const { blobs, total } = payloadBlobs(file, plan);
    if (total > MAX_U32 - 16) throw new Error(`第 ${s + 1} 段 mdat 超过 32 位盒大小限制`);
    const mdat = new Blob([boxHeader("mdat", 8 + total), ...blobs]);

    // Patch data_offset values into the moof bytes, then emit moof + mdat.
    const moofBytes = await moof.arrayBuffer();
    const dv = new DataView(moofBytes);
    for (const p of patches) dv.setInt32(p.at, p.value);
    pieces.push(new Blob([moofBytes]));
    pieces.push(mdat);

    if (onProgress) onProgress({ segment: s + 1, total: boundaries.length });
  }

  return new Blob(pieces, { type: "video/mp4" });
}

// Re-export the original-fragment export. moof/mdat payload bytes are kept
// verbatim; explicit base_data_offset values are relocated because the moov
// cleanup shifts every fragment's absolute file position.
export async function buildOriginal(model) {
  const { file, ftyp, moovClean, fragments } = model;
  const pieces = [new Blob([ftyp]), moovClean];

  // New position of each fragment's moof after the cleaned head.
  let cursor = ftyp.length + moovClean.size;
  const newMoofStart = [];
  for (const f of fragments) {
    newMoofStart.push(cursor);
    cursor += f.moofSize + (f.payloadEnd - f.mdatStart);
  }

  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i];
    let moofPart = file.slice(f.moofStart, f.moofStart + f.moofSize);
    if (f.baseRelocs.length > 0) {
      const bytes = new Uint8Array(await moofPart.arrayBuffer());
      const dv = new DataView(bytes.buffer);
      const delta = BigInt(newMoofStart[i] - f.moofStart);
      for (const rel of f.baseRelocs) {
        dv.setBigUint64(rel.localOffset, BigInt(rel.oldBase) + delta);
      }
      moofPart = new Blob([bytes]);
    }
    pieces.push(moofPart);
    pieces.push(file.slice(f.mdatStart, f.payloadEnd));
  }
  return new Blob(pieces, { type: "video/mp4" });
}
