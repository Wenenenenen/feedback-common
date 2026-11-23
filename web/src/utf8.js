// 手写 UTF-8 编解码（不依赖 TextEncoder/TextDecoder）、字节序比较与码点计数。

export function encodeUtf8(str) {
  const out = [];
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new Error(`UTF-8 编码失败：位置 ${i} 出现孤立代理项 U+${cp.toString(16).toUpperCase()}`);
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return Uint8Array.from(out);
}

// 严格解码：拒绝截断、超长编码、代理项与超范围码点
export function decodeUtf8(bytes) {
  let s = '';
  let i = 0;
  const need = (b) => {
    if (++i >= bytes.length) {
      throw new Error('UTF-8 解码失败：序列被截断');
    }
    const c = bytes[i];
    if ((c & 0xc0) !== 0x80) {
      throw new Error(`UTF-8 解码失败：位置 ${i} 不是合法续字节`);
    }
    return c & 0x3f;
  };
  while (i < bytes.length) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) {
      cp = b;
    } else if ((b & 0xe0) === 0xc0) {
      cp = ((b & 0x1f) << 6) | need(b);
      if (cp < 0x80) throw new Error(`UTF-8 解码失败：位置 ${i} 超长编码`);
    } else if ((b & 0xf0) === 0xe0) {
      const b1 = need(b);
      cp = ((b & 0x0f) << 12) | (b1 << 6) | need(b);
      if (cp < 0x800) throw new Error(`UTF-8 解码失败：位置 ${i} 超长编码`);
      if (cp >= 0xd800 && cp <= 0xdfff) throw new Error(`UTF-8 解码失败：位置 ${i} 编码了代理项`);
    } else if ((b & 0xf8) === 0xf0) {
      const b1 = need(b);
      cp = ((b & 0x07) << 18) | (b1 << 12) | (need(b) << 6) | need(b);
      if (cp < 0x10000 || cp > 0x10ffff) {
        throw new Error(`UTF-8 解码失败：位置 ${i} 码点越界或超长`);
      }
    } else {
      throw new Error(`UTF-8 解码失败：位置 ${i} 非法首字节 0x${b.toString(16)}`);
    }
    s += String.fromCodePoint(cp);
    i++;
  }
  return s;
}

// 无符号字节字典序比较
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// Unicode 码点计数（正确处理代理对）
export function countCodePoints(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++, n++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) i++;
    }
  }
  return n;
}
