/** 极简 ZIP 读取（仅 stored/deflate），用于浏览器端直接打开样例包。 */

import { importWav } from './wav';
import type { AudioClip } from './types';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEocd(view: DataView): number {
  const maxScan = Math.min(view.byteLength, 0xffff + 22);
  for (let i = view.byteLength - 22; i >= view.byteLength - maxScan && i >= 0; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!ctor) throw new Error('当前运行环境不支持 DecompressionStream，无法解压样例包');
  const stream = new Blob([compressed as unknown as BlobPart]).stream().pipeThrough(new ctor('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** 读取整个 ZIP，返回未压缩的条目字节。 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('ZIP 缺少中央目录结尾记录');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeUtf8(bytes, offset + 46, nameLength);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > view.byteLength) throw new Error(`ZIP 条目 ${name} 数据越界`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new Error(`ZIP 条目 ${name} 使用不支持的压缩方法 ${method}`);
    }
    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`ZIP 条目 ${name} 解压长度 ${data.length} 与声明 ${uncompressedSize} 不符`);
    }
    if (!name.endsWith('/')) entries.push({ name, bytes: data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeUtf8(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(slice);
  let out = '';
  for (const byte of slice) out += String.fromCharCode(byte);
  return out;
}

export interface SampleCase {
  id: string;
  label: string;
  reference: { name: string; bytes: Uint8Array } | null;
  microphone: { name: string; bytes: Uint8Array } | null;
  /** 由包内 JSON 解析出的参数与期望值原文。 */
  meta: Record<string, unknown> | null;
  expected: Record<string, unknown> | null;
  notes: string | null;
}

export interface SampleBundle {
  cases: SampleCase[];
  notes: string;
  license: string;
  extras: Array<{ name: string; bytes: Uint8Array }>;
}

/** 把样例 zip 解析成可载入的案例集合（不在此处解码 WAV）。 */
export async function readSampleBundle(bytes: Uint8Array): Promise<SampleBundle> {
  const entries = await readZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  const text = (name: string): string | null => {
    const data = byName.get(name);
    return data ? decodeUtf8(data, 0, data.length) : null;
  };
  const json = (name: string): Record<string, unknown> | null => {
    const raw = text(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`样例 ${name} 不是合法 JSON：${(error as Error).message}`);
    }
  };

  const cases: SampleCase[] = [];
  const consider = (id: string, label: string, xName: string, dName: string, cfgName: string, expectedName?: string) => {
    const x = byName.get(xName);
    const d = byName.get(dName);
    if (!x && !d) return;
    cases.push({
      id,
      label,
      reference: x ? { name: xName, bytes: x } : null,
      microphone: d ? { name: dName, bytes: d } : null,
      meta: cfgName ? json(cfgName) : null,
      expected: expectedName ? json(expectedName) : null,
      notes: null,
    });
  };
  consider('tiny', 'tiny 核对（2 抽头）', 'tiny-x.wav', 'tiny-d.wav', 'tiny.json', 'tiny-expected.json');
  consider('main', 'main 双阶段真回声路径', 'main-x.wav', 'main-d.wav', 'main.json');

  const extras = entries.filter((entry) => /^formats\/.*\.wav$/i.test(entry.name));
  for (const entry of extras) {
    const stem = entry.name.replace(/^formats\//, '').replace(/\.wav$/i, '');
    cases.push({
      id: `format-${stem}`,
      label: `格式样例 ${stem}`,
      reference: { name: entry.name, bytes: entry.bytes },
      microphone: { name: entry.name, bytes: entry.bytes },
      meta: null,
      expected: null,
      notes: '同文件同时作为参考与麦克风：e 应恒为 0（滤波器全零输出、样本逐位相减）。',
    });
  }

  return {
    cases,
    notes: text('说明.md') ?? '',
    license: text('许可.txt') ?? '',
    extras: extras.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
  };
}

/** 解码案例中的两条 WAV（长度与采样率必须一致）。 */
export async function loadSampleCase(c: SampleCase): Promise<{ reference: AudioClip; microphone: AudioClip }> {
  if (!c.reference || !c.microphone) throw new Error(`案例 ${c.id} 缺少参考或麦克风 WAV`);
  const reference = await importWav(c.reference.name, c.reference.bytes);
  const microphone = await importWav(c.microphone.name, c.microphone.bytes);
  if (reference.sampleRate !== microphone.sampleRate) {
    throw new Error(`参考 ${reference.sampleRate}Hz 与麦克风 ${microphone.sampleRate}Hz 采样率不一致`);
  }
  if (reference.numFrames !== microphone.numFrames) {
    throw new Error(`参考 ${reference.numFrames} 帧与麦克风 ${microphone.numFrames} 帧长度不一致（必须等长）`);
  }
  return { reference, microphone };
}
