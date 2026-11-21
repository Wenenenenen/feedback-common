/**
 * WAV 解析与生成。
 *
 * 支持 8 / 16 / 48 kHz、16 / 24 位、单声道 PCM（tag 1）。浮点样本按
 * `PCM 整数 / 2^(位深-1)` 换算；24 位读取有符号小端三字节。
 * 任何不支持的结构都给出具体原因，不做猜测性降级。
 */

import { digestSha256 } from './digest';
import { NLMS_CONSTANTS, type AudioClip } from './types';

export const SUPPORTED_RATES = [8000, 16000, 48000] as const;
export const SUPPORTED_BIT_DEPTHS = [16, 24] as const;
/** 导入上限（秒）：与包内“输入最长 15 秒”的约定同源。 */
export const MAX_IMPORT_SECONDS = NLMS_CONSTANTS.maxSeconds;

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavError';
  }
}

export interface WavEncodeOptions {
  sampleRate: number;
  /** 位深，仅支持 24（导出残差 WAV 的约定）。 */
  bitDepth: 24;
  /** 浮点样本，写入前按调用方给的限幅/取整策略处理。 */
  samples: Float64Array;
}

function fail(message: string): never {
  throw new WavError(message);
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    const code = view.getUint8(offset + i);
    if (code < 32 || code > 126) return text;
    text += String.fromCharCode(code);
  }
  return text;
}

/**
 * 文件内容摘要：重放检查点时用它确认是同一份输入。
 * 统一走 core/checkpoint 的 SHA-256（WebCrypto 或纯 JS 回退），
 * 保证浏览器与 Node 得到同一个前缀（sha256-...）。
 */
export async function digestBytesAsync(bytes: Uint8Array): Promise<string> {
  return `sha256-${await digestSha256(bytes)}`;
}

interface ParsedChunks {
  fmt: DataView | null;
  fmtSize: number;
  data: DataView | null;
  dataSize: number;
  riffSize: number;
}

function readChunks(bytes: Uint8Array): ParsedChunks {
  if (bytes.length < 12) fail('文件过短，不是有效的 WAV');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== 'RIFF') fail('缺少 RIFF 头（可能不是 WAV 文件）');
  const riffSize = view.getUint32(4, true);
  const form = ascii(view, 8, 4);
  if (form !== 'WAVE') fail(`RIFF 类型为 “${form}”，仅支持 WAVE`);
  if (riffSize + 8 > bytes.length + 1) {
    fail(`RIFF 声明长度 ${riffSize + 8} 超出文件实际长度 ${bytes.length}（文件可能被截断）`);
  }
  let offset = 12;
  const out: ParsedChunks = { fmt: null, fmtSize: 0, data: null, dataSize: 0, riffSize };
  while (offset + 8 <= bytes.length) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) {
      if (id === 'data') fail(`data 块声明 ${size} 字节，超出文件剩余长度 ${bytes.length - body}`);
      fail(`块 “${id}” 声明长度越界（文件可能被截断）`);
    }
    if (id === 'fmt ') {
      out.fmt = new DataView(bytes.buffer, bytes.byteOffset + body, size);
      out.fmtSize = size;
    } else if (id === 'data' && out.data === null) {
      out.data = new DataView(bytes.buffer, bytes.byteOffset + body, size);
      out.dataSize = size;
    }
    offset = body + size + (size & 1);
  }
  return out;
}

export interface DecodedPcm {
  sampleRate: number;
  bitDepth: 16 | 24;
  numChannels: number;
  numFrames: number;
  pcm: Int32Array;
  samples: Float64Array;
}

/** 只做格式解析与 PCM 解码（不含文件摘要，便于纯数值测试）。 */
export function decodeWavPcm(bytes: Uint8Array): DecodedPcm {
  const chunks = readChunks(bytes);
  if (!chunks.fmt) fail('缺少 fmt 块');
  if (chunks.fmtSize < 16) fail('fmt 块长度不足 16 字节');
  const fmt = chunks.fmt;
  const formatTag = fmt.getUint16(0, true);
  const numChannels = fmt.getUint16(2, true);
  const sampleRate = fmt.getUint32(4, true);
  const byteRate = fmt.getUint32(8, true);
  const blockAlign = fmt.getUint16(12, true);
  const bitsPerSample = fmt.getUint16(14, true);
  if (formatTag !== 1) {
    fail(`编码格式 tag=${formatTag}（仅支持整数 PCM tag=1${formatTag === 3 ? '；浮点 WAV 不支持' : ''}）`);
  }
  if (numChannels !== 1) fail(`声道数 ${numChannels}（仅支持单声道）`);
  if (!(SUPPORTED_RATES as readonly number[]).includes(sampleRate)) {
    fail(`采样率 ${sampleRate}Hz（仅支持 8 / 16 / 48kHz）`);
  }
  if (!(SUPPORTED_BIT_DEPTHS as readonly number[]).includes(bitsPerSample)) {
    fail(`位深 ${bitsPerSample} 位（仅支持 16 / 24 位整数 PCM）`);
  }
  if (chunks.fmtSize >= 18 && formatTag === 1) {
    const cbSize = fmt.getUint16(16, true);
    if (chunks.fmtSize < 18 + cbSize) fail('fmt 块扩展段长度越界');
  }
  const expectedAlign = numChannels * (bitsPerSample / 8);
  if (blockAlign !== expectedAlign) {
    fail(`块对齐 ${blockAlign} 字节与 ${numChannels} 声道 × ${bitsPerSample} 位不符（应为 ${expectedAlign}）`);
  }
  if (byteRate !== sampleRate * blockAlign) {
    fail(`字节率 ${byteRate} 与采样率 ${sampleRate} × 块对齐 ${blockAlign} 不符（应为 ${sampleRate * blockAlign}）`);
  }
  if (!chunks.data) fail('缺少 data 块');
  const dataSize = chunks.dataSize;
  if (dataSize % blockAlign !== 0) fail(`data 长度 ${dataSize} 不是块对齐 ${blockAlign} 的整数倍`);
  const numFrames = dataSize / blockAlign;
  if (numFrames === 0) fail('音频为空（0 帧）');
  const seconds = numFrames / sampleRate;
  if (seconds > MAX_IMPORT_SECONDS + 1e-9) {
    fail(`时长 ${seconds.toFixed(3)}s（${numFrames} 帧）超过 ${MAX_IMPORT_SECONDS} 秒上限`);
  }

  const data = chunks.data;
  const pcm = new Int32Array(numFrames);
  const samples = new Float64Array(numFrames);
  if (bitsPerSample === 16) {
    const scale = 1 / 32768;
    for (let i = 0; i < numFrames; i += 1) {
      const value = data.getInt16(i * 2, true);
      pcm[i] = value;
      samples[i] = value * scale;
    }
  } else {
    const scale = 1 / 8388608;
    for (let i = 0; i < numFrames; i += 1) {
      const base = i * 3;
      const raw = data.getUint8(base) | (data.getUint8(base + 1) << 8) | (data.getUint8(base + 2) << 16);
      const signed = raw >= 0x800000 ? raw - 0x1000000 : raw;
      pcm[i] = signed;
      samples[i] = signed * scale;
    }
  }
  return { sampleRate, bitDepth: bitsPerSample as 16 | 24, numChannels, numFrames, pcm, samples };
}

/** 完整导入：解析、解码、附加文件名与内容摘要。 */
export async function importWav(name: string, bytes: Uint8Array): Promise<AudioClip> {
  const decoded = decodeWavPcm(bytes);
  const digest = await digestBytesAsync(bytes);
  return {
    name,
    sampleRate: decoded.sampleRate,
    bitDepth: decoded.bitDepth,
    numFrames: decoded.numFrames,
    samples: decoded.samples,
    pcm: decoded.pcm,
    bytes,
    digest,
  };
}

/**
 * 24 位 PCM WAV 编码。
 * `encode` 回调把每个样本索引映射为有符号 24 位整数（调用方负责限幅与取整）。
 */
export function encodeWav24(sampleRate: number, numFrames: number, encode: (index: number) => number): Uint8Array {
  const dataSize = numFrames * 3;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 3, true);
  view.setUint16(32, 3, true);
  view.setUint16(34, 24, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numFrames; i += 1) {
    const value = encode(i);
    const base = 44 + i * 3;
    out[base] = value & 0xff;
    out[base + 1] = (value >> 8) & 0xff;
    out[base + 2] = (value >> 16) & 0xff;
  }
  return out;
}
