// fMP4 parser. Reads box headers and fragment metadata only; mdat payloads are
// never loaded into memory (the original File is kept for later slice copies).

import { ByteReader } from "./io.js";

const CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "dinf", "moof", "traf",
]);

const INDEX_BOXES = new Set([
  "stts", "ctts", "stsc", "stsz", "stco", "co64", "stss", "stsh",
]);

const U64_MAX = (1n << 64n) - 1n;

// Sliding-window reader over a File: sequential metadata reads stay in one
// ArrayBuffer window; seeking past an mdat just moves the window.
class FileWindow {
  constructor(file, windowSize = 1 << 20) {
    this.file = file;
    this.windowSize = windowSize;
    this.base = 0;
    this.buf = new ArrayBuffer(0);
  }

  async readAt(offset, n) {
    if (offset < this.base || offset + n > this.base + this.buf.byteLength) {
      const size = Math.max(this.windowSize, n);
      this.buf = await this.file.slice(offset, offset + size).arrayBuffer();
      this.base = offset;
    }
    return new Uint8Array(this.buf, offset - this.base, n).slice();
  }
}

async function readHeader(win, offset) {
  const hdr = await win.readAt(offset, 8);
  const dv = new DataView(hdr.buffer);
  let size = dv.getUint32(0);
  const type = String.fromCharCode(...hdr.subarray(4, 8));
  let headerSize = 8;
  if (size === 1) {
    const ext = await win.readAt(offset + 8, 8);
    size = Number(new DataView(ext.buffer).getBigUint64(0));
    headerSize = 16;
    if (size < 16) {
      throw new Error(`盒 ${type}（偏移 ${offset}）扩展大小 ${size} 小于 16 字节头`);
    }
  }
  return { type, size, headerSize, start: offset };
}

function fullBox(r) {
  const version = r.u8();
  const flags = r.u24();
  return { version, flags };
}

// Per-track columnar sample storage (decode order).
function makeTrack(meta) {
  return {
    meta,
    count: 0,
    cap: 0,
    dts: null,          // BigUint64Array
    cts: null,          // Float64Array (holds full u32 or i32 range exactly)
    pts: null,          // BigInt64Array when PTS fits, otherwise Array
    ptsFallback: false,
    duration: null,
    size: null,
    sampleFlags: null,
    offset: null,       // absolute file offset, file <= 512 MiB
    frag: null,
    displayOrder: null,
  };
}

function ensureCapacity(t, n) {
  if (n <= t.cap) return;
  const cap = Math.max(n, t.cap * 2, 1024);
  const grow = (arr, Ctor) => {
    const next = new Ctor(cap);
    if (arr) next.set(arr);
    return next;
  };
  t.dts = grow(t.dts, BigUint64Array);
  t.cts = grow(t.cts, Float64Array);
  t.duration = grow(t.duration, Uint32Array);
  t.size = grow(t.size, Uint32Array);
  t.sampleFlags = grow(t.sampleFlags, Uint32Array);
  t.offset = grow(t.offset, Uint32Array);
  t.frag = grow(t.frag, Uint32Array);
  t.cap = cap;
}

function trimTrack(t) {
  const n = t.count;
  t.dts = t.dts.slice(0, n);
  t.cts = t.cts.slice(0, n);
  t.duration = t.duration.slice(0, n);
  t.size = t.size.slice(0, n);
  t.sampleFlags = t.sampleFlags.slice(0, n);
  t.offset = t.offset.slice(0, n);
  t.frag = t.frag.slice(0, n);
}

// Build a moov copy with legacy sample index boxes removed.
export function cleanMoov(moovBytes) {
  const r = new ByteReader(moovBytes.buffer, moovBytes.byteOffset,
    moovBytes.byteOffset + moovBytes.byteLength);

  function header(type, size) {
    const h = new ArrayBuffer(8);
    const dv = new DataView(h);
    const u8 = new Uint8Array(h);
    dv.setUint32(0, size);
    for (let i = 0; i < 4; i++) u8[i + 4] = type.charCodeAt(i);
    return u8;
  }

  // Returns pieces for all boxes inside the reader; index boxes are dropped.
  function keepChildren(parentReader) {
    const out = [];
    while (parentReader.remaining() > 0) {
      const box = parentReader.readBox();
      const { type, headerSize, bodyStart } = box;
      const raw = parentReader.u8a.subarray(
        bodyStart, bodyStart + (box.size - headerSize));
      if (INDEX_BOXES.has(type)) continue;
      if (CONTAINERS.has(type)) {
        const sub = new ByteReader(raw.buffer, raw.byteOffset,
          raw.byteOffset + raw.byteLength);
        const cleaned = keepChildren(sub);
        const innerLen = cleaned.reduce((a, c) => a + c.byteLength, 0);
        out.push(header(type, 8 + innerLen), ...cleaned);
      } else {
        out.push(header(type, box.size), raw);
      }
    }
    return out;
  }

  // The input is the full moov box (header included).
  const moovSize = r.u32();
  const moovType = r.fourcc();
  if (moovType !== "moov") throw new Error("cleanMoov 输入不是 moov 盒");
  const inner = keepChildren(r);
  const innerLen = inner.reduce((a, c) => a + c.byteLength, 0);
  return new Blob([header("moov", 8 + innerLen), ...inner]);
}

export async function parseFile(file, onProgress = null) {
  const win = new FileWindow(file);
  const fileSize = file.size;

  // ---- top-level scan -----------------------------------------------------
  const top = [];
  let offset = 0;
  while (offset < fileSize) {
    const box = await readHeader(win, offset);
    if (box.size < 8 || offset + box.size > fileSize) {
      throw new Error(`顶层盒 ${box.type}（偏移 ${offset}）大小 ${box.size} 越界`);
    }
    if (box.size === 0 && offset + box.headerSize !== fileSize) {
      throw new Error("size=0 只允许用于文件末尾顶层盒");
    }
    top.push(box);
    offset += box.size;
  }

  let ftyp = null;
  let moovBox = null;
  const fragments = [];
  const mdatRanges = [];
  let pendingMoof = null;

  for (let i = 0; i < top.length; i++) {
    const box = top[i];
    if (box.type === "ftyp") {
      ftyp = await win.readAt(box.start, box.size);
    } else if (box.type === "moov") {
      moovBox = box;
    } else if (box.type === "moof") {
      if (pendingMoof) throw new Error("moof 后缺少后继 mdat");
      pendingMoof = box;
    } else if (box.type === "mdat") {
      if (!pendingMoof) throw new Error(`mdat（偏移 ${box.start}）没有对应的 moof`);
      const payloadStart = box.start + box.headerSize;
      mdatRanges.push({ start: payloadStart, end: box.start + box.size });
      fragments.push({ moof: pendingMoof, mdat: box, payloadStart, payloadEnd: box.start + box.size });
      pendingMoof = null;
    }
  }
  if (pendingMoof) throw new Error("文件末尾的 moof 缺少后继 mdat");
  if (!ftyp) throw new Error("缺少 ftyp 盒");
  if (!moovBox) throw new Error("缺少前置 moov 盒");
  const firstMoof = top.find((b) => b.type === "moof");
  if (firstMoof && moovBox.start > firstMoof.start) {
    throw new Error("moov 必须位于所有 moof 之前（仅支持前置 moov）");
  }
  if (fragments.length === 0) throw new Error("缺少 moof/mdat 分片");

  // ---- moov: tracks and trex ---------------------------------------------
  const moovBytes = await win.readAt(moovBox.start, moovBox.size);
  const trackMeta = new Map();
  {
    const r = new ByteReader(moovBytes.buffer, moovBytes.byteOffset,
      moovBytes.byteOffset + moovBytes.byteLength);
    let trak = null;
    function walk(cr) {
      while (cr.remaining() > 0) {
        const box = cr.readBox();
        const bType = box.type;
        const body = box.body;
        if (bType === "trak") {
          trak = { id: null, timescale: null, handler: null, trex: null };
          walk(body);
          if (trak.id == null) throw new Error("trak 缺少 tkhd 轨标识");
          trackMeta.set(trak.id, trak);
          trak = null;
        } else if (bType === "tkhd") {
          const { version } = fullBox(body);
          if (version === 1) { body.u64(); body.u64(); }
          else { body.u32(); body.u32(); }
          trak.id = body.u32();
        } else if (bType === "mdhd") {
          const { version } = fullBox(body);
          if (version === 1) { body.u64(); body.u64(); }
          else { body.u32(); body.u32(); }
          trak.timescale = body.u32();
        } else if (bType === "hdlr") {
          fullBox(body);
          body.u32();
          trak.handler = body.fourcc();
        } else if (bType === "trex") {
          fullBox(body);
          const tid = body.u32();
          const trex = {
            descriptionIndex: body.u32(),
            defaultDuration: body.u32(),
            defaultSize: body.u32(),
            defaultFlags: body.u32(),
          };
          // trex lives in mvex outside trak; attach by id.
          if (!trackMeta.has(tid)) trackMeta.set(tid, { id: tid, timescale: null, handler: null, trex: null });
          trackMeta.get(tid).trex = trex;
        } else if (CONTAINERS.has(bType)) {
          walk(body);
        }
      }
    }
    walk(r);
  }

  const videoTracks = [...trackMeta.values()].filter((t) => t.handler === "vide");
  const audioTracks = [...trackMeta.values()].filter((t) => t.handler === "soun");
  if (videoTracks.length !== 1) throw new Error(`要求恰好一条视频轨，实际 ${videoTracks.length} 条`);
  if (audioTracks.length > 1) throw new Error(`至多一条音轨，实际 ${audioTracks.length} 条`);
  for (const t of trackMeta.values()) {
    if (!t.trex) throw new Error(`轨 ${t.id} 缺少 trex 默认值`);
    if (!t.timescale) throw new Error(`轨 ${t.id} 缺少 mdhd 时标`);
  }
  const trackOrder = [videoTracks[0].id, ...audioTracks.map((t) => t.id)];
  const tracks = new Map();
  for (const id of trackOrder) tracks.set(id, makeTrack(trackMeta.get(id)));

  // ---- fragments -----------------------------------------------------------
  const rangeErrors = [];
  const intervals = [];
  const expectedDts = new Map();

  for (let fi = 0; fi < fragments.length; fi++) {
    const { moof, mdat } = fragments[fi];
    const moofBytes = await win.readAt(moof.start, moof.size);
    const mr = new ByteReader(moofBytes.buffer, moofBytes.byteOffset,
      moofBytes.byteOffset + moofBytes.byteLength);
    let sequence = null;
    const trafs = [];

    function walkMoof(r) {
      while (r.remaining() > 0) {
        const box = r.readBox();
        const { type: bType, body } = box;
        if (bType === "mfhd") {
          fullBox(body);
          sequence = body.u32();
        } else if (bType === "traf") {
          // Collected for separate parsing; do not descend here.
          trafs.push(body);
        } else if (CONTAINERS.has(bType)) {
          walkMoof(body);
        }
      }
    }
    walkMoof(mr);
    if (trafs.length === 0) throw new Error(`片段 ${fi + 1} 缺少 traf`);
    fragments[fi].sequence = sequence ?? fi + 1;

    for (const trafReader of trafs) {
      let tfhd = null;
      let tfdt = null;
      const trunBoxes = [];
      while (trafReader.remaining() > 0) {
        const box = trafReader.readBox();
        const { type: bType, body } = box;
        if (bType === "tfhd") tfhd = { ...fullBox(body), body };
        else if (bType === "tfdt") tfdt = { ...fullBox(body), body };
        else if (bType === "trun") trunBoxes.push({ ...fullBox(body), body });
      }
      if (!tfhd) throw new Error(`片段 ${fi + 1} 的 traf 缺少 tfhd`);
      if (!tfdt) throw new Error(`片段 ${fi + 1} 的 traf 缺少 tfdt`);
      if (trunBoxes.length === 0) throw new Error(`片段 ${fi + 1} 的 traf 缺少 trun`);

      const { body: tb, flags: tfFlags } = tfhd;
      const trackId = tb.u32();
      const track = tracks.get(trackId);
      if (!track) throw new Error(`片段 ${fi + 1} 引用了未知轨 ${trackId}`);
      const trex = track.meta.trex;

      const hasBaseOffset = (tfFlags & 0x000001) !== 0;
      const baseIsMoof = (tfFlags & 0x020000) !== 0;
      if (hasBaseOffset === baseIsMoof) {
        throw new Error(`片段 ${fi + 1} 轨 ${trackId}：显式 base-data-offset 与 default-base-is-moof 必须二选一`);
      }
      let base;
      let baseOffsetLocal = null;
      if (hasBaseOffset) {
        // Position of the u64 field relative to the moof box start; the moof
        // bytes live in their own copied ArrayBuffer beginning at zero.
        baseOffsetLocal = tb.pos - moofBytes.byteOffset;
        const b64 = tb.u64();
        if (b64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`片段 ${fi + 1} 轨 ${trackId}：基址超出安全整数范围`);
        }
        base = Number(b64);
        fragments[fi].baseRelocs = fragments[fi].baseRelocs || [];
        fragments[fi].baseRelocs.push({ localOffset: baseOffsetLocal, oldBase: base });
      } else {
        base = moof.start;
      }
      const tfDefaultDuration = (tfFlags & 0x000008) ? tb.u32() : null;
      const tfDefaultSize = (tfFlags & 0x000010) ? tb.u32() : null;
      const tfDefaultFlags = (tfFlags & 0x000020) ? tb.u32() : null;
      if (tfFlags & 0x000002) tb.u32(); // sample description index, not needed

      if (tfdt.version !== 0 && tfdt.version !== 1) {
        throw new Error(`片段 ${fi + 1} 轨 ${trackId}：tfdt 版本 ${tfdt.version} 不支持`);
      }
      const baseDts = tfdt.version === 1 ? tfdt.body.u64() : BigInt(tfdt.body.u32());
      if (baseDts < 0n) throw new Error("tfdt 不能为负");
      if (expectedDts.has(trackId) && expectedDts.get(trackId) !== baseDts) {
        throw new Error(
          `片段 ${fi + 1} 轨 ${trackId}：tfdt=${baseDts} 与前段结束 DTS=${expectedDts.get(trackId)} 不连续`);
      }

      let cursor = base;
      let runDts = baseDts;
      for (let ri = 0; ri < trunBoxes.length; ri++) {
        const tr = trunBoxes[ri];
        const { body: rb, flags: trFlags, version } = tr;
        if ((trFlags & 0x000004) && (trFlags & 0x000400)) {
          throw new Error(`片段 ${fi + 1} 轨 ${trackId}：first-sample-flags 与逐样本 flags 互斥`);
        }
        const count = rb.u32();
        if (count === 0) throw new Error(`片段 ${fi + 1} 轨 ${trackId}：trun 不允许为空`);
        const hasDataOffset = (trFlags & 0x000001) !== 0;
        const hasFirstFlags = (trFlags & 0x000004) !== 0;
        const hasDur = (trFlags & 0x000100) !== 0;
        const hasSize = (trFlags & 0x000200) !== 0;
        const hasFlags = (trFlags & 0x000400) !== 0;
        const hasCts = (trFlags & 0x000800) !== 0;
        const dataOffset = hasDataOffset ? rb.i32() : null;
        const firstFlags = hasFirstFlags ? rb.u32() : null;

        const runStart = dataOffset === null ? cursor : base + dataOffset;
        let sampleCursor = runStart;

        ensureCapacity(track, track.count + count);
        for (let si = 0; si < count; si++) {
          const duration = hasDur ? rb.u32()
            : tfDefaultDuration !== null ? tfDefaultDuration : trex.defaultDuration;
          const size = hasSize ? rb.u32()
            : tfDefaultSize !== null ? tfDefaultSize : trex.defaultSize;
          let flags;
          if (si === 0 && firstFlags !== null) flags = firstFlags;
          else if (hasFlags) flags = rb.u32();
          else if (tfDefaultFlags !== null) flags = tfDefaultFlags;
          else flags = trex.defaultFlags;
          let cts = 0;
          if (hasCts) cts = version === 1 ? rb.i32() : rb.u32();

          if (duration <= 0) throw new Error(`片段 ${fi + 1} 轨 ${trackId} 样本 ${si}：时长须为正`);
          if (size <= 0) throw new Error(`片段 ${fi + 1} 轨 ${trackId} 样本 ${si}：大小须为正`);

          const gi = track.count;
          track.dts[gi] = runDts;
          track.cts[gi] = cts;
          track.duration[gi] = duration;
          track.size[gi] = size;
          track.sampleFlags[gi] = flags;
          track.offset[gi] = sampleCursor;
          track.frag[gi] = fi;
          intervals.push({ offset: sampleCursor, end: sampleCursor + size, trackId, gi, fi });

          runDts += BigInt(duration);
          if (runDts > U64_MAX) {
            throw new Error(`片段 ${fi + 1} 轨 ${trackId}：样本结束 DTS 超出 u64`);
          }
          sampleCursor += size;
          track.count = gi + 1;
        }
        cursor = sampleCursor;
      }
      expectedDts.set(trackId, runDts);
    }
    if (onProgress) onProgress({ fragments: fi + 1, total: fragments.length });
  }

  // columnar arrays are already populated to track.count
  for (const t of tracks.values()) trimTrack(t);

  const videoId = trackOrder[0];
  if (tracks.get(videoId).count === 0) throw new Error("视频轨至少需要一个样本");

  // ---- payload range & overlap checks -------------------------------------
  const mdatSorted = [...mdatRanges].sort((a, b) => a.start - b.start);
  function findMdat(pos) {
    let lo = 0, hi = mdatSorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = mdatSorted[mid];
      if (pos < m.start) hi = mid - 1;
      else if (pos >= m.end) lo = mid + 1;
      else return m;
    }
    return null;
  }

  for (const iv of intervals) {
    const m = findMdat(iv.offset);
    if (!m || iv.end > m.end) {
      rangeErrors.push({
        kind: "out-of-mdat",
        trackId: iv.trackId, sample: iv.gi, fragment: iv.fi + 1,
        offset: iv.offset, end: iv.end,
      });
    }
  }
  intervals.sort((a, b) => a.offset - b.offset || a.end - b.end);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].offset < intervals[i - 1].end) {
      const a = intervals[i - 1], b = intervals[i];
      rangeErrors.push({
        kind: "overlap",
        a: { trackId: a.trackId, sample: a.gi, fragment: a.fi + 1, offset: a.offset },
        b: { trackId: b.trackId, sample: b.gi, fragment: b.fi + 1, offset: b.offset },
      });
    }
  }

  // ---- PTS and display order ----------------------------------------------
  for (const t of tracks.values()) {
    const n = t.count;
    let safe = true;
    const pts = new BigInt64Array(n);
    for (let i = 0; i < n; i++) {
      const p = t.dts[i] + BigInt(t.cts[i]);
      if (p < 0n || p > BigInt(Number.MAX_SAFE_INTEGER) * 2n) safe = false;
      if (p < (-9223372036854775808n) || p > 9223372036854775807n) safe = false;
      pts[i] = p;
    }
    if (safe) {
      t.pts = pts;
    } else {
      t.pts = Array.from({ length: n }, (_, i) => t.dts[i] + BigInt(t.cts[i]));
      t.ptsFallback = true;
    }
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const ptsAt = (i) => (safe ? BigInt(pts[i]) : t.pts[i]);
    order.sort((x, y) => {
      const px = ptsAt(x), py = ptsAt(y);
      if (px < py) return -1;
      if (px > py) return 1;
      return x - y; // 同 PTS 按解码序号
    });
    t.displayOrder = order;
  }

  const video = tracks.get(videoId);
  const firstVideoFlags = video.sampleFlags[0];
  if ((firstVideoFlags & 0x00010000) !== 0) {
    throw new Error("视频首样本必须是关键帧");
  }

  return {
    file,
    fileSize,
    ftyp,
    moovBytes,
    tracks,
    trackOrder,
    videoId,
    audioId: trackOrder.length > 1 ? trackOrder[1] : null,
    fragments: fragments.map((f, i) => ({
      index: i,
      moofStart: f.moof.start,
      moofSize: f.moof.size,
      mdatStart: f.mdat.start,
      payloadStart: f.payloadStart,
      payloadEnd: f.payloadEnd,
      sequence: f.sequence,
      baseRelocs: f.baseRelocs || [],
    })),
    mdatRanges,
    rangeErrors,
  };
}

export function isKeyframe(track, index) {
  return (track.sampleFlags[index] & 0x00010000) === 0;
}
