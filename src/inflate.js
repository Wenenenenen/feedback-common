/*
 * Minimal ZIP reader (stored + deflate via DecompressionStream) and a tiny
 * ZIP writer (stored) used for the import/export of case bundles.
 * Works in browsers and in modern Node. All input is treated as untrusted.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持解压（缺少 DecompressionStream）');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Read a ZIP archive. Returns Map<normalisedName, Uint8Array>.
   * Rejects absolute paths, "..", backslashes, huge entries and encrypted /
   * unsupported compression methods.
   */
  async function unzip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // locate End of Central Directory
    let eocd = -1;
    const minPos = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到目录结尾）');
    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset + 12 > u8.length) throw new Error('ZIP 目录偏移非法');
    const out = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length) throw new Error('ZIP 目录条目越界');
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 目录条目签名错误');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const compSize = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
      let name;
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
      } catch {
        name = new TextDecoder('utf-8').decode(nameBytes);
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x1) throw new Error(`条目 "${name}" 已加密，无法读取`);
      const norm = normalise(name);
      if (!norm) throw new Error(`条目名 "${name}" 非法（不允许绝对路径或 ..）`);
      if (uncompSize > 512 * 1024 * 1024) throw new Error(`条目 "${name}" 过大`);
      if (localOff + 30 > u8.length) throw new Error(`条目 "${name}" 本地头越界`);
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`条目 "${name}" 本地头签名错误`);
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compSize > u8.length) throw new Error(`条目 "${name}" 数据越界`);
      const comp = u8.subarray(dataOff, dataOff + compSize);
      let data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error(`条目 "${name}" 使用了不支持的压缩方式 ${method}`);
      if (data.length !== uncompSize) throw new Error(`条目 "${name}" 解压后尺寸不符`);
      if (crc32(data) !== crc) throw new Error(`条目 "${name}" CRC 校验失败`);
      if (!norm.endsWith('/')) out.set(norm, data);
    }
    if (out.size === 0) throw new Error('ZIP 中没有可用文件');
    return out;
  }

  function normalise(name) {
    if (name.includes('\0')) return null;
    const parts = name.split('/');
    const clean = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..' || part.includes('\\') || part.includes(':')) return null;
      clean.push(part);
    }
    if (clean.length === 0) return null;
    return clean.join('/');
  }

  /** Build a stored (uncompressed) ZIP from [{name, data:Uint8Array}]. */
  function zip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const data = e.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // utf-8 names
      dv.setUint16(8, 0, true);      // stored
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);  // 1980-01-01
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      parts.push(local);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cen.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);
    const total = offset + cdSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(eocd, pos);
    return out;
  }

  return { unzip, zip, crc32 };
});
