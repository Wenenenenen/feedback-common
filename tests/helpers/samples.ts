import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/** 直接从样例 zip 读取条目（不依赖 unzip 命令，也不解包到源码目录）。 */

const EOCD = 0x06054b50;

export function readZipEntries(archivePath: string): Map<string, Buffer> {
  const buffer = readFileSync(archivePath);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 0xffff - 22); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('样例包缺少中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('样例包中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('样例包本地头损坏');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`不支持的压缩方法 ${method}`);
    if (!name.endsWith('/')) files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export const SAMPLE_ARCHIVE = path.resolve('samples/echo-path-nlms-desk-cases.zip');

let cache: Map<string, Buffer> | null = null;

export function sampleFiles(): Map<string, Buffer> {
  if (!cache) cache = readZipEntries(SAMPLE_ARCHIVE);
  return cache;
}

export function sampleBytes(name: string): Uint8Array {
  const data = sampleFiles().get(name);
  if (!data) throw new Error(`样例包缺少 ${name}`);
  return new Uint8Array(data);
}

export function sampleJson(name: string): unknown {
  return JSON.parse(Buffer.from(sampleBytes(name)).toString('utf8'));
}
