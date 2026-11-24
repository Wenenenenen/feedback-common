/*
 * 最小 ZIP 读取器（stored + deflate）。用于导入测量包示例。
 * 所有输入按不可信数据处理：拒绝绝对路径、".."、反斜杠、隐藏段、加密条目、
 * 超大条目与不支持的压缩方式；解压前先校验长度，解压后再核对 CRC32。
 * 浏览器（全局 SHMZip）与 Node（module.exports）共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHMZip = api;
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

  const MAX_ENTRY = 512 * 1024 * 1024;
  const MAX_TOTAL = 1024 * 1024 * 1024;
  const MAX_NAME = 512;

  function safeName(raw) {
    if (!raw) throw new Error('ZIP 条目名为空');
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('ZIP 含绝对路径：' + raw);
    if (raw.includes('\\')) throw new Error('ZIP 条目名含反斜杠：' + raw);
    if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('ZIP 条目名含控制字符');
    const parts = raw.split('/');
    for (const p of parts) {
      if (p === '..') throw new Error('ZIP 含路径穿越：' + raw);
      if (p.startsWith('.')) throw new Error('ZIP 含隐藏条目：' + raw);
    }
    if (!/^[\p{L}\p{N}._\- ()\/]+$/u.test(raw)) throw new Error('ZIP 条目名含不允许的字符：' + raw);
    if (raw.length > MAX_NAME) throw new Error('ZIP 条目名过长');
    return raw;
  }

  async function inflateRaw(data) {
    let ds;
    try {
      ds = new DecompressionStream('deflate-raw');
    } catch (e) {
      throw new Error('当前环境不支持 deflate 解压（缺少 DecompressionStream）');
    }
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /*
   * 读取 ZIP，返回 Map<normalisedName, Uint8Array>（按条目在压缩包中的顺序）。
   * 目录条目跳过。
   */
  async function unzip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    const minPos = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到目录结尾）');
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('不支持 ZIP64');
    if (cdOffset + cdSize > u8.length) throw new Error('ZIP 中央目录越界');
    const out = new Map();
    let total = 0;
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length) throw new Error('ZIP 中央目录条目越界');
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 中央目录签名错误');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const compSize = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      if (p + 46 + nameLen > u8.length) throw new Error('ZIP 条目名越界');
      const rawName = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
      const next = p + 46 + nameLen + extraLen + commentLen;
      if (next > u8.length) throw new Error('ZIP 中央目录条目越界');
      p = next;
      if (rawName.endsWith('/')) continue;         // 目录
      const name = safeName(rawName);
      if (out.has(name)) throw new Error('ZIP 条目重复：' + name);
      if (flags & 0x1) throw new Error('ZIP 条目已加密，不支持：' + name);
      if (flags & 0x8) throw new Error('ZIP 条目使用数据描述符，不支持：' + name);
      if (method !== 0 && method !== 8) throw new Error('ZIP 压缩方式 ' + method + ' 不受支持：' + name);
      if (uncompSize > MAX_ENTRY) throw new Error('ZIP 条目过大：' + name);
      total += uncompSize;
      if (total > MAX_TOTAL) throw new Error('ZIP 解压总量过大');
      if (localOffset + 30 > u8.length) throw new Error('ZIP 本地头越界：' + name);
      if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 本地头签名错误：' + name);
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > u8.length) throw new Error('ZIP 条目数据越界：' + name);
      const comp = u8.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) {
        if (compSize !== uncompSize) throw new Error('ZIP stored 条目长度不符：' + name);
        data = comp.slice();
      } else {
        data = await inflateRaw(comp);
        if (data.length !== uncompSize) throw new Error('ZIP 解压长度不符：' + name);
      }
      if (crc32(data) !== crc) throw new Error('ZIP CRC 校验失败：' + name);
      out.set(name, data);
    }
    return out;
  }

  /* 打包 ZIP（stored，无压缩），用于「全部导出」。entries: [{name, data:Uint8Array}] */
  function zipStore(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();
    for (const e of entries) {
      const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      const nameBytes = enc.encode(e.name);
      if (nameBytes.length > MAX_NAME) throw new Error('ZIP 条目名过长：' + e.name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(local.buffer);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(4, 20, true);
      ldv.setUint16(6, 0x0800, true);      // UTF-8 名
      ldv.setUint16(8, 0, true);
      ldv.setUint16(10, 0, true);          // 时间 / 日期
      ldv.setUint16(12, 0, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, data.length, true);
      ldv.setUint32(22, data.length, true);
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cen.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      parts.push(local, data);
      central.push(cen);
      offset += local.length + data.length;
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

  return { unzip, crc32, zipStore };
});
