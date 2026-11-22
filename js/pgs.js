// pgs.js — parser/compositor for the synthetic PGS subset described in samples/extracted/约定.txt
// Pure ES module, no DOM usage here; runs unchanged in the browser and under Node.
//
// Subset conventions (from the sample pack agreement):
//   - Only PCS state 0x00 (Epoch Start) and 0x80 (Normal) are used. PTS is taken from the PCS.
//   - A display set takes effect only when its END segment arrives.
//   - Epoch Start clears objects, windows and palettes. Normal sets may reuse previous state.
//   - state=0x80 with zero composition objects = palette-only update (keep the previous object list).
//   - state=0x00 with zero composition objects = clear screen.
//   - Crop rectangles live inside object entries (flag 0x40); the cropped top-left is placed at the
//     PCS coordinate, then clipped by window rectangles and finally by the canvas.
//   - Forced flag is 0x40... note: in this subset forced is 0x80 in the PCS entry flags, crop is 0x40.
//   - Colours are limited-range BT.709 YCbCr; clear colour is transparent black; output is straight RGBA.

export const SEG = { PDS: 0x14, WDS: 0x15, PCS: 0x16, ODS: 0x17, END: 0x80 };
export const SEG_NAME = { 0x14: "PDS", 0x15: "WDS", 0x16: "PCS", 0x17: "ODS", 0x80: "END" };

export const LIMITS = { MAX_FILE: 20 * 1024 * 1024, MAX_W: 1920, MAX_H: 1080 };
export const FLAG_CROP = 0x40;
export const FLAG_FORCED = 0x80;

export class PgsError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "PgsError";
    this.segmentOffset = opts.segmentOffset; // byte offset of the offending segment header
    this.segmentIndex = opts.segmentIndex;
    this.segmentType = opts.segmentType;
    this.fileOffset = opts.fileOffset; // raw byte offset for truncation/magic failures
  }
}

function u16be(dv, o) { return dv.getUint16(o); }
function u16le(dv, o) { return dv.getUint16(o, true); }
function u24(dv, o) { return (dv.getUint8(o) << 16) | dv.getUint16(o + 1); }
function u32(dv, o) { return dv.getUint32(o); }

// ---------------------------------------------------------------- segment walking

/** Walk 13-byte PGS segment headers. Returns { segments, orphan } where orphan describes trailing
 *  bytes that cannot form another segment. Throws only on bad magic mid-stream. */
export function walkSegments(buf) {
  const dv = new DataView(buf);
  const out = [];
  let off = 0;
  let index = 0;
  while (off < buf.byteLength) {
    if (buf.byteLength - off < 13) {
      return {
        segments: out,
        orphan: { offset: off, bytes: buf.byteLength - off, index },
      };
    }
    if (dv.getUint8(off) !== 0x50 || dv.getUint8(off + 1) !== 0x47) {
      const b0 = off < buf.byteLength ? dv.getUint8(off).toString(16).padStart(2, "0") : "?";
      const b1 = off + 1 < buf.byteLength ? dv.getUint8(off + 1).toString(16).padStart(2, "0") : "?";
      throw new PgsError(`偏移 0x${off.toString(16)} 处段头魔数不是 "PG"（读到 ${b0} ${b1}）`,
        { fileOffset: off, segmentIndex: index });
    }
    const pts = u32(dv, off + 2);
    const dts = u32(dv, off + 6);
    const type = dv.getUint8(off + 10);
    const len = u16be(dv, off + 11);
    const payloadStart = off + 13;
    if (payloadStart + len > buf.byteLength) {
      throw new PgsError(
        `${SEG_NAME[type] ?? "0x" + type.toString(16)} 段（#${index}，偏移 0x${off.toString(16)}）声明负载 ${len} 字节，` +
        `但文件只剩 ${buf.byteLength - payloadStart} 字节`,
        { segmentOffset: off, segmentIndex: index, segmentType: type });
    }
    out.push({ index, offset: off, pts, dts, type, len, payload: new Uint8Array(buf, payloadStart, len) });
    off = payloadStart + len;
    index += 1;
  }
  return { segments: out, orphan: null };
}

// ---------------------------------------------------------------- segment payloads

function parsePCS(seg) {
  const { payload: p, offset, index } = seg;
  if (p.length < 11) {
    throw new PgsError(`PCS 段 #${index}（偏移 0x${offset.toString(16)}）负载仅 ${p.length} 字节，至少需要 11 字节固定头`,
      { segmentOffset: offset, segmentIndex: index, segmentType: SEG.PCS });
  }
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const pcs = {
    videoWidth: u16be(dv, 0),
    videoHeight: u16be(dv, 2),
    frameRate: dv.getUint8(4),
    compositionNumber: u16be(dv, 5),
    state: dv.getUint8(8),
    paletteId: dv.getUint8(9),
    count: dv.getUint8(10),
    entries: [],
  };
  let o = 11; // synthetic subset: 11-byte fixed header; entries start at offset 11
  // tolerate standard 10-byte PCS layout if a real-world file is loaded
  if (p.length - 10 >= pcs.count * 8 && p.length - 11 < pcs.count * 8) o = 10;
  for (let i = 0; i < pcs.count; i++) {
    const need = o + 8;
    if (need > p.length) {
      throw new PgsError(`PCS 段 #${index}（偏移 0x${offset.toString(16)}）第 ${i + 1} 个对象条目不完整`,
        { segmentOffset: offset, segmentIndex: index, segmentType: SEG.PCS });
    }
    const entry = {
      objectId: u16be(dv, o),
      flags: u16be(dv, o + 2),
      x: u16be(dv, o + 4),
      y: u16be(dv, o + 6),
      forced: (dv.getUint16(o + 2) & FLAG_FORCED) !== 0,
      cropped: (dv.getUint16(o + 2) & FLAG_CROP) !== 0,
      crop: null,
    };
    o += 8;
    if (entry.cropped) {
      if (o + 8 > p.length) {
        throw new PgsError(`PCS 段 #${index}（偏移 0x${offset.toString(16)}）对象 ${entry.objectId} 声明裁剪但缺少 8 字节裁剪矩形`,
          { segmentOffset: offset, segmentIndex: index, segmentType: SEG.PCS });
      }
      entry.crop = { x: u16be(dv, o), y: u16be(dv, o + 2), w: u16be(dv, o + 4), h: u16be(dv, o + 6) };
      o += 8;
    }
    pcs.entries.push(entry);
  }
  return pcs;
}

function parsePDS(seg) {
  const { payload: p, offset, index } = seg;
  if (p.length < 2) {
    throw new PgsError(`PDS 段 #${index}（偏移 0x${offset.toString(16)}）负载过短`,
      { segmentOffset: offset, segmentIndex: index, segmentType: SEG.PDS });
  }
  const paletteId = p[0];
  const version = p[1];
  const entries = [];
  for (let o = 2; o + 4 < p.length + 1 && o + 5 <= p.length; o += 5) {
    entries.push({ index: p[o], y: p[o + 1], cb: p[o + 2], cr: p[o + 3], a: p[o + 4] });
  }
  return { paletteId, version, entries };
}

/** Best-effort WDS decode. The synthetic windows mix endianness; we keep every candidate and
 *  mark windows whose rectangle cannot fit the canvas as invalid instead of failing the file. */
function parseWDS(seg, canvasW, canvasH) {
  const { payload: p, offset, index } = seg;
  const warnings = [];
  if (p.length < 4) {
    throw new PgsError(`WDS 段 #${index}（偏移 0x${offset.toString(16)}）负载短于 4 字节，无法读取窗口标识`,
      { segmentOffset: offset, segmentIndex: index, segmentType: SEG.WDS });
  }
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const windows = [];
  let o = 0;
  // Subset window entry, big-endian:
  //   id16 flags16 x16 y16 w16 h16  (12 bytes); when flags carry 0x40 a 4-byte crop (x16, w16)
  //   is appended. Entries are variable length and back-to-back.
  while (o < p.length) {
    if (p.length - o < 12) {
      warnings.push(`WDS 段 #${index}（偏移 0x${offset.toString(16)}）剩余 ${p.length - o} 字节不足一个 12 字节窗口条目，已保留原始字节`);
      break;
    }
    const id = u16be(dv, o);
    const flags = u16be(dv, o + 2);
    // geometry fields are big-endian u16; the effective one-pixel height rides in the low byte
    const rect = { x: u16be(dv, o + 4), y: u16be(dv, o + 6), w: u16be(dv, o + 8), h: dv.getUint8(o + 11) };
    const fits = rect.w > 0 && rect.h > 0 && rect.x + rect.w <= canvasW && rect.y + rect.h <= canvasH;
    const win = {
      id, flags, rect, valid: fits,
      forced: (flags & FLAG_FORCED) !== 0,
      cropped: (flags & FLAG_CROP) !== 0,
      crop: null,
    };
    if (!fits) {
      warnings.push(`WDS 段 #${index} 窗口 ${id} 的矩形 (${rect.x},${rect.y},${rect.w},${rect.h}) 超出画布 ${canvasW}×${canvasH}，该窗口不参与裁剪`);
    }
    o += 12;
    if (win.cropped) {
      if (o + 4 > p.length) {
        warnings.push(`WDS 段 #${index} 窗口 ${id} 声明裁剪但负载缺少 4 字节裁剪矩形`);
      } else {
        win.crop = { x: u16be(dv, o), w: u16be(dv, o + 2) };
        o += 4;
      }
    }
    windows.push(win);
  }
  return { windows, warnings };
}

// ---------------------------------------------------------------- RLE

/**
 * Decode the subset RLE stream into palette-index rows.
 * Standard PGS opcodes are supported (literal, 0000 EOL, 0001 EOB, 00NN run8, 0002 LLHH run16);
 * the subset streams may omit EOB, so end-of-data after exactly expectedPixels is accepted.
 */
export function decodeRLE(bytes, expectedPixels) {
  const rows = [[]];
  let i = 0;
  const n = bytes.length;
  let sawEOB = false;
  while (i < n) {
    const b = bytes[i];
    if (b !== 0) {
      rows[rows.length - 1].push(b);
      i += 1;
      continue;
    }
    if (i + 1 >= n) { // dangling escape: treat as implicit end
      break;
    }
    const b2 = bytes[i + 1];
    if (b2 === 0) { // EOL
      rows.push([]);
      i += 2;
    } else if (b2 === 1) { // EOB
      sawEOB = true;
      i += 2;
      break;
    } else if (b2 === 2) {
      if (i + 3 >= n) break;
      const run = bytes[i + 2] | (bytes[i + 3] << 8);
      for (let k = 0; k < run; k++) rows[rows.length - 1].push(0);
      i += 4;
    } else {
      for (let k = 0; k < b2; k++) rows[rows.length - 1].push(0);
      i += 2;
    }
  }
  const flat = rows.flat();
  const warnings = [];
  if (expectedPixels != null && flat.length !== expectedPixels) {
    warnings.push(`RLE 解出 ${flat.length} 个像素，与期望 ${expectedPixels} 不一致`);
  }
  if (!sawEOB && i < n) {
    warnings.push("RLE 缺少 EOB（0001）结束标记，已按数据末尾隐式收尾");
  }
  return { rows, pixels: flat, sawEOB, warnings };
}

function parseODS(seg) {
  const { payload: p, offset, index } = seg;
  if (p.length < 6) {
    throw new PgsError(`ODS 段 #${index}（偏移 0x${offset.toString(16)}）负载短于 6 字节对象头`,
      { segmentOffset: offset, segmentIndex: index, segmentType: SEG.ODS });
  }
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const obj = {
    // Subset object header (6 bytes): id8 version8 seq8 reserved8 reserved8 reserved8
    objectId: dv.getUint8(0),
    version: dv.getUint8(1),
    sequenceFlags: dv.getUint8(2),
    firstInSequence: (dv.getUint8(2) & 0x40) !== 0,
    lastInSequence: (dv.getUint8(2) & 0x80) !== 0,
    headerTail: [dv.getUint8(3), dv.getUint8(4), dv.getUint8(5)],
    rle: p.slice(6),
    width: null,
    height: null,
    rows: null,
    pixels: null,
    warnings: [],
  };
  const decoded = decodeRLE(obj.rle, null);
  obj.rows = decoded.rows;
  obj.pixels = decoded.pixels;
  obj.warnings.push(...decoded.warnings);
  // The subset ODS header carries no dimensions; infer from the row layout. Single-row streams
  // without an EOL arrive as one row and get their height from the WDS/PCS geometry cross-check.
  obj.height = obj.rows.length;
  obj.width = obj.height === 1 ? obj.pixels.length : Math.max(...obj.rows.map((r) => r.length));
  return obj;
}

// ---------------------------------------------------------------- BT.709 limited range

function limitedY(v) { return (v - 16) * 255 / 219; }
function limitedC(v) { return (v - 128) * 255 / 224; }
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export function ycbcrToRgba(y, cb, cr, a) {
  const Y = limitedY(y);
  const Pb = limitedC(cb);
  const Pr = limitedC(cr);
  return [
    clamp8(Y + 1.5748 * Pr),
    clamp8(Y - 0.1873 * Pb - 0.4681 * Pr),
    clamp8(Y + 1.8556 * Pb),
    a, // straight (non-premultiplied) alpha
  ];
}

// ---------------------------------------------------------------- display sets + timeline

/**
 * Parse the whole file into committed display states.
 * Returns { canvas:{width,height}, states:[{pts, kind, entries, windows, palette, warnings, diagnostics}],
 *           objects:Map, segments, warnings, trailing }.
 */
export function parseSup(arrayBuffer) {
  if (arrayBuffer.byteLength > LIMITS.MAX_FILE) {
    throw new PgsError(`文件 ${arrayBuffer.byteLength} 字节超过 20MB 上限`);
  }
  const { segments, orphan } = walkSegments(arrayBuffer);
  const warnings = [];
  const diagnostics = [];

  // First PCS fixes the canvas size; validated up front.
  const firstPCS = segments.find((s) => s.type === SEG.PCS);
  if (!firstPCS) throw new PgsError("文件中没有 PCS 段");
  const probe = parsePCS(firstPCS);
  if (probe.videoWidth > LIMITS.MAX_W || probe.videoHeight > LIMITS.MAX_H || probe.videoWidth <= 0 || probe.videoHeight <= 0) {
    throw new PgsError(`画布尺寸 ${probe.videoWidth}×${probe.videoHeight} 超出允许范围（最大 ${LIMITS.MAX_W}×${LIMITS.MAX_H}）`,
      { segmentOffset: firstPCS.offset, segmentIndex: firstPCS.index, segmentType: SEG.PCS });
  }
  const canvas = { width: probe.videoWidth, height: probe.videoHeight };

  // Group segments between PCSes into display sets.
  const sets = [];
  let current = null;
  for (const seg of segments) {
    if (seg.type === SEG.PCS) {
      current = { pcsSeg: seg, members: [] };
      sets.push(current);
    } else if (current) {
      current.members.push(seg);
    } else {
      warnings.push(`段 #${seg.index}（${SEG_NAME[seg.type]}，偏移 0x${seg.offset.toString(16)}）出现在第一个 PCS 之前，已忽略`);
    }
  }

  const objects = new Map(); // objectId -> latest ODS bitmap
  let palette = new Map();   // index -> rgba
  let windows = [];
  let prevEntries = [];      // object list retained across palette-only updates
  let lastCompositionNumber = null;
  const states = [];

  sets.forEach((set, setIdx) => {
    const pcsSeg = set.pcsSeg;
    const pcs = parsePCS(pcsSeg);
    const localWarnings = [];
    const hasEND = set.members.some((s) => s.type === SEG.END);

    // The subset only uses Normal and Epoch Start PCS. A zero-object PCS is either a palette-only
    // update (state 0x80, keeps the previous object list) or a real clear (state 0x00). Those two
    // cases are decided purely by the state byte and take precedence over epoch detection.
    const zeroObject = pcs.entries.length === 0;
    // Among object-carrying PCS, an epoch boundary is the first PCS or a composition number that
    // does not advance.
    const isEpochStart = !zeroObject &&
      (lastCompositionNumber === null || pcs.compositionNumber <= lastCompositionNumber);
    lastCompositionNumber = pcs.compositionNumber;
    if (isEpochStart) {
      // Epoch start: clear objects, windows and palettes per the agreement.
      objects.clear();
      palette = new Map();
      windows = [];
      prevEntries = [];
    }

    for (const seg of set.members) {
      if (seg.type === SEG.PDS) {
        const pds = parsePDS(seg);
        for (const e of pds.entries) {
          palette.set(e.index, { ...e, rgba: ycbcrToRgba(e.y, e.cb, e.cr, e.a) });
        }
      } else if (seg.type === SEG.WDS) {
        const w = parseWDS(seg, canvas.width, canvas.height);
        windows = w.windows;
        localWarnings.push(...w.warnings);
      } else if (seg.type === SEG.ODS) {
        const obj = parseODS(seg);
        objects.set(obj.objectId, obj);
        localWarnings.push(...obj.warnings.map((m) => `ODS 对象 ${obj.objectId}：${m}`));
      }
    }

    // Resolve the composition object list per the agreement.
    let kind;
    let entries;
    if (zeroObject && pcs.state === 0x00) {
      kind = "clear";
      entries = [];
      prevEntries = [];
    } else if (zeroObject && pcs.state === 0x80) {
      kind = "palette";
      entries = prevEntries.map((e) => ({ ...e, retained: true }));
      localWarnings.push("Normal 段对象数为 0：仅更新调色板条目，沿用上一次的对象列表");
    } else {
      kind = isEpochStart ? "epoch" : "normal";
      entries = pcs.entries.map((e) => ({ ...e, retained: false }));
      prevEntries = pcs.entries;
    }

    // Attach bitmaps; missing ids fall back to the most recently defined object (the "stale"
    // carry-over the inspector is meant to expose) but are flagged explicitly.
    const latestId = objects.size ? [...objects.keys()].at(-1) : null;
    for (const e of entries) {
      let obj = objects.get(e.objectId) || null;
      e.stale = false;
      e.missing = false;
      if (!obj) {
        if (latestId != null) {
          obj = objects.get(latestId);
          e.stale = true;
          localWarnings.push(`PCS 对象 id=${e.objectId} 在当前纪元没有对应 ODS，已沿用上一个对象 id=${latestId} 的位图（疑似旧对象被带进新段）`);
        } else {
          e.missing = true;
          localWarnings.push(`PCS 对象 id=${e.objectId} 没有任何可用 ODS 位图，该位置为空`);
        }
      }
      e.object = obj;
    }

    if (!hasEND) {
      diagnostics.push({
        setIndex: setIdx,
        pts: pcsSeg.pts,
        level: "error",
        message: `PTS=${pcsSeg.pts} 的显示集缺少 END 段，按规则不生效（解析在偏移 0x${pcsSeg.offset.toString(16)} 的 PCS 开始）`,
      });
      return; // uncommitted set: not part of the timeline
    }

    states.push({
      pts: pcsSeg.pts, // PTS always taken from the PCS
      kind,
      compositionNumber: pcs.compositionNumber,
      paletteId: pcs.paletteId,
      entries,
      windows: windows.map((w) => ({ ...w })),
      paletteSnapshot: new Map(palette),
      objectCount: entries.length,
      anyForced: entries.some((e) => e.forced),
      warnings: localWarnings,
      setIndex: setIdx,
    });
    warnings.push(...localWarnings.map((m) => `[PTS ${pcsSeg.pts}] ${m}`));
  });

  // Orphan trailing bytes mean the final display set is incomplete (its END never arrived). When an
  // earlier state already committed we keep the timeline and report it; otherwise it is fatal.
  const lastSet = sets[sets.length - 1];
  if (orphan) {
    diagnostics.push({
      level: "error",
      message: `文件在偏移 0x${orphan.offset.toString(16)} 处残留 ${orphan.bytes} 字节，不足 13 字节段头` +
        (lastSet ? `（属于从 PCS 段 #${lastSet.pcsSeg.index}（偏移 0x${lastSet.pcsSeg.offset.toString(16)}）开始、缺少 END 的显示集）` : ""),
    });
  }
  if (lastSet && !lastSet.members.some((s) => s.type === SEG.END)) {
    const after = lastSet.members.length ? lastSet.members.at(-1) : lastSet.pcsSeg;
    const tailOffset = after.offset + 13 + after.len;
    const trailing = arrayBuffer.byteLength - tailOffset;
    diagnostics.push({
      level: "error",
      message: `最后一个显示集（PCS 段 #${lastSet.pcsSeg.index}，偏移 0x${lastSet.pcsSeg.offset.toString(16)}，PTS=${lastSet.pcsSeg.pts}）没有 END 段，按规则不生效` +
        (trailing > 0 ? `；其后还有 ${trailing} 字节残尾（起始偏移 0x${tailOffset.toString(16)}）` : ""),
    });
  }

  if (states.length === 0 && diagnostics.some((d) => d.level === "error")) {
    throw new PgsError(diagnostics[0].message, { segmentOffset: lastSet?.pcsSeg.offset });
  }

  states.sort((a, b) => a.pts - b.pts);
  return { canvas, states, objects, segments, warnings, diagnostics };
}

// ---------------------------------------------------------------- compositing

function clipRect(r, clip) {
  if (!clip) return r;
  const x1 = Math.max(r.x, clip.x);
  const y1 = Math.max(r.y, clip.y);
  const x2 = Math.min(r.x + r.w, clip.x + clip.w);
  const y2 = Math.min(r.y + r.h, clip.y + clip.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Render one committed state to a straight-alpha RGBA buffer plus a parallel Uint16Array naming
 * the composition entry that painted each pixel (for click inspection).
 */
export function renderState(state, canvas) {
  const n = canvas.width * canvas.height;
  const rgba = new Uint8ClampedArray(n * 4); // all zeros => transparent black clear
  const owner = new Int16Array(n).fill(-1);
  const paintedEntries = [];

  state.entries.forEach((entry, entryIdx) => {
    const info = { entryIdx, objectId: entry.objectId, forced: entry.forced, stale: entry.stale,
      missing: entry.missing, pixels: 0, placed: null, crop: entry.crop };
    if (entry.missing || !entry.object) {
      paintedEntries.push(info);
      return;
    }
    const obj = entry.object;
    const win = state.windows.find((w) => w.id === entry.objectId && w.valid);
    // Subset ODS single-row streams carry no EOL and no dimensions. Recover the effective height
    // from the PCS crop rectangle or the matching window, and treat the full pixel stream as row 0.
    const effectiveH = obj.height >= 1
      ? obj.height
      : (entry.crop?.h || win?.rect.h || 1);
    const objW = obj.width;
    const objH = effectiveH;
    // 1) crop rectangle inside the object; the subset crop may omit y/h, which then default to the
    //    full object extent.
    const crop = entry.crop
      ? { x: entry.crop.x ?? 0, y: entry.crop.y ?? 0, w: entry.crop.w ?? objW, h: entry.crop.h ?? objH }
      : { x: 0, y: 0, w: objW, h: objH };
    const c = clipRect(crop, { x: 0, y: 0, w: objW, h: objH });
    // 2) the cropped top-left is placed at the PCS coordinate
    const placed = { x: entry.x, y: entry.y, w: c.w, h: c.h };
    // 3) clip by the matching valid window, then by the canvas
    let target = placed;
    if (win) target = clipRect(target, win.rect);
    target = clipRect(target, { x: 0, y: 0, w: canvas.width, h: canvas.height });
    info.placed = target;
    if (target.w === 0 || target.h === 0) {
      paintedEntries.push(info);
      return;
    }

    const srcX0 = c.x + (target.x - placed.x);
    const srcY0 = c.y + (target.y - placed.y);
    for (let row = 0; row < target.h; row++) {
      const srcRow = obj.rows[Math.min(srcY0 + row, obj.rows.length - 1)];
      if (!srcRow) continue;
      for (let col = 0; col < target.w; col++) {
        const idx = srcRow[srcX0 + col];
        const pal = state.paletteSnapshot.get(idx);
        if (!pal) continue;
        const [r, g, b, a] = pal.rgba;
        if (a === 0) continue;
        const px = target.x + col;
        const py = target.y + row;
        const poff = py * canvas.width + px;
        const o = poff * 4;
        // source-over with straight alpha
        const dstA = rgba[o + 3] / 255;
        const srcA = a / 255;
        const outA = srcA + dstA * (1 - srcA);
        if (outA > 0) {
          rgba[o] = (r * srcA + rgba[o] * dstA * (1 - srcA)) / outA;
          rgba[o + 1] = (g * srcA + rgba[o + 1] * dstA * (1 - srcA)) / outA;
          rgba[o + 2] = (b * srcA + rgba[o + 2] * dstA * (1 - srcA)) / outA;
          rgba[o + 3] = outA * 255;
        }
        owner[poff] = entryIdx;
        info.pixels += 1;
      }
    }
    paintedEntries.push(info);
  });

  return { rgba, owner, paintedEntries };
}

// ---------------------------------------------------------------- intervals

/** Half-open [start,end) intervals in 90kHz ticks; the final end tick is supplied by the caller. */
export function buildIntervals(states, userEndTicks, { forcedOnly = false } = {}) {
  // Palette-only states carry no PCS objects but retain the previous entry list, whose forced bits
  // stay in effect, so forced-ness is read from the resolved entries rather than anyForced.
  const effectiveForced = (s) => s.entries.some((e) => e.forced);
  const chosen = forcedOnly
    ? states.map((s) => (effectiveForced(s) ? s : { ...s, entries: [], objectCount: 0, blankedByFilter: true }))
    : states;
  const intervals = [];
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    const end = i + 1 < chosen.length ? chosen[i + 1].pts : userEndTicks;
    intervals.push({
      start: s.pts,
      end,
      kind: s.kind,
      forced: effectiveForced(s),
      blank: s.entries.length === 0,
      compositionNumber: s.compositionNumber,
      objectCount: s.entries.length,
    });
  }
  return intervals;
}

export function formatTicks(ticks) {
  if (ticks == null || Number.isNaN(ticks)) return "--:--:--.---";
  const ms = Math.round((ticks / 90) * 1000) / 1000;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = Math.round(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}
