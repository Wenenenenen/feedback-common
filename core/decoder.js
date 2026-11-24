// CXR1 解析与差量重建核心。纯 JS，无 DOM 依赖，可在 Worker / Node 中运行。
//
// 解析阶段一遍线性扫描建立帧索引（不猜测记录边界）；
// 重建阶段以关键帧为锚点，配合周期快照 + LRU 轮换双缓冲定位任意有效帧。
import { crc32Range } from './crc32.js';

const MAGIC = 0x31525843; // "CXR1" 小端
const NO_BASE = 0xffffffff;
const HEADER_SIZE = 8;
const BODY_FIXED = 13; // u32 seq + u32 base + u8 key + u16 移动数 + u16 脏块数
const MOVE_REC = 12;   // 6 × i16/u16
const DIRTY_HDR = 8;   // 4 × i16/u16
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_FRAMES = 20000;
export const MAX_DIMENSION = 4096;

// 单条结构错误：携带可报告的字节偏移（相对文件头）
class CxrFormatError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'CxrFormatError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
export function parseCxr(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError('parseCxr 需要 ArrayBuffer');
  }
  const fileSize = buffer.byteLength;
  if (fileSize > MAX_FILE_BYTES) {
    throw new CxrFormatError(
      `文件 ${(fileSize / 1048576).toFixed(1)}MiB 超过 128MiB 支持上限`,
      0,
    );
  }
  if (fileSize < HEADER_SIZE) {
    throw new CxrFormatError(`文件过短：${fileSize} 字节，不足文件头`, 0);
  }
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  if (view.getUint32(0, true) !== MAGIC) {
    throw new CxrFormatError('魔数不是 CXR1', 0);
  }
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  if (width === 0 || height === 0) {
    throw new CxrFormatError(`画布尺寸非法：${width}×${height}`, 4);
  }
  const frameBytes = width * height * 4;
  // 像素总量上限按 4096×2160 约束
  if (
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    frameBytes > MAX_DIMENSION * 2160 * 4
  ) {
    throw new CxrFormatError(`画布超出支持上限：${width}×${height}`, 4);
  }

  const frames = [];
  let offset = HEADER_SIZE;
  let chainValid = false;       // 当前差量链是否有效
  let lastSuccessSeq = -1;      // 上一成功帧 seq
  let anchorIndex = -1;         // 当前链最近关键帧在 frames 中的下标
  let truncated = null;         // 截断尾帧描述

  while (offset < fileSize) {
    const frameStart = offset;

    if (frames.length >= MAX_FRAMES) {
      truncated = {
        offset: frameStart,
        reason: `达到 ${MAX_FRAMES} 帧支持上限，停止解析（不扫描后续内容）`,
      };
      break;
    }

    // 长度字段本身不完整
    if (fileSize - frameStart < 4) {
      truncated = { offset: frameStart, reason: '长度字段不完整（文件尾截断）' };
      break;
    }
    const L = view.getUint32(frameStart, true);
    if (L < 4) {
      // 规格：L<4 停在该帧起始偏移，不扫描猜测
      truncated = { offset: frameStart, reason: `帧长度字段 L=${L} 小于 4` };
      break;
    }
    if (fileSize - frameStart < 4 + L) {
      truncated = {
        offset: frameStart,
        reason: `声明长度 ${L} 越过文件尾（剩余 ${fileSize - frameStart - 4} 字节）`,
      };
      break;
    }

    const crcOffset = frameStart + 4;
    const bodyStart = frameStart + 8;
    const bodyEnd = frameStart + 4 + L;
    const storedCrc = view.getUint32(crcOffset, true);
    let entry;

    try {
      if (bodyEnd - bodyStart < BODY_FIXED) {
        throw new CxrFormatError('帧体不足 13 字节固定头', frameStart);
      }
      const seq = view.getUint32(bodyStart, true);
      const base = view.getUint32(bodyStart + 4, true);
      const key = view.getUint8(bodyStart + 8);
      const moveCount = view.getUint16(bodyStart + 9, true);
      const dirtyCount = view.getUint16(bodyStart + 11, true);
      if (key !== 0 && key !== 1) {
        throw new CxrFormatError(`key 字段非法：${key}`, bodyStart + 8);
      }

      let p = bodyStart + BODY_FIXED;
      const moves = [];
      for (let i = 0; i < moveCount; i++) {
        if (bodyEnd - p < MOVE_REC) {
          throw new CxrFormatError(`移动记录 ${i} 越界`, p);
        }
        const sx = view.getInt16(p, true);
        const sy = view.getInt16(p + 2, true);
        const mw = view.getUint16(p + 4, true);
        const mh = view.getUint16(p + 6, true);
        const dx = view.getInt16(p + 8, true);
        const dy = view.getInt16(p + 10, true);
        p += MOVE_REC;
        moves.push([sx, sy, mw, mh, dx, dy]);
      }

      const dirty = [];
      for (let i = 0; i < dirtyCount; i++) {
        if (bodyEnd - p < DIRTY_HDR) {
          throw new CxrFormatError(`脏块头 ${i} 越界`, p);
        }
        const x = view.getInt16(p, true);
        const y = view.getInt16(p + 2, true);
        const dw = view.getUint16(p + 4, true);
        const dh = view.getUint16(p + 6, true);
        p += DIRTY_HDR;
        const area = dw * dh;
        const need = area * 4;
        if (bodyEnd - p < need) {
          throw new CxrFormatError(
            `脏块 ${i} (${x},${y} ${dw}×${dh}) 像素数据越界：需 ${need} 字节，剩 ${bodyEnd - p}`,
            p,
          );
        }
        dirty.push([x, y, dw, dh, p]); // p 为像素在文件中的起始偏移（零拷贝）
        p += need;
      }

      if (p !== bodyEnd) {
        throw new CxrFormatError(
          `帧体未恰好用完：消费 ${p - bodyStart} / ${bodyEnd - bodyStart} 字节`,
          p,
        );
      }

      // CRC 在结构合法之后再算（覆盖完整帧体）
      const crcOk = crc32Range(view, bodyStart, bodyEnd) === storedCrc;
      if (!crcOk) {
        const e = new CxrFormatError(
          `CRC32 校验失败（记录 0x${storedCrc.toString(16).padStart(8, '0')}）`,
          crcOffset,
        );
        e.crc = true;
        throw e;
      }

      // ---- 帧级合法性 / 链路判定 ----
      let valid = false;
      let reason = null;
      if (key === 1) {
        const fullCanvas =
          base === NO_BASE &&
          moveCount === 0 &&
          dirtyCount === 1 &&
          dirty[0][0] === 0 &&
          dirty[0][1] === 0 &&
          dirty[0][2] === width &&
          dirty[0][3] === height;
        if (fullCanvas) {
          valid = true;
        } else {
          reason = '关键帧不满足：base=0xffffffff、无移动、且仅有一个 (0,0) 满画布脏块';
        }
      } else {
        if (!chainValid) {
          reason = `差量帧出现在断链状态（上一成功帧 seq=${lastSuccessSeq < 0 ? '无' : lastSuccessSeq}）`;
        } else if (base !== (lastSuccessSeq >>> 0)) {
          reason = `base=${base} 与上一成功帧 seq=${lastSuccessSeq} 不符`;
        } else if (seq <= lastSuccessSeq) {
          reason = `成功帧 seq 未严格递增：${seq} <= ${lastSuccessSeq}`;
        } else {
          valid = true;
        }
      }

      if (valid) {
        if (key === 1) {
          chainValid = true;
          anchorIndex = frames.length;
        }
        lastSuccessSeq = seq;
      } else {
        chainValid = false;
        anchorIndex = -1;
      }

      entry = {
        index: frames.length,
        offset: frameStart,
        length: L,
        seq,
        base,
        key: key === 1,
        moves,
        dirty,
        valid,
        reason,
        anchorIndex: valid ? anchorIndex : -1,
      };
    } catch (err) {
      // 帧体非法 / CRC 错：按已知长度跳过，中断差量链
      chainValid = false;
      anchorIndex = -1;
      entry = {
        index: frames.length,
        offset: frameStart,
        length: L,
        seq: null,
        base: null,
        key: false,
        moves: [],
        dirty: [],
        valid: false,
        reason: err.message || String(err),
        anchorIndex: -1,
      };
    }

    frames.push(entry);
    offset = bodyEnd;
  }

  return {
    buffer,
    view,
    u8,
    width,
    height,
    frameBytes,
    frames,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// 重建
// ---------------------------------------------------------------------------
export class CxrDecoder {
  constructor(parsed, opts = {}) {
    this.p = parsed;
    this.W = parsed.width;
    this.H = parsed.height;
    this.frameBytes = parsed.frameBytes;
    this.snapshots = new Map(); // frameIndex -> Uint8Array

    // 快照节奏：保证最坏重放距离 <= 256，且缓存数量受工作内存约束。
    // 目标快照驻留约 160MiB（输入文件本体与浏览器空载另行扣除）。
    const targetSnapshotBytes = opts.snapshotBudget ?? 160 * 1024 * 1024;
    const maxLive = Math.max(2, Math.floor(targetSnapshotBytes / this.frameBytes));
    this.maxSnapshots = Math.min(64, maxLive);
    this.snapshotEvery = opts.snapshotEvery ?? 256;
  }

  // 找到包含 frameIndex 的链上、不晚于它的最近快照；没有则返回锚点
  _resolveStart(frameIndex) {
    const target = this.p.frames[frameIndex];
    if (!target || !target.valid) return null;

    let best = -1;
    for (const idx of this.snapshots.keys()) {
      // 快照必须与目标同属一条有效链（同一关键帧锚点），否则视为陈旧快照
      if (
        idx <= frameIndex &&
        idx > best &&
        this.p.frames[idx].valid &&
        this.p.frames[idx].anchorIndex === target.anchorIndex
      ) {
        best = idx;
      }
    }
    if (best >= 0) return { index: best, isSnapshot: true };

    const anchor = target.anchorIndex;
    if (anchor < 0) return null;
    return { index: anchor, isSnapshot: false };
  }

  _putSnapshot(index, bytes) {
    const map = this.snapshots;
    if (map.has(index)) {
      map.delete(index);
      map.set(index, bytes); // 刷新 LRU 顺序（同索引像素内容确定且一致）
      return;
    }
    map.set(index, bytes);
    // 关键帧锚点快照受保护：它们是断链恢复的起点，淘汰时跳过
    while (map.size > this.maxSnapshots) {
      const oldest = map.keys().next().value;
      if (this.p.frames[oldest]?.key) {
        // 最旧的是受保护锚点：找其后第一个非锚点快照淘汰
        let victim = null;
        for (const idx of map.keys()) {
          if (!this.p.frames[idx].key) { victim = idx; break; }
        }
        if (victim === null) break; // 全是锚点则允许暂时超上限
        map.delete(victim);
      } else {
        map.delete(oldest);
      }
    }
  }

  // 重建指定有效帧，返回与导出像素逐字节一致的 RGBA8 Uint8Array。
  //
  // 就地更新策略：工作缓冲只有一块。移动块先把"上一成功帧"的源矩形
  // 备份到小块临时缓冲，再写回工作缓冲——因此同帧多个移动块重叠时各自
  // 看到的仍是旧像素（不会在同一张图上二次搬运把字拖花）；脏块随后
  // 按记录顺序直通覆盖。只有制作快照时才发生整帧复制。
  decode(frameIndex) {
    const start = this._resolveStart(frameIndex);
    if (!start) {
      throw new Error(`帧 ${frameIndex} 不是可重建的有效帧`);
    }

    let buf;
    if (start.isSnapshot) {
      // 复制一份作为工作缓冲，快照本身保持不可变
      buf = this.snapshots.get(start.index).slice();
    } else {
      const painted = this._paintKeyframe(start.index);
      // 锚点本身值得常驻（首个关键帧尤其高频复用）；快照持独立副本
      this._putSnapshot(start.index, painted.slice());
      buf = painted;
    }

    // 节拍起点：最近一个关键帧（或重放起点）
    let beatOrigin = start.index;
    for (let i = start.index + 1; i <= frameIndex; i++) {
      const e = this.p.frames[i];
      // 重放路径上的每一帧都必须有效（无效帧必断链，目标锚点会指向其后的关键帧）
      if (!e.valid) {
        throw new Error(`内部错误：帧 ${i} 不属于锚点 ${start.index} 的有效链`);
      }
      if (e.key) {
        // 新关键帧：整块重绘，节拍从这里重新计数
        this._paintKeyframeInto(i, buf);
        beatOrigin = i;
        if (i !== frameIndex) this._putSnapshot(i, buf.slice());
      } else {
        this._applyMovesInPlace(e, buf);
        this._applyDirtyInPlace(e, buf);
        if (i !== frameIndex && (i - beatOrigin) % this.snapshotEvery === 0) {
          this._putSnapshot(i, buf.slice());
        }
      }
    }
    // 目标帧入快照（最近使用，利于连续/来回跳帧）
    this._putSnapshot(frameIndex, buf.slice());
    return buf;
  }

  _paintKeyframe(frameIndex) {
    const e = this.p.frames[frameIndex];
    if (!e.key) throw new Error(`内部错误：帧 ${frameIndex} 不是关键帧`);
    const out = new Uint8Array(this.frameBytes);
    const [x, y, w, h, pxOff] = e.dirty[0];
    // 合法关键帧矩形必为满画布，这里仍走通用裁剪路径
    this._blitDirty(out, x, y, w, h, pxOff);
    return out;
  }

  _paintKeyframeInto(frameIndex, dst) {
    const e = this.p.frames[frameIndex];
    const [x, y, w, h, pxOff] = e.dirty[0];
    this._blitDirty(dst, x, y, w, h, pxOff);
  }

  // 移动（就地版）：所有移动的数据源必须同属"上一成功帧"。
  // 因此先一次性备份本帧全部移动的源矩形，再按记录顺序写目的矩形——
  // 即使移动之间源/目重叠，也不会读到被前一条移动改过的像素。
  // 源、目的同时裁剪，无交集像素的移动不写。
  _applyMovesInPlace(e, buf) {
    const { W, H } = this;
    const backups = [];
    for (const [sx, sy, mw, mh, dx, dy] of e.moves) {
      const xL = Math.max(0, sx, dx);
      const xR = Math.min(W, sx + mw, dx + mw);
      const yL = Math.max(0, sy, dy);
      const yR = Math.min(H, sy + mh, dy + mh);
      if (xR <= xL || yR <= yL) {
        backups.push(null);
        continue;
      }
      const span = xR - xL;
      const rows = yR - yL;
      const srcX0 = sx + (xL - dx);
      const backup = new Uint8Array(span * rows * 4);
      for (let k = 0; k < rows; k++) {
        const srow = sy + (yL - dy) + k;
        const sOff = (srow * W + srcX0) * 4;
        backup.set(buf.subarray(sOff, sOff + span * 4), k * span * 4);
      }
      backups.push({ xL, yL, span, rows, backup });
    }
    // 全部源备份完成后，才允许写目的；按记录顺序覆盖
    for (let m = 0; m < e.moves.length; m++) {
      const bk = backups[m];
      if (!bk) continue;
      const { xL, yL, span, rows, backup } = bk;
      for (let k = 0; k < rows; k++) {
        const dOff = ((yL + k) * W + xL) * 4;
        buf.set(backup.subarray(k * span * 4, (k + 1) * span * 4), dOff);
      }
    }
  }

  _applyDirtyInPlace(e, buf) {
    for (const [x, y, w, h, pxOff] of e.dirty) {
      this._blitDirty(buf, x, y, w, h, pxOff);
    }
  }

  // 脏块直通 RGBA8；仅裁目的，无面积矩形不写像素
  _blitDirty(dst, x, y, w, h, pxOff) {
    if (w === 0 || h === 0) return;
    const { W, H, p } = this;
    const xL = Math.max(0, x);
    const yL = Math.max(0, y);
    const xR = Math.min(W, x + w);
    const yR = Math.min(H, y + h);
    if (xR <= xL || yR <= yL) return;
    const span = xR - xL;
    const u8 = p.u8;
    for (let row = yL; row < yR; row++) {
      const srcX = xL - x;
      const srcY = row - y;
      const sOff = pxOff + (srcY * w + srcX) * 4;
      const dOff = (row * W + xL) * 4;
      dst.set(u8.subarray(sOff, sOff + span * 4), dOff);
    }
  }
}

export { CxrFormatError };
