/*
 * zip-import.js — minimal ZIP reader for settings bundles.
 *
 * Scope: the workbench only needs to pull a small settings.json and a WAV
 * out of an archive. We parse the local file headers directly and support
 * the two compression methods a normal archiver emits for this content:
 *   0  stored
 *   8  deflate  (via DecompressionStream('deflate-raw'), available in all
 *               current evergreen browsers)
 * Zip64, encryption and spanned archives are rejected explicitly.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ZipImport = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function ascii(u8, start, len) {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[start + i]);
    return s;
  }

  function inflateRaw(u8) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("浏览器不支持 DecompressionStream，无法解压 deflate 条目"));
    }
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }

  /**
   * @returns {Promise<Map<string, Uint8Array>>} archive entries by path
   */
  async function readZip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const entries = new Map();
    let p = 0;
    let sawLocal = false;

    // Signatures as read little-endian via getUint32.
    const SIG_LOCAL = 0x04034b50;
    const STOP_SIGS = new Set([
      0x02014b50, // central directory file header
      0x06054b50, // end of central directory
      0x06064b50, // zip64 EOCD
      0x07064b50, // zip64 EOCD locator
    ]);
    // NOTE: the on-disk byte patterns are 50 4B .. ..; DataView little-endian
    // reads return the constants above (e.g. bytes 50 4B 01 02 -> 0x02014b50).
    while (p + 4 <= u8.length) {
      const sig = dv.getUint32(p, true);
      // Central directory header, EOCD (or zip64 variants): local scan is done.
      if (STOP_SIGS.has(sig)) break;
      if (p + 30 > u8.length || sig !== SIG_LOCAL) {
        throw new Error("非法 ZIP：本地文件头签名错误，偏移 " + p);
      }
      sawLocal = true;
      const version = dv.getUint16(p + 4, true);
      const flags = dv.getUint16(p + 6, true);
      const method = dv.getUint16(p + 8, true);
      const crc = dv.getUint32(p + 14, true);
      const compSize = dv.getUint32(p + 18, true);
      const uncompSize = dv.getUint32(p + 22, true);
      const nameLen = dv.getUint16(p + 26, true);
      const extraLen = dv.getUint16(p + 28, true);
      const name = ascii(u8, p + 30, nameLen);
      const dataStart = p + 30 + nameLen + extraLen;

      if (flags & 0x01) throw new Error("加密的 ZIP 条目不受支持：" + name);
      if (flags & 0x08) throw new Error("使用数据描述符的 ZIP（流式写入）不受支持：" + name);
      if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) {
        throw new Error("Zip64 归档不受支持");
      }
      if (method !== 0 && method !== 8) {
        throw new Error("不支持的压缩方式 " + method + "（条目 " + name + "），仅存储/deflate");
      }
      const raw = u8.subarray(dataStart, dataStart + compSize);
      let content;
      if (method === 0) {
        content = raw.slice();
      } else {
        content = new Uint8Array(await inflateRaw(raw));
      }
      if (crc !== 0 && content.length !== uncompSize) {
        throw new Error("条目 " + name + " 解压后长度不符");
      }
      if (!name.endsWith("/")) entries.set(name.replace(/\\/g, "/"), content);
      // Local file data has no padding byte; only central-directory records pad.
      p = dataStart + compSize;
    }
    if (!sawLocal) throw new Error("未在归档中找到任何文件条目");
    return entries;
  }

  return { readZip };
});
