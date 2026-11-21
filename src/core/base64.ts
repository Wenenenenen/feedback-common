/** 浏览器 / Node 通用的 base64 编解码（不依赖 Buffer 或 btoa）。 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64(input: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < input.length; i += 3) {
    const b0 = input[i];
    const b1 = input[i + 1];
    const b2 = input[i + 2];
    out += ALPHABET[b0 >> 2] + ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] + ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] + ALPHABET[b2 & 63];
  }
  const rest = input.length - i;
  if (rest === 1) {
    const b0 = input[i];
    out += ALPHABET[b0 >> 2] + ALPHABET[(b0 & 3) << 4] + '==';
  } else if (rest === 2) {
    const b0 = input[i];
    const b1 = input[i + 1];
    out += ALPHABET[b0 >> 2] + ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] + ALPHABET[(b1 & 15) << 2] + '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\r\n\t ]/g, '');
  if (clean.length % 4 !== 0) throw new Error('base64 长度不是 4 的倍数');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let pos = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)];
    const c1 = LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = LOOKUP[clean.charCodeAt(i + 3)];
    if (c0 < 0 || c1 < 0) throw new Error('base64 含非法字符');
    const b0 = (c0 << 2) | (c1 >> 4);
    out[pos] = b0;
    pos += 1;
    if (c2 >= 0) {
      const b1 = ((c1 & 15) << 4) | (c2 >> 2);
      out[pos] = b1;
      pos += 1;
      if (c3 >= 0) {
        const b2 = ((c2 & 3) << 6) | c3;
        out[pos] = b2;
        pos += 1;
      }
    }
  }
  return out;
}

export function float64ToBase64(values: Float64Array): string {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setFloat64(i * 8, values[i], true);
  return encodeBase64(bytes);
}

export function base64ToFloat64(text: string, expectedLength?: number): Float64Array {
  const bytes = decodeBase64(text);
  if (bytes.length % 8 !== 0) throw new Error('float64 数据长度不是 8 的倍数');
  if (expectedLength !== undefined && bytes.length !== expectedLength * 8) {
    throw new Error(`float64 数据长度 ${bytes.length / 8} 与期望 ${expectedLength} 不符`);
  }
  const values = new Float64Array(bytes.length / 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat64(i * 8, true);
  return values;
}
