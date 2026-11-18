// 网格导入解析：样例 JSON、Wavefront OBJ、ASCII PLY。
// 只做解析，不做几何计算；返回 { positions, triangles, sources, tau }。

export class ParseError extends Error {}

export function parseMeshText(text, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json') || text.trimStart().startsWith('{')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ParseError(`JSON 解析失败：${e.message}`);
    }
    if (!Array.isArray(data.positions) || !Array.isArray(data.triangles)) {
      throw new ParseError('JSON 缺少 positions / triangles 数组');
    }
    return {
      positions: data.positions.map((p) => [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)]),
      triangles: data.triangles.map((t) => t.slice()),
      sources: Array.isArray(data.sources) ? data.sources.slice() : [],
      tau: typeof data.tau === 'number' ? data.tau : 1,
    };
  }
  if (lower.endsWith('.obj') || text.includes('\nv ') || text.startsWith('v ')) {
    return parseOBJ(text);
  }
  if (lower.endsWith('.ply') || text.trimStart().startsWith('ply')) {
    return parsePLY(text);
  }
  throw new ParseError('不支持的文件格式（支持 .json / .obj / .ply）');
}

function parseOBJ(text) {
  const positions = [];
  const triangles = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)]);
    } else if (parts[0] === 'f') {
      const idx = parts.slice(1).map((tok) => {
        const n = Number(tok.split('/')[0]);
        return n > 0 ? n - 1 : positions.length + n; // OBJ 负索引
      });
      if (idx.length < 3) continue;
      for (let k = 1; k < idx.length - 1; k++) triangles.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!positions.length || !triangles.length) throw new ParseError('OBJ 中未读到顶点或面');
  return { positions, triangles, sources: [], tau: 1 };
}

function parsePLY(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new ParseError('非法 PLY 文件头');
  let i = 1;
  let fmt = '';
  let nV = 0;
  let nF = 0;
  const props = [];
  let inVertex = false;
  while (i < lines.length) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts[0] === 'format') {
      fmt = parts[1];
      if (fmt !== 'ascii') throw new ParseError('仅支持 ASCII PLY（binary PLY 请先转换）');
    } else if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex';
      if (parts[1] === 'vertex') nV = Number(parts[2]);
      if (parts[1] === 'face') nF = Number(parts[2]);
    } else if (parts[0] === 'property' && inVertex) {
      props.push(parts[parts.length - 1]);
    } else if (parts[0] === 'end_header') {
      i++;
      break;
    }
    i++;
  }
  const xIdx = props.indexOf('x');
  const yIdx = props.indexOf('y');
  const zIdx = props.indexOf('z');
  if (xIdx < 0 || yIdx < 0) throw new ParseError('PLY 顶点缺少 x/y 属性');
  const positions = [];
  for (let k = 0; k < nV; k++, i++) {
    const p = lines[i].trim().split(/\s+/).map(Number);
    positions.push([p[xIdx], p[yIdx], zIdx >= 0 ? p[zIdx] : 0]);
  }
  const triangles = [];
  for (let k = 0; k < nF; k++, i++) {
    const p = lines[i].trim().split(/\s+/).map(Number);
    const cnt = p[0];
    if (cnt < 3) continue;
    for (let q = 1; q < cnt - 1; q++) triangles.push([p[1], p[q + 1], p[q + 2]]);
  }
  return { positions, triangles, sources: [], tau: 1 };
}
