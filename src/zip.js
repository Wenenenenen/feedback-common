/*
 * 最小 ZIP 读取器（只支持 stored / deflate，含 ZIP64 不支持的明确报错）。
 * 浏览器：globalThis.PQZip；Node：module.exports
 * 依赖浏览器 DecompressionStream（Node 18+ / Chrome 80+ 均支持）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PQZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_CEN = 0x02014b50;
  const SIG_LOC = 0x04034b50;

  function findEOCD(u8) {
    const min = 22;
    const start = Math.max(0, u8.length - 22 - 0xffff);
    for (let i = u8.length - min; i >= start; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 deflate');
    }
    const ds = new DecompressionStream('deflate-raw');
    const blob = new Blob([data]);
    const stream = blob.stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * 解析 ZIP，返回 [{name, size, compressedSize, method, bytes:()=>Promise<Uint8Array>}]
   */
  async function readZip(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const eocd = findEOCD(u8);
    if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结尾');
    const total = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 压缩包，请用普通 ZIP');
    }
    if (cdOffset + cdSize > u8.length) throw new Error('ZIP 中央目录越界，文件可能损坏');

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
      if (view.getUint32(p, true) !== SIG_CEN) throw new Error('ZIP 中央目录项损坏');
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue; // 目录

      const entry = {
        name,
        size,
        compressedSize: compSize,
        method,
        bytes: async () => {
          const lv = new DataView(arrayBuffer);
          if (lv.getUint32(localOff, true) !== SIG_LOC) throw new Error('ZIP 本地头损坏: ' + name);
          const lNameLen = lv.getUint16(localOff + 26, true);
          const lExtraLen = lv.getUint16(localOff + 28, true);
          const dataStart = localOff + 30 + lNameLen + lExtraLen;
          const raw = u8.subarray(dataStart, dataStart + compSize);
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw);
          throw new Error('不支持的压缩方式 ' + method + '（' + name + '）');
        },
      };
      if (entry.size > 512 * 1024 * 1024) throw new Error('条目过大: ' + name);
      entries.push(entry);
    }
    return entries;
  }

  return { readZip };
});
