/*
 * zip-read.js — 最小 ZIP 读取器（无第三方依赖）
 * 支持 method 0 (stored) 与 8 (deflate-raw，经 DecompressionStream)。
 * 只负责把条目解成 Uint8Array，不执行包内任何内容。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CCL = root.CCL || {};
    Object.assign(root.CCL, { Zip: api });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  function findEOCD(dv, len) {
    // EOCD 至少 22 字节，注释最长 65535。
    const lo = Math.max(0, len - 22 - 65535);
    for (let i = len - 22; i >= lo; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) return i;
    }
    throw new Error('ZIP 中找不到 EOCD 记录');
  }

  function decodeName(u8) {
    try { return new TextDecoder('utf-8').decode(u8); }
    catch (e) { return String.fromCharCode.apply(null, u8); }
  }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持 DecompressionStream，无法解压 deflate 条目');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  /**
   * 读取 zip：ArrayBuffer | Uint8Array -> [{ name, bytes:Uint8Array }]
   */
  async function unzip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const eocd = findEOCD(dv, u8.length);
    let cdOffset = dv.getUint32(eocd + 16, true);
    const cdCount = dv.getUint16(eocd + 10, true);

    // 处理 ZIP64 长度/偏移（本任务素材很小，正常走不到，仅做基本兜底）。
    if (cdOffset === 0xffffffff || cdCount === 0xffff) {
      throw new Error('暂不支持 ZIP64，请先解压后导入其中的 WAV');
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (dv.getUint32(p, true) !== CDFH_SIG) throw new Error('ZIP 中央目录损坏');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const rawName = u8.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? decodeName(rawName) : decodeName(rawName);

      if (dv.getUint32(localOff, true) !== LFH_SIG) throw new Error('ZIP 本地文件头损坏: ' + name);
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const compressed = u8.subarray(dataStart, dataStart + compSize);

      let bytes;
      if (method === 0) {
        bytes = compressed.slice();
      } else if (method === 8) {
        bytes = await inflateRaw(compressed);
      } else {
        throw new Error('不支持的 ZIP 压缩方法 ' + method + '（' + name + '）');
      }
      entries.push({ name, bytes, size: uncompSize || bytes.length });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  return { unzip };
});
