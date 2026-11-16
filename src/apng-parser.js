// apng-parser.js — Hand-rolled APNG chunk parser with byte-offset error localization.
// Only 8-bit RGBA (color type 6), non-interlaced files are accepted by the studio;
// every structural problem is reported with the offending chunk type and byte offset.
import { PNG_SIGNATURE } from './png-codec.js';
import { crc32 } from './crc32.js';

export class ApngError extends Error {
  constructor(message, kind, detail = {}) {
    super(message);
    this.name = 'ApngError';
    this.kind = kind;            // signature | crc | length | count | sequence | bounds | truncation | structure
    this.detail = detail;        // { chunkType, offset, ... }
    this.errors = null;          // when aggregation reports several problems at once
  }
}

// Severity ordering for stable presentation.
const KIND_ORDER = ['signature', 'truncation', 'crc', 'length', 'sequence', 'count', 'bounds', 'structure'];
function aggregate(problems) {
  const sorted = problems.slice().sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    (a.detail.offset ?? 0) - (b.detail.offset ?? 0));
  const top = sorted[0];
  if (sorted.length > 1) {
    top.errors = sorted;
    top.message = `共发现 ${sorted.length} 个问题，首要问题：${top.message}`;
  }
  return top;
}

function readType(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

// Walk the chunk list without throwing on CRC mismatch so multiple problems can be collected.
function walkChunks(bytes) {
  const chunks = [];
  const problems = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      problems.push(new ApngError(
        `截断：偏移 ${offset} 处块头不完整（需要 8 字节，仅剩 ${bytes.length - offset} 字节）`,
        'truncation', { offset }));
      return { chunks, problems, truncated: true };
    }
    const length = dv.getUint32(offset);
    const type = readType(bytes, offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    const crcEnd = bodyEnd + 4;
    if (length > 0x7fffffff) {
      problems.push(new ApngError(`长度错误：${type} 块 @${offset} 声明长度 ${length} 超出 PNG 上限`, 'length',
        { chunkType: type, offset, length }));
      return { chunks, problems, truncated: true };
    }
    if (crcEnd > bytes.length) {
      problems.push(new ApngError(
        `截断：${type} 块 @${offset} 声明数据长度 ${length}，文件仅剩 ${bytes.length - bodyStart} 字节（CRC 结束应到 ${crcEnd}）`,
        'truncation', { chunkType: type, offset, length, available: bytes.length - bodyStart }));
      return { chunks, problems, truncated: true };
    }
    const storedCrc = dv.getUint32(bodyEnd);
    const actualCrc = crc32(bytes, offset + 4, bodyEnd);
    const crcOk = storedCrc === actualCrc;
    if (!crcOk) {
      problems.push(new ApngError(
        `CRC 错误：${type} 块 @${offset}（CRC 字段位于 ${bodyEnd}..${crcEnd - 1}），存储值 0x${storedCrc.toString(16).padStart(8, '0')}，计算值 0x${actualCrc.toString(16).padStart(8, '0')}`,
        'crc', { chunkType: type, offset, crcOffset: bodyEnd, storedCrc, actualCrc }));
    }
    chunks.push({ type, offset, length, bodyStart, bodyEnd, crcOffset: bodyEnd, crcOk });
    offset = crcEnd;
  }
  return { chunks, problems, truncated: false };
}

export function parseApng(bytes) {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    throw new ApngError('PNG 签名错误：文件头不是 89 50 4E 47 0D 0A 1A 0A', 'signature', { offset: 0 });
  }
  const { chunks, problems, truncated } = walkChunks(bytes);
  const problemsOut = problems.slice();

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) {
    // If the walk already recorded a truncation, surface that precise location instead
    // of a generic "missing IHDR" with no offset.
    const cut = problemsOut.find((p) => p.kind === 'truncation');
    if (cut) throw aggregate(problemsOut);
    throw new ApngError('结构错误：缺少 IHDR 块', 'structure', { chunkType: 'IHDR', offset: 8 });
  }
  if (ihdr.length !== 13) {
    throw new ApngError(`长度错误：IHDR 块 @${ihdr.offset} 长度应为 13，实际 ${ihdr.length}`, 'length',
      { chunkType: 'IHDR', offset: ihdr.offset, length: ihdr.length });
  }
  const iv = new DataView(bytes.buffer, bytes.byteOffset + ihdr.bodyStart, ihdr.length);
  const width = iv.getUint32(0);
  const height = iv.getUint32(4);
  const bitDepth = bytes[ihdr.bodyStart + 8];
  const colorType = bytes[ihdr.bodyStart + 9];
  const interlace = bytes[ihdr.bodyStart + 12];
  const ihdrProblems = [];
  if (bitDepth !== 8) ihdrProblems.push(`位深 ${bitDepth}（仅支持 8 位）`);
  if (colorType !== 6) ihdrProblems.push(`颜色类型 ${colorType}（仅支持 6 = RGBA）`);
  if (interlace !== 0) ihdrProblems.push(`隔行扫描 interlace=${interlace}（仅支持非隔行）`);
  if (ihdrProblems.length) {
    throw new ApngError(`格式不支持：IHDR 块 @${ihdr.offset}：${ihdrProblems.join('；')}`, 'structure',
      { chunkType: 'IHDR', offset: ihdr.offset });
  }
  if (width > 1024 || height > 1024) {
    throw new ApngError(`画布 ${width}×${height} 超出 1024×1024 上限（IHDR @${ihdr.offset}）`, 'bounds',
      { chunkType: 'IHDR', offset: ihdr.offset, width, height });
  }

  const actl = chunks.find((c) => c.type === 'acTL');
  if (!actl) throw new ApngError('结构错误：缺少 acTL 块，不是 APNG 文件', 'structure', { chunkType: 'acTL' });
  if (actl.length !== 8) {
    problemsOut.push(new ApngError(`长度错误：acTL 块 @${actl.offset} 长度应为 8，实际 ${actl.length}`, 'length',
      { chunkType: 'acTL', offset: actl.offset, length: actl.length }));
  }
  const numFramesDeclared = dv.getUint32(actl.bodyStart);
  const numPlays = dv.getUint32(actl.bodyStart + 4);

  // Frame assembly. fcTL opens a frame; IDAT belongs to frame 0 only when the first fcTL
  // precedes the first IDAT; fdAT always belongs to the currently open frame.
  const frames = [];
  let current = null;
  let firstFctlSeenBeforeIdat = null;   // decided when the first IDAT appears
  const idatChunks = [];
  const frameDataChunks = [];           // { frameIndex, chunk, kind }
  let expectedSeq = 0;
  let iend = null;

  for (const c of chunks) {
    const bv = new DataView(bytes.buffer, bytes.byteOffset + c.bodyStart, c.length);
    if (c.type === 'fcTL') {
      if (c.length !== 26) {
        problemsOut.push(new ApngError(`长度错误：fcTL 块 @${c.offset} 长度应为 26，实际 ${c.length}`, 'length',
          { chunkType: 'fcTL', offset: c.offset, length: c.length }));
      }
      const seq = bv.getUint32(0);
      const fw = bv.getUint32(4);
      const fh = bv.getUint32(8);
      const fx = bv.getUint32(12);
      const fy = bv.getUint32(16);
      const delayNum = bv.getUint16(20);
      const delayDen = bv.getUint16(22);
      const disposeOp = bytes[c.bodyStart + 24];
      const blendOp = bytes[c.bodyStart + 25];

      if (seq !== expectedSeq) {
        problemsOut.push(new ApngError(
          `序号错误：fcTL 块 @${c.offset} 的 sequence_number=${seq}，应为 ${expectedSeq}`,
          'sequence', { chunkType: 'fcTL', offset: c.offset, seq, expectedSeq }));
        expectedSeq = seq + 1;
      } else {
        expectedSeq++;
      }
      if (disposeOp > 2) {
        problemsOut.push(new ApngError(`处置方式非法：fcTL 块 @${c.offset} dispose_op=${disposeOp}（允许 0/1/2）`,
          'structure', { chunkType: 'fcTL', offset: c.offset, disposeOp }));
      }
      if (blendOp > 1) {
        problemsOut.push(new ApngError(`混合方式非法：fcTL 块 @${c.offset} blend_op=${blendOp}（允许 0/1）`,
          'structure', { chunkType: 'fcTL', offset: c.offset, blendOp }));
      }
      if (fw === 0 || fh === 0) {
        problemsOut.push(new ApngError(`帧矩形非法：fcTL 块 @${c.offset} 尺寸 ${fw}×${fh} 含零边`,
          'bounds', { chunkType: 'fcTL', offset: c.offset, width: fw, height: fh }));
      }
      if (fx < 0 || fy < 0 || fx + fw > width || fy + fh > height) {
        problemsOut.push(new ApngError(
          `越界：fcTL 块 @${c.offset} 帧矩形 (${fx},${fy}) ${fw}×${fh} 超出画布 ${width}×${height}（右边界 ${fx + fw}，下边界 ${fy + fh}）`,
          'bounds', { chunkType: 'fcTL', offset: c.offset, x: fx, y: fy, frameWidth: fw, frameHeight: fh }));
      }
      current = {
        fctlOffset: c.offset,
        sequenceNumber: seq,
        width: fw, height: fh, x: fx, y: fy,
        delayNum, delayDen, disposeOp, blendOp,
        dataChunks: [],
      };
      frames.push(current);
    } else if (c.type === 'IDAT') {
      idatChunks.push(c);
      if (firstFctlSeenBeforeIdat === null) {
        firstFctlSeenBeforeIdat = frames.length === 1 && frames[0] === current;
      }
      if (firstFctlSeenBeforeIdat && current === frames[0]) {
        current.dataChunks.push({ chunk: c, kind: 'IDAT' });
        frameDataChunks.push({ frameIndex: 0, chunk: c, kind: 'IDAT' });
      }
    } else if (c.type === 'fdAT') {
      if (c.length < 4) {
        problemsOut.push(new ApngError(`长度错误：fdAT 块 @${c.offset} 至少需要 4 字节序号，实际 ${c.length}`,
          'length', { chunkType: 'fdAT', offset: c.offset, length: c.length }));
        continue;
      }
      const seq = bv.getUint32(0);
      if (seq !== expectedSeq) {
        problemsOut.push(new ApngError(
          `序号错误：fdAT 块 @${c.offset} 的 sequence_number=${seq}，应为 ${expectedSeq}（序号字段位于 ${c.bodyStart}..${c.bodyStart + 3}）`,
          'sequence', { chunkType: 'fdAT', offset: c.offset, seq, expectedSeq }));
        expectedSeq = seq + 1;
      } else {
        expectedSeq++;
      }
      if (!current) {
        problemsOut.push(new ApngError(`结构错误：fdAT 块 @${c.offset} 之前没有 fcTL 帧控制块`,
          'structure', { chunkType: 'fdAT', offset: c.offset }));
      } else {
        current.dataChunks.push({ chunk: c, kind: 'fdAT' });
        frameDataChunks.push({ frameIndex: frames.length - 1, chunk: c, kind: 'fdAT' });
      }
    } else if (c.type === 'IEND') {
      iend = c;
    }
  }

  if (!iend && !truncated) {
    problemsOut.push(new ApngError('结构错误：缺少 IEND 块', 'structure', { chunkType: 'IEND' }));
  }
  if (!idatChunks.length) {
    problemsOut.push(new ApngError('结构错误：默认图像缺少 IDAT 块', 'structure', { chunkType: 'IDAT' }));
  }

  const posterIsFrame = firstFctlSeenBeforeIdat === true;
  if (numFramesDeclared !== frames.length) {
    problemsOut.push(new ApngError(
      `帧数错误：acTL 块 @${actl.offset} 声明 num_frames=${numFramesDeclared}，实际解析到 ${frames.length} 个 fcTL 帧`,
      'count', { chunkType: 'acTL', offset: actl.offset, declared: numFramesDeclared, actual: frames.length }));
  }
  if (frames.length > 120) {
    problemsOut.push(new ApngError(`帧数 ${frames.length} 超出 120 帧上限（acTL @${actl.offset}）`, 'count',
      { chunkType: 'acTL', offset: actl.offset, actual: frames.length }));
  }
  frames.forEach((f, i) => {
    if (!f.dataChunks.length) {
      problemsOut.push(new ApngError(`结构错误：第 ${i} 帧（fcTL @${f.fctlOffset}）没有任何图像数据块`,
        'structure', { chunkType: 'fcTL', offset: f.fctlOffset, frameIndex: i }));
    }
  });

  // Every problem is fatal: this studio never downgrades a malformed file to a fake static image.
  if (problemsOut.length) throw aggregate(problemsOut);

  return {
    bytes,
    width, height,
    numPlays,
    numFramesDeclared,
    posterIsFrame,
    frames,
    idatChunks,
    chunks,
    limits: { maxFrames: 120, maxDimension: 1024, maxBytes: 50 * 1024 * 1024 },
  };
}

// Concatenate a frame's zlib stream across its IDAT/fdAT data chunks.
export function frameZlibStream(parsed, frame) {
  const parts = [];
  for (const dc of frame.dataChunks) {
    if (dc.kind === 'IDAT') {
      parts.push(parsed.bytes.subarray(dc.chunk.bodyStart, dc.chunk.bodyEnd));
    } else {
      parts.push(parsed.bytes.subarray(dc.chunk.bodyStart + 4, dc.chunk.bodyEnd));
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Default (poster) image zlib stream across every IDAT chunk.
export function posterZlibStream(parsed) {
  const parts = parsed.idatChunks.map((c) => parsed.bytes.subarray(c.bodyStart, c.bodyEnd));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
