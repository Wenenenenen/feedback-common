/*
 * optical-core.js — 扫描胶片条 → 48kHz 双声道 16 位 PCM 的全部纯算法。
 *
 * 无 DOM 依赖，UMD：
 *   - 浏览器经典脚本：globalThis.OpticalStitcher
 *   - Node：module.exports（.mjs 里可用 createRequire 或 import default）
 *
 * 时间模型：
 *   每个输出音频帧占 960 刻（tick），帧 f 对应半开刻区间 [960f, 960(f+1))。
 *   条带 s 的第 i 行（从 0 起）对应半开区间
 *     [s.start + i*s.step, s.start + (i+1)*s.step)
 *   step 为正整数行宽（刻）。重叠刻上逐声道取编号 id 最小、且该行该声道有效的条带；
 *   小编号条带在该刻无效时，继续让给更大编号的有效条带。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    // 下面的显式赋值让 Node ESM 的 cjs-module-lexer 能识别具名导出
    // （运行时与上面的 module.exports = api 指向同一批函数）。
    module.exports.SAMPLE_RATE = api.SAMPLE_RATE;
    module.exports.TICKS_PER_FRAME = api.TICKS_PER_FRAME;
    module.exports.MAX_FRAMES = api.MAX_FRAMES;
    module.exports.MAX_STRIPS = api.MAX_STRIPS;
    module.exports.MAX_ROWS = api.MAX_ROWS;
    module.exports.roundHalfEven = api.roundHalfEven;
    module.exports.divRoundHalfEven = api.divRoundHalfEven;
    module.exports.clampInt16 = api.clampInt16;
    module.exports.analyzeChannel = api.analyzeChannel;
    module.exports.decodeChannel = api.decodeChannel;
    module.exports.parseDataset = api.parseDataset;
    module.exports.renderStrips = api.renderStrips;
    module.exports.inspectFrame = api.inspectFrame;
    module.exports.getGaps = api.getGaps;
    module.exports.pcmToFloatChannels = api.pcmToFloatChannels;
    module.exports.encodeWavPcm = api.encodeWavPcm;
    module.exports.gapsToCsv = api.gapsToCsv;
    module.exports.gapsToJson = api.gapsToJson;
  } else {
    root.OpticalStitcher = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ------------------------------------------------------------ 常量

  const SAMPLE_RATE = 48000;
  const TICKS_PER_FRAME = 960;
  const MAX_SECONDS = 60;
  const MAX_FRAMES = SAMPLE_RATE * MAX_SECONDS; // 2,880,000
  const MAX_STRIPS = 64;
  const MAX_ROWS = 300000;
  const MAX_PIXELS = 32;

  const INT16_MIN = -32768;
  const INT16_MAX = 32767;
  const MISSING = 0x7fffffff; // Int32Array 哨兵：该声道此行无效

  // ------------------------------------------------------------ 基础取整

  function isFiniteNumber(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  /**
   * 就近取整，正好半整数时取偶数（round half to even）。
   * 作用在 JS number（IEEE double）的实际值上，与 Python 内置 round(float) 对齐。
   */
  function roundHalfEven(x) {
    if (typeof x !== 'number') {
      if (x === null || x === undefined) return 0;
      x = Number(x);
    }
    if (!Number.isFinite(x)) {
      if (Number.isNaN(x)) return 0;
      return x > 0 ? Number.MAX_SAFE_INTEGER + 0 : -Number.MAX_SAFE_INTEGER;
    }
    if (Math.abs(x) >= 9007199254740992) return x; // >= 2^53，整数本身
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    // d === 0.5：0.5 在 double 中可精确表示，故这是真正的半档。
    return (f % 2 === 0) ? f : f + 1;
  }

  /** 整数 a / 正整数 b 的向下取整商（精确整数运算）。 */
  function floorDivInt(a, b) {
    let q = Math.trunc(a / b);
    if (a % b !== 0 && ((a < 0) !== (b < 0))) q -= 1;
    return q;
  }

  /**
   * 精确整数版「除以 den 后就近取整、半档取偶数」。
   * 帧混合用：num 为 Σ(样本*覆盖刻数)，den 固定 960。
   */
  function divRoundHalfEven(num, den) {
    if (den === undefined) den = TICKS_PER_FRAME;
    if (Number.isInteger(num) && Number.isInteger(den) && den > 0 &&
        Math.abs(num) <= Number.MAX_SAFE_INTEGER) {
      const q = floorDivInt(num, den);
      const r = num - q * den; // 0 <= r < den
      const twice = 2 * r;
      if (twice < den) return q;
      if (twice > den) return q + 1;
      return (q % 2 === 0) ? q : q + 1; // 正好半档
    }
    return roundHalfEven(num / den);
  }

  function clampInt16(v) {
    if (v <= INT16_MIN) return INT16_MIN;
    if (v >= INT16_MAX) return INT16_MAX;
    return v | 0;
  }

  // ------------------------------------------------------------ 声道解码

  /** 从数组或对象形态中取出 [dark, bright, pixels]，无法辨认返回 null。 */
  function extractChannel(raw) {
    if (raw === null || raw === undefined) return null;
    let dark, bright, values;
    if (Array.isArray(raw)) {
      dark = raw[0];
      bright = raw[1];
      if (Array.isArray(raw[2])) {
        values = raw[2];
      } else if (raw.length > 2) {
        // 兼容 [dark, bright, p0, p1, ...] 扁平形态
        values = raw.slice(2);
      } else {
        values = null;
      }
    } else if (typeof raw === 'object') {
      dark = firstDefined(raw.dark, raw.d, raw.darkRef, raw.black, raw.refDark);
      bright = firstDefined(raw.bright, raw.b, raw.brightRef, raw.white, raw.refBright);
      values = firstDefined(raw.values, raw.pixels, raw.px, raw.vals, raw.samples, raw.data);
    } else {
      return null;
    }
    return { dark, bright, values };
  }

  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined) return arguments[i];
    }
    return undefined;
  }

  /**
   * 详细解码一行中的一个声道。
   * 返回 { valid, reason, dark, bright, normalized, mean, unscaled, rounded, sample }。
   * 任一必要值缺失（null/undefined/非有限数）、没有亮度值、或 bright <= dark → 无效。
   */
  function analyzeChannel(raw) {
    const ex = extractChannel(raw);
    if (!ex) {
      return { valid: false, reason: 'missing', normalized: null, mean: null,
        unscaled: null, rounded: null, sample: null };
    }
    const { dark, bright, values } = ex;
    if (dark === null || dark === undefined || bright === null || bright === undefined ||
        !isFiniteNumber(dark) || !isFiniteNumber(bright)) {
      return { valid: false, reason: 'missing-reference', dark: dark ?? null,
        bright: bright ?? null, normalized: null, mean: null, unscaled: null,
        rounded: null, sample: null };
    }
    if (!(bright > dark)) {
      return { valid: false, reason: 'bright-not-greater-than-dark',
        dark, bright, normalized: null, mean: null, unscaled: null,
        rounded: null, sample: null };
    }
    if (!Array.isArray(values) || values.length === 0) {
      return { valid: false, reason: 'missing-values', dark, bright,
        normalized: null, mean: null, unscaled: null, rounded: null,
        sample: null };
    }
    const denom = bright - dark;
    const normalized = new Array(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const p = values[i];
      // 任何一个亮度值缺失 → 整个声道此行无效（题面：缺失就让该声道无效）
      if (p === null || p === undefined || !isFiniteNumber(p)) {
        return { valid: false, reason: 'missing-pixel', dark, bright,
          normalized: null, mean: null, unscaled: null, rounded: null,
          sample: null };
      }
      let x = (p - dark) / denom;
      if (x < 0) x = 0;
      else if (x > 1) x = 1;
      normalized[i] = x;
      sum += x;
    }
    const mean = sum / values.length;
    const unscaled = mean * 65536 - 32768;
    const rounded = roundHalfEven(unscaled);
    const sample = clampInt16(rounded);
    return { valid: true, reason: null, dark, bright, normalized, mean,
      unscaled, rounded, sample };
  }

  /** 只取解码后的 16 位整数样本；无效返回 null。 */
  function decodeChannel(raw) {
    const a = analyzeChannel(raw);
    return a.valid ? a.sample : null;
  }

  // ------------------------------------------------------------ 数据集解析

  function pickField(obj, names) {
    for (const n of names) {
      if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    }
    return undefined;
  }

  /**
   * 解析 JSON 对象（或 JSON 文本）为内部结构，并把每行左右声道解码成 Int32Array。
   * 不做截断；超出题面上限时在 warnings 中提示。
   */
  function parseDataset(input) {
    let data = input;
    if (typeof input === 'string') data = JSON.parse(input);
    if (data === null || typeof data !== 'object') {
      throw new Error('数据不是有效的 JSON 对象');
    }
    const rawStrips = Array.isArray(data) ? data
      : (data.strips || data.tracks || data.stripes);
    if (!Array.isArray(rawStrips)) {
      throw new Error('找不到 strips 数组');
    }

    const warnings = [];
    if (rawStrips.length > MAX_STRIPS) {
      warnings.push(`条带数 ${rawStrips.length} 超过约定上限 ${MAX_STRIPS}`);
    }

    const strips = [];
    let totalRows = 0;
    rawStrips.forEach((rs, fileIndex) => {
      if (rs === null || typeof rs !== 'object') {
        warnings.push(`第 ${fileIndex + 1} 个条带不是对象，已忽略`);
        return;
      }
      const idRaw = pickField(rs, ['id', 'index', 'no', 'number']);
      const id = (idRaw === undefined) ? fileIndex + 1 : Number(idRaw);
      const start = Number(pickField(rs, ['start', 'offset', 'startTick', 't0']) ?? 0);
      const step = Number(pickField(rs, ['step', 'width', 'rowWidth', 'w']) ??
        pickField(rs, ['rowWidthTicks']));
      const rows = rs.rows || rs.scanRows || rs.data;
      if (!Number.isInteger(start)) {
        throw new Error(`条带 ${id} 的 start 必须是整数刻`);
      }
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`条带 ${id} 的行宽 step 必须是正整数（刻）`);
      }
      if (!Array.isArray(rows)) {
        throw new Error(`条带 ${id} 缺少 rows 数组`);
      }
      totalRows += rows.length;
      const n = rows.length;
      const samplesL = new Int32Array(n);
      const samplesR = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const row = rows[i];
        let lRaw, rRaw;
        if (Array.isArray(row)) {
          lRaw = row[0];
          rRaw = row[1];
        } else if (row && typeof row === 'object') {
          lRaw = firstDefined(row.left, row.l, row.L, row.ch0, row[0]);
          rRaw = firstDefined(row.right, row.r, row.R, row.ch1, row[1]);
        }
        const l = decodeChannel(lRaw);
        const r = decodeChannel(rRaw);
        samplesL[i] = (l === null) ? MISSING : l;
        samplesR[i] = (r === null) ? MISSING : r;
      }
      strips.push({
        id: Number.isFinite(id) ? id : fileIndex + 1,
        fileIndex,
        start,
        step,
        rowCount: n,
        end: start + n * step,
        samplesL,
        samplesR,
      });
    });

    if (totalRows > MAX_ROWS) {
      warnings.push(`总行数 ${totalRows} 超过约定上限 ${MAX_ROWS}`);
    }

    // 编号最小优先；同编号保持文件顺序，保证确定性。
    strips.sort((a, b) => (a.id - b.id) || (a.fileIndex - b.fileIndex));

    let frameCount;
    const rawFrames = pickField(data, ['frames', 'frameCount', 'frame_count', 'outputFrames']);
    const nFrames = Number(rawFrames);
    if (rawFrames !== undefined && Number.isInteger(nFrames) && nFrames > 0) {
      frameCount = nFrames;
    } else {
      let maxEnd = TICKS_PER_FRAME;
      for (const s of strips) if (s.end > maxEnd) maxEnd = s.end;
      frameCount = Math.max(1, Math.ceil(maxEnd / TICKS_PER_FRAME));
      warnings.push(`未提供 frames，按最大覆盖末端推导为 ${frameCount} 帧`);
    }
    let capped = false;
    if (frameCount > MAX_FRAMES) {
      frameCount = MAX_FRAMES;
      capped = true;
      warnings.push(`帧数超过 ${MAX_FRAMES}（60 秒），已截断到 60 秒`);
    }

    return {
      sampleRate: SAMPLE_RATE,
      ticksPerFrame: TICKS_PER_FRAME,
      frameCount,
      totalRows,
      strips,
      warnings,
      capped,
      sourceName: typeof input === 'object' && input && input.__name ? input.__name : null,
    };
  }

  // ------------------------------------------------------------ 主渲染

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /**
   * 把 JSON 数据渲染为 PCM、覆盖刻数、缺口和逐帧来源索引。
   * 返回 RenderResult（结构见文件末尾导出的 JSDoc）。
   */
  function renderStrips(input, options) {
    const tStart = nowMs();
    const parsed = parseDataset(input);
    const strips = parsed.strips;
    const TPF = TICKS_PER_FRAME;
    const F = parsed.frameCount;
    const T = F * TPF;
    options = options || {};

    // 1) 收集所有行边界作为压缩坐标（几何左右共用）。
    const coordSet = new Set();
    coordSet.add(0);
    coordSet.add(T);
    for (const s of strips) {
      coordSet.add(s.start);
      for (let i = 0; i <= s.rowCount; i++) {
        coordSet.add(s.start + i * s.step);
      }
    }
    const coords = Array.from(coordSet)
      .filter(isFiniteNumber)
      .sort((a, b) => a - b);

    const segCount = Math.max(0, coords.length - 1);
    const segStripL = new Int32Array(segCount).fill(-1);
    const segRowL = new Int32Array(segCount).fill(-1);
    const segValL = new Int16Array(segCount);
    const segStripR = new Int32Array(segCount).fill(-1);
    const segRowR = new Int32Array(segCount).fill(-1);
    const segValR = new Int16Array(segCount);

    const sumL = new Int32Array(F);
    const sumR = new Int32Array(F);
    const covL = new Uint16Array(F);
    const covR = new Uint16Array(F);

    // 扁平缺口坐标对 [s0,e0,s1,e1,...]，全局刻坐标，已裁到 [0,T)。
    const gapFlatL = [];
    const gapFlatR = [];

    // 2) 每个压缩段内，每条条带的活动行恒定；按编号顺序选首个有效声道。
    for (let j = 0; j < segCount; j++) {
      const a = coords[j];
      const b = coords[j + 1];

      let idL = -1, rowL = -1, valL = 0;
      let idR = -1, rowR = -1, valR = 0;

      for (let k = 0; k < strips.length; k++) {
        const s = strips[k];
        if (idL !== -1 && idR !== -1) break;
        if (a < s.start || a >= s.end) continue;
        const ri = Math.floor((a - s.start) / s.step);
        if (ri < 0 || ri >= s.rowCount) continue;

        if (idL === -1) {
          const v = s.samplesL[ri];
          if (v !== MISSING) { idL = s.id; rowL = ri; valL = v; }
        }
        if (idR === -1) {
          const v = s.samplesR[ri];
          if (v !== MISSING) { idR = s.id; rowR = ri; valR = v; }
        }
      }

      segStripL[j] = idL; segRowL[j] = rowL; segValL[j] = valL;
      segStripR[j] = idR; segRowR[j] = rowR; segValR[j] = valR;

      const lo = a < 0 ? 0 : a;
      const hi = b > T ? T : b;
      if (lo < hi) {
        if (idL !== -1) accumulate(sumL, covL, lo, hi, valL, TPF);
        else pushGap(gapFlatL, lo, hi);
        if (idR !== -1) accumulate(sumR, covR, lo, hi, valR, TPF);
        else pushGap(gapFlatR, lo, hi);
      }
    }

    // 3) 精确整数加权除 960 → 半档取偶 → int16，交错布局 L,R,L,R...
    const pcm = new Int16Array(F * 2);
    for (let f = 0; f < F; f++) {
      pcm[2 * f] = clampInt16(divRoundHalfEven(sumL[f], TPF));
      pcm[2 * f + 1] = clampInt16(divRoundHalfEven(sumR[f], TPF));
    }

    const renderMs = nowMs() - tStart;

    const result = {
      sampleRate: SAMPLE_RATE,
      ticksPerFrame: TPF,
      frameCount: F,
      totalTicks: T,
      pcm,
      coverage: { left: covL, right: covR },
      numerators: { left: sumL, right: sumR },
      gapTicks: { left: gapFlatL, right: gapFlatR },
      gapCount: { left: gapFlatL.length / 2, right: gapFlatR.length / 2 },
      coords,
      segments: {
        stripL: segStripL, rowL: segRowL, valueL: segValL,
        stripR: segStripR, rowR: segRowR, valueR: segValR,
      },
      strips: parsed.strips.map((s) => ({
        id: s.id, start: s.start, step: s.step,
        rowCount: s.rowCount, end: s.end,
      })),
      warnings: parsed.warnings,
      stats: {
        stripCount: strips.length,
        totalRows: parsed.totalRows,
        coordinateCount: coords.length,
        segmentCount: segCount,
        frameCount: F,
        renderMs,
      },
    };

    result.inspectFrame = function (frameIndex) {
      return inspectFrame(result, frameIndex);
    };
    result.getGaps = function (channel) {
      return getGaps(result, channel);
    };
    result.pcmSlice = function (startFrame, endFrame) {
      const a = Math.max(0, startFrame | 0);
      const b = Math.min(F, endFrame === undefined ? F : (endFrame | 0));
      if (b <= a) return new Int16Array(0);
      return pcm.slice(2 * a, 2 * b);
    };
    result.toFloatChannels = function (startFrame, endFrame) {
      return pcmToFloatChannels(pcm, F, startFrame, endFrame);
    };

    return result;
  }

  /** 把常量样本 v 按 [lo,hi) 与各帧的实际相交刻数累加进 sum/cov。 */
  function accumulate(sum, cov, lo, hi, v, tpf) {
    let x = lo;
    while (x < hi) {
      const f = Math.floor(x / tpf); // x >= 0
      const frameEnd = (f + 1) * tpf;
      const xEnd = hi < frameEnd ? hi : frameEnd;
      const w = xEnd - x;
      sum[f] += v * w;
      cov[f] += w;
      x = xEnd;
    }
  }

  function pushGap(flat, lo, hi) {
    if (lo >= hi) return;
    const n = flat.length;
    if (n >= 2 && flat[n - 1] === lo) flat[n - 1] = hi;
    else flat.push(lo, hi);
  }

  // ------------------------------------------------------------ 帧来源查询

  // 第一个满足 coords[i] >= x 的下标。
  function lowerBound(coords, x) {
    let lo = 0, hi = coords.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (coords[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 第一个满足 coords[i] > x 的下标。
  function upperBound(coords, x) {
    let lo = 0, hi = coords.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (coords[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function inspectChannel(result, frameIndex, side) {
    const { coords, segments, ticksPerFrame: tpf } = result;
    const A = frameIndex * tpf;
    const B = A + tpf;
    const isL = side === 'left';
    const segStrip = isL ? segments.stripL : segments.stripR;
    const segRow = isL ? segments.rowL : segments.rowR;
    const segVal = isL ? segments.valueL : segments.valueR;
    const covArr = isL ? result.coverage.left : result.coverage.right;

    // 最后一个 coords[j] <= A；段 j = [coords[j], coords[j+1]) 包含 A。
    let j = upperBound(coords, A) - 1;
    if (j < 0) j = 0;

    const runs = [];
    const stripTicks = new Map();
    while (j < coords.length - 1 && coords[j] < B) {
      const sa = coords[j];
      const sb = coords[j + 1];
      const stripId = segStrip[j];
      if (stripId !== -1 && sb > A && sa < B) {
        const startTick = sa > A ? sa : A;
        const endTick = sb < B ? sb : B;
        const ticks = endTick - startTick;
        const rowIndex = segRow[j];
        const value = segVal[j];
        const last = runs[runs.length - 1];
        // 合并同条带同行（可能仅因其他条带边界被切开）的相邻段。
        if (last && last.stripId === stripId && last.rowIndex === rowIndex &&
            last.endTick === startTick) {
          last.endTick = endTick;
          last.ticks += ticks;
        } else {
          runs.push({ startTick, endTick, ticks, stripId, rowIndex, value });
        }
        stripTicks.set(stripId, (stripTicks.get(stripId) || 0) + ticks);
      }
      j++;
    }

    const sources = Array.from(stripTicks.entries())
      .map(([stripId, ticks]) => ({ stripId: Number(stripId), ticks }))
      .sort((a, b) => a.stripId - b.stripId);

    return {
      coverageTicks: covArr[frameIndex],
      sources,
      runs,
    };
  }

  function inspectFrame(result, frameIndex) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 ||
        frameIndex >= result.frameCount) {
      throw new RangeError(`帧号必须是 [0, ${result.frameCount - 1}] 内的整数`);
    }
    const tpf = result.ticksPerFrame;
    const left = inspectChannel(result, frameIndex, 'left');
    const right = inspectChannel(result, frameIndex, 'right');
    return {
      frame: frameIndex,
      tickStart: frameIndex * tpf,
      tickEnd: (frameIndex + 1) * tpf,
      timeSeconds: frameIndex / result.sampleRate,
      sample: {
        left: result.pcm[2 * frameIndex],
        right: result.pcm[2 * frameIndex + 1],
      },
      numerator: {
        left: result.numerators.left[frameIndex],
        right: result.numerators.right[frameIndex],
      },
      coverage: {
        left: result.coverage.left[frameIndex],
        right: result.coverage.right[frameIndex],
      },
      left,
      right,
    };
  }

  /** 取某声道缺口的 [[start,end], ...] 数组（半开、全局刻坐标）。 */
  function getGaps(result, channel) {
    const flat = channel === 'left' || channel === 0
      ? result.gapTicks.left
      : result.gapTicks.right;
    const out = new Array(flat.length / 2);
    for (let i = 0, k = 0; i < flat.length; i += 2, k++) {
      out[k] = [flat[i], flat[i + 1]];
    }
    return out;
  }

  // ------------------------------------------------------------ 音频缓冲

  /** int16 交错 PCM → 两个 Float32 声道（除以 32768，与 WAV/浏览器惯例一致）。 */
  function pcmToFloatChannels(pcm, totalFrames, startFrame, endFrame) {
    const F = totalFrames || (pcm.length >> 1);
    const a = startFrame ? Math.max(0, startFrame | 0) : 0;
    const b = (endFrame === undefined) ? F : Math.min(F, endFrame | 0);
    const n = Math.max(0, b - a);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = pcm[2 * (a + i)] / 32768;
      right[i] = pcm[2 * (a + i) + 1] / 32768;
    }
    return { left, right, sampleRate: SAMPLE_RATE, startFrame: a, endFrame: b };
  }

  // ------------------------------------------------------------ WAV 编码

  /**
   * 把交错 int16 PCM 编码成标准 44 字节头的 16 位 PCM WAV。
   * pcm 可以是整个 result.pcm，也可以是其帧切片 subarray(2a,2b)。
   */
  function encodeWavPcm(pcm, options) {
    options = options || {};
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    const channels = options.channels || 2;
    const bitsPerSample = 16;
    const frameCount = options.frames !== undefined
      ? options.frames
      : Math.floor(pcm.length / channels);
    const dataBytes = frameCount * channels * (bitsPerSample / 8);
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    writeAscii(dv, 0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeAscii(dv, 8, 'WAVE');
    writeAscii(dv, 12, 'fmt ');
    dv.setUint32(16, 16, true); // PCM fmt chunk size
    dv.setUint16(20, 1, true);  // PCM format
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * bitsPerSample / 8, true); // byte rate
    dv.setUint16(32, channels * bitsPerSample / 8, true); // block align
    dv.setUint16(34, bitsPerSample, true);
    writeAscii(dv, 36, 'data');
    dv.setUint32(40, dataBytes, true);

    let o = 44;
    const n = Math.min(pcm.length, frameCount * channels);
    for (let i = 0; i < n; i++) {
      dv.setInt16(o, pcm[i], true);
      o += 2;
    }
    return u8;
  }

  function writeAscii(dv, offset, text) {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
  }

  // ------------------------------------------------------------ 缺口 CSV/JSON

  function formatSeconds(tick) {
    // 48000 帧/秒 × 960 刻/帧 = 46,080,000 刻/秒
    return (tick / (SAMPLE_RATE * TICKS_PER_FRAME)).toFixed(12);
  }

  function gapRowCsv(chLabel, chIndex, s, e) {
    const tpf = TICKS_PER_FRAME;
    const sf = Math.floor(s / tpf);
    const so = s - sf * tpf;
    const ef = Math.floor(e / tpf);
    const eo = e - ef * tpf;
    return [
      chLabel, chIndex, s, e, e - s,
      sf, so, ef, eo,
      formatSeconds(s), formatSeconds(e),
    ].join(',');
  }

  const GAP_CSV_HEADER = [
    'channel', 'channel_index',
    'start_tick', 'end_tick', 'tick_count',
    'start_frame', 'start_tick_in_frame',
    'end_frame', 'end_tick_in_frame',
    'start_seconds', 'end_seconds',
  ].join(',');

  /** 缺口表 CSV。channel: 'left' | 'right' | 'both'（默认 both，先左后右）。 */
  function gapsToCsv(result, channel) {
    const parts = [GAP_CSV_HEADER];
    const wantL = !channel || channel === 'both' || channel === 'left' || channel === 0;
    const wantR = !channel || channel === 'both' || channel === 'right' || channel === 1;
    if (wantL) {
      const flat = result.gapTicks.left;
      for (let i = 0; i < flat.length; i += 2) {
        parts.push(gapRowCsv('left', 0, flat[i], flat[i + 1]));
      }
    }
    if (wantR) {
      const flat = result.gapTicks.right;
      for (let i = 0; i < flat.length; i += 2) {
        parts.push(gapRowCsv('right', 1, flat[i], flat[i + 1]));
      }
    }
    return parts.join('\n') + '\n';
  }

  /** 结构化缺口对象（可 JSON 序列化）。 */
  function gapsToJson(result) {
    const conv = (flat) => {
      const arr = [];
      for (let i = 0; i < flat.length; i += 2) {
        const s = flat[i], e = flat[i + 1];
        arr.push({
          start_tick: s, end_tick: e, tick_count: e - s,
          start_frame: Math.floor(s / TICKS_PER_FRAME),
          end_frame: Math.floor(e / TICKS_PER_FRAME),
        });
      }
      return arr;
    };
    return {
      sample_rate: SAMPLE_RATE,
      ticks_per_frame: TICKS_PER_FRAME,
      frame_count: result.frameCount,
      left: conv(result.gapTicks.left),
      right: conv(result.gapTicks.right),
    };
  }

  // ------------------------------------------------------------ 导出

  return {
    // 常量
    SAMPLE_RATE,
    TICKS_PER_FRAME,
    MAX_SECONDS,
    MAX_FRAMES,
    MAX_STRIPS,
    MAX_ROWS,
    MAX_PIXELS,
    INT16_MIN,
    INT16_MAX,
    // 取整 / 数值
    roundHalfEven,
    divRoundHalfEven,
    floorDivInt,
    clampInt16,
    // 解码
    extractChannel,
    analyzeChannel,
    decodeChannel,
    // 数据 / 渲染
    parseDataset,
    renderStrips,
    inspectFrame,
    getGaps,
    lowerBound,
    upperBound,
    // 音频 / 导出
    pcmToFloatChannels,
    encodeWavPcm,
    gapsToCsv,
    gapsToJson,
  };
});
