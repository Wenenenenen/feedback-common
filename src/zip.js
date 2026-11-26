// Minimal ZIP reader: stored (method 0) and deflate (method 8) entries only.
// ZIP central directory fields are little-endian; all multi-byte access is explicit.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {}

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }

async function inflateRaw(raw) {
  // ZIP method-8 entries are raw DEFLATE (no zlib/gzip header). Browsers
  // expose exactly this as DecompressionStream('deflate-raw'). Node lacks
  // that format string, so it uses the matching zlib function instead.
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { inflateRaw } = await import('node:zlib');
    const { promisify } = await import('node:util');
    return new Uint8Array(await promisify(inflateRaw)(raw));
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Locate End Of Central Directory (no fixed position; scan from the end).
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (u32(dv, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ZIP: end of central directory not found');
  const total = u16(dv, eocd + 10);
  const cdSize = u32(dv, eocd + 12);
  const cdOff = u32(dv, eocd + 16);
  if (cdOff + cdSize > buf.length) throw new ZipError('ZIP: central directory out of range');

  const entries = [];
  let p = cdOff;
  for (let k = 0; k < total; k++) {
    if (u32(dv, p) !== CENTRAL_SIG) throw new ZipError('ZIP: bad central directory signature');
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const localOff = u32(dv, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    if (u32(dv, localOff) !== LOCAL_SIG) throw new ZipError(`ZIP: bad local header for ${name}`);
    const lhNameLen = u16(dv, localOff + 26);
    const lhExtraLen = u16(dv, localOff + 28);
    const dataOff = localOff + 30 + lhNameLen + lhExtraLen;
    if (dataOff + compSize > buf.length) throw new ZipError(`ZIP: entry data out of range: ${name}`);
    const raw = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) {
      data = new Uint8Array(raw);
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new ZipError(`ZIP: unsupported compression method ${method} for ${name}`);
    }
    entries.push({ name, data });
  }
  return entries;
}
