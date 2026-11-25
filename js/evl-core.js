/*!
 * EVL1 事件曝光重建核心 —— 无 DOM 依赖，可在浏览器经典脚本与 Node 中运行。
 *
 * 约定见 samples/extracted/format.txt：
 *  - EVL1 小端二进制解析与“首个坏字段字节偏移”报错
 *  - 相邻有效锚之间：事件极性 /8 + 端点差额均摊漂移
 *  - 轨迹先夹 [-24,8]，再对任意半开 [start,end) 窗做解析积分
 *  - 缺锚时段只扣覆盖率；亮度只除以有效时长；无有效时长 -> 亮度/覆盖率精确为 0
 *  - LUM1 编码（逐像素交错 float32 亮度、float32 覆盖率）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EVLCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    maxWidth: 512,
    maxHeight: 384,
    maxAnchors: 12,
    maxEvents: 4000000,
    maxWindows: 24,
    logMin: -24,
    logMax: 8,
    codeMin: -6144,
    codeMax: 2048,
    missing: -32768,
    u32Max: 4294967295,
  });

  const LN2 = Math.LN2;
  const LOG_MIN = LIMITS.logMin;
  const LOG_MAX = LIMITS.logMax;
  const V_LOW = Math.pow(2, LOG_MIN);
  const V_HIGH = Math.pow(2, LOG_MAX);

  class EVLFormatError extends Error {
    constructor(offset, field, message) {
      super(message || `EVL1 字段非法（${field}）`);
      this.name = 'EVLFormatError';
      this.offset = offset;
      this.field = field;
    }
  }

  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
      // 复制一份，避免调用方缓冲随后被复用/分离
      return input.slice(0);
    }
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    throw new Error('parseEVL 需要 ArrayBuffer / TypedArray / Buffer');
  }

  /**
   * 严格顺序解析 EVL1。任何字段非法/截断都抛 EVLFormatError，
   * offset 为零基“字段起始字节”；尾随字节报第一个多余字节。
   * 成功返回的 codes 已转置为像素优先：codes[p*anchorCount+a]。
   */
  function parseEVL(input) {
    const buf = toArrayBuffer(input);
    const len = buf.byteLength;
    const dv = new DataView(buf);

    if (len < 4) throw new EVLFormatError(0, 'magic', '文件过短，EVL1 魔数字段不完整');
    let magic = '';
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(dv.getUint8(i));
    if (magic !== 'EVL1') throw new EVLFormatError(0, 'magic', '魔数不是 EVL1');

    if (len < 6) throw new EVLFormatError(4, 'width', '宽度字段被截断');
    const width = dv.getUint16(4, true);
    if (width < 1 || width > LIMITS.maxWidth) {
      throw new EVLFormatError(4, 'width', `宽度 ${width} 超出 1..512`);
    }

    if (len < 8) throw new EVLFormatError(6, 'height', '高度字段被截断');
    const height = dv.getUint16(6, true);
    if (height < 1 || height > LIMITS.maxHeight) {
      throw new EVLFormatError(6, 'height', `高度 ${height} 超出 1..384`);
    }

    if (len < 12) throw new EVLFormatError(8, 'anchorCount', '锚图数字段被截断');
    const anchorCount = dv.getUint32(8, true);
    if (anchorCount < 2 || anchorCount > LIMITS.maxAnchors) {
      throw new EVLFormatError(8, 'anchorCount', `锚图数 ${anchorCount} 超出 2..12`);
    }

    if (len < 16) throw new EVLFormatError(12, 'eventCount', '事件数字段被截断');
    const eventCount = dv.getUint32(12, true);
    if (eventCount > LIMITS.maxEvents) {
      throw new EVLFormatError(12, 'eventCount', `事件数 ${eventCount} 超过 4000000`);
    }

    const pixels = width * height;
    const codes = new Int16Array(pixels * anchorCount);
    const anchorTimes = new Uint32Array(anchorCount);

    let pos = 16;

    // ---- 锚图（时标 + w*h 个 i16 码，按行） ----
    for (let a = 0; a < anchorCount; a++) {
      if (pos + 4 > len) {
        throw new EVLFormatError(pos, `anchors[${a}].time`, '锚时标字段被截断');
      }
      const t = dv.getUint32(pos, true);
      if (a > 0 && t <= anchorTimes[a - 1]) {
        throw new EVLFormatError(pos, `anchors[${a}].time`, '锚图时标未严格递增');
      }
      anchorTimes[a] = t;
      pos += 4;

      for (let p = 0; p < pixels; p++) {
        if (pos + 2 > len) {
          throw new EVLFormatError(pos, `anchors[${a}].codes[${p}]`, '锚亮度码字段被截断');
        }
        const code = dv.getInt16(pos, true);
        if (code !== LIMITS.missing && (code < LIMITS.codeMin || code > LIMITS.codeMax)) {
          throw new EVLFormatError(pos, `anchors[${a}].codes[${p}]`, `非法对数亮度码 ${code}`);
        }
        codes[p * anchorCount + a] = code;
        pos += 2;
      }
    }

    // ---- 事件 ----
    const evTime = new Uint32Array(eventCount);
    const evWord = new Uint32Array(eventCount);
    const firstT = anchorTimes[0];
    const lastT = anchorTimes[anchorCount - 1];
    let prevEventT = -1;

    for (let i = 0; i < eventCount; i++) {
      if (pos + 4 > len) {
        throw new EVLFormatError(pos, `events[${i}].time`, '事件时标字段被截断');
      }
      const t = dv.getUint32(pos, true);
      if (t < firstT || t > lastT) {
        throw new EVLFormatError(pos, `events[${i}].time`,
          `事件时标 ${t} 落在首末锚 [${firstT}, ${lastT}] 之外`);
      }
      if (i > 0 && t < prevEventT) {
        throw new EVLFormatError(pos, `events[${i}].time`, '事件时标非降约束被破坏');
      }
      prevEventT = t;
      evTime[i] = t;
      pos += 4;

      if (pos + 4 > len) {
        throw new EVLFormatError(pos, `events[${i}].word`, '事件位字字段被截断');
      }
      const word = dv.getUint32(pos, true);
      const idx = word & 0x7fffffff;
      if (idx >= pixels) {
        throw new EVLFormatError(pos, `events[${i}].pixel`, `像素下标 ${idx} >= ${pixels}`);
      }
      evWord[i] = word;
      pos += 4;
    }

    if (pos < len) {
      throw new EVLFormatError(pos, 'trailing', `存在 ${len - pos} 个尾随多余字节`);
    }

    // ---- 按像素稳定计数排序（同像素内保持全局非降时间序） ----
    const counts = new Uint32Array(pixels);
    for (let i = 0; i < eventCount; i++) {
      counts[evWord[i] & 0x7fffffff]++;
    }
    const gStart = new Uint32Array(pixels + 1);
    for (let p = 0; p < pixels; p++) gStart[p + 1] = gStart[p] + counts[p];
    const cursor = new Uint32Array(gStart); // 长度 pixels+1，只用 [0,pixels)
    const gTime = new Uint32Array(eventCount);
    const gPol = new Int8Array(eventCount);
    for (let i = 0; i < eventCount; i++) {
      const word = evWord[i];
      const idx = word & 0x7fffffff;
      const q = cursor[idx]++;
      gTime[q] = evTime[i];
      gPol[q] = (word & 0x80000000) ? 1 : -1;
    }

    return {
      format: 'EVL1',
      width,
      height,
      pixels,
      anchorCount,
      eventCount,
      anchorTimes,
      codes,
      gStart,
      gTime,
      gPol,
    };
  }

  /** ∫_0^len 2^(z + beta*x) dx，expm1 形式避免小斜率/短区间相消。 */
  function expLinIntegral(z, beta, len) {
    if (len <= 0) return 0;
    if (beta === 0) return Math.pow(2, z) * len;
    const q = beta * LN2 * len;
    // q 与 beta*LN2 同号，expm1(q)/(beta*LN2) -> len 的稳定形式
    return Math.pow(2, z) * Math.expm1(q) / (beta * LN2);
  }

  /**
   * ∫_u^v 2^clamp(z0+beta*x, LOG_MIN, LOG_MAX) dx，
   * x 相对线性段起点；允许任意极端斜率，内部按夹断交点切分。
   */
  function clampedIntegral(z0, beta, u, v) {
    const len = v - u;
    if (len <= 0) return 0;
    const zu = z0 + beta * u;
    const zv = z0 + beta * v;
    const zmin = zu < zv ? zu : zv;
    const zmax = zu < zv ? zv : zu;
    if (zmax <= LOG_MIN) return V_LOW * len;
    if (zmin >= LOG_MAX) return V_HIGH * len;
    if (zmin >= LOG_MIN && zmax <= LOG_MAX) return expLinIntegral(zu, beta, len);

    // 跨越夹断边界：收集切点（至多两个）后分段积分
    const cuts = [u];
    if (beta !== 0) {
      let x = (LOG_MIN - z0) / beta;
      if (x > u && x < v) cuts.push(x);
      x = (LOG_MAX - z0) / beta;
      if (x > u && x < v) cuts.push(x);
    }
    cuts.push(v);
    cuts.sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const x0 = cuts[i];
      const x1 = cuts[i + 1];
      if (!(x1 > x0)) continue;
      const zm = z0 + beta * ((x0 + x1) * 0.5);
      if (zm <= LOG_MIN) sum += V_LOW * (x1 - x0);
      else if (zm >= LOG_MAX) sum += V_HIGH * (x1 - x0);
      else sum += expLinIntegral(z0 + beta * x0, beta, x1 - x0);
    }
    return sum;
  }

  /**
   * 构造像素的全部有效连续段（run = 连续 ≥2 个有效锚）。
   * 返回数组，每个 run：
   *   {i0,i1,start,end,T:number[],Z:number[],B:number[],Tot:number[]}
   * T[j] 为第 j 个线性子段起点（锚点或合并后的同刻事件），
   * Z[j] 为该起点（事件已生效）的未夹紧对数亮度，B[j] 为均摊斜率，
   * Tot[j] 为整个子段的夹紧亮度积分；子段终点为 T[j+1] 或 run.end。
   */
  function buildPixelRuns(data, p) {
    const A = data.anchorCount;
    const at = data.anchorTimes;
    const codes = data.codes;
    const base = p * A;
    const gs = data.gStart;
    const gT = data.gTime;
    const gP = data.gPol;
    const e1all = gs[p + 1];
    let q = gs[p];

    const runs = [];
    const mT = [];
    const mD = [];

    let i = 0;
    while (i < A) {
      if (codes[base + i] === LIMITS.missing) { i++; continue; }
      let j = i;
      while (j + 1 < A && codes[base + j + 1] !== LIMITS.missing) j++;
      if (j > i) {
        const T = [];
        const Z = [];
        const B = [];
        const Tot = [];

        for (let k = i; k < j; k++) {
          const ta = at[k];
          const tb = at[k + 1];
          const La = codes[base + k] / 256;
          const Lb = codes[base + k + 1] / 256;

          while (q < e1all && gT[q] <= ta) q++; // 同刻锚点事件：丢弃
          mT.length = 0;
          mD.length = 0;
          let N = 0;
          let q2 = q;
          while (q2 < e1all && gT[q2] < tb) {
            const t = gT[q2];
            let s = 0;
            while (q2 < e1all && gT[q2] === t) {
              s += gP[q2];
              q2++;
            }
            mT.push(t);
            mD.push(s);
            N += s;
          }
          q = q2; // 下一段的 <=tb 跳过会处理 t==tb

          const beta = (Lb - La - N / 8) / (tb - ta);

          let n = 0;
          let qtime = ta;
          let z = La;
          T.push(ta);
          Z.push(z);
          B.push(beta);

          for (let m = 0; m < mT.length; m++) {
            const t = mT[m];
            Tot.push(clampedIntegral(z, beta, 0, t - qtime));
            n += mD[m];
            qtime = t;
            z = La + n / 8 + beta * (t - ta);
            T.push(t);
            Z.push(z);
            B.push(beta);
          }
          Tot.push(clampedIntegral(z, beta, 0, tb - qtime));
        }

        runs.push({ i0: i, i1: j, start: at[i], end: at[j], T, Z, B, Tot });
      }
      i = j + 1;
    }
    return runs;
  }

  /** 在一个 run 的 [lo,hi] 上做局部稳定积分（不使用大全局前缀相减）。 */
  function integralRange(run, lo, hi) {
    if (!(hi > lo)) return 0;
    const { T, Z, B, Tot, end } = run;
    const K = T.length;

    let l = 0, r = K;
    while (l < r) {
      const m = (l + r) >> 1;
      if (T[m] <= lo) l = m + 1; else r = m;
    }
    let j = l - 1;
    if (j < 0) j = 0;

    let sum = 0;
    while (j < K) {
      const t0 = T[j];
      const tend = (j + 1 < K) ? T[j + 1] : end;
      if (t0 >= hi) break;
      const a = lo > t0 ? lo : t0;
      const b = hi < tend ? hi : tend;
      if (b > a) {
        if (a === t0 && b === tend) {
          sum += Tot[j];
        } else {
          sum += clampedIntegral(Z[j], B[j], a - t0, b - t0);
        }
      }
      if (tend >= hi) break;
      j++;
    }
    return sum;
  }

  /**
   * 计算单个像素在所有窗上的结果，写入 window-major 大数组：
   * lum[w*P+p], cov[w*P+p]。dur/integral 为调用方复用的长度 W 临时数组。
   */
  function computePixelInto(data, p, windows, lum, cov, P, dur, integral) {
    const W = windows.length;
    for (let w = 0; w < W; w++) { dur[w] = 0; integral[w] = 0; }

    const runs = buildPixelRuns(data, p);
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      const rs = run.start;
      const re = run.end;
      for (let w = 0; w < W; w++) {
        const ws = windows[w][0];
        const we = windows[w][1];
        const lo = ws > rs ? ws : rs;
        const hi = we < re ? we : re;
        if (hi > lo) {
          dur[w] += hi - lo; // 整数 µs，float64 精确
          integral[w] += integralRange(run, lo, hi);
        }
      }
    }

    for (let w = 0; w < W; w++) {
      const idx = w * P + p;
      const d = dur[w];
      if (d > 0) {
        const v = integral[w] / d;
        lum[idx] = v < 0 ? 0 : v;
        cov[idx] = d / (windows[w][1] - windows[w][0]);
      } else {
        lum[idx] = 0; // 理论零精确为零
        cov[idx] = 0;
      }
    }
  }

  /** 同步计算全部像素 × 全部窗。windows: [[start,end],...] ≤24。 */
  function computeAll(data, windows) {
    if (!data || data.format !== 'EVL1') throw new Error('缺少已解析的 EVL1 数据');
    const W = windows.length;
    if (W > LIMITS.maxWindows) throw new Error('曝光窗最多 24 个');
    const P = data.pixels;
    const lum = new Float64Array(W * P);
    const cov = new Float64Array(W * P);
    const dur = new Float64Array(W);
    const integral = new Float64Array(W);
    for (let p = 0; p < P; p++) {
      computePixelInto(data, p, windows, lum, cov, P, dur, integral);
    }
    return { lum, cov, width: data.width, height: data.height, pixels: P, windows };
  }

  /** 分块异步版本，带进度，避免长文件完全锁死 UI。 */
  function computeAllAsync(data, windows, opts) {
    opts = opts || {};
    const yieldEvery = opts.yieldEvery || 4096;
    const onProgress = opts.onProgress;
    return new Promise((resolve, reject) => {
      try {
        const W = windows.length;
        if (W > LIMITS.maxWindows) throw new Error('曝光窗最多 24 个');
        const P = data.pixels;
        const lum = new Float64Array(W * P);
        const cov = new Float64Array(W * P);
        const dur = new Float64Array(W);
        const integral = new Float64Array(W);
        let p = 0;
        function chunk() {
          try {
            const stop = Math.min(P, p + yieldEvery);
            for (; p < stop; p++) {
              computePixelInto(data, p, windows, lum, cov, P, dur, integral);
            }
            if (onProgress) onProgress(p / P);
            if (p < P) {
              setTimeout(chunk, 0);
            } else {
              resolve({ lum, cov, width: data.width, height: data.height, pixels: P, windows });
            }
          } catch (err) { reject(err); }
        }
        chunk();
      } catch (err) { reject(err); }
    });
  }

  /** 编码单个窗的 LUM1：魔数4 + u16w + u16h，随后逐像素交错 float32 亮度/覆盖率。 */
  function encodeLUM1(result, windowIndex) {
    const { width, height, pixels: P, lum, cov } = result;
    const w = windowIndex | 0;
    const bytes = new ArrayBuffer(8 + 8 * P);
    const dv = new DataView(bytes);
    dv.setUint8(0, 0x4c); // L
    dv.setUint8(1, 0x55); // U
    dv.setUint8(2, 0x4d); // M
    dv.setUint8(3, 0x31); // 1
    dv.setUint16(4, width, true);
    dv.setUint16(6, height, true);
    let off = 8;
    const base = w * P;
    for (let p = 0; p < P; p++) {
      dv.setFloat32(off, lum[base + p], true);
      dv.setFloat32(off + 4, cov[base + p], true);
      off += 8;
    }
    return bytes;
  }

  /** 平面布局版本（先全部亮度再全部覆盖率），仅作工具/兼容备用。 */
  function encodeLUM1Planar(result, windowIndex) {
    const { width, height, pixels: P, lum, cov } = result;
    const w = windowIndex | 0;
    const bytes = new ArrayBuffer(8 + 8 * P);
    const dv = new DataView(bytes);
    dv.setUint8(0, 0x4c); dv.setUint8(1, 0x55); dv.setUint8(2, 0x4d); dv.setUint8(3, 0x31);
    dv.setUint16(4, width, true);
    dv.setUint16(6, height, true);
    const base = w * P;
    let off = 8;
    for (let p = 0; p < P; p++) dv.setFloat32(off + 4 * p, lum[base + p], true);
    off = 8 + 4 * P;
    for (let p = 0; p < P; p++) dv.setFloat32(off + 4 * p, cov[base + p], true);
    return bytes;
  }

  // ---- 最小 ZIP(STORE) 写入，用于一次导出全部窗 ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** files: [{name, bytes:ArrayBuffer|Uint8Array}] -> Uint8Array zip */
  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const crc = crc32(data);
      const size = data.length;

      const local = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(local);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      new Uint8Array(local, 30).set(nameBytes);

      chunks.push(new Uint8Array(local), data);

      const cd = new ArrayBuffer(46 + nameBytes.length);
      const cv = new DataView(cd);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      new Uint8Array(cd, 46).set(nameBytes);
      central.push(new Uint8Array(cd));

      offset += local.byteLength + size;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cdSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const ch of chunks) { out.set(ch, pos); pos += ch.length; }
    let cdStart = pos;
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(new Uint8Array(end), pos);
    void cdStart;
    return out;
  }

  function validateWindows(list) {
    if (!Array.isArray(list)) throw new Error('曝光窗必须是数组');
    if (list.length < 1) throw new Error('至少需要 1 个曝光窗');
    if (list.length > LIMITS.maxWindows) throw new Error('曝光窗最多 24 个');
    return list.map((w, i) => {
      const s = Number(w[0]);
      const e = Number(w[1]);
      if (!Number.isInteger(s) || !Number.isInteger(e) ||
        s < 0 || e < 0 || s > LIMITS.u32Max || e > LIMITS.u32Max) {
        throw new Error(`第 ${i + 1} 窗时标必须是 0..4294967295 的整数`);
      }
      if (!(s < e)) throw new Error(`第 ${i + 1} 窗必须满足 start < end`);
      return [s, e];
    });
  }

  return {
    LIMITS,
    EVLFormatError,
    parseEVL,
    clampedIntegral,
    expLinIntegral,
    buildPixelRuns,
    integralRange,
    computeAll,
    computeAllAsync,
    computePixelInto,
    encodeLUM1,
    encodeLUM1Planar,
    zipStore,
    crc32,
    validateWindows,
  };
});
