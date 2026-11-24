// timeline.js — 拼接轨模型
//
// 段（segment）引用源轨的半开区间 [srcStart, srcEnd)：
//   reverse=false：拼接帧 d 对应源帧 srcStart + d；
//   reverse=true ：拼接帧 d 对应源帧 srcEnd - 1 - d（帧内双声道顺序不变，不交换 L/R）；
//   muted=true   ：声音不计，按零样本统计，逐帧查询返回 0。
// 拆分只是把一个段变成两个引用同一区间的段（倒序时镜像切分），声音不变。

import { mergeStat, zeroStat } from './pyramid.js';

export const MAX_SEGMENTS = 20000;
export const MAX_TOTAL_FRAMES = 0x7fffffff; // 2^31 - 1
export const MAX_COLUMNS = 2048;

let nextSegmentId = 1;

export function makeSegment(sourceId, srcStart, srcEnd, { reverse = false, muted = false } = {}) {
  if (!Number.isInteger(srcStart) || !Number.isInteger(srcEnd) || srcEnd <= srcStart || srcStart < 0) {
    throw new RangeError(`非法源区间 [${srcStart}, ${srcEnd})`);
  }
  return { id: nextSegmentId++, sourceId, srcStart, srcEnd, reverse, muted };
}

export class Timeline {
  /** @param {Map<string, {pyramid: import('./pyramid.js').SourcePyramid, frameCount:number, name:string}>} sources */
  constructor(sources) {
    this.sources = sources;
    /** @type {ReturnType<typeof makeSegment>[]} */
    this.segments = [];
    this.offsets = []; // 段 i 起点 = offsets[i]，长度 frameCount
    this._total = 0;
  }

  rebuild() {
    this.offsets = new Array(this.segments.length);
    let acc = 0;
    for (let i = 0; i < this.segments.length; i++) {
      this.offsets[i] = acc;
      acc += this.segments[i].srcEnd - this.segments[i].srcStart;
    }
    this._total = acc;
  }
  totalFrames() { return this._total; }

  _checkSourceRef(seg) {
    const src = this.sources.get(seg.sourceId);
    if (!src) throw new RangeError(`引用了不存在的源轨 ${seg.sourceId}`);
    if (seg.srcEnd > src.frameCount) throw new RangeError(`源区间越过源轨长度（${src.frameCount} 帧）`);
  }

  _checkCapacity(addLength, addCount = 1) {
    if (this.segments.length + addCount > MAX_SEGMENTS) {
      throw new RangeError(`拼接段数超过 ${MAX_SEGMENTS} 段上限`);
    }
    if (this._total + addLength > MAX_TOTAL_FRAMES) {
      throw new RangeError(`总帧数超过 2^31-1（${MAX_TOTAL_FRAMES}）上限`);
    }
  }

  append(seg) {
    this._checkSourceRef(seg);
    this._checkCapacity(seg.srcEnd - seg.srcStart);
    this.segments.push(seg);
    this.rebuild();
  }

  removeAt(index) {
    if (index < 0 || index >= this.segments.length) throw new RangeError('段索引越界');
    this.segments.splice(index, 1);
    this.rebuild();
  }

  /** 在段内的 absFrame 处拆分；absFrame 落在段边界上则不做任何事 */
  splitAt(absFrame) {
    const loc = this.locate(absFrame);
    if (!loc) return;
    const { seg, index, offsetInSegment } = loc;
    if (offsetInSegment === 0) return; // 已在边界
    const len = seg.srcEnd - seg.srcStart;
    if (offsetInSegment === len) return;
    let a, b;
    if (!seg.reverse) {
      // [s,e) → [s,m) + [m,e)
      const m = seg.srcStart + offsetInSegment;
      a = { ...seg, srcEnd: m };
      b = { ...seg, srcStart: m };
    } else {
      // 倒序：拼接前半对应源尾部，镜像切分，保证声音逐帧不变
      const m = seg.srcEnd - offsetInSegment;
      a = { ...seg, srcStart: m };                 // 拼接 [0, cut) → 源 [m, e) 倒序
      b = { ...seg, srcEnd: m };                   // 拼接 [cut, len) → 源 [s, m) 倒序
    }
    this.segments.splice(index, 1, a, b);
    this.rebuild();
  }

  move(index, toIndex) {
    if (index < 0 || index >= this.segments.length) throw new RangeError('段索引越界');
    const [seg] = this.segments.splice(index, 1);
    const clamped = Math.max(0, Math.min(toIndex, this.segments.length));
    this.segments.splice(clamped, 0, seg);
    this.rebuild();
  }

  toggleReverse(index) {
    const seg = this.at(index);
    seg.reverse = !seg.reverse;
  }

  toggleMute(index) {
    const seg = this.at(index);
    seg.muted = !seg.muted;
  }

  at(index) {
    if (index < 0 || index >= this.segments.length) throw new RangeError('段索引越界');
    return this.segments[index];
  }

  /** 拼接帧 → 段 + 源位置；超出总长度返回 null */
  locate(absFrame) {
    if (!Number.isInteger(absFrame) || absFrame < 0 || absFrame >= this._total) return null;
    if (this.offsets.length === 0 || absFrame < this.offsets[0]) return null;
    // 二分：最后一个 offsets[i] <= absFrame
    let lo = 0, hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= absFrame) lo = mid; else hi = mid - 1;
    }
    const index = lo;
    const seg = this.segments[index];
    const offsetInSegment = absFrame - this.offsets[index];
    const srcFrame = seg.reverse
      ? seg.srcEnd - 1 - offsetInSegment
      : seg.srcStart + offsetInSegment;
    return { index, seg, offsetInSegment, srcFrame };
  }

  /** 单帧逐帧定位：源位置与两个声道的值（静音返回 0） */
  inspectFrame(absFrame) {
    const loc = this.locate(absFrame);
    if (!loc) return null;
    const { seg, index, offsetInSegment, srcFrame } = loc;
    const src = this.sources.get(seg.sourceId);
    if (seg.muted) {
      return {
        absFrame, segmentIndex: index, sourceId: seg.sourceId, sourceName: src.name,
        srcFrame, reverse: seg.reverse, muted: true,
        values: [0, 0],
      };
    }
    return {
      absFrame, segmentIndex: index, sourceId: seg.sourceId, sourceName: src.name,
      srcFrame, reverse: seg.reverse, muted: false,
      values: [src.pyramid.sample(0, srcFrame), src.pyramid.sample(1, srcFrame)],
    };
  }

  // 取一段引用的源统计；倒序映射为等价源半开区间（统计与顺序无关）
  _sourceStat(seg, d0, d1, channel) {
    const src = this.sources.get(seg.sourceId);
    let s, e;
    if (!seg.reverse) {
      s = seg.srcStart + d0;
      e = seg.srcStart + d1;
    } else {
      s = seg.srcEnd - d1;
      e = seg.srcEnd - d0;
    }
    return src.pyramid.query(channel, s, e);
  }

  /**
   * 拼接轨半开区间 [start, end) 的双声道精确统计。
   * 静音段贡献零样本（min=max=0、count 照计、sumSq=0）。
   */
  rangeStats(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > this._total || end < start) {
      throw new RangeError(`非法统计区间 [${start}, ${end})`);
    }
    const out = [null, null];
    if (end === start) return out;
    for (let ch = 0; ch < 2; ch++) {
      let acc = null;
      let i = 0;
      // 单调推进到与区间相交的第一段（不能在相交后提前 break：后续段仍可能落回区间内）
      while (i < this.segments.length && this._segEnd(i) <= start) i++;
      for (; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const segStart = this.offsets[i];
        const segEnd = segStart + (seg.srcEnd - seg.srcStart);
        if (segStart >= end) continue;
        const d0 = Math.max(start, segStart) - segStart;
        const d1 = Math.min(end, segEnd) - segStart;
        if (d1 <= d0) continue;
        const pieceLen = d1 - d0;
        let piece;
        if (seg.muted) piece = zeroStat(pieceLen);
        else piece = this._sourceStat(seg, d0, d1, ch);
        acc = mergeStat(acc, piece);
      }
      out[ch] = acc;
    }
    return out;
  }

  _segEnd(i) {
    return this.offsets[i] + (this.segments[i].srcEnd - this.segments[i].srcStart);
  }

  /**
   * 把所选 n 帧（[selStart, selStart+n)）分到 B 列：
   * 第 j 列边界 floor(j n / B)，j=0..B。
   * 空列 min/max 为 null，count=0、sumSq=0n。
   * 返回列数组，每列 { start, end, stats:[左,右] }。
   */
  columnStats(selStart, n, B) {
    if (!Number.isInteger(B) || B < 1 || B > MAX_COLUMNS) throw new RangeError('B 必须在 1..2048');
    if (!Number.isInteger(selStart) || !Number.isInteger(n) || n < 0 ||
        selStart < 0 || selStart + n > this._total) {
      throw new RangeError('所选区间超出拼接轨范围');
    }
    const columns = new Array(B);
    if (n === 0) {
      for (let j = 0; j < B; j++) {
        columns[j] = { start: selStart, end: selStart, stats: [null, null] };
      }
      return columns;
    }
    const segCount = this.segments.length;
    let segIdx = 0;
    for (let j = 0; j < B; j++) {
      const colStart = selStart + Math.floor((j * n) / B);
      const colEnd = selStart + Math.floor(((j + 1) * n) / B);
      if (colEnd === colStart) {
        columns[j] = { start: colStart, end: colStart, stats: [null, null] };
        continue;
      }
      while (segIdx < segCount) {
        const s0 = this.offsets[segIdx];
        const s1 = s0 + (this.segments[segIdx].srcEnd - this.segments[segIdx].srcStart);
        if (s1 > colStart) break;
        segIdx++;
      }
      const stats = [null, null];
      for (let ch = 0; ch < 2; ch++) {
        let acc = null;
        let k = segIdx;
        let pos = colStart;
        while (pos < colEnd && k < segCount) {
          const seg = this.segments[k];
          const segStart = this.offsets[k];
          const segEnd = segStart + (seg.srcEnd - seg.srcStart);
          const pieceEnd = Math.min(segEnd, colEnd);
          const d0 = pos - segStart;
          const d1 = pieceEnd - segStart;
          const pieceLen = d1 - d0;
          let piece;
          if (seg.muted) piece = zeroStat(pieceLen);
          else piece = this._sourceStat(seg, d0, d1, ch);
          acc = mergeStat(acc, piece);
          pos = pieceEnd;
          k++;
        }
        stats[ch] = acc;
      }
      columns[j] = { start: colStart, end: colEnd, stats };
    }
    return columns;
  }
}
