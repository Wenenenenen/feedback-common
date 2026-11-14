/**
 * STL parsing — ASCII and binary, no third-party libraries.
 *
 * Format detection deliberately does NOT trust the "solid" prefix: binary STL
 * files frequently start with it. A file is treated as binary only when the
 * declared triangle count exactly matches the byte size (or, for a truncated
 * binary file, when the content is clearly binary and the declared size is
 * larger than what is present).
 *
 * Units are assumed to be millimetres throughout the application.
 */

const MAX_TRIANGLES = 60_000_000;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export class StlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StlError';
    this.code = code;
    this.details = details;
  }
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function looksBinary(bytes) {
  if (bytes.length < 84) return false;
  // NUL bytes are a strong binary signal; ASCII STL never contains them.
  const probe = Math.min(bytes.length, 4096);
  let nul = 0;
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) nul++;
  return nul >= 4;
}

function isMostlyText(bytes) {
  const probe = Math.min(bytes.length, 4096);
  let text = 0;
  for (let i = 0; i < probe; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) text++;
  }
  return text / Math.max(probe, 1) > 0.85;
}

/**
 * Parse an STL file.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{positions: Float64Array, normals: (Float64Array|null),
 *           triangleCount: number, format: 'ascii'|'binary',
 *           warnings: string[]}}
 */
export function parseStl(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new StlError('too-large', `文件过大（${bytes.length} 字节），上限 ${MAX_UPLOAD_BYTES} 字节`);
  }
  if (bytes.length === 0) {
    throw new StlError('empty', '空文件');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredCount = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  const declaredSize = 84 + 50 * declaredCount;

  if (bytes.length >= 84 && declaredCount > 0 && declaredCount <= MAX_TRIANGLES && declaredSize === bytes.length) {
    return parseBinary(view, bytes.length, declaredCount, []);
  }

  // Exact-size match failed. Decide between truncated binary and ASCII.
  if (bytes.length >= 84 && declaredCount > 0 && declaredCount <= MAX_TRIANGLES &&
      declaredSize > bytes.length && looksBinary(bytes)) {
    throw new StlError(
      'truncated',
      `二进制 STL 截断：文件声明 ${declaredCount} 个三角面，需要 ${declaredSize} 字节，实际只有 ${bytes.length} 字节`,
      { declaredCount, declaredSize, actualSize: bytes.length },
    );
  }

  if (isMostlyText(bytes)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return parseAscii(text, []);
  }

  throw new StlError(
    'unknown-format',
    `无法识别的 STL：文件 ${bytes.length} 字节，二进制声明 ${declaredCount} 个面（需 ${declaredSize} 字节）`,
  );
}

function rejectNonFinite(value, what) {
  if (!Number.isFinite(value)) {
    throw new StlError('bad-number', `${what} 不是有限数值`);
  }
}

function parseBinary(view, byteLength, count, warnings) {
  const positions = new Float64Array(count * 9);
  const normals = new Float64Array(count * 3);
  let degenerateNormals = 0;
  for (let i = 0; i < count; i++) {
    const off = 84 + 50 * i;
    for (let k = 0; k < 3; k++) {
      const v = view.getFloat32(off + k * 4, true);
      rejectNonFinite(v, `三角面 ${i + 1} 法线分量`);
      normals[i * 3 + k] = v;
    }
    if (!(normals[i * 3] !== 0 || normals[i * 3 + 1] !== 0 || normals[i * 3 + 2] !== 0)) {
      degenerateNormals++;
    }
    for (let k = 0; k < 9; k++) {
      const v = view.getFloat32(off + 12 + k * 4, true);
      rejectNonFinite(v, `三角面 ${i + 1} 顶点坐标`);
      positions[i * 9 + k] = v;
    }
  }
  if (count === 0) throw new StlError('no-triangles', '文件不含三角面');
  if (degenerateNormals === count && count > 0) {
    warnings.push('文件未提供有效法线；方向将根据三角形绕序与体积推断。');
  }
  return { positions, normals, triangleCount: count, format: 'binary', warnings };
}

function parseAscii(text, warnings) {
  if (text.includes('\u0000')) {
    throw new StlError('unknown-format', '文件包含二进制数据，但尺寸与二进制 STL 声明不符');
  }
  // Tokenize lines, case-insensitive keywords, any whitespace.
  const positions = [];
  const normals = [];
  const lines = text.split(/\r?\n/);
  let facetNormal = null;
  let current = [];
  let facets = 0;
  let sawFacet = false;
  let sawSolid = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === '') continue;
    const kw = tokens[0].toLowerCase();
    if (kw === 'solid') { sawSolid = true; continue; }
    if (kw === 'endsolid') continue;
    if (kw === 'facet') {
      sawFacet = true;
      facetNormal = null;
      current = [];
      // "facet normal nx ny nz"
      if (tokens.length >= 5 && tokens[1] && tokens[1].toLowerCase() === 'normal') {
        facetNormal = [Number(tokens[2]), Number(tokens[3]), Number(tokens[4])];
        if (!facetNormal.every(isFiniteNumber)) facetNormal = null;
      }
      continue;
    }
    if (kw === 'outer' || kw === 'endfacet' || kw === 'endloop') {
      if (kw === 'endfacet') {
        if (current.length < 3) {
          throw new StlError('malformed-ascii', `第 ${li + 1} 行：facet 少于 3 个顶点`);
        }
        // Triangulate a fan if a facet has more than three vertices.
        for (let t = 1; t + 1 < current.length; t++) {
          const a = current[0], b = current[t], c = current[t + 1];
          positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          const n = facetNormal || [0, 0, 0];
          normals.push(n[0], n[1], n[2]);
          facets++;
        }
        current = [];
        facetNormal = null;
      }
      continue;
    }
    if (kw === 'vertex') {
      if (tokens.length < 4) {
        throw new StlError('malformed-ascii', `第 ${li + 1} 行：vertex 缺少坐标`);
      }
      const p = [Number(tokens[1]), Number(tokens[2]), Number(tokens[3])];
      if (!p.every(isFiniteNumber)) {
        throw new StlError('bad-number', `第 ${li + 1} 行：顶点坐标不是有限数值`);
      }
      current.push(p);
      continue;
    }
    // Unknown keyword: ignore (some exporters put comments in odd places), but
    // a non-keyword line before any solid/facet suggests a bad file.
  }

  if (!sawFacet || facets === 0) {
    throw new StlError(
      'not-ascii-stl',
      sawSolid ? 'ASCII STL 中没有任何 facet' : '不是有效的 ASCII STL（缺少 facet）',
    );
  }
  if (current.length !== 0) {
    throw new StlError('malformed-ascii', '文件在 facet 内部意外结束');
  }
  const n = facets;
  if (n > MAX_TRIANGLES) throw new StlError('too-many-triangles', `三角面数量 ${n} 超出上限`);
  const pos = new Float64Array(positions);
  const nor = new Float64Array(normals);
  let zeroNormals = 0;
  for (let i = 0; i < n; i++) {
    if (nor[i * 3] === 0 && nor[i * 3 + 1] === 0 && nor[i * 3 + 2] === 0) zeroNormals++;
  }
  if (zeroNormals === n) {
    warnings.push('文件未提供有效法线；方向将根据三角形绕序与体积推断。');
  }
  if (!sawSolid) warnings.push('ASCII STL 缺少 solid 头，已按 facet 结构解析。');
  return { positions: pos, normals: nor, triangleCount: n, format: 'ascii', warnings };
}
