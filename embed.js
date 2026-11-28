/*
 * 灰度扫描样张批次号可逆嵌入 —— 核心算法
 * 浏览器（window.ReversibleStamp）与 Node（module.exports）通用。
 *
 * 嵌入：整数差值扩展。每对像素 (x, y) 以 l = floor((x+y)/2)、h = x - y 表示，
 * 把 h 换成 2h + b 后还原：x' = l + floor((2h+b+1)/2)，y' = l - floor((2h+b)/2)。
 * 某对像素“可用”当且仅当：两种载荷位（b=0 与 b=1）嵌入后两像素都不越出 [0,255]，
 * 且两像素都被掩膜获准（无掩膜时全部获准）。
 *
 * 配对：按 8×8 块划分（边缘块截断到图内）。每块分别试横向、纵向的不交叠相邻配对，
 * 从块左上起配，选可用容量大的方向，同数取横向。块内各对按首像素行序排列，
 * 块之间按块行序排列。载荷为十六进制串，每字符 4 位、字节高位在先依次写入。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.ReversibleStamp = lib;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_SIDE = 2048;
  const BLOCK = 8;

  /* ---------------- CRC32（标准 IEEE） ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** 返回 8 位小写十六进制字符串 */
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  /* ---------------- PGM（P5，8 位） ---------------- */
  function isSpace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
  }

  /**
   * 解析 P5 PGM。buf: Uint8Array。
   * 返回 { width, height, pixels: Uint8Array }。不合规抛出 Error。
   */
  function parsePGM(buf) {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let pos = 0;

    function readToken() {
      for (;;) {
        while (pos < data.length && isSpace(data[pos])) pos++;
        if (pos < data.length && data[pos] === 0x23) {
          // '#' 注释到行尾
          while (pos < data.length && data[pos] !== 0x0a && data[pos] !== 0x0d) pos++;
        } else {
          break;
        }
      }
      if (pos >= data.length) throw new Error('PGM 头不完整');
      const start = pos;
      while (pos < data.length && !isSpace(data[pos]) && data[pos] !== 0x23) pos++;
      let s = '';
      for (let i = start; i < pos; i++) s += String.fromCharCode(data[i]);
      return s;
    }

    const magic = readToken();
    if (magic !== 'P5') throw new Error('仅支持 P5（二进制灰度）PGM，实际为 ' + magic);
    const width = parseInt(readToken(), 10);
    const height = parseInt(readToken(), 10);
    const maxval = parseInt(readToken(), 10);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('PGM 尺寸非法');
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      throw new Error('单边尺寸超过 ' + MAX_SIDE + '：' + width + '×' + height);
    }
    if (maxval !== 255) throw new Error('仅支持 8 位（maxval=255），实际 maxval=' + maxval);
    // maxval 后恰有一个空白字符，随后是栅格
    if (pos >= data.length || !isSpace(data[pos])) throw new Error('PGM 头与栅格之间缺少分隔');
    pos++;
    const need = width * height;
    if (data.length - pos < need) {
      throw new Error('栅格数据不足：需要 ' + need + ' 字节，实际 ' + (data.length - pos));
    }
    return { width, height, pixels: data.slice(pos, pos + need) };
  }

  /** 生成 P5 PGM 字节 */
  function writePGM(width, height, pixels) {
    if (pixels.length !== width * height) throw new Error('栅格长度与尺寸不符');
    const header = 'P5\n' + width + ' ' + height + '\n255\n';
    const out = new Uint8Array(header.length + pixels.length);
    for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
    out.set(pixels, header.length);
    return out;
  }

  /* ---------------- 差值扩展 ---------------- */

  /** 该对像素嵌入 b=0 与 b=1 后两像素是否都在 [0,255] */
  function usablePair(x, y) {
    const l = (x + y) >> 1;
    const h = x - y;
    for (let b = 0; b <= 1; b++) {
      const h2 = 2 * h + b;
      const xp = l + ((h2 + 1) >> 1); // >> 对负数即向下取整
      const yp = l - (h2 >> 1);
      if (xp < 0 || xp > 255 || yp < 0 || yp > 255) return false;
    }
    return true;
  }

  /**
   * 计算整图的配对规划。
   * mask: null 或与栅格等长的 Uint8Array，非 0 表示获准嵌入。
   * 返回 { width, height, pairs: [{x1,y1,x2,y2}], blocks: [...], capacityBits }。
   */
  function computePlan(width, height, pixels, mask) {
    const pairs = [];
    const blocks = [];

    function tryPair(list, x1, y1, x2, y2) {
      const i1 = y1 * width + x1;
      const i2 = y2 * width + x2;
      if (mask && (mask[i1] === 0 || mask[i2] === 0)) return;
      if (!usablePair(pixels[i1], pixels[i2])) return;
      list.push({ x1, y1, x2, y2 });
    }

    function collect(bx, by, xEnd, yEnd, dir) {
      const list = [];
      if (dir === 'h') {
        for (let y = by; y < yEnd; y++) {
          for (let x = bx; x + 1 < xEnd; x += 2) tryPair(list, x, y, x + 1, y);
        }
      } else {
        for (let x = bx; x < xEnd; x++) {
          for (let y = by; y + 1 < yEnd; y += 2) tryPair(list, x, y, x, y + 1);
        }
      }
      // 块内按首像素行序
      list.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
      return list;
    }

    for (let by = 0; by < height; by += BLOCK) {
      for (let bx = 0; bx < width; bx += BLOCK) {
        const xEnd = Math.min(bx + BLOCK, width);
        const yEnd = Math.min(by + BLOCK, height);
        const hPairs = collect(bx, by, xEnd, yEnd, 'h');
        const vPairs = collect(bx, by, xEnd, yEnd, 'v');
        const dir = hPairs.length >= vPairs.length ? 'h' : 'v'; // 同数取横向
        const chosen = dir === 'h' ? hPairs : vPairs;
        blocks.push({
          bx, by, dir,
          count: chosen.length,
          hCount: hPairs.length,
          vCount: vPairs.length,
        });
        for (const p of chosen) pairs.push(p);
      }
    }
    return { width, height, pairs, blocks, capacityBits: pairs.length };
  }

  /**
   * 把 bits（0/1 数组）依次嵌入 pairs 前 bits.length 对，返回新栅格（不改动原数组）。
   */
  function embedBits(pixels, pairs, bits, width) {
    if (bits.length > pairs.length) {
      throw new Error('容量不足：需要 ' + bits.length + ' 位，可用 ' + pairs.length + ' 位');
    }
    const out = new Uint8Array(pixels);
    for (let i = 0; i < bits.length; i++) {
      const p = pairs[i];
      const i1 = p.y1 * width + p.x1;
      const i2 = p.y2 * width + p.x2;
      const x = out[i1];
      const y = out[i2];
      const l = (x + y) >> 1;
      const h2 = 2 * (x - y) + bits[i];
      out[i1] = l + ((h2 + 1) >> 1);
      out[i2] = l - (h2 >> 1);
    }
    return out;
  }

  /**
   * 从标记栅格的前 bitCount 对中提取载荷位并还原原图。
   * 返回 { bits, restored }。
   */
  function extractBits(marked, pairs, bitCount, width) {
    if (bitCount > pairs.length) throw new Error('提取位数超出坐标对数量');
    const out = new Uint8Array(marked);
    const bits = new Array(bitCount);
    for (let i = 0; i < bitCount; i++) {
      const p = pairs[i];
      const i1 = p.y1 * width + p.x1;
      const i2 = p.y2 * width + p.x2;
      const xp = out[i1];
      const yp = out[i2];
      const l = (xp + yp) >> 1;
      const h2 = xp - yp;
      const b = ((h2 % 2) + 2) % 2;
      const h = (h2 - b) / 2;
      bits[i] = b;
      out[i1] = l + ((h + 1) >> 1);
      out[i2] = l - (h >> 1);
    }
    return { bits, restored: out };
  }

  /* ---------------- 十六进制载荷与位流 ---------------- */

  /** 十六进制串 → 位数组（每字符 4 位，高位在先）。非法输入抛错。 */
  function hexToBits(hex) {
    if (typeof hex !== 'string' || hex.length === 0) throw new Error('载荷为空');
    if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('载荷必须是十六进制字符（0-9 a-f）');
    const bits = new Array(hex.length * 4);
    for (let i = 0; i < hex.length; i++) {
      const v = parseInt(hex[i], 16);
      bits[i * 4] = (v >> 3) & 1;
      bits[i * 4 + 1] = (v >> 2) & 1;
      bits[i * 4 + 2] = (v >> 1) & 1;
      bits[i * 4 + 3] = v & 1;
    }
    return bits;
  }

  /** 位数组 → 小写十六进制串（长度须为 4 的倍数） */
  function bitsToHex(bits) {
    if (bits.length % 4 !== 0) throw new Error('位数不是 4 的倍数');
    let s = '';
    for (let i = 0; i < bits.length; i += 4) {
      s += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return s;
  }

  return {
    MAX_SIDE,
    BLOCK,
    crc32,
    parsePGM,
    writePGM,
    usablePair,
    computePlan,
    embedBits,
    extractBits,
    hexToBits,
    bitsToHex,
  };
});
