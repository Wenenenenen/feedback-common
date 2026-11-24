// Web Worker：负责 CXR 解析、帧重建与渲染，主线程只负责 UI。
// 输入 ArrayBuffer 以 Transferable 移交；渲染结果同样以 Transferable 回传。
import { parseCxr, CxrDecoder } from '../core/decoder.js';

let parsed = null;
let decoder = null;
let lastFrame = null; // { index, pixels }

function send(msg) {
  self.postMessage(msg);
}

// 给主线程一份精简但够用的帧索引（移动/脏块矩形随帧携带，避免二次查询）
function summarize() {
  return {
    width: parsed.width,
    height: parsed.height,
    frameBytes: parsed.frameBytes,
    truncated: parsed.truncated,
    frames: parsed.frames.map((f) => ({
      index: f.index,
      offset: f.offset,
      length: f.length,
      seq: f.seq,
      base: f.base,
      key: f.key,
      valid: f.valid,
      reason: f.reason,
      anchorIndex: f.anchorIndex,
      moves: f.moves,
      dirty: f.dirty.map(([x, y, w, h]) => [x, y, w, h]), // 不带文件内像素偏移
    })),
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'open') {
      try {
        parsed = parseCxr(msg.buffer); // 取得 ArrayBuffer 所有权
      } catch (err) {
        parsed = null;
        decoder = null;
        self.postMessage({
          type: 'open-failed',
          message: err.message || String(err),
          offset: typeof err.offset === 'number' ? err.offset : null,
        });
        return;
      }
      decoder = new CxrDecoder(parsed);
      lastFrame = null;
      self.postMessage({ type: 'opened', summary: summarize() });
      return;
    }

    if (!parsed) throw new Error('尚未打开文件');

    if (msg.type === 'decode') {
      const entry = parsed.frames[msg.index];
      if (!entry || !entry.valid) {
        send({
          type: 'error',
          requestId: msg.requestId,
          message: entry
            ? `帧 ${msg.index} 不可重建：${entry.reason ?? '无效帧'}`
            : `帧 ${msg.index} 不存在`,
        });
        return;
      }
      const pixels = decoder.decode(msg.index);
      lastFrame = { index: msg.index, pixels };
      // 转移像素缓冲所有权给主线程；内部快照不受影响（decode 返回的是工作副本）
      self.postMessage(
        {
          type: 'frame',
          requestId: msg.requestId,
          index: msg.index,
          width: parsed.width,
          height: parsed.height,
          pixels,
          meta: {
            seq: entry.seq,
            base: entry.base,
            key: entry.key,
            offset: entry.offset,
            length: entry.length,
            moves: entry.moves,
            dirty: entry.dirty.map(([x, y, w, h]) => [x, y, w, h]),
          },
        },
        [pixels.buffer],
      );
      return;
    }

    if (msg.type === 'export-png') {
      // 导出要求与当前帧像素逐字节一致：重新解码一份独立缓冲，
      // 绝不混入画面叠加框
      const pixels = decoder.decode(msg.index);
      const png = await encodePng(pixels, parsed.width, parsed.height);
      self.postMessage(
        { type: 'png', requestId: msg.requestId, index: msg.index, bytes: png },
        [png.buffer],
      );
      return;
    }
  } catch (err) {
    send({ type: 'error', requestId: msg.requestId, message: err.message || String(err) });
  }
};

// ---------------------------------------------------------------------------
// 极简 PNG 编码器（RGBA8 -> 真彩色+alpha，zlib 包装 DEFLATE）
// 浏览器有 CompressionStream('deflate')，输出 zlib 流只需补 2 字节头、4 字节尾。
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngCrc(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len, false);
  out.set(type, 4);
  out.set(data, 8);
  dv.setUint32(8 + len, pngCrc(out.subarray(4, 8 + len)), false);
  return out;
}

async function encodePng(rgba, width, height) {
  // 1) 每行前加 filter=0 字节
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  // 2) CompressionStream('deflate') 输出带 78 9c 头与 adler32 尾的完整
  //    zlib 流，正是 PNG IDAT 要求的封装
  const cs = new CompressionStream('deflate');
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  const zlib = new Uint8Array(await new Response(stream).arrayBuffer());

  // 3) PNG 组装
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(new TextEncoder().encode('IHDR'), ihdr),
    chunk(new TextEncoder().encode('IDAT'), zlib),
    chunk(new TextEncoder().encode('IEND'), new Uint8Array(0)),
  ];
  return concat(parts);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
