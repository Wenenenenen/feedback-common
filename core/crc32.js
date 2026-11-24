// IEEE CRC-32（与 zlib crc32 相同的多项式 0xEDB88320）
// 提供逐字节版本与 slice-by-4 版本；结果完全一致，后者用于大文件建索引。
const T0 = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  T0[n] = c >>> 0;
}

// 标准 zlib slice-by-4 派生表：T_k(n) = 表 T_{k-1} 项的逐字节表查表结果
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  T1[n] = (T0[T0[n] & 0xff] ^ (T0[n] >>> 8)) >>> 0;
  T2[n] = (T0[T1[n] & 0xff] ^ (T1[n] >>> 8)) >>> 0;
  T3[n] = (T0[T2[n] & 0xff] ^ (T2[n] >>> 8)) >>> 0;
}

export function crc32Bytes(view, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = T0[(c ^ view.getUint8(i)) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// slice-by-4：先逐字节走到 4 字节对齐，再按小端 u32 批量处理
export function crc32Range(view, start, end) {
  let c = 0xffffffff;
  let i = start;
  while (i < end && (i & 3) !== 0) {
    c = T0[(c ^ view.getUint8(i)) & 0xff] ^ (c >>> 8);
    i++;
  }
  const alignedEnd = end - ((end - i) & 3);
  for (; i < alignedEnd; i += 4) {
    const word = (view.getUint32(i, true) ^ c) >>> 0;
    c = (
      T3[word & 0xff] ^
      T2[(word >>> 8) & 0xff] ^
      T1[(word >>> 16) & 0xff] ^
      T0[word >>> 24]
    ) >>> 0;
  }
  for (; i < end; i++) {
    c = T0[(c ^ view.getUint8(i)) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
