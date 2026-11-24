/*
 * PNM（P6 8 位二进制）解析与编码。
 * 头允许注释与任意空白；maxval 必须为 255；数据字节数必须恰好为 W*H*3。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPPnm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseHeader(bytes) {
    if (!bytes || bytes.length < 3) throw new Error('PNM 文件过短');
    const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    let i = 0;
    // 魔数
    if (bytes[0] !== 0x50 || bytes[1] !== 0x36) throw new Error('只支持二进制 P6 格式');
    i = 2;
    if (i >= bytes.length || !isSpace(bytes[i])) throw new Error('P6 魔数后缺少空白');
    const readInt = () => {
      // 跳过空白与注释
      for (;;) {
        while (i < bytes.length && isSpace(bytes[i])) i++;
        if (i < bytes.length && bytes[i] === 0x23) {
          while (i < bytes.length && bytes[i] !== 0x0a) i++;
          continue;
        }
        break;
      }
      let v = 0;
      let any = false;
      while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
        v = v * 10 + (bytes[i] - 0x30);
        any = true;
        i++;
        if (v > 1e9) throw new Error('PNM 头数值过大');
      }
      if (!any) throw new Error('PNM 头缺少数值');
      return v;
    };
    const width = readInt();
    const height = readInt();
    const maxval = readInt();
    if (width < 1 || height < 1) throw new Error('PNM 宽高必须为正');
    if (maxval !== 255) throw new Error(`PNM maxval 必须为 255（实际 ${maxval}）`);
    // 头部结束：maxval 后恰好一个空白字符
    if (i >= bytes.length || !isSpace(bytes[i])) throw new Error('PNM maxval 后缺少空白');
    i++;
    return { width, height, maxval, offset: i };
  }

  /** 解码 P6 → {width, height, data:Uint8Array(RGB 交错)}；data 为新副本。 */
  function decodePnm(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const h = parseHeader(bytes);
    const need = h.width * h.height * 3;
    const have = bytes.length - h.offset;
    if (have !== need) {
      throw new Error(`P6 数据字节数不符：期望 ${need}，实际 ${have}`);
    }
    const data = bytes.subarray(h.offset, h.offset + need).slice();
    return { width: h.width, height: h.height, data };
  }

  /** 编码 P6。data: Uint8Array(W*H*3)。 */
  function encodePnm(width, height, data) {
    const need = width * height * 3;
    if (data.length !== need) throw new Error('P6 编码：数据长度与宽高不符');
    const head = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const out = new Uint8Array(head.length + need);
    out.set(head, 0);
    out.set(data, head.length);
    return out;
  }

  /** 只读头部（用于导入时快速取尺寸，不复制像素）。 */
  function readPnmInfo(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const h = parseHeader(bytes);
    const need = h.width * h.height * 3;
    if (bytes.length - h.offset !== need) {
      throw new Error(`P6 数据字节数不符：期望 ${need}，实际 ${bytes.length - h.offset}`);
    }
    return { width: h.width, height: h.height, offset: h.offset };
  }

  return { decodePnm, encodePnm, readPnmInfo };
});
