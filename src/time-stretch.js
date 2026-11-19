// time-stretch.js — 瞬态保护 WSOLA，无依赖，无第三方库
//
// 标准 WSOLA（波形相似叠加）+ 瞬态锚点分段：
//  1) 瞬态锚点把输入切段；每段独立做 WSOLA，首帧分析起点锁在段首锚点、
//     合成起点锁在锚点映射位置 round(p/speed) —— 敲击精确定位、不重复不丢失；
//  2) 段内恒定合成跳幅 hs，分析跳幅 ha = 段输入长/段帧数（每帧从 k*ha 重新
//     标称，取整误差零均值，不产生长时音高漂移）；
//  3) WSOLA 参考段取"上一选中分析点 + hs"（自然延续位置），在标称位置 ±SEARCH
//     内选归一化互相关最大的候选，逐帧续上相位，音高不变；
//  4) 搜索只在单声道混音做一次，左右声道共用同一偏移序列 —— 双声道联动，
//     时间差/相位关系逐样本保持；
//  5) 窗口：段首平顶汉宁窗（前半恒 1，敲击不被斜坡衰减），其余对称汉宁窗；
//     逐样本权重归一化，重叠相加幅度无调制；
//  6) 总长度精确等于 round(N/speed)。

const W = 1024;  // 分析窗长（44.1k≈23ms / 48k≈21ms）
const HS = 128;  // 合成跳幅（约 2.7ms）
const SEARCH = 128;
const LAMBDA = 0.1; // 连续性惩罚（NCC 归一量纲）

function round(x) { return Math.floor(x + 0.5); }

// 对称汉宁窗
function hannWin(len) {
  const win = new Float64Array(len);
  for (let i = 0; i < len; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
  return win;
}

// 平顶汉宁窗：前半恒 1（锚点/敲击起点权重为 1，瞬态满幅不被衰减），
// 后半按汉宁斜坡降到 0，与后续对称汉宁帧在重叠区平滑衔接。
function flatTopWin(len) {
  const win = new Float64Array(len);
  const half = len >> 1;
  for (let i = 0; i < half; i++) win[i] = 1;
  for (let i = half; i < len; i++) win[i] = 0.5 * (1 + Math.cos(Math.PI * (i - half) / half));
  return win;
}

// 在标称位置 nom 附近搜索与参考段（ref 起）波形最相似的分析起点。
// 搜索严格限制在 [segStart, segEnd-w] 内，不跨锚点。
function bestOffset(mono, ref, nom, w, segEnd, segStart) {
  const lo = Math.max(-SEARCH, segStart - nom, segStart - ref);
  const hi = Math.min(SEARCH, segEnd - w - nom, segEnd - w - ref);
  let a2 = 0;
  for (let i = 0; i < w; i++) a2 += mono[ref + i] * mono[ref + i];
  if (a2 < 1e-10) return 0;
  let best = 0, bestScore = -Infinity;
  for (let d = lo; d <= hi; d++) {
    const b0 = nom + d;
    let num = 0, b2 = 0;
    for (let i = 0; i < w; i++) {
      const x = mono[ref + i], y = mono[b0 + i];
      num += x * y; b2 += y * y;
    }
    const ncc = b2 > 1e-12 ? num / Math.sqrt(a2 * b2) : -2;
    const score = ncc - LAMBDA * (d * d) / (SEARCH * SEARCH);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// 处理一段：输入严格限定在 [segStart, segEnd)，输出从 outPos 起覆盖 segTarget 个样本。
// 帧不跨锚点取内容 -> 段间无信号污染。
// 首帧平顶汉宁窗（锚点权重为 1，敲击满幅），其余对称汉宁窗；
// 逐样本权重归一化保证重叠区幅度连续。
async function stretchSegment(channels, mono, segStart, segEnd, segTarget, out, weight, outPos,
  winH, winFlat, N, speed, onProgress, progBase, progSpan, yieldHook) {
  const segLen = segEnd - segStart;
  let w = W, WH = winH, WF = winFlat, hs = HS;

  // 极短段自适应缩窗（2 的幂），跳幅同比缩小
  if (segLen < W) {
    w = 8;
    while (w * 2 <= segLen && w * 2 <= W) w *= 2;
    WH = hannWin(w);
    WF = flatTopWin(w);
    hs = Math.max(1, w >> 3);
  }
  // 分析跳幅：保证 K 帧恰好走完输入段（零均值取整，无长时漂移）；
  // 帧数由合成侧目标长度决定，合成重叠密度恒定。
  const K = Math.max(2, Math.ceil(segTarget / hs) + 1);
  let ha = segLen / K;
  if (!isFinite(ha) || ha < 1) ha = 1;

  let prevAna = -1;
  for (let k = 0; k < K; k++) {
    const synPos = outPos + k * hs;
    if (synPos >= out[0].length) break;
    const win = k === 0 ? WF : WH;
    let aStart;
    if (k === 0) {
      aStart = segStart; // 锚点帧：锁死段首
    } else {
      const nom = segStart + Math.round(k * ha);
      const ref = prevAna + hs; // 参考：上一分析点的自然延续
      let d = 0;
      if (ref >= segStart && ref + w <= segEnd && nom >= segStart && nom < segEnd) {
        d = bestOffset(mono, ref, nom, w, segEnd, segStart);
      }
      aStart = nom + d;
      // 严格钳制在段内，绝不跨越锚点
      if (aStart < segStart) aStart = segStart;
      if (aStart + w > segEnd) aStart = segEnd - w;
    }
    prevAna = aStart;

    const L = Math.min(w, segEnd - aStart, out[0].length - synPos);
    if (L <= 0) continue;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = out[c];
      for (let i = 0; i < L; i++) dst[synPos + i] += src[aStart + i] * win[i];
    }
    for (let i = 0; i < L; i++) weight[synPos + i] += win[i];
    if (onProgress && (k & 63) === 0) onProgress(progBase + progSpan * (k / K));
    if (yieldHook && (k & 255) === 0) await yieldHook();
  }
}

// 主入口（async：yieldHook 存在时定期让步，使 worker 能响应取消；不使用 await 时行为等同同步）
// samples: [Float32Array,...]；speed>0；返回 {out, anchorsOut, Nout}
export async function timeStretch(samples, speed, anchorsIn, sampleRate, onProgress = null, yieldHook = null) {
  const N = samples[0].length;
  const ch = samples.length;
  const Nout = round(N / speed);

  // speed=1 直接透传，保证与输入逐样本一致
  if (speed === 1) {
    const out = samples.map(s => s.slice());
    return { out, anchorsOut: Int32Array.from(anchorsIn), Nout: N };
  }

  // 单声道混音（仅用于搜索；双声道相等时与任一声道完全相同）
  const mono = new Float32Array(N);
  for (let c = 0; c < ch; c++) for (let i = 0; i < N; i++) mono[i] += 0.5 * samples[c][i];

  // 锚点：始终包含 0，去掉过近的（<30ms），末尾补 N
  const minGap = round(sampleRate * 0.03);
  const anchors = [0];
  for (const p of anchorsIn) {
    if (p <= 0 || p >= N) continue;
    if (p - anchors[anchors.length - 1] >= minGap) anchors.push(p);
  }
  anchors.push(N);

  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Float64Array(Nout));
  const weight = new Float64Array(Nout);
  const winH = hannWin(W);
  const winFlat = flatTopWin(W);

  // 段目标输出位置：锚点 a 的映射 round(a/speed)
  const mapped = anchors.map(a => (a === N ? Nout : round(a / speed)));

  let outCursor = 0;
  const segCount = anchors.length - 1;
  for (let s = 0; s < segCount; s++) {
    const segStart = anchors[s];
    const segEnd = anchors[s + 1];
    let segTarget = mapped[s + 1] - mapped[s];
    if (segTarget <= 0) continue;
    // 最后一段扩到输出末尾，保证尾部完整覆盖
    if (s === segCount - 1) segTarget = Nout - outCursor;
    await stretchSegment(samples, mono, segStart, segEnd, segTarget, out, weight, outCursor,
      winH, winFlat, N, speed, onProgress, 0.1 + 0.85 * (s / segCount), 0.85 / segCount, yieldHook);
    outCursor = mapped[s + 1];
  }

  // 逐样本归一化
  const result = [];
  for (let c = 0; c < ch; c++) {
    const o = new Float32Array(Nout);
    for (let i = 0; i < Nout; i++) {
      const wgt = weight[i] > 1e-8 ? weight[i] : 1;
      let v = out[c][i] / wgt;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      o[i] = v;
    }
    result.push(o);
  }

  // 输出锚点：所有输入敲击的映射位置（含被最小间距合并的），用于导出对照表
  const anchorsOut = new Int32Array(anchorsIn.length);
  for (let i = 0; i < anchorsIn.length; i++) anchorsOut[i] = round(anchorsIn[i] / speed);

  if (onProgress) onProgress(1);
  return { out: result, anchorsOut, Nout };
}
