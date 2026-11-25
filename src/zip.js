/*!
 * 极简 ZIP：读取（STORE / DEFLATE，DEFLATE 走 DecompressionStream('deflate-raw')）
 * 与写入（STORE，带 CRC32）。无第三方依赖。
 * UMD: window.GKZip / module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GKZip = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRC_TABLE = (function () {
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

  function dv(buf) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持 DecompressionStream，无法解压 DEFLATE zip');
    }
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  }

  /** 解压 zip 字节 -> [{name, bytes}]，忽略目录项与 macOS 垃圾文件由调用方决定。 */
  async function unzip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = dv(bytes);

    // EOCD
    let eocd = -1;
    const minScan = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minScan; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
    const total = view.getUint16(eocd + 10, true);
    let cdOff = view.getUint32(eocd + 16, true);

    const dec = new TextDecoder('utf-8');
    const entries = [];
    let p = cdOff;
    for (let n = 0; n < total; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip 中央目录损坏');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const nameRaw = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = dec.decode(nameRaw);

      // 本地头定位数据
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      let data = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 8) data = await inflateRaw(data);
      else if (method !== 0) throw new Error('不支持的 zip 压缩方法 ' + method + '（' + name + '）');

      // bit 3: 数据描述符可能让中央目录 size 为 0，但 Python zipfile 通常已写好；这里不额外处理流式 zip
      entries.push({ name, bytes: new Uint8Array(data), size: uncompSize || data.length, flags });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function setU16(arr, off, v) { new DataView(arr.buffer).setUint16(off, v, true); }
  function setU32(arr, off, v) { new DataView(arr.buffer).setUint32(off, v >>> 0, true); }

  /** 以 STORE 方式打包 [{name, bytes}] 为 zip。 */
  function zipSync(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length + data.length);
      setU32(local, 0, 0x04034b50);
      setU16(local, 4, 20);
      setU16(local, 6, 0x0800); // UTF-8 名称标志
      setU16(local, 8, 0);      // STORE
      setU16(local, 10, 0); setU16(local, 12, 0); // time/date
      setU32(local, 14, crc);
      setU32(local, 18, data.length);
      setU32(local, 22, data.length);
      setU16(local, 26, nameBytes.length);
      setU16(local, 28, 0);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      locals.push(local);

      const cd = new Uint8Array(46 + nameBytes.length);
      setU32(cd, 0, 0x02014b50);
      setU16(cd, 4, 20);
      setU16(cd, 6, 20);
      setU16(cd, 8, 0x0800);
      setU16(cd, 10, 0);
      setU16(cd, 12, 0); setU16(cd, 14, 0);
      setU32(cd, 16, crc);
      setU32(cd, 20, data.length);
      setU32(cd, 24, data.length);
      setU16(cd, 28, nameBytes.length);
      setU16(cd, 30, 0); setU16(cd, 32, 0);
      setU16(cd, 34, 0); setU16(cd, 36, 0);
      setU32(cd, 38, 0);
      setU32(cd, 42, offset);
      cd.set(nameBytes, 46);
      centrals.push(cd);

      offset += local.length;
    }

    let cdSize = 0;
    for (const c of centrals) cdSize += c.length;
    const eocd = new Uint8Array(22);
    setU32(eocd, 0, 0x06054b50);
    setU16(eocd, 8, files.length);
    setU16(eocd, 10, files.length);
    setU32(eocd, 12, cdSize);
    setU32(eocd, 16, offset);

    let total = 22 + cdSize;
    for (const l of locals) total += l.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const l of locals) { out.set(l, p); p += l.length; }
    let cdOff = p;
    for (const c of centrals) { out.set(c, p); p += c.length; }
    setU32(eocd, 16, cdOff); // 修正：中央目录起始 = 所有 local 之后
    out.set(eocd, p);
    return out;
  }

  return { unzip, zipSync, crc32 };
});
