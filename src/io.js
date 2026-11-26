/* WAV 构建与 zip 读取（无第三方依赖，浏览器/Node 通用） */
(function (global) {
  'use strict';

  /* 48kHz PCM16 单声道 WAV，输入为 Int16Array */
  function buildWav(pcm, sampleRate) {
    const dataBytes = pcm.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // 单声道
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true); // 字节率
    dv.setUint16(32, 2, true); // 块对齐
    dv.setUint16(34, 16, true); // 位深
    writeStr(36, 'data');
    dv.setUint32(40, dataBytes, true);
    const dst = new Int16Array(buf, 44, pcm.length);
    dst.set(pcm);
    return u8;
  }

  /*
   * 极简 zip 读取：扫描本地文件头，支持 STORE(0) 与 deflate(8)。
   * 仅处理数据描述符未启用或可跳过的常规包；返回 [{name, bytes}]。
   */
  async function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const files = [];
    let p = 0;

    const u16 = (o) => dv.getUint16(o, true);
    const u32 = (o) => dv.getUint32(o, true);

    while (p + 30 <= u8.length && u32(p) === 0x04034b50) {
      const flags = u16(p + 6);
      const method = u16(p + 8);
      const compSize = u32(p + 18);
      const nameLen = u16(p + 26);
      const extraLen = u16(p + 28);
      const nameStart = p + 30;
      const nameBytes = u8.subarray(nameStart, nameStart + nameLen);
      const name = new TextDecoder('utf-8').decode(nameBytes);
      const dataStart = nameStart + nameLen + extraLen;
      let size = compSize;
      if (size === 0 && (flags & 0x08)) {
        // 数据描述符：按方法扫描下一个签名（deflate 块不与签名冲突，按 4 字节对齐找）
        let q = dataStart;
        while (q + 4 <= u8.length && u32(q) !== 0x08074b50 && u32(q) !== 0x02014b50) q++;
        size = q - dataStart;
      }
      const raw = u8.subarray(dataStart, dataStart + size);
      let bytes;
      if (method === 0) {
        bytes = new Uint8Array(raw);
      } else if (method === 8) {
        bytes = await inflate(raw);
      } else {
        throw new Error(`zip 内 ${name} 使用了不支持的压缩方式 ${method}`);
      }
      if (!name.endsWith('/')) files.push({ name, bytes });

      p = dataStart + size;
      if (flags & 0x08) {
        // 跳过数据描述符（可选签名 + 12/16 字节）
        if (u32(p) === 0x08074b50) p += 16;
        else p += 12;
      }
    }
    if (!files.length) throw new Error('zip 中未找到任何文件');
    return files;
  }

  async function inflate(raw) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('当前环境不支持 DecompressionStream，无法解压 deflate 条目');
  }

  const api = { buildWav, readZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TrackerIO = api;
})(typeof self !== 'undefined' ? self : globalThis);
