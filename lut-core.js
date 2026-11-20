/*
 * lut-core.js — LUT 链核心引擎（纯计算，无 DOM 依赖，浏览器与 Node 通用）
 *
 * 规则（与样例 README 一致）：
 * - .cube 支持 TITLE、DOMAIN_MIN/MAX、LUT_1D_SIZE 或 LUT_3D_SIZE、# 注释、空白与科学计数法
 * - 单文件只含一种表；未给 DOMAIN 默认各通道 0..1
 * - 每条数据三个有限浮点数；3D 按 R 最快、G 次之、B 最慢存放
 * - 每级先按各通道 DOMAIN 归一化并夹到 [0,1]
 * - 1D 逐通道线性插值；3D 四面体插值：分数从大到小排序，平手按 R、G、B，
 *   顶点 000、e_a、e_a+e_b、111，权重 1-f_a、f_a-f_b、f_b-f_c、f_c
 * - 表输出可超出 [0,1]，只在下一级 DOMAIN 输入处或最终展示时夹紧
 * - 1D 大小 2..4096，3D 边长 2..65，链最多 8 级
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LutCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_STAGES = 8;
  const MIN_1D = 2, MAX_1D = 4096;
  const MIN_3D = 2, MAX_3D = 65;

  const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  function isFiniteToken(tok) {
    return FLOAT_RE.test(tok) && Number.isFinite(Number(tok));
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  class CubeParseError extends Error {
    constructor(message, line) {
      super(line != null ? `第 ${line} 行: ${message}` : message);
      this.name = 'CubeParseError';
      this.line = line != null ? line : null;
    }
  }

  /**
   * 解析 .cube 文本。
   * 返回 { title, type:'1d'|'3d', size, domainMin:[3], domainMax:[3], data:Float64Array, warnings:[] }
   * data 布局：1D — data[i*3+c]；3D — data[((b*N+g)*N+r)*3+c]
   */
  function parseCube(text) {
    if (typeof text !== 'string') throw new CubeParseError('内容不是文本');
    const lines = text.split(/\r\n|\r|\n/);
    let title = '';
    let domainMin = null, domainMax = null;
    let size1d = null, size3d = null;
    const data = [];
    const warnings = [];

    for (let ln = 0; ln < lines.length; ln++) {
      const lineNo = ln + 1;
      let line = lines[ln];
      const hash = line.indexOf('#');
      if (hash >= 0) line = line.slice(0, hash);
      line = line.trim();
      if (!line) continue;

      const tokens = line.split(/\s+/);
      const kw = tokens[0].toUpperCase();

      if (kw === 'TITLE') {
        const m = line.match(/^\s*TITLE\s+(.*)$/i);
        let t = m ? m[1].trim() : '';
        const q = t.match(/^"(.*)"$/) || t.match(/^'(.*)'$/);
        if (q) t = q[1];
        title = t;
        continue;
      }
      if (kw === 'DOMAIN_MIN' || kw === 'DOMAIN_MAX') {
        if (tokens.length !== 4 || !tokens.slice(1).every(isFiniteToken))
          throw new CubeParseError(`${kw} 需要 3 个有限浮点数`, lineNo);
        const v = tokens.slice(1).map(Number);
        if (kw === 'DOMAIN_MIN') domainMin = v; else domainMax = v;
        continue;
      }
      if (kw === 'LUT_1D_SIZE' || kw === 'LUT_3D_SIZE') {
        if (tokens.length !== 2 || !/^\d+$/.test(tokens[1]))
          throw new CubeParseError(`${kw} 需要一个正整数`, lineNo);
        const n = parseInt(tokens[1], 10);
        if (kw === 'LUT_1D_SIZE') {
          if (size1d !== null) throw new CubeParseError('LUT_1D_SIZE 重复', lineNo);
          size1d = n;
        } else {
          if (size3d !== null) throw new CubeParseError('LUT_3D_SIZE 重复', lineNo);
          size3d = n;
        }
        continue;
      }

      // 数据行：恰好 3 个有限浮点数
      if (tokens.length === 3 && tokens.every(isFiniteToken)) {
        data.push(Number(tokens[0]), Number(tokens[1]), Number(tokens[2]));
        continue;
      }
      // 已知但形态错误的行 / 未知关键字
      if (/^[A-Za-z]/.test(tokens[0])) {
        warnings.push(`第 ${lineNo} 行: 忽略未识别的关键字「${tokens[0]}」`);
        continue;
      }
      throw new CubeParseError('无法解析的行（应为 3 个有限浮点数或关键字）', lineNo);
    }

    if (size1d !== null && size3d !== null)
      throw new CubeParseError('同一文件不能同时包含 LUT_1D_SIZE 和 LUT_3D_SIZE');
    if (size1d === null && size3d === null)
      throw new CubeParseError('缺少 LUT_1D_SIZE 或 LUT_3D_SIZE');

    const type = size1d !== null ? '1d' : '3d';
    const size = size1d !== null ? size1d : size3d;
    if (type === '1d' && (size < MIN_1D || size > MAX_1D))
      throw new CubeParseError(`LUT_1D_SIZE 须在 ${MIN_1D}..${MAX_1D}，实际 ${size}`);
    if (type === '3d' && (size < MIN_3D || size > MAX_3D))
      throw new CubeParseError(`LUT_3D_SIZE 须在 ${MIN_3D}..${MAX_3D}，实际 ${size}`);

    const expect = type === '1d' ? size : size * size * size;
    const got = data.length / 3;
    if (got !== expect)
      throw new CubeParseError(`数据条数应为 ${expect}，实际 ${got}`);

    if (!domainMin) domainMin = [0, 0, 0];
    if (!domainMax) domainMax = [1, 1, 1];
    for (let c = 0; c < 3; c++) {
      if (!(domainMax[c] > domainMin[c]))
        throw new CubeParseError(
          `DOMAIN 通道 ${'RGB'[c]} 无效：min=${domainMin[c]} 必须小于 max=${domainMax[c]}`);
    }

    return { title, type, size, domainMin, domainMax, data: Float64Array.from(data), warnings };
  }

  /** 1D 逐通道线性插值（输入先做 DOMAIN 归一化并夹到 [0,1]） */
  function apply1d(lut, r, g, b) {
    const n = lut.size, d = lut.data;
    const inp = [r, g, b], out = [0, 0, 0];
    const x = [0, 0, 0], idx = [0, 0, 0], t = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = clamp01((inp[c] - lut.domainMin[c]) / (lut.domainMax[c] - lut.domainMin[c]));
      let xc = v * (n - 1);
      let i = Math.floor(xc);
      if (i > n - 2) i = n - 2;
      x[c] = xc; idx[c] = i; t[c] = xc - i;
    }
    for (let c = 0; c < 3; c++) {
      // 注意：每个输出通道使用各自输入通道的插值位置（逐通道整形）
      const i = idx[c], tc = t[c];
      out[c] = d[i * 3 + c] * (1 - tc) + d[(i + 1) * 3 + c] * tc;
    }
    return out;
  }

  /** 3D 四面体插值 */
  function apply3d(lut, r, g, b) {
    const n = lut.size, d = lut.data;
    const inp = [r, g, b];
    const cell = [0, 0, 0], f = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = clamp01((inp[c] - lut.domainMin[c]) / (lut.domainMax[c] - lut.domainMin[c]));
      const xc = v * (n - 1);
      let i = Math.floor(xc);
      if (i > n - 2) i = n - 2;
      cell[c] = i;
      f[c] = xc - i;
    }
    // 分数从大到小排序，平手按 R、G、B（通道号小者优先）
    const order = [0, 1, 2].sort((a, b2) => (f[b2] - f[a]) || (a - b2));
    const a = order[0], bCh = order[1], cCh = order[2];
    const fa = f[a], fb = f[bCh], fc = f[cCh];

    // 四个四面体顶点偏移：000、e_a、e_a+e_b、111
    const off = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 1, 1]];
    off[1][a] = 1;
    off[2][a] = 1; off[2][bCh] = 1;
    const w = [1 - fa, fa - fb, fb - fc, fc];

    const out = [0, 0, 0];
    for (let v = 0; v < 4; v++) {
      const rr = cell[0] + off[v][0];
      const gg = cell[1] + off[v][1];
      const bb = cell[2] + off[v][2];
      const base = ((bb * n + gg) * n + rr) * 3;
      const wv = w[v];
      if (wv === 0) continue;
      out[0] += wv * d[base];
      out[1] += wv * d[base + 1];
      out[2] += wv * d[base + 2];
    }
    return out;
  }

  /** 应用单级 LUT，输出不夹紧 */
  function applyLut(lut, r, g, b) {
    return lut.type === '1d' ? apply1d(lut, r, g, b) : apply3d(lut, r, g, b);
  }

  /**
   * 应用链。stages: [{lut, enabled}]
   * 返回 { out:[3], steps:[{name, enabled, input:[3], output:[3]}] }
   * 级间不夹紧（夹紧只发生在每级内部 DOMAIN 归一化处）。
   */
  function applyChain(stages, r, g, b) {
    let cur = [r, g, b];
    const steps = [];
    for (const st of stages) {
      const input = cur.slice();
      let output;
      if (st.enabled) {
        output = applyLut(st.lut, cur[0], cur[1], cur[2]);
        cur = output;
      } else {
        output = cur.slice();
      }
      steps.push({ name: st.lut.title || st.name || '(未命名)', enabled: !!st.enabled, input, output: output.slice() });
    }
    return { out: cur.slice(), steps };
  }

  /**
   * 烘焙：在指定输入 DOMAIN 的 N×N×N 网格上采样完整启用链，生成单张 3D LUT。
   */
  function bakeChain(stages, domainMin, domainMax, n) {
    if (!Number.isInteger(n) || n < MIN_3D || n > MAX_3D)
      throw new Error(`烘焙边长须为 ${MIN_3D}..${MAX_3D} 的整数`);
    for (let c = 0; c < 3; c++)
      if (!(domainMax[c] > domainMin[c]))
        throw new Error(`烘焙 DOMAIN 通道 ${'RGB'[c]} 无效：min 必须小于 max`);
    const data = new Float64Array(n * n * n * 3);
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const ir = domainMin[0] + (r / (n - 1)) * (domainMax[0] - domainMin[0]);
          const ig = domainMin[1] + (g / (n - 1)) * (domainMax[1] - domainMin[1]);
          const ib = domainMin[2] + (b / (n - 1)) * (domainMax[2] - domainMin[2]);
          const { out } = applyChain(stages, ir, ig, ib);
          const base = ((b * n + g) * n + r) * 3;
          data[base] = out[0]; data[base + 1] = out[1]; data[base + 2] = out[2];
        }
      }
    }
    return {
      title: '烘焙链', type: '3d', size: n,
      domainMin: domainMin.slice(), domainMax: domainMax.slice(),
      data, warnings: [],
    };
  }

  function fmtNum(v) {
    if (!Number.isFinite(v)) throw new Error('表中含非有限值，无法写出');
    return String(v); // 最短往返表示，保证重载不丢精度
  }

  /** 把 LUT 序列化为 .cube 文本（完整表内容） */
  function cubeToText(lut) {
    const lines = [];
    if (lut.title) lines.push(`TITLE "${lut.title}"`);
    lines.push(`DOMAIN_MIN ${lut.domainMin.map(fmtNum).join(' ')}`);
    lines.push(`DOMAIN_MAX ${lut.domainMax.map(fmtNum).join(' ')}`);
    lines.push(lut.type === '1d' ? `LUT_1D_SIZE ${lut.size}` : `LUT_3D_SIZE ${lut.size}`);
    const d = lut.data;
    for (let i = 0; i < d.length; i += 3)
      lines.push(`${fmtNum(d[i])} ${fmtNum(d[i + 1])} ${fmtNum(d[i + 2])}`);
    return lines.join('\n') + '\n';
  }

  /* ---------------- PNG 编码（8-bit RGBA，不预乘，保留透明像素 RGB） ---------------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(8 + data.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const crcBuf = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) crcBuf[i] = type.charCodeAt(i);
    crcBuf.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcBuf));
    return out;
  }

  async function deflateRaw(bytes) {
    // CompressionStream('deflate') 输出 zlib（RFC1950）流，正是 PNG IDAT 所需
    const cs = new CompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * 编码 8-bit RGBA PNG。rgba 为未预乘的 Uint8Array（w*h*4），alpha=0 像素的 RGB 原样写入。
   */
  async function encodePng(w, h, rgba) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1)
      throw new Error('PNG 尺寸无效');
    if (rgba.length !== w * h * 4) throw new Error('像素数据长度与尺寸不符');

    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    // 10..12: compression/filter/interlace = 0

    const raw = new Uint8Array(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
      const rowStart = y * (1 + w * 4);
      raw[rowStart] = 0; // filter: None
      raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), rowStart + 1);
    }
    const idat = await deflateRaw(raw);

    const chunks = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /* ---------------- 探针对比 ---------------- */

  /** 确定性伪随机（可复现的连续探针） */
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * 在指定 DOMAIN 内生成连续（非网格点）随机探针。
   */
  function makeProbes(domainMin, domainMax, count, seed) {
    const rng = makeRng(seed == null ? 0x5eed : seed);
    const probes = [];
    for (let i = 0; i < count; i++) {
      probes.push([
        domainMin[0] + rng() * (domainMax[0] - domainMin[0]),
        domainMin[1] + rng() * (domainMax[1] - domainMin[1]),
        domainMin[2] + rng() * (domainMax[2] - domainMin[2]),
      ]);
    }
    return probes;
  }

  /**
   * 对比连续原链与烘焙表。返回 { rows, maxErr, meanErr, rmsErr }
   * rows: [{input, chainOut, bakedOut, err:[3], maxAbs}] 按 maxAbs 降序。
   */
  function compareProbes(stages, bakedLut, probes) {
    const rows = [];
    let maxErr = 0, sum = 0, sumSq = 0;
    for (const p of probes) {
      const chainOut = applyChain(stages, p[0], p[1], p[2]).out;
      const bakedOut = applyLut(bakedLut, p[0], p[1], p[2]);
      const err = [
        Math.abs(chainOut[0] - bakedOut[0]),
        Math.abs(chainOut[1] - bakedOut[1]),
        Math.abs(chainOut[2] - bakedOut[2]),
      ];
      const maxAbs = Math.max(err[0], err[1], err[2]);
      rows.push({ input: p.slice(), chainOut, bakedOut, err, maxAbs });
      if (maxAbs > maxErr) maxErr = maxAbs;
      sum += maxAbs; sumSq += maxAbs * maxAbs;
    }
    rows.sort((x, y) => y.maxAbs - x.maxAbs);
    const n = Math.max(1, probes.length);
    return { rows, maxErr, meanErr: sum / n, rmsErr: Math.sqrt(sumSq / n) };
  }

  return {
    MAX_STAGES, MIN_1D, MAX_1D, MIN_3D, MAX_3D,
    CubeParseError, parseCube,
    clamp01, applyLut, applyChain, bakeChain, cubeToText,
    encodePng, crc32,
    makeProbes, compareProbes, makeRng,
  };
});
