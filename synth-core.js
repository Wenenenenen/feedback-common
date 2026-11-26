'use strict';

/*
 * anchored-partial-synth core.
 *
 * This file is dependency-free and works in browsers (window.AnchoredPartialSynth)
 * and Node.js (require('./synth-core.js')).  It contains the exact integer turn
 * solver, frequency extrema, PCM16 rounding/clipping and WAV encoding.
 */
(function factory(root, moduleFactory) {
  const api = moduleFactory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof root === 'object' && root !== null) {
    root.AnchoredPartialSynth = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApi() {
  const SAMPLE_RATE = 48000;
  const CHANNELS = 2;
  const BITS_PER_SAMPLE = 16;
  const MAX_SECONDS = 30;
  const MAX_FRAMES = SAMPLE_RATE * MAX_SECONDS; // 1,440,000
  const MAX_TRACKS = 128;
  const MAX_ANCHORS = 60000;
  const PHASE_STEPS = 65536;
  const AMP_MAX = 32767;
  const FREQ_MIN_MHZ = 20000;
  const FREQ_MAX_MHZ = 20000000;
  const TWO_PI = Math.PI * 2;

  class SynthDataError extends Error {
    constructor(message, issues) {
      super(message);
      this.name = 'SynthDataError';
      this.issues = issues || [];
    }
  }

  class SegmentInfeasibleError extends Error {
    constructor(issue) {
      super(issue.message);
      this.name = 'SegmentInfeasibleError';
      this.issue = issue;
      this.issues = [issue];
      this.trackId = issue.trackId;
      this.segmentIndex = issue.segmentIndex;
      this.segmentNumber = issue.segmentIndex + 1;
    }
  }

  function isInteger(value) {
    return typeof value === 'number' && Number.isInteger(value);
  }

  function anchorFrom(input, path) {
    let x, p, f, aL, aR;
    if (Array.isArray(input)) {
      [x, p, f, aL, aR] = input;
    } else if (input && typeof input === 'object') {
      x = input.x ?? input.frame ?? input[0];
      p = input.p ?? input.phase ?? input.phaseRemainder ?? input[1];
      f = input.f ?? input.fMilliHz ?? input.freqMilliHz ?? input.frequencyMilliHz ?? input[2];
      aL = input.aL ?? input.left ?? input.ampL ?? input[3];
      aR = input.aR ?? input.right ?? input.ampR ?? input[4];
    }
    const errors = [];
    if (!isInteger(x) || x < 0 || x > MAX_FRAMES) errors.push(`${path}.x 必须是 0..${MAX_FRAMES} 的整数帧号`);
    if (!isInteger(p) || p < 0 || p > 65535) errors.push(`${path}.p 必须是 0..65535 的整数相位余数`);
    if (!isInteger(f)) errors.push(`${path}.f 必须是整数毫赫兹`);
    if (!isInteger(aL) || aL < 0 || aL > AMP_MAX) errors.push(`${path}.aL 必须是 0..${AMP_MAX} 的整数`);
    if (!isInteger(aR) || aR < 0 || aR > AMP_MAX) errors.push(`${path}.aR 必须是 0..${AMP_MAX} 的整数`);
    if (errors.length) throw new SynthDataError(`锚点数据无效：${path}：${errors.join('；')}`, errors);
    return { x, p, f, aL, aR };
  }

  /*
   * Normalize and structurally validate a project.  Segment turn solving is a
   * separate step because callers may want to retain a previously compiled mix
   * when only the musical constraints fail.
   */
  function normalizeProject(input) {
    if (input == null) throw new SynthDataError('请选择或导入 anchored-partials.json 工程');
    const rawTracks = Array.isArray(input) ? input : input.tracks;
    if (!Array.isArray(rawTracks)) {
      throw new SynthDataError('JSON 顶层必须包含 tracks 数组（或本身为轨道数组）');
    }
    if (rawTracks.length > MAX_TRACKS) {
      throw new SynthDataError(`轨道数 ${rawTracks.length} 超过上限 ${MAX_TRACKS}`);
    }

    const ids = new Set();
    let totalAnchors = 0;
    let duration = 0;
    const tracks = rawTracks.map((rawTrack, ti) => {
      if (!rawTrack || typeof rawTrack !== 'object') {
        throw new SynthDataError(`第 ${ti + 1} 轨不是对象`);
      }
      let id = rawTrack.id ?? rawTrack.name ?? `T${ti + 1}`;
      if (typeof id === 'number') id = String(id);
      if (typeof id !== 'string' || id.length === 0) id = `T${ti + 1}`;
      if (ids.has(id)) throw new SynthDataError(`轨道 id 重复：${id}`);
      ids.add(id);

      const rawAnchors = rawTrack.anchors;
      if (!Array.isArray(rawAnchors)) throw new SynthDataError(`轨 ${id} 缺少 anchors 数组`);
      if (rawAnchors.length < 2) throw new SynthDataError(`轨 ${id} 至少需要两个锚点`);
      totalAnchors += rawAnchors.length;
      if (totalAnchors > MAX_ANCHORS) {
        throw new SynthDataError(`锚点总数超过上限 ${MAX_ANCHORS}`);
      }

      const anchors = rawAnchors.map((a, ai) => anchorFrom(a, `tracks[${ti}].anchors[${ai}]`));
      for (let i = 1; i < anchors.length; i += 1) {
        if (anchors[i].x <= anchors[i - 1].x) {
          throw new SynthDataError(`轨 ${id} 的锚点必须严格升序：第 ${i} 与第 ${i + 1} 个锚点帧号未递增`);
        }
      }
      duration = Math.max(duration, anchors[anchors.length - 1].x);
      return { id, anchors };
    });

    if (totalAnchors > MAX_ANCHORS) {
      throw new SynthDataError(`锚点总数 ${totalAnchors} 超过上限 ${MAX_ANCHORS}`);
    }
    if (duration > MAX_FRAMES) {
      throw new SynthDataError(`工程时长 ${(duration / SAMPLE_RATE).toFixed(3)}s 超过 ${MAX_SECONDS}s / ${MAX_FRAMES} 帧`);
    }
    return { sampleRate: SAMPLE_RATE, channels: CHANNELS, duration, tracks };
  }

  function floorDivBig(value, denominator) {
    const q = value / denominator;
    const r = value % denominator;
    if (r !== 0n && value < 0n) return q - 1n;
    return q;
  }

  /*
   * Exact scaled frequency polynomial.
   *
   * For h=x1-x0 and q=p1-p0+65536*k, instantaneous frequency in milli-Hz is
   *
   *   F(u) = (C0 + C1 u + C2 u^2) / (32 h),
   *
   * with integer C0/C1/C2.  This lets boundary checks use BigInt rather than
   * an epsilon that could reject mathematically exact 20/20000 Hz cases.
   */
  function frequencyPolynomial(segment, k) {
    const h = BigInt(segment.h);
    const f0 = BigInt(segment.a0.f);
    const f1 = BigInt(segment.a1.f);
    const q = BigInt(segment.a1.p - segment.a0.p + PHASE_STEPS * k);
    const C0 = 32n * h * f0;
    const C1 = 140625n * q - 32n * h * BigInt(4 * segment.a0.f + 2 * segment.a1.f);
    const C2 = -140625n * q + 96n * h * BigInt(segment.a0.f + segment.a1.f);
    return { h, q, C0, C1, C2 };
  }

  function endpointsInRange(segment) {
    const f0 = segment.a0.f;
    const f1 = segment.a1.f;
    return f0 >= FREQ_MIN_MHZ && f0 <= FREQ_MAX_MHZ &&
      f1 >= FREQ_MIN_MHZ && f1 <= FREQ_MAX_MHZ;
  }

  function lowerFrequencyOK(segment, k) {
    if (!endpointsInRange(segment)) return false;
    const { h, C0, C1, C2 } = frequencyPolynomial(segment, k);
    if (C2 > 0n && C1 <= 0n && C1 + 2n * C2 >= 0n) {
      const bound = BigInt(FREQ_MIN_MHZ);
      return 4n * C2 * (C0 - 32n * h * bound) - C1 * C1 >= 0n;
    }
    return true;
  }

  function upperFrequencyOK(segment, k) {
    if (!endpointsInRange(segment)) return false;
    const { h, C0, C1, C2 } = frequencyPolynomial(segment, k);
    if (C2 < 0n && C1 >= 0n && C1 + 2n * C2 <= 0n) {
      const bound = BigInt(FREQ_MAX_MHZ);
      return 4n * C2 * (C0 - 32n * h * bound) - C1 * C1 >= 0n;
    }
    return true;
  }

  function approximateKBounds(segment) {
    const { h, a0, a1 } = segment;
    const f0 = a0.f;
    const f1 = a1.f;
    const d = a1.p - a0.p;
    const lowShrink = Math.sqrt(Math.max(0, (f0 - FREQ_MIN_MHZ) * (f1 - FREQ_MIN_MHZ)));
    const highShrink = Math.sqrt(Math.max(0, (FREQ_MAX_MHZ - f0) * (FREQ_MAX_MHZ - f1)));
    const slope = 144000000 / h; // milli-Hz per integer turn k
    const intercept = (140625 * d) / (64 * h) - f0 - f1;
    return {
      low: (FREQ_MIN_MHZ - lowShrink - intercept) / slope,
      high: (FREQ_MAX_MHZ + highShrink - intercept) / slope,
    };
  }

  function findMinimumK(segment, approximateLow) {
    let k = Math.ceil(approximateLow) - 2;
    let guard = 0;
    while (!lowerFrequencyOK(segment, k)) {
      k += 1;
      if (++guard > 2000000) throw new Error('lower k search failed');
    }
    guard = 0;
    while (lowerFrequencyOK(segment, k - 1)) {
      k -= 1;
      if (++guard > 2000000) throw new Error('lower k adjustment failed');
    }
    return k;
  }

  function findMaximumK(segment, approximateHigh) {
    let k = Math.floor(approximateHigh) + 2;
    let guard = 0;
    while (!upperFrequencyOK(segment, k)) {
      k -= 1;
      if (++guard > 2000000) throw new Error('upper k search failed');
    }
    guard = 0;
    while (upperFrequencyOK(segment, k + 1)) {
      k += 1;
      if (++guard > 2000000) throw new Error('upper k adjustment failed');
    }
    return k;
  }

  function frequencyExtrema(segment, k) {
    const { h, C0, C1, C2 } = frequencyPolynomial(segment, k);
    const values = [segment.a0.f, segment.a1.f];
    let vertexMhz = null;
    if (C2 !== 0n) {
      let numeratorU = -C1;
      let denominatorU = 2n * C2;
      if (denominatorU < 0n) {
        numeratorU = -numeratorU;
        denominatorU = -denominatorU;
      }
      if (numeratorU >= 0n && numeratorU <= denominatorU) {
        let num = 4n * C2 * C0 - C1 * C1;
        let den = 128n * h * C2;
        if (den < 0n) {
          num = -num;
          den = -den;
        }
        vertexMhz = Number(num) / Number(den);
        values.push(vertexMhz);
      }
    }
    let minMhz = Infinity;
    let maxMhz = -Infinity;
    for (const value of values) {
      if (value < minMhz) minMhz = value;
      if (value > maxMhz) maxMhz = value;
    }
    return { minMhz, maxMhz, vertexMhz };
  }

  /*
   * Objective:
   *   |(p1/65536+k-p0/65536) - h(f0+f1)/96,000,000|
   * when frequencies are integer milli-Hz.
   *
   * The rational target is Knum / KDEN in units of k.  BigInt distances make
   * exact half-way ties choose the smaller integer.
   */
  const TARGET_DEN = 3072000000n;
  function targetKNumerator(segment) {
    return 32n * BigInt(segment.h) * BigInt(segment.a0.f + segment.a1.f) -
      46875n * BigInt(segment.a1.p - segment.a0.p);
  }

  function chooseK(segment, kMin, kMax) {
    const targetNum = targetKNumerator(segment);
    const minBig = BigInt(kMin);
    const maxBig = BigInt(kMax);
    if (targetNum <= minBig * TARGET_DEN) return kMin;
    if (targetNum >= maxBig * TARGET_DEN) return kMax;

    const floorK = Number(floorDivBig(targetNum, TARGET_DEN));
    const distance = (k) => {
      let z = BigInt(k) * TARGET_DEN - targetNum;
      if (z < 0n) z = -z;
      return z;
    };
    const d0 = distance(floorK);
    const d1 = distance(floorK + 1);
    return d0 <= d1 ? floorK : floorK + 1;
  }

  function solveSegment(trackId, index, a0, a1) {
    const segment = {
      trackId,
      index,
      x0: a0.x,
      x1: a1.x,
      h: a1.x - a0.x,
      a0,
      a1,
    };
    const base = {
      ...segment,
      segmentIndex: index,
      segmentNumber: index + 1,
    };
    if (!endpointsInRange(segment)) {
      const issue = {
        trackId,
        segmentIndex: index,
        segmentNumber: index + 1,
        x0: a0.x,
        x1: a1.x,
        code: 'endpoint-frequency-out-of-range',
        message: `轨 ${trackId} 段 #${index}（第 ${index + 1} 段，帧 ${a0.x}→${a1.x}）端点频率不在 20–20000 Hz，无可用整圈数`,
      };
      return { ...base, feasible: false, issue };
    }

    const approx = approximateKBounds(segment);
    const kMin = findMinimumK(segment, approx.low);
    const kMax = findMaximumK(segment, approx.high);
    if (kMin > kMax) {
      const issue = {
        trackId,
        segmentIndex: index,
        segmentNumber: index + 1,
        x0: a0.x,
        x1: a1.x,
        kMin,
        kMax,
        code: 'no-feasible-turn-count',
        message: `轨 ${trackId} 段 #${index}（第 ${index + 1} 段，帧 ${a0.x}→${a1.x}）无可用整圈数`,
      };
      return { ...base, feasible: false, kMin, kMax, issue };
    }

    const targetK = Number(targetKNumerator(segment)) / Number(TARGET_DEN);
    const k = chooseK(segment, kMin, kMax);
    const extrema = frequencyExtrema(segment, k);
    return {
      ...base,
      feasible: true,
      k,
      kMin,
      kMax,
      targetK,
      objectiveError: Math.abs((a1.p / PHASE_STEPS + k - a0.p / PHASE_STEPS) -
        segment.h * (a0.f + a1.f) / 96000000),
      ...extrema,
    };
  }

  function compileProject(input) {
    const project = normalizeProject(input);
    const issues = [];
    const tracks = project.tracks.map((track) => {
      const segments = [];
      for (let i = 0; i < track.anchors.length - 1; i += 1) {
        const solved = solveSegment(track.id, i, track.anchors[i], track.anchors[i + 1]);
        segments.push(solved);
        if (!solved.feasible) issues.push(solved.issue);
      }
      return { ...track, segments };
    });
    if (issues.length) {
      const error = new SegmentInfeasibleError(issues[0]);
      error.issues = issues;
      error.compiled = { ...project, tracks };
      throw error;
    }
    return { ...project, tracks };
  }

  function sinTurns(phase) {
    // Math.sin(2*pi/12) is one double ULP below 0.5 in V8/libm.  A project can
    // intentionally put an odd integer amplitude at that exact mathematical
    // half-way code boundary, so snap only cardinal rational phases to their
    // exact signed half/zero values.  The tolerance follows double magnitude.
    const fractional = phase - Math.floor(phase);
    const magnitude = phase < 0 ? -phase : phase;
    const tol = 1e-12 + 8 * Number.EPSILON * (magnitude > 1 ? magnitude : 1);
    if (Math.abs(fractional - 1 / 12) <= tol || Math.abs(fractional - 5 / 12) <= tol) return 0.5;
    if (Math.abs(fractional - 7 / 12) <= tol || Math.abs(fractional - 11 / 12) <= tol) return -0.5;
    if (fractional <= tol || fractional >= 1 - tol) return 0;
    if (Math.abs(fractional - 0.25) <= tol) return 1;
    if (Math.abs(fractional - 0.75) <= tol) return -1;
    return Math.sin(TWO_PI * phase);
  }

  /*
   * Add one compiled track's contribution to planar Float64 mixes.
   *
   * startFrame/endFrame are global project frame numbers.  The same arithmetic
   * and track order is used for full and ranged renders, so ranged PCM codes are
   * identical to the corresponding full-mix slice.
   */
  function renderTrackInto(left, right, compiledTrack, options = {}) {
    const totalFrames = left.length;
    const rangeStart = options.startFrame ?? 0;
    const rangeEnd = options.endFrame ?? rangeStart + totalFrames;
    if (rangeEnd - rangeStart !== totalFrames) {
      throw new Error('mix length must equal render frame count');
    }

    for (const segment of compiledTrack.segments) {
      const frameBegin = Math.max(segment.x0, rangeStart);
      const frameEnd = Math.min(segment.x1, rangeEnd);
      if (frameBegin >= frameEnd) continue;

      const { h, k, a0, a1 } = segment;
      const invH = 1 / h;
      const y0 = a0.p / PHASE_STEPS;
      const y1 = a1.p / PHASE_STEPS + k;
      const m0 = (h * a0.f) / 48000000;
      const m1 = (h * a1.f) / 48000000;

      const ampDL = a1.aL - a0.aL;
      const ampDR = a1.aR - a0.aR;

      for (let frame = frameBegin; frame < frameEnd; frame += 1) {
        const j = frame - segment.x0;
        const u = j * invH;
        // Evaluate the specification's cubic Hermite basis directly.  This is
        // also the same operation order used by the Python cross-reference.
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        const phase = h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1;
        const s = sinTurns(phase);
        const mixIndex = frame - rangeStart;
        left[mixIndex] += (a0.aL + ampDL * u) * s;
        right[mixIndex] += (a0.aR + ampDR * u) * s;
      }
    }
  }

  function createMix(frameCount) {
    return {
      left: new Float64Array(frameCount),
      right: new Float64Array(frameCount),
    };
  }

  function renderMix(compiledProject, options = {}) {
    const startFrame = options.startFrame ?? 0;
    const endFrame = options.endFrame ?? compiledProject.duration;
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) ||
      startFrame < 0 || endFrame < startFrame || endFrame > compiledProject.duration) {
      throw new Error(`非法帧区间 [${startFrame},${endFrame})`);
    }
    const audibleIds = options.audibleIds ? new Set(options.audibleIds.map(String)) : null;
    const frameCount = endFrame - startFrame;
    const { left, right } = createMix(frameCount);
    for (const track of compiledProject.tracks) {
      if (audibleIds && !audibleIds.has(String(track.id))) continue;
      renderTrackInto(left, right, track, { startFrame, endFrame });
    }
    return { left, right, startFrame, endFrame };
  }

  function roundHalfEven(x) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  function clampPcm16(x) {
    if (x < -32768) return -32768;
    if (x > 32767) return 32767;
    return x;
  }

  function finalizePcm16(mix) {
    const frameCount = mix.left.length;
    const pcm = new Int16Array(frameCount * 2);
    for (let i = 0; i < frameCount; i += 1) {
      const l = clampPcm16(roundHalfEven(mix.left[i]));
      const r = clampPcm16(roundHalfEven(mix.right[i]));
      pcm[i * 2] = l;
      pcm[i * 2 + 1] = r;
    }
    return pcm;
  }

  function renderPcm16(compiledProject, options = {}) {
    const mix = renderMix(compiledProject, options);
    return finalizePcm16(mix);
  }

  function encodeWav(pcm, sampleRate = SAMPLE_RATE, channels = CHANNELS) {
    if (!(pcm instanceof Int16Array)) {
      throw new Error('encodeWav expects an interleaved Int16Array');
    }
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcm.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeAscii(offset, text) {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    }

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < pcm.length; i += 1, offset += 2) {
      view.setInt16(offset, pcm[i], true);
    }
    return new Uint8Array(buffer);
  }

  function decodeWavPcm16(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 44) throw new Error('WAV too short');
    const sampleRate = view.getUint32(24, true);
    const channels = view.getUint16(22, true);
    const dataSize = view.getUint32(40, true);
    const samples = new Int16Array(dataSize / 2);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1, offset += 2) {
      samples[i] = view.getInt16(offset, true);
    }
    return { sampleRate, channels, samples };
  }

  function renderWav(project, options = {}) {
    const compiled = options.__compiled || compileProject(project);
    const startFrame = options.startFrame ?? 0;
    const endFrame = options.endFrame ?? compiled.duration;
    const pcm = options.pcm || renderPcm16(compiled, {
      ...options,
      startFrame,
      endFrame,
    });
    return encodeWav(pcm, options.sampleRate || SAMPLE_RATE, CHANNELS);
  }

  function generateQuotaProject(options = {}) {
    const trackCount = options.trackCount ?? MAX_TRACKS;
    const anchorCount = options.anchorCount ?? MAX_ANCHORS;
    const duration = options.duration ?? MAX_FRAMES;
    const perTrack = Math.floor(anchorCount / trackCount);
    const extra = anchorCount - perTrack * trackCount;
    const tracks = [];
    let used = 0;
    for (let ti = 0; ti < trackCount; ti += 1) {
      const count = perTrack + (ti < extra ? 1 : 0);
      used += count;
      const anchors = [];
      const baseFreq = 220000 + (ti % 48) * 13750; // milli-Hz, stays musical and in range
      for (let ai = 0; ai < count; ai += 1) {
        const x = ai === count - 1 ? duration : Math.round((ai * duration) / (count - 1));
        const f = baseFreq + Math.round(40000 * Math.sin(ai * 0.37 + ti * 0.11));
        const previousX = ai === 0 ? 0 : anchors[ai - 1][0];
        const idealQ = (x - previousX) * f / (48000000 / PHASE_STEPS);
        const p = ai === 0 ? (ti * 12345) % PHASE_STEPS : Math.round(idealQ) % PHASE_STEPS;
        anchors.push([
          x,
          ((p % PHASE_STEPS) + PHASE_STEPS) % PHASE_STEPS,
          f,
          9000 + (ti % 12) * 900,
          9000 + ((ti + 5) % 12) * 900,
        ]);
      }
      // Ensure strict ascending despite rounded x for very dense requested counts.
      for (let ai = 1; ai < anchors.length; ai += 1) {
        if (anchors[ai][0] <= anchors[ai - 1][0]) anchors[ai][0] = anchors[ai - 1][0] + 1;
      }
      if (anchors[anchors.length - 1][0] > duration) {
        // Requested count cannot fit in duration if this happens; quota defaults fit.
        const shift = anchors[anchors.length - 1][0] - duration;
        for (const a of anchors) a[0] = Math.max(0, a[0] - shift);
        for (let ai = 1; ai < anchors.length; ai += 1) {
          if (anchors[ai][0] <= anchors[ai - 1][0]) anchors[ai][0] = anchors[ai - 1][0] + 1;
        }
      }
      tracks.push({ id: `Q${String(ti + 1).padStart(3, '0')}`, anchors });
    }
    return { convention: 'generated quota project', tracks, _usedAnchors: used };
  }

  return {
    SAMPLE_RATE,
    CHANNELS,
    BITS_PER_SAMPLE,
    MAX_SECONDS,
    MAX_FRAMES,
    MAX_TRACKS,
    MAX_ANCHORS,
    PHASE_STEPS,
    AMP_MAX,
    FREQ_MIN_MHZ,
    FREQ_MAX_MHZ,
    SynthDataError,
    SegmentInfeasibleError,
    normalizeProject,
    compileProject,
    solveSegment,
    frequencyExtrema,
    frequencyPolynomial,
    lowerFrequencyOK,
    upperFrequencyOK,
    renderTrackInto,
    sinTurns,
    renderMix,
    finalizePcm16,
    renderPcm16,
    roundHalfEven,
    clampPcm16,
    encodeWav,
    decodeWavPcm16,
    renderWav,
    generateQuotaProject,
  };
});
