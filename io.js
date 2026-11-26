'use strict';

/* Binary P5 PGM parsing/encoding and a small dependency-free ZIP reader. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ToneCurveIO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error('输入必须是 ArrayBuffer 或 Uint8Array。');
  }

  function isWhitespace(b) {
    return b === 32 || b === 9 || b === 10 || b === 13;
  }

  function readP5(data) {
    const bytes = toUint8Array(data);
    let p = 0;

    function skipWhitespaceAndComments() {
      while (p < bytes.length) {
        while (p < bytes.length && isWhitespace(bytes[p])) p += 1;
        if (p < bytes.length && bytes[p] === 35 /* # */) {
          while (p < bytes.length && bytes[p] !== 10 && bytes[p] !== 13) p += 1;
        } else {
          break;
        }
      }
    }

    function readToken(label) {
      skipWhitespaceAndComments();
      const start = p;
      while (p < bytes.length && !isWhitespace(bytes[p])) p += 1;
      if (start === p) throw new Error(`PGM 头部缺少${label}`);
      return new TextDecoder('ascii').decode(bytes.subarray(start, p));
    }

    const magic = readToken('P5 魔数');
    if (magic !== 'P5') throw new Error(`仅支持二进制 P5 PGM，收到 ${magic}`);

    const width = Number(readToken('宽度'));
    const height = Number(readToken('高度'));
    const maxval = Number(readToken('maxval'));

    if (!Number.isInteger(width) || width <= 0) throw new Error('PGM 宽度无效。');
    if (!Number.isInteger(height) || height <= 0) throw new Error('PGM 高度无效。');
    if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 65535) {
      throw new Error('PGM maxval 无效，应为 1..65535。');
    }

    // The PNM header has exactly one separator whitespace after maxval.
    if (p >= bytes.length || !isWhitespace(bytes[p])) {
      throw new Error('PGM maxval 后缺少分隔符。');
    }
    p += 1;

    const bitsPerSample = maxval < 256 ? 8 : 16;
    const sampleCount = width * height;
    const expectedBytes = sampleCount * (bitsPerSample === 16 ? 2 : 1);
    if (bytes.length < p + expectedBytes) {
      throw new Error(`PGM 栅格数据不完整：需要 ${expectedBytes} 字节，剩余 ${bytes.length - p}。`);
    }

    let samples;
    if (bitsPerSample === 8) {
      samples = bytes.slice(p, p + sampleCount);
    } else {
      samples = new Uint16Array(sampleCount);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = view.getUint16(p + i * 2, false); // P5 16-bit is big-endian.
      }
    }

    return {
      format: 'P5',
      width,
      height,
      maxval,
      bitsPerSample,
      data: samples,
      byteLength: expectedBytes,
    };
  }

  function encodeP5_16(width, height, samples, maxval = 1023) {
    const count = width * height;
    if (samples.length !== count) throw new Error('导出样值数量与图像尺寸不一致。');

    const header = `P5\n${width} ${height}\n${maxval}\n`;
    const headerBytes = new TextEncoder().encode(header);
    const out = new Uint8Array(headerBytes.length + count * 2);
    out.set(headerBytes, 0);

    const view = new DataView(out.buffer);
    let offset = headerBytes.length;
    for (let i = 0; i < count; i += 1) {
      const v = samples[i];
      if (!Number.isInteger(v) || v < 0 || v > maxval) {
        throw new Error(`导出值 ${v} 超出 0..${maxval}。`);
      }
      view.setUint16(offset, v, false); // big-endian
      offset += 2;
    }
    return out;
  }

  function u16(view, offset) {
    return view.getUint16(offset, true);
  }

  function u32(view, offset) {
    return view.getUint32(offset, true);
  }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 ZIP；请分别选择 PGM/JSON 文件。');
    }
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(data) {
    const bytes = toUint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const scanStart = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
      if (u32(view, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 中央目录结束记录。');

    let entries = u16(view, eocd + 10);
    const centralSize = u32(view, eocd + 12);
    let centralOffset = u32(view, eocd + 16);

    // Prefer ZIP64 fields when present (not expected for these small cases).
    if (centralOffset === 0xffffffff || centralSize === 0xffffffff || entries === 0xffff) {
      throw new Error('暂不支持 ZIP64 样例包，请解压后分别导入文件。');
    }

    const decoder = new TextDecoder('utf-8');
    const files = {};
    let p = centralOffset;

    for (let n = 0; n < entries; n += 1) {
      if (u32(view, p) !== 0x02014b50) throw new Error('ZIP 中央目录头损坏。');

      const flags = u16(view, p + 8);
      const method = u16(view, p + 10);
      const compressedSize = u32(view, p + 20);
      const uncompressedSize = u32(view, p + 24);
      const nameLength = u16(view, p + 28);
      const extraLength = u16(view, p + 30);
      const commentLength = u16(view, p + 32);
      const localOffset = u32(view, p + 42);

      const rawName = bytes.subarray(p + 46, p + 46 + nameLength);
      const name = (flags & 0x800) ? decoder.decode(rawName) : new TextDecoder('ascii').decode(rawName);

      if (u32(view, localOffset) !== 0x04034b50) {
        throw new Error(`ZIP 本地文件头损坏：${name}`);
      }
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

      let content;
      if (method === 0) {
        content = compressed.slice();
      } else if (method === 8) {
        content = await inflateRaw(compressed);
      } else {
        throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方法 ${method}。`);
      }

      if (uncompressedSize > 0 && content.length !== uncompressedSize) {
        throw new Error(`ZIP 条目 ${name} 解压长度不符。`);
      }

      files[name] = { name, data: content };
      p += 46 + nameLength + extraLength + commentLength;
    }

    return files;
  }

  function baseName(path) {
    const normalized = String(path).replace(/\\/g, '/');
    return normalized.split('/').pop();
  }

  function classifyFileName(name) {
    const lower = baseName(name).toLowerCase();
    if (lower === 'source.pgm' || lower.includes('source') || lower.includes('源')) return 'source';
    if (lower === 'target.pgm' || lower.includes('target') || lower.includes('目标')) return 'target';
    if (lower === 'weights.pgm' || lower === 'weight.pgm' || lower.includes('weight') || lower.includes('权重')) {
      return 'weights';
    }
    if (lower === 'locks.json' || lower === 'lock.json' || lower.includes('lock') || lower.includes('锁')) {
      return 'locks';
    }
    return null;
  }

  async function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error(`读取 ${file.name} 失败`));
      reader.readAsArrayBuffer(file);
    });
  }

  async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error(`读取 ${file.name} 失败`));
      reader.readAsText(file);
    });
  }

  function parseLocksJson(text) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.locks)) return parsed.locks;
    if (parsed && Array.isArray(parsed.points)) return parsed.points;
    throw new Error('锁点 JSON 应为数组，或包含 locks 数组。');
  }

  return {
    toUint8Array,
    readP5,
    encodeP5_16,
    unzip,
    baseName,
    classifyFileName,
    readFileAsArrayBuffer,
    readFileAsText,
    parseLocksJson,
  };
});
