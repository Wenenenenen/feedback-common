// zip.js — deterministic ZIP writer (store or deflate) and a small reader for
// exported parameter bundles.  Standard library only: the page has no
// third-party dependencies, and writeFile() helpers are added because all
// archives here are produced in memory.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// ZIP method 8 is raw deflate (no zlib header), hence 'deflate-raw' rather
// than 'deflate'.
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

const UTF8_FLAG = 0x0800;

// entries: [{ name, data, compress = 'deflate'|'store', date = new Date() }]
// Files are emitted in the order given so exports are reproducible.
export async function makeZip(entries) {
  if (!entries.length) throw new Error('ZIP 至少需要一个文件');
  const locals = [];
  const centrals = [];
  let offset = 0;
  const names = new Set();

  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('..')) {
      throw new Error(`ZIP 条目名无效：${entry.name}`);
    }
    if (names.has(entry.name)) throw new Error(`ZIP 条目重复：${entry.name}`);
    names.add(entry.name);

    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    let useMethod = 0;
    let payload = data;
    if (entry.compress !== 'store') {
      const packed = await deflateRaw(data);
      if (packed.length < data.length) { payload = packed; useMethod = 8; }
    }
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.date || new Date());

    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(UTF8_FLAG), ...u16(useMethod),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(payload.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ]);
    locals.push(local, nameBytes, payload);

    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(UTF8_FLAG), ...u16(useMethod),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(payload.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ]);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  let centralSize = 0;
  for (const part of centrals) centralSize += part.length;
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of locals) { out.set(part, at); at += part.length; }
  for (const part of centrals) { out.set(part, at); at += part.length; }
  out.set(end, at);
  return out;
}

// Read a ZIP produced by makeZip (and most simple archivers).  Returns
// [{ name, data }].  Throws on truncation, bad CRCs or unsupported methods.
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the end-of-central-directory record (last 64 KiB + 22 bytes).
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 缺少中央目录结尾记录（文件可能被截断）');

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOff = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOff === 0xffffffff) throw new Error('不支持 ZIP64 归档');
  if (centralOff + centralSize > bytes.length) throw new Error('ZIP 中央目录超出文件尾部（文件可能被截断）');

  const entries = [];
  let at = centralOff;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error(`ZIP 第 ${i + 1} 条中央目录记录损坏`);
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOff = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error(`ZIP 条目 ${name} 的本地头损坏`);
    }
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > bytes.length) throw new Error(`ZIP 条目 ${name} 被截断`);
    let data = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 8) data = await inflateRaw(data);
    else if (method !== 0) throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方法 ${method}`);
    if (data.length !== size) throw new Error(`ZIP 条目 ${name} 解压后长度不符：期望 ${size}，实际 ${data.length}`);
    if (crc32(data) !== crc) throw new Error(`ZIP 条目 ${name} 的 CRC 校验失败`);
    entries.push({ name, data });
  }
  return entries;
}
