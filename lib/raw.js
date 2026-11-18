// BYR1 RAW 文件解析（小端 16 字节文件头 + 行优先 uint16 样本）。
// 头格式见 samples 内《格式说明.md》。解析失败时抛出带中文原因的 Error，
// invalid-magic / invalid-pattern / invalid-truncated 三个异常样例均在此拒绝。

export const CHANNELS = { R: 0, G: 1, B: 2 };

// patternId 表示 (0,0)(1,0)(0,1)(1,1) 四个位置的颜色
export const PATTERNS = [
  { id: 0, name: 'RGGB', cfa: [[0, 1], [1, 2]] },
  { id: 1, name: 'BGGR', cfa: [[2, 1], [1, 0]] },
  { id: 2, name: 'GRBG', cfa: [[1, 0], [2, 1]] },
  { id: 3, name: 'GBRG', cfa: [[1, 2], [0, 1]] },
];

const VALID_BITS = new Set([10, 12, 14, 16]);
const HEADER_BYTES = 16;

export function parseRaw(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < HEADER_BYTES) {
    throw new Error('文件过短，缺少 16 字节 BYR1 文件头');
  }
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'BYR1') {
    throw new Error(`非法文件头标识 "${magic}"，应为 "BYR1"`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint16(4, true);
  const height = dv.getUint16(6, true);
  const bits = dv.getUint8(8);
  const patternId = dv.getUint8(9);
  const black = dv.getUint16(10, true);
  const white = dv.getUint16(12, true);

  if (width === 0 || height === 0) {
    throw new Error('图像宽高必须大于 0');
  }
  if (!VALID_BITS.has(bits)) {
    throw new Error(`不支持的位深 ${bits}（仅支持 10/12/14/16）`);
  }
  if (patternId > 3) {
    throw new Error(`非法排列编号 ${patternId}（仅支持 0..3：RGGB/BGGR/GRBG/GBRG）`);
  }
  if (white <= black) {
    throw new Error(`电平非法：黑电平 ${black} 必须小于白电平 ${white}`);
  }

  const expected = HEADER_BYTES + width * height * 2;
  if (buf.length < expected) {
    throw new Error(`文件被截断：应有 ${expected} 字节，实际 ${buf.length} 字节`);
  }
  if (buf.length > expected) {
    // 多余字节不参与解析，但明确提示，避免静默吞掉异常数据
    throw new Error(`文件长度异常：应为 ${expected} 字节，实际多了 ${buf.length - expected} 字节`);
  }

  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = dv.getUint16(HEADER_BYTES + i * 2, true);
  }

  const pattern = PATTERNS[patternId];
  return {
    width,
    height,
    bits,
    pattern: patternId,
    patternName: pattern.name,
    cfa: pattern.cfa,
    black,
    white,
    data,
  };
}

// 白平衡前的归一化 + 增益 + 限幅，输出按平面存储的三个 Float64 通道（0..1）。
// 非该像素采样颜色的位置填 0，配合 sampleMask 可在页面上还原原始采样位置。
export function normalizePlanes(raw, wb) {
  const { width: w, height: h, data, cfa, black, white } = raw;
  const gains = [wb.r, wb.g, wb.b];
  const range = white - black;
  // 全程 float64 存储，与参考实现（numpy 默认 float64）的舍入保持一致
  const planes = [
    new Float64Array(w * h),
    new Float64Array(w * h),
    new Float64Array(w * h),
  ];
  const mask = new Uint8Array(w * h); // 记录每个像素采样的颜色 0/1/2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cfa[y & 1][x & 1];
      const idx = y * w + x;
      let v = (data[idx] - black) / range;
      v = Math.min(1, Math.max(0, v * gains[c]));
      planes[c][idx] = v;
      mask[idx] = c;
    }
  }
  return { planes, mask };
}
