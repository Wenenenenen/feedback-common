// ZIP reader/writer for sequence import/export. No external dependencies.
// Reader: stored (0) and deflated (8) entries, UTF-8 names, data descriptors
// tolerated. Writer: deflate via CompressionStream (browser) or zlib (node).

import { deflateBytes } from './zip-deflate.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateRawSync } = await import('node:zlib');
  return inflateRawSync(bytes);
}

// Parse a ZIP (Uint8Array) into entries: [{ name, bytes: Uint8Array }].
// Directory entries are skipped. Rejects zip-slip paths outright.
export async function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  // Find End Of Central Directory (scan backwards; no zip64 support needed at
  // the sizes this app handles).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP：找不到中央目录');
  const entries = [];
  let off = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (!name.endsWith('/')) {
      if (name.startsWith('/') || name.includes('..')) throw new Error('ZIP 内含非法路径: ' + name);
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      const bytes = method === 0 ? raw.slice() : method === 8 ? await inflate(raw) : (() => { throw new Error('不支持的 ZIP 压缩方式: ' + method); })();
      entries.push({ name, bytes });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// entries: [{ name, bytes }]. Returns a complete ZIP as Uint8Array.
export async function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const compressed = await deflateBytes(bytes);
    const head = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);            // version needed
    hv.setUint16(6, 0x0800, true);        // UTF-8 flag
    hv.setUint16(8, 8, true);             // deflate
    hv.setUint16(10, 0, true); hv.setUint16(12, 0, true); // no time/date
    hv.setUint32(14, crc, true);
    hv.setUint32(18, compressed.length, true);
    hv.setUint32(22, bytes.length, true);
    hv.setUint16(26, nameBytes.length, true);
    hv.setUint16(28, 0, true);
    head.set(nameBytes, 30);
    locals.push(head, compressed);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += head.length + compressed.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  return concat([...locals, ...central, eocd]);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
