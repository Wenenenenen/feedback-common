// core.mjs — 时域历史重投影纯算法核心（无 DOM 依赖，可在 Node / Worker 中运行）
// 严格按 samples 包内 说明.txt 的约定实现，不调用任何现成 TAA 接口。

export const DEFAULTS = Object.freeze({ tau: 0.05, historyWeight: 0.9, cap: 8 });

// 参数范围（含端点）
export const PARAM_LIMITS = Object.freeze({
  tau: { min: 0, max: 0.5 },
  historyWeight: { min: 0, max: 0.99 },
  cap: { min: 1, max: 64 },
});

// 拒绝 / 接受原因枚举
export const Reason = Object.freeze({
  ACCEPTED: 0,                 // 有有效历史，完成混合
  FIRST_FRAME: 1,              // 第 0 帧
  DEPTH_NULL: 2,               // 当前像素深度为空
  NO_VALID_OUT_OF_BOUNDS: 3,   // 无有效历史：采样点全部越界
  NO_VALID_DEPTH_NULL: 4,      // 无有效历史：历史点深度为空
  NO_VALID_DEPTH_THRESHOLD: 5, // 无有效历史：深度差超阈值
});

// 逐采样点无效原因枚举（有效为 NONE）
export const SampleReason = Object.freeze({
  NONE: 0,
  OUT_OF_BOUNDS: 1,
  DEPTH_NULL: 2,
  DEPTH_THRESHOLD: 3,
});

export const REASON_META = [
  { id: Reason.ACCEPTED, key: 'accepted', label: '接受历史（混合）', color: [38, 166, 91] },
  { id: Reason.FIRST_FRAME, key: 'first-frame', label: '首帧', color: [120, 144, 156] },
  { id: Reason.DEPTH_NULL, key: 'depth-null', label: '当前深度为空', color: [45, 125, 235] },
  { id: Reason.NO_VALID_OUT_OF_BOUNDS, key: 'oob', label: '无有效历史·越界', color: [240, 160, 30] },
  { id: Reason.NO_VALID_DEPTH_NULL, key: 'hist-null', label: '无有效历史·历史深度空', color: [170, 90, 210] },
  { id: Reason.NO_VALID_DEPTH_THRESHOLD, key: 'depth-reject', label: '无有效历史·深度拒绝', color: [228, 72, 72] },
];

export function clampParams(p) {
  const tau = Math.min(PARAM_LIMITS.tau.max, Math.max(PARAM_LIMITS.tau.min, Number(p.tau)));
  const historyWeight = Math.min(PARAM_LIMITS.historyWeight.max,
    Math.max(PARAM_LIMITS.historyWeight.min, Number(p.historyWeight)));
  const cap = Math.min(PARAM_LIMITS.cap.max, Math.max(PARAM_LIMITS.cap.min, Math.round(Number(p.cap))));
  return { tau, historyWeight, cap };
}

// 结构校验：返回 { ok, errors:[...] }
export function validateSequence(seq) {
  const errors = [];
  if (typeof seq !== 'object' || seq === null) {
    return { ok: false, errors: ['文件内容不是 JSON 对象'] };
  }
  const { width, height, frames } = seq;
  if (!Number.isInteger(width) || width <= 0) errors.push('width 必须为正整数');
  if (!Number.isInteger(height) || height <= 0) errors.push('height 必须为正整数');
  if (!Array.isArray(frames) || frames.length === 0) {
    errors.push('frames 必须为非空数组');
    return { ok: false, errors, width, height, frames };
  }
  if (errors.length) return { ok: false, errors, width, height, frames };
  const n = width * height;
  frames.forEach((f, i) => {
    if (!Array.isArray(f.color) || f.color.length !== n) {
      errors.push(`第 ${i} 帧 color 长度应为 ${n}`);
    } else if (!Array.isArray(f.color[0]) || f.color[0].length !== 3) {
      errors.push(`第 ${i} 帧 color 必须为 RGB 三元组数组`);
    }
    if (!Array.isArray(f.depth) || f.depth.length !== n) {
      errors.push(`第 ${i} 帧 depth 长度应为 ${n}`);
    }
    if (!Array.isArray(f.motion) || f.motion.length !== n) {
      errors.push(`第 ${i} 帧 motion 长度应为 ${n}`);
    } else if (!Array.isArray(f.motion[0]) || f.motion[0].length !== 2) {
      errors.push(`第 ${i} 帧 motion 必须为 [dx,dy] 数组`);
    }
    if (!Array.isArray(f.jitter) || f.jitter.length !== 2) {
      errors.push(`第 ${i} 帧 jitter 必须为 [x,y]`);
    }
  });
  return { ok: errors.length === 0, errors, width, height, frames, pixelCount: n };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 单像素重投影调试计算（点击检视 / 像素追踪复用）
// prevColor: Float64Array(3N)，prevCount: Int32Array(N)，为上一帧累积结果
export function computePixelDebug(seq, fi, x, y, prevColor, prevCount, params) {
  const { width: w, height: h, frames } = seq;
  const { tau, historyWeight, cap } = params;
  const p = y * w + x;
  const frame = frames[fi];
  const cur = frame.color[p];
  const base = {
    frame: fi, x, y, currentColor: [cur[0], cur[1], cur[2]],
    depth: frame.depth[p], reason: Reason.ACCEPTED,
  };

  if (frame.depth[p] === null || frame.depth[p] === undefined) {
    return { ...base, reason: Reason.DEPTH_NULL, samples: [],
      outputColor: [cur[0], cur[1], cur[2]], count: 1,
      historyX: null, historyY: null };
  }
  if (fi === 0) {
    return { ...base, reason: Reason.FIRST_FRAME, samples: [],
      outputColor: [cur[0], cur[1], cur[2]], count: 1,
      historyX: null, historyY: null };
  }

  const prevFrame = frames[fi - 1];
  const [jx, jy] = frame.jitter;
  const [pjx, pjy] = prevFrame.jitter;
  // 历史位置 = 像素中心 + motion(当前→前帧，不含抖动) + 前帧 jitter − 当前 jitter
  const hx = (x + 0.5) + frame.motion[p][0] + pjx - jx;
  const hy = (y + 0.5) + frame.motion[p][1] + pjy - jy;

  // 以历史像素中心做双线性采样
  const x0 = Math.floor(hx - 0.5);
  const y0 = Math.floor(hy - 0.5);
  const fx = (hx - 0.5) - x0;
  const fy = (hy - 0.5) - y0;
  const corners = [
    { x: x0, y: y0, weight: (1 - fx) * (1 - fy) },
    { x: x0 + 1, y: y0, weight: fx * (1 - fy) },
    { x: x0, y: y0 + 1, weight: (1 - fx) * fy },
    { x: x0 + 1, y: y0 + 1, weight: fx * fy },
  ];

  const dCur = frame.depth[p];
  const depthLimit = tau * Math.max(1, dCur);
  const samples = corners.map((c) => {
    const s = { x: c.x, y: c.y, bilinearWeight: c.weight, valid: false,
      sampleReason: SampleReason.NONE, inside: false,
      prevColor: null, prevCount: null, prevDepth: null, normalizedWeight: 0 };
    if (c.x < 0 || c.x >= w || c.y < 0 || c.y >= h) {
      s.sampleReason = SampleReason.OUT_OF_BOUNDS;
      return s;
    }
    s.inside = true;
    const q = c.y * w + c.x;
    const dPrev = prevFrame.depth[q];
    s.prevDepth = dPrev;
    if (dPrev === null || dPrev === undefined) {
      s.sampleReason = SampleReason.DEPTH_NULL;
      return s;
    }
    if (Math.abs(dCur - dPrev) > depthLimit) {
      s.sampleReason = SampleReason.DEPTH_THRESHOLD;
      return s;
    }
    s.valid = true;
    s.sampleReason = SampleReason.NONE;
    s.prevColor = [prevColor[q * 3], prevColor[q * 3 + 1], prevColor[q * 3 + 2]];
    s.prevCount = prevCount[q];
    return s;
  });

  const validSamples = samples.filter((s) => s.valid);
  if (validSamples.length === 0) {
    let reason = Reason.NO_VALID_OUT_OF_BOUNDS;
    if (samples.some((s) => s.sampleReason === SampleReason.DEPTH_THRESHOLD)) {
      reason = Reason.NO_VALID_DEPTH_THRESHOLD;
    } else if (samples.some((s) => s.sampleReason === SampleReason.DEPTH_NULL)) {
      reason = Reason.NO_VALID_DEPTH_NULL;
    }
    return { ...base, reason, samples, historyX: hx, historyY: hy,
      outputColor: [cur[0], cur[1], cur[2]], count: 1 };
  }

  // 有效权重重新归一化；H、n 为有效点上一帧累积色 / 计数的加权值
  const wsum = validSamples.reduce((a, s) => a + s.bilinearWeight, 0);
  const inv = 1 / wsum;
  const H = [0, 0, 0];
  let n = 0;
  for (const s of validSamples) {
    s.normalizedWeight = s.bilinearWeight * inv;
    const q = s.y * w + s.x;
    for (let c = 0; c < 3; c++) H[c] += s.bilinearWeight * prevColor[q * 3 + c];
    n += s.bilinearWeight * prevCount[q];
  }
  for (let c = 0; c < 3; c++) H[c] *= inv;
  n *= inv;

  // 当前帧图内 3×3 邻域逐通道最小最大值限幅
  const nMin = [Infinity, Infinity, Infinity];
  const nMax = [-Infinity, -Infinity, -Infinity];
  for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
      const nc = frame.color[ny * w + nx];
      for (let c = 0; c < 3; c++) {
        if (nc[c] < nMin[c]) nMin[c] = nc[c];
        if (nc[c] > nMax[c]) nMax[c] = nc[c];
      }
    }
  }
  const Hclamped = [clamp(H[0], nMin[0], nMax[0]),
                    clamp(H[1], nMin[1], nMax[1]),
                    clamp(H[2], nMin[2], nMax[2])];

  const alpha = Math.min(historyWeight, n / (n + 1));
  const outputColor = [
    (1 - alpha) * cur[0] + alpha * Hclamped[0],
    (1 - alpha) * cur[1] + alpha * Hclamped[1],
    (1 - alpha) * cur[2] + alpha * Hclamped[2],
  ];
  const count = Math.min(cap, Math.floor(n + 1));

  return { ...base, reason: Reason.ACCEPTED, samples, historyX: hx, historyY: hy,
    H, Hclamped, neighborhoodMin: nMin, neighborhoodMax: nMax,
    n, alpha, outputColor, count };
}

// 计算整帧，写入调用方提供的 TypedArray（供逐帧递推 / 分批调度）
export function computeFrame(seq, fi, params, prevColor, prevCount, outColor, outCount, outReason) {
  const { width: w, height: h, pixelCount: n } = seq._meta;
  const frame = seq.frames[fi];
  if (fi === 0) {
    for (let p = 0; p < n; p++) {
      const c = frame.color[p];
      outColor[p * 3] = c[0];
      outColor[p * 3 + 1] = c[1];
      outColor[p * 3 + 2] = c[2];
      outCount[p] = 1;
      // 深度为空优先判定为 DEPTH_NULL（与 computePixelDebug 顺序一致）
      outReason[p] = (frame.depth[p] === null || frame.depth[p] === undefined)
        ? Reason.DEPTH_NULL : Reason.FIRST_FRAME;
    }
    return;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dbg = computePixelDebug(seq, fi, x, y, prevColor, prevCount, params);
      const p = y * w + x;
      outColor[p * 3] = dbg.outputColor[0];
      outColor[p * 3 + 1] = dbg.outputColor[1];
      outColor[p * 3 + 2] = dbg.outputColor[2];
      outCount[p] = dbg.count;
      outReason[p] = dbg.reason;
    }
  }
}

// 全量重投影（Node 测试 / 小序列便捷接口）。onFrame(frameIndex) 每帧完成后回调，可抛 CancelError 取消。
export class CancelError extends Error {}

export function reprojectSequence(seq, params, onFrame = null) {
  const meta = validateSequence(seq);
  if (!meta.ok) throw new Error(meta.errors.join('；'));
  const n = meta.pixelCount;
  seq._meta = meta;
  const F = seq.frames.length;
  let prevColor = new Float64Array(n * 3);
  let prevCount = new Int32Array(n);
  const results = [];
  for (let fi = 0; fi < F; fi++) {
    const color = new Float64Array(n * 3);
    const count = new Int32Array(n);
    const reason = new Uint8Array(n);
    computeFrame(seq, fi, params, prevColor, prevCount, color, count, reason);
    results.push({ frame: fi, color, count, reason });
    prevColor = color;
    prevCount = count;
    if (onFrame) onFrame(fi);
  }
  return { width: meta.width, height: meta.height, frames: results };
}

// 线性 RGB → sRGB 传递函数（输入先夹到 [0,1]）
export function linearToSrgb(c) {
  const v = clamp(c, 0, 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
