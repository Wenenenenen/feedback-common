/*
 * 极简 ZIP 写出器（无第三方依赖）。
 * 仅使用 method=0（STORE，不压缩），保证确定性与可移植性；
 * 生成的文件可被 unzip / 系统解压直接打开。
 */
'use strict';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function strU8(s) {
  return new TextEncoder().encode(s);
}

/**
 * entries: [{ name: string, data: Uint8Array }]
 * 返回完整 ZIP 的 Uint8Array。
 */
function buildZip(entries) {
  const localParts = [];
  const central = [];
  let offset = 0;
  const dosTime = 0; // 固定时间戳，输出确定
  const dosDate = 0x21; // 1980-01-01，合法 DOS 日期即可

  for (const entry of entries) {
    const name = strU8(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // ---- 本地文件头 (0x04034b50) ----
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);   // 版本
    local.setUint16(6, 0, true);    // 标志位
    local.setUint16(8, 0, true);    // STORE
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);   // 无 extra
    localParts.push(new Uint8Array(local.buffer), name, data);

    // ---- 中央目录头 (0x02014b50) ----
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true); // extra
    cd.setUint16(32, 0, true); // comment
    cd.setUint16(34, 0, true); // disk
    cd.setUint16(36, 0, true); // 内部属性
    cd.setUint32(38, 0, true); // 外部属性
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const p of central) centralSize += p.length;

  // ---- 中央目录结束记录 (0x06054b50) ----
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  const all = [...localParts, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const api = { buildZip, crc32 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.FlowZip = api;
export { buildZip, crc32 };
