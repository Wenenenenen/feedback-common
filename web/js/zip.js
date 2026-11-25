/*
 * zip.js — 最小 ZIP 归档读取（stored / deflate），无第三方依赖。
 * 浏览器用 DecompressionStream('deflate-raw')，Node 测试回退 zlib。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RBZip = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function findEOCD(dv, len) {
    // EOCD 签名 0x06054b50，从尾部向前最多 64KiB+22
    const min = Math.max(0, len - (65535 + 22));
    for (let i = len - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) return i;
    }
    throw new Error('不是有效的 ZIP：找不到 EOCD');
  }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        // 继续尝试 Node zlib
      }
    }
    if (typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return new Uint8Array(zlib.inflateRawSync(Buffer.from(compressed)));
      } catch (e) {
        throw new Error('无法解压 deflate 条目：' + e.message);
      }
    }
    throw new Error('当前环境不支持 deflate-raw 解压');
  }

  /**
   * 解析 ZIP 字节，返回 [{name, bytes:Uint8Array}]
   */
  async function unzip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const eocd = findEOCD(dv, u8.length);
    let cdOffset = dv.getUint32(eocd + 16, true);
    let cdCount = dv.getUint16(eocd + 10, true);

    // ZIP64
    if (cdOffset === 0xffffffff || cdCount === 0xffff) {
      try {
        const z64 = findZip64EOCD(dv, eocd);
        if (z64) {
          cdOffset = Number(dv.getBigUint64(z64 + 48, true));
          cdCount = Number(dv.getBigUint64(z64 + 32, true));
        }
      } catch (e) { /* 忽略，按普通 zip 处理 */ }
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 中央目录条目签名错误');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      let compSize = dv.getUint32(p + 20, true);
      let uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      let nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
      const name = decodeName(nameBytes, flags);

      // ZIP64 额外字段
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
        const extraStart = p + 46 + nameLen;
        let ep = extraStart;
        const extraEnd = extraStart + extraLen;
        while (ep + 4 <= extraEnd) {
          const id = dv.getUint16(ep, true);
          const sz = dv.getUint16(ep + 2, true);
          if (id === 0x0001) {
            let q = ep + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
          }
          ep += 4 + sz;
        }
      }

      // 用本地头中的 name/extra 长度定位数据
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('ZIP 本地头签名错误：' + name);
      const localNameLen = dv.getUint16(localOff + 26, true);
      const localExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + localNameLen + localExtraLen;
      const raw = u8.subarray(dataStart, dataStart + compSize);

      let bytes;
      if (method === 0) {
        bytes = raw.slice();
      } else if (method === 8) {
        bytes = await inflateRaw(raw);
      } else {
        throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方式 ${method}`);
      }
      entries.push({ name, bytes, size: uncompSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function findZip64EOCD(dv, eocd) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const off = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(off, true) === 0x06064b50) return off;
    }
    return 0;
  }

  function decodeName(bytes, flags) {
    // bit 11 = UTF-8
    if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return new TextDecoder('latin1').decode(bytes);
    }
  }

  /** 在条目列表中找 layout.json / dump.bin，允许位于单层目录下 */
  function pickNamed(entries, base) {
    const exact = entries.find((e) => e.name === base || e.name === './' + base);
    if (exact) return exact;
    const re = new RegExp('(^|/)' + base.replace('.', '\\.') + '$');
    const hits = entries.filter((e) => re.test(e.name) && !e.name.endsWith('/'));
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.name.length - b.name.length);
    return hits[0];
  }

  return { unzip, pickNamed };
});
