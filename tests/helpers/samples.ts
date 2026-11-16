import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Minimal ZIP reader (stored + deflate) so tests do not depend on unzip(1). */
function readZip(archivePath: string): Map<string, Buffer> {
  const buf = fs.readFileSync(archivePath);
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方法：${method}`);
    if (!name.endsWith('/')) files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export interface SampleBundle {
  scene: unknown;
  expected: {
    payload_initial_world: number[];
    payload_reparent_new_parent_local: number[];
    reparent_preserve_tolerance: number;
  };
  invalidCycle: unknown;
  sceneNodes: Record<string, { id: string; parent: string | null; matrix: number[]; box: number[] }>;
}

let cached: SampleBundle | null = null;

export function readSampleArchive(): SampleBundle {
  if (cached) return cached;
  const archivePath = path.resolve('samples/affine-scene-reparent-cases.zip');
  const files = readZip(archivePath);
  const scene = JSON.parse((files.get('scene.json') ?? fail('scene.json')).toString('utf8'));
  const sceneNodes: SampleBundle['sceneNodes'] = {};
  for (const node of scene.nodes as Array<{ id: string }>) sceneNodes[node.id] = node as SampleBundle['sceneNodes'][string];
  cached = {
    scene,
    expected: JSON.parse((files.get('expected.json') ?? fail('expected.json')).toString('utf8')),
    invalidCycle: JSON.parse((files.get('invalid-cycle.json') ?? fail('invalid-cycle.json')).toString('utf8')),
    sceneNodes,
  };
  return cached;
}

function fail(name: string): never {
  throw new Error(`样例压缩包缺少 ${name}`);
}
