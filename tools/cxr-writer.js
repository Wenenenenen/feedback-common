// 测试夹具用 CXR1 写出器（Node ESM）。字段全部小端。
import { crc32 } from 'node:zlib';

export class CxrWriter {
  constructor(width, height) {
    this.W = width;
    this.H = height;
    this.chunks = [Buffer.from('CXR1'), u16(width), u16(height)];
  }

  // body: Buffer；badCrc=true 时写入错误校验和
  _writeBody(body, badCrc = false) {
    const L = body.length + 4; // L 计 CRC32 + 帧体
    const sum = crc32(body) >>> 0;
    this.chunks.push(u32(L), u32(badCrc ? sum ^ 0xdeadbeef : sum), body);
  }

  addKeyframe(seq, rgba) {
    if (rgba.length !== this.W * this.H * 4) throw new Error('关键帧像素必须满画布');
    const body = Buffer.concat([
      u32(seq), u32(0xffffffff), u8(1), u16(0), u16(1),
      i16(0), i16(0), u16(this.W), u16(this.H),
      Buffer.from(rgba),
    ]);
    this._writeBody(body);
  }

  // moves: [[sx,sy,w,h,dx,dy]...]  dirty: [{x,y,w,h,pixels:Uint8Array}]
  addDelta(seq, base, moves, dirty, opts = {}) {
    const parts = [
      u32(seq), u32(base), u8(0), u16(moves.length), u16(dirty.length),
    ];
    for (const [sx, sy, w, h, dx, dy] of moves) {
      parts.push(i16(sx), i16(sy), u16(w), u16(h), i16(dx), i16(dy));
    }
    for (const d of dirty) {
      const need = d.w * d.h * 4;
      if (d.pixels.length !== need) {
        throw new Error(`脏块 ${d.x},${d.y} 像素长度不符：${d.pixels.length} != ${need}`);
      }
      parts.push(i16(d.x), i16(d.y), u16(d.w), u16(d.h), Buffer.from(d.pixels));
    }
    this._writeBody(Buffer.concat(parts), opts.badCrc === true);
  }

  // 直接追加一段原始帧（用于构造非法帧体等），调用方自行负责 body 内容
  addRawFrame(body, badCrc = false) {
    this._writeBody(Buffer.from(body), badCrc);
  }

  // 追加 u32 长度头后只给 partial 字节（截断尾帧）
  appendTruncatedFrame(declaredL, partial) {
    this.chunks.push(u32(declaredL), Buffer.from(partial));
  }

  build() {
    return Buffer.concat(this.chunks);
  }
}

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => {
  if (v < 0 || v > 0xffff) throw new RangeError(`u16 越界：${v}`);
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v >>> 0);
  return b;
};
const i16 = (v) => {
  if (v < -0x8000 || v > 0x7fff) throw new RangeError(`i16 越界：${v}`);
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
};
const u32 = (v) => {
  if (v < 0 || v > 0xffffffff) throw new RangeError(`u32 越界：${v}`);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
