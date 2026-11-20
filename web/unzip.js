/* unzip.js — minimal ZIP reader for the test-bench export packages.
 * Parses the central directory itself and inflates method-8 entries with the
 * browser-native DecompressionStream('deflate-raw') (ZIP stores raw DEFLATE).
 * No third-party code. Method 0 (stored) is also handled. */
"use strict";
(function (root) {
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("浏览器不支持 DecompressionStream，无法解压 ZIP；"
        + "请改用同时选择 .raw 和 .json 多文件导入。");
    }
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Read an ArrayBuffer ZIP; return Map<lowercase filename, Uint8Array>. */
  async function unzip(buffer) {
    const dv = new DataView(buffer);
    // Find end of central directory record (signature 0x06054b50), scanning
    // backwards over the variable comment field.
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= 0; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("未找到 ZIP 中央目录结尾，文件可能已损坏。");
    const total = u16(dv, eocd + 10);
    let offset = u32(dv, eocd + 16);
    const out = new Map();

    for (let n = 0; n < total; n++) {
      if (u32(dv, offset) !== 0x02014b50) {
        throw new Error("ZIP 中央目录结构异常，条目 " + n);
      }
      const method = u16(dv, offset + 10);
      const crc = u32(dv, offset + 16);
      const csize = u32(dv, offset + 20);
      const usize = u32(dv, offset + 24);
      const nLen = u16(dv, offset + 28);
      const eLen = u16(dv, offset + 30);
      const cLen = u16(dv, offset + 32);
      const localOff = u32(dv, offset + 42);
      const nameBytes = new Uint8Array(buffer, offset + 46, nLen);
      const name = new TextDecoder("utf-8").decode(nameBytes);

      // Local header: its name/extra lengths may differ from the central copy.
      if (u32(dv, localOff) !== 0x04034b50) {
        throw new Error("ZIP 本地头结构异常：" + name);
      }
      const lnLen = u16(dv, localOff + 26);
      const leLen = u16(dv, localOff + 28);
      const dataOff = localOff + 30 + lnLen + leLen;
      const raw = new Uint8Array(buffer, dataOff, csize);

      let data;
      if (method === 0) {
        data = raw.slice();
      } else if (method === 8) {
        data = await inflateRaw(raw);
      } else {
        throw new Error("不支持的 ZIP 压缩方式 " + method + "（" + name + "）");
      }
      if (data.length !== usize) {
        throw new Error("解压后长度不符：" + name);
      }
      // CRC check (deflate-raw output trusted, but cheap to verify).
      const gotCrc = crc32(data);
      if (gotCrc !== crc) {
        throw new Error("CRC 校验失败：" + name);
      }
      out.set(name.replace(/^.*\//, "").toLowerCase(), data);
      offset += 46 + nLen + eLen + cLen;
    }
    return out;
  }

  // Standard CRC-32 (IEEE 802.3), table built once.
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  root.Unzip = { unzip };
})(typeof self !== "undefined" ? self : this);
