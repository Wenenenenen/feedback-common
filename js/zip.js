/*
 * ZIP 读写（浏览器与 Node 通用）。
 * 读取：store / deflate-raw，校验收缩尺寸、CRC32 与条目名（拒绝绝对路径、.. 、反斜杠）。
 * 写出：优先 deflate-raw（浏览器 / Node 内置 CompressionStream），不可用时退回 store。
 * 所有导入内容视为不可信输入。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ENTRY = 512 * 1024 * 1024;
  const MAX_TOTAL = 1024 * 1024 * 1024;

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

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前环境不支持解压（缺少 DecompressionStream）'));
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
  }

  function deflateRaw(data) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
  }

  function normalise(name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (name.includes('\0') || name.includes('\\') || name.includes(':')) return null;
    if (name.startsWith('/')) return null;
    const clean = [];
    for (const part of name.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') return null;
      clean.push(part);
    }
    if (clean.length === 0) return null;
    return clean.join('/');
  }

  /** 读取 ZIP，返回 Map<规范化路径, Uint8Array>（跳过目录条目）。 */
  async function unzip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 22) throw new Error('不是有效的 ZIP 文件（太短）');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    const minPos = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到目录结尾）');
    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    if (cdOffset + cdSize > u8.length) throw new Error('ZIP 目录越界');
    const out = new Map();
    let total = 0;
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
        throw new Error('ZIP 条目名不是合法 UTF-8');
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x1) throw new Error(`条目 "${name}" 已加密，无法读取`);
      if (uncompSize > MAX_ENTRY) throw new Error(`条目 "${name}" 过大`);
      total += uncompSize;
      if (total > MAX_TOTAL) throw new Error('ZIP 解压后总大小超限');
      if (localOff + 30 > u8.length) throw new Error(`条目 "${name}" 本地头越界`);
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`条目 "${name}" 本地头签名错误`);
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compSize > u8.length) throw new Error(`条目 "${name}" 数据越界`);
      const norm = normalise(name);
      if (!norm) throw new Error(`条目名 "${name}" 非法（不允许绝对路径、.. 或反斜杠）`);
      if (norm.endsWith('/')) continue;
      const comp = u8.subarray(dataOff, dataOff + compSize);
      let data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error(`条目 "${name}" 使用了不支持的压缩方式 ${method}`);
      if (data.length !== uncompSize) throw new Error(`条目 "${name}" 解压后尺寸不符`);
      if (crc32(data) !== crc) throw new Error(`条目 "${name}" CRC 校验失败`);
      out.set(norm, data);
    }
    if (out.size === 0) throw new Error('ZIP 中没有可用文件');
    return out;
  }

  const utf8 = new TextEncoder();

  function localHeader(nameBytes, data, crc) {
    const head = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 名字
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    head.set(nameBytes, 30);
    return head;
  }

  function assemble(parts, central, count, crcList, sizes) {
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, count, true);
    edv.setUint16(10, count, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, parts.reduce((a, b) => a + b.length, 0), true);
    const total = parts.reduce((a, b) => a + b.length, 0) + cdSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(eocd, pos);
    return out;
  }

  /** 以 store（不压缩）写出 ZIP；entries: [{name, data:Uint8Array}] */
  function zipStore(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const norm = normalise(e.name);
      if (!norm) throw new Error(`导出条目名非法：${e.name}`);
      const nameBytes = utf8.encode(norm);
      const data = e.data;
      const crc = crc32(data);
      const head = localHeader(nameBytes, data, crc);
      const rec = new Uint8Array(head.length + data.length);
      rec.set(head, 0);
      rec.set(data, head.length);
      parts.push(rec);
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
      offset += rec.length;
    }
    return assemble(parts, central, entries.length);
  }

  /**
   * 以 deflate-raw 写出 ZIP（浏览器与 Node 均可用内置流）。
   * 失败或环境不支持时退回 store。
   */
  async function zip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    try {
      for (const e of entries) {
        const norm = normalise(e.name);
        if (!norm) throw new Error(`导出条目名非法：${e.name}`);
        const nameBytes = utf8.encode(norm);
        const data = e.data;
        const comp = await deflateRaw(data);
        if (!comp) return zipStore(entries);
        const crc = crc32(data);
        const head = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(head.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);
        dv.setUint16(8, 8, true); // deflate
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0x21, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, comp.length, true);
        dv.setUint32(22, data.length, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        head.set(nameBytes, 30);
        const rec = new Uint8Array(head.length + comp.length);
        rec.set(head, 0);
        rec.set(comp, head.length);
        parts.push(rec);
        const cen = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(cen.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
        cdv.setUint16(8, 0x0800, true);
        cdv.setUint16(10, 8, true);
        cdv.setUint16(12, 0, true);
        cdv.setUint16(14, 0x21, true);
        cdv.setUint32(16, crc, true);
        cdv.setUint32(20, comp.length, true);
        cdv.setUint32(24, data.length, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint32(42, offset, true);
        cen.set(nameBytes, 46);
        central.push(cen);
        offset += rec.length;
      }
      return assemble(parts, central, entries.length);
    } catch {
      return zipStore(entries);
    }
  }

  return { crc32, unzip, zip, zipStore };
});
