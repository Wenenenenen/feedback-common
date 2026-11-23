// L21P 二进制解析：小端；头 4B "L21P" + u32 记录数 + u32 总帧数；记录每条 8B
// 结构错误标出字节偏移，且不产出文档（保留旧稿由 UI 层负责）

export const HEADER_SIZE = 12;
export const RECORD_SIZE = 8;

export function parseL21P(buffer) {
  const bytes = new Uint8Array(buffer);
  const errors = [];

  if (bytes.length < HEADER_SIZE) {
    errors.push({ offset: 0, message: `文件过短：${bytes.length} 字节，不足 12 字节头部` });
    return { ok: false, errors };
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'L21P') {
    errors.push({ offset: 0, message: `魔数错误：得到 "${magic}"，应为 "L21P"` });
  }
  const dv = new DataView(buffer);
  const recordCount = dv.getUint32(4, true);
  const totalFrames = dv.getUint32(8, true);
  const expectedSize = HEADER_SIZE + recordCount * RECORD_SIZE;
  if (bytes.length !== expectedSize) {
    errors.push({
      offset: 4,
      message: `长度不符：头部声明 ${recordCount} 条记录应共 ${expectedSize} 字节，实际 ${bytes.length} 字节`,
    });
  }
  if (errors.length) return { ok: false, errors };

  const frames = new Uint32Array(recordCount);
  const fields = new Uint8Array(recordCount);
  const rawA = new Uint8Array(recordCount);
  const rawB = new Uint8Array(recordCount);
  const statuses = new Uint8Array(recordCount); // 由引擎填充

  let prevFrame = -1;
  let prevField = 0;
  const seenFrameField = new Set();

  for (let i = 0; i < recordCount; i++) {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    const frame = dv.getUint32(off, true);
    const field = bytes[off + 4];
    const a = bytes[off + 5];
    const b = bytes[off + 6];
    const reserved = bytes[off + 7];

    if (frame >= totalFrames) {
      errors.push({ offset: off, message: `记录 ${i}：帧号 ${frame} 超出总帧数 ${totalFrames}` });
    }
    if (field !== 1 && field !== 2) {
      errors.push({ offset: off + 4, message: `记录 ${i}：场号 ${field} 非法（只允许 1 或 2）` });
    }
    if (reserved !== 0) {
      errors.push({ offset: off + 7, message: `记录 ${i}：保留字节非 0（0x${reserved.toString(16).toUpperCase()}）` });
    }
    if (frame < prevFrame || (frame === prevFrame && field <= prevField)) {
      errors.push({ offset: off, message: `记录 ${i}：未按帧/场严格递增（上一条为帧 ${prevFrame} 场 ${prevField}）` });
    }
    const key = frame * 2 + (field - 1);
    if (seenFrameField.has(key)) {
      errors.push({ offset: off, message: `记录 ${i}：帧 ${frame} 场 ${field} 重复（同帧同场最多一条）` });
    }
    seenFrameField.add(key);
    prevFrame = frame;
    prevField = field;

    frames[i] = frame;
    fields[i] = field;
    rawA[i] = a;
    rawB[i] = b;
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    doc: { frames, fields, rawA, rawB, statuses, totalFrames, recordCount },
  };
}

// 单条记录改字节对（结构不变，仅 A/B 两字节），返回新 buffer
export function editRecordBytes(buffer, recordIndex, newA, newB) {
  const next = buffer.slice(0);
  const dv = new Uint8Array(next);
  const off = HEADER_SIZE + recordIndex * RECORD_SIZE;
  dv[off + 5] = newA & 0xff;
  dv[off + 6] = newB & 0xff;
  return next;
}
