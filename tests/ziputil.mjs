// ZIP 读写测试辅助（Node 侧）：未加密的 stored / deflate 都能读。
import zlib from 'node:zlib';

export async function unzipNode(buffer) {
  const { default: ZipImpl } = await import('../src/js/zip.js').catch(() => ({}));
  // 直接用产品实现：Node 22 有 DecompressionStream
  const mod = await import('../src/js/zip.js');
  const api = mod.default || mod;
  return api.unzip(buffer);
}

/* 只用 Node 标准库的独立读取器，交叉核验产品实现 */
export function unzipPure(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = b.readUInt16LE(localOffset + 26);
    const lExtraLen = b.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const comp = b.subarray(start, start + compSize);
    const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    out.set(name, data);
  }
  return out;
}
