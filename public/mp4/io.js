// Sequential big-endian reader over an ArrayBuffer with bounded sub-readers.

export class ByteReader {
  constructor(buffer, start = 0, end = buffer.byteLength) {
    this.view = new DataView(buffer);
    this.u8a = new Uint8Array(buffer);
    this.start = start;
    this.end = end;
    this.pos = start;
  }

  remaining() {
    return this.end - this.pos;
  }

  need(n) {
    if (this.pos + n > this.end) {
      throw new Error(`字段不完整：需要 ${n} 字节，仅剩 ${this.remaining()}（偏移 ${this.pos}）`);
    }
  }

  u8() {
    this.need(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u24() {
    this.need(3);
    const p = this.pos;
    const v = (this.u8a[p] << 16) | (this.u8a[p + 1] << 8) | (this.u8a[p + 2]);
    this.pos += 3;
    return v >>> 0;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  u64() {
    this.need(8);
    const v = this.view.getBigUint64(this.pos);
    this.pos += 8;
    return v;
  }

  // ISO BMFF four-character code.
  fourcc() {
    this.need(4);
    const p = this.pos;
    const a = this.u8a;
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(a[p + i]);
    this.pos += 4;
    return s;
  }

  bytes(n) {
    this.need(n);
    const v = this.u8a.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  // Bounded reader for a declared child box; parent boundaries are enforced.
  child(n) {
    this.need(n);
    const r = new ByteReader(this.view.buffer, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }

  // Read one box header (supports 64-bit largesize). Returns a bounded body
  // reader and advances past the whole box.
  readBox() {
    const start = this.pos;
    let size = this.u32();
    const type = this.fourcc();
    let headerSize = 8;
    if (size === 1) {
      size = Number(this.u64());
      headerSize = 16;
      if (size < 16) throw new Error(`盒 ${type}（偏移 ${start}）扩展大小非法`);
    }
    if (size < 8 || start + size > this.end) {
      throw new Error(`盒 ${type}（偏移 ${start}）大小 ${size} 越出父盒边界`);
    }
    const bodyStart = this.pos;
    const body = this.child(size - headerSize);
    return { type, start, size, headerSize, bodyStart, body };
  }
}

// Growing big-endian writer.
export class ByteWriter {
  constructor(initial = 4096) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.u8a = new Uint8Array(this.buf);
    this.pos = 0;
  }

  get length() {
    return this.pos;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.pos + n) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.u8a = new Uint8Array(next);
  }

  u8(v) {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v);
    this.pos += 2;
  }

  u24(v) {
    this.ensure(3);
    this.u8a[this.pos] = (v >>> 16) & 0xff;
    this.u8a[this.pos + 1] = (v >>> 8) & 0xff;
    this.u8a[this.pos + 2] = v & 0xff;
    this.pos += 3;
  }

  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
  }

  i32(v) {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0);
    this.pos += 4;
  }

  u64(v) {
    this.ensure(8);
    this.view.setBigUint64(this.pos, BigInt(v));
    this.pos += 8;
  }

  fourcc(s) {
    this.ensure(4);
    for (let i = 0; i < 4; i++) this.u8a[this.pos + i] = s.charCodeAt(i);
    this.pos += 4;
  }

  bytes(a) {
    this.ensure(a.length);
    this.u8a.set(a, this.pos);
    this.pos += a.length;
  }

  // Zero-filled placeholder; returns a handle for later patching.
  reserve(n) {
    this.ensure(n);
    const at = this.pos;
    for (let i = 0; i < n; i++) this.u8a[this.pos + i] = 0;
    this.pos += n;
    return { at, n };
  }

  patchU32(at, v) {
    this.view.setUint32(at, v >>> 0);
  }

  patchI32(at, v) {
    this.view.setInt32(at, v | 0);
  }

  toUint8Array() {
    return this.u8a.slice(0, this.pos);
  }
}
