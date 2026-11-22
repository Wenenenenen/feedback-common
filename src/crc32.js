// CRC-32/MPEG-2 (ISO 13818-1 § Annex A, polynomial 0x04C11DB7, init 0xFFFFFFFF, no reflection, no xorout)
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) {
      c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Mpeg(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}
