/*
 * PFM（Portable FloatMap）读取。
 *
 * 支持样例包所要求的最小、明确的子集：
 *   - 头三行：`PF`、`<宽> <高>`、`<非零尺度>`。
 *   - 尺度为负 → 小端；为正 → 大端（样例 constant-be-scale2.pfm 即大端 + 尺度 2）。
 *   - 样本值乘以 |尺度|；RGB 三通道 float32。
 *   - 文件先存最底行：文件第 0 行 = 逻辑最后一行（r = H−1）。
 *
 * 输出统一为「逻辑行序」（顶行 r=0 在前）的 Float32Array，便于积分与预览。
 * 读取时会给出可选的显式覆盖（字节序 / 行序 / 尺度），默认全部按文件头。
 *
 * 校验：
 *   - 只接受 PF（RGB float32）；Pf 灰度、其它类型直接拒绝。
 *   - 尺寸必须为正整数且不超过 1024×512。
 *   - 数据字节数不足 → 截断错误（报告缺少多少字节）。
 *   - 乘过尺度后出现 NaN / ±Inf → 非有限值错误（报告个数与首个位置）。
 *
 * 解析失败不产生半成品：抛出 PfmError，由调用方保留已有结果。
 */

export const PFM_LIMITS = Object.freeze({ maxWidth: 1024, maxHeight: 512 });

export class PfmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PfmError';
    this.code = code;
    this.details = details;
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('parsePfm 需要 ArrayBuffer 或 Uint8Array');
}

function readLine(bytes, offset) {
  const limit = Math.min(bytes.length, offset + 4096);
  let end = -1;
  for (let i = offset; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let stop = end;
  while (stop > offset && (bytes[stop - 1] === 0x0d || bytes[stop - 1] === 0x20 || bytes[stop - 1] === 0x09)) {
    stop--;
  }
  let text = '';
  for (let i = offset; i < stop; i++) text += String.fromCharCode(bytes[i]);
  return { text, next: end + 1 };
}

/** 把文件存储行序（默认底行优先）换算为逻辑行序（顶行 r=0）的源行号。 */
export function sourceRowFor(logicalRow, height, rowOrder) {
  return rowOrder === 'top' ? logicalRow : height - 1 - logicalRow;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{maxWidth?:number,maxHeight?:number,
 *          byteOrder?:'auto'|'little'|'big',
 *          rowOrder?:'auto'|'bottom'|'top',
 *          scaleMode?:'header'|'one'}} [options]
 * @returns {{
 *   width:number, height:number, scale:number, endian:'little'|'big', factor:number,
 *   rowOrder:'bottom'|'top', values:Float32Array, // 逻辑行序、顶行在前
 *   bytesUsed:number, byteLength:number,
 *   stats:{min:number,max:number,nonFinite:number,pixels:number},
 *   warnings:string[], header:{magic:string,width:number,height:number,scale:number,dataOffset:number}
 * }}
 */
export function parsePfm(input, options = {}) {
  const maxWidth = options.maxWidth ?? PFM_LIMITS.maxWidth;
  const maxHeight = options.maxHeight ?? PFM_LIMITS.maxHeight;
  const byteOrderOpt = options.byteOrder ?? 'auto';
  const rowOrderOpt = options.rowOrder ?? 'auto';
  const scaleMode = options.scaleMode ?? 'header';
  const bytes = toBytes(input);

  if (bytes.length === 0) {
    throw new PfmError('PFM_EMPTY', 'PFM 文件为空。', {});
  }

  const l0 = readLine(bytes, 0);
  if (!l0) {
    throw new PfmError('PFM_HEADER', 'PFM 头不完整：找不到第一行结束符。');
  }
  const magic = l0.text.trim();
  if (magic === 'Pf') {
    throw new PfmError(
      'PFM_HEADER',
      '这是灰度 Pf 文件，本页需要三通道 RGB 的 PF 文件。',
      { magic },
    );
  }
  if (magic !== 'PF') {
    throw new PfmError(
      'PFM_HEADER',
      `首行应为 “PF”（三通道 float32），实际为 “${magic || '(空)'}”。`,
      { magic },
    );
  }

  const l1 = readLine(bytes, l0.next);
  if (!l1) {
    throw new PfmError('PFM_HEADER', 'PFM 头不完整：缺少 “宽 高” 行。');
  }
  const sizeParts = l1.text.trim().split(/\s+/).filter(Boolean);
  if (sizeParts.length !== 2 || !/^\d+$/.test(sizeParts[0]) || !/^\d+$/.test(sizeParts[1])) {
    throw new PfmError(
      'PFM_DIMENSIONS',
      `尺寸行无效：“${l1.text.trim()}”，应为两个正整数（宽 高）。`,
      { line: l1.text.trim() },
    );
  }
  const width = Number(sizeParts[0]);
  const height = Number(sizeParts[1]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new PfmError('PFM_DIMENSIONS', `尺寸无效：${width}×${height}，宽高必须为正整数。`, { width, height });
  }
  if (width > maxWidth || height > maxHeight) {
    throw new PfmError(
      'PFM_DIMENSIONS',
      `尺寸超限：${width}×${height}；本页最多接受 ${maxWidth}×${maxHeight}。`,
      { width, height, maxWidth, maxHeight },
    );
  }

  const l2 = readLine(bytes, l1.next);
  if (!l2) {
    throw new PfmError('PFM_HEADER', 'PFM 头不完整：缺少尺度因子行。');
  }
  const scaleText = l2.text.trim();
  const headerScale = Number(scaleText);
  if (scaleText === ''
    || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(scaleText)
    || !Number.isFinite(headerScale)) {
    throw new PfmError(
      'PFM_SCALE',
      `尺度因子无效：“${scaleText}”，应为非零有限数。`,
      { line: scaleText },
    );
  }
  if (headerScale === 0) {
    throw new PfmError('PFM_SCALE', '尺度因子为 0：无法确定字节序，也无法换算样本值。', { scale: headerScale });
  }

  let endian;
  if (byteOrderOpt === 'little' || byteOrderOpt === 'big') {
    endian = byteOrderOpt;
  } else {
    endian = headerScale < 0 ? 'little' : 'big';
  }
  const inlineRowOrder = rowOrderOpt === 'bottom' || rowOrderOpt === 'top' ? rowOrderOpt : 'bottom';
  const factor = scaleMode === 'one' ? 1 : Math.abs(headerScale);

  const offset = l2.next;
  const pixelCount = width * height;
  const floatCount = pixelCount * 3;
  const need = floatCount * 4;
  const have = bytes.length - offset;
  const warnings = [];

  if (have < need) {
    throw new PfmError(
      'PFM_TRUNCATED',
      `数据被截断：${width}×${height}×3×float32 需要 ${need} 字节，实际只有 ${have} 字节，缺少 ${need - have} 字节。`,
      { width, height, need, have, missing: need - have },
    );
  }
  if (have > need) {
    warnings.push(`文件尾部有 ${have - need} 字节多余数据（已忽略）。`);
  }
  if (width !== height * 2) {
    warnings.push(`宽高比为 ${width}:${height}，不是 2:1；将按等距柱状图规则继续积分。`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, need);
  const values = new Float32Array(floatCount);
  let min = Infinity;
  let max = -Infinity;
  let nonFinite = 0;
  let firstNonFinite = null;
  const ordered = rowOrderOpt === 'auto' ? 'bottom' : rowOrderOpt;

  for (let fileRow = 0; fileRow < height; fileRow++) {
    const logRow = ordered === 'bottom' ? height - 1 - fileRow : fileRow;
    const src = fileRow * width * 3;
    const dst = logRow * width * 3;
    for (let p = 0; p < width * 3; p++) {
      let v = view.getFloat32((src + p) * 4, endian === 'little');
      v *= factor;
      values[dst + p] = v;
      if (!Number.isFinite(v)) {
        nonFinite++;
        if (!firstNonFinite) {
          firstNonFinite = {
            fileRow,
            row: logRow,
            column: Math.floor(p / 3),
            channel: ['R', 'G', 'B'][p % 3],
            value: v,
          };
        }
      } else {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }

  if (nonFinite > 0) {
    const where = firstNonFinite;
    throw new PfmError(
      'PFM_NONFINITE',
      `含 ${nonFinite} 个非有限值（NaN 或 ±Inf）；首个位于逻辑第 ${where.row} 行（自顶起算）第 ${where.column} 列 ${where.channel} 通道。`,
      { count: nonFinite, first: firstNonFinite, width, height },
    );
  }

  if (byteOrderOpt === 'auto' && scaleMode === 'header') {
    warnings.push(`字节序按尺度符号判定为${endian === 'little' ? '小端' : '大端'}（尺度 ${headerScale}）。`);
  }
  if (rowOrderOpt === 'auto') {
    warnings.push('行序按 PFM 惯例：文件先存最底行。');
  }

  return {
    width,
    height,
    scale: headerScale,
    endian,
    factor,
    rowOrder: ordered,
    values,
    bytesUsed: offset + need,
    byteLength: bytes.length,
    stats: { min, max, nonFinite: 0, pixels: pixelCount },
    warnings,
    header: { magic, width, height, scale: headerScale, dataOffset: offset },
  };
}
