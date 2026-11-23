/*
 * onset-grid 求解器：纯手写动态规划，不依赖任何节拍跟踪器或优化库。
 * 帧单位：1 帧 = 240 采样（5ms）。所有拍长均为 6 的倍数，内部以
 * “6帧单位” u = frame/6 表示，拍长单位 p = P/6，p ∈ [8,39]。
 * 反拍：s=0 -> P/2 = 3p 单位；s=1 -> 2P/3 = 4p 单位。
 * 转移代价：3*|p-p'| + 7*(s!==s')。
 */
(function (root) {
  'use strict';

  var P_MIN = 8;    // 48 帧 / 6
  var P_MAX = 39;   // 234 帧 / 6
  var P_STEP = 2;   // 相邻拍长最多差 12 帧 = 2 个单位
  var COMBO = 64;   // 32 个拍长 * 2 种反拍类型
  var NEG = -1e9;

  function comboIndex(p, s) { return (p - P_MIN) * 2 + s; }

  /**
   * 输入:
   *   beats       计分拍数（拍号 0..beats-1）
   *   anchors     Map<拍号, 帧号>，调用方已完成全部合法性校验
   *   onsets      [[frame, wOn, wOff], ...]，帧号唯一、可乱序
   *   frameCount  完整帧数 floor(samples/240)
   * 返回:
   *   { feasible:false, reason } 或
   *   { feasible:true, score, beats:[{frame,period,swing,onMatch,offMatch,
   *                                   onScore,offScore,penalty}], stats }
   */
  function solve(cfg) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var beats = cfg.beats;
    var frameCount = cfg.frameCount;
    var anchorFrame = cfg.anchorFrame; // Int32Array(beats+1)，-1 表示无锚点
    var endFrame = anchorFrame[beats];
    var endU = endFrame / 6;

    // ---------- 1. 逐帧正/反拍匹配分与来源候选 ----------
    var onSc = new Int32Array(frameCount);
    var offSc = new Int32Array(frameCount);
    var onSrc = new Int32Array(frameCount);
    var offSrc = new Int32Array(frameCount);
    onSrc.fill(-1);
    offSrc.fill(-1);

    var sorted = cfg.onsets.slice().sort(function (a, b) { return a[0] - b[0]; });
    for (var k = 0; k < sorted.length; k++) {
      var o = sorted[k][0], wOn = sorted[k][1], wOff = sorted[k][2];
      for (var d = -3; d <= 3; d++) {
        var f = o + d;
        if (f < 0 || f >= frameCount) continue;
        var dist = d < 0 ? -d : d;
        if (wOn > 0) {
          var va = wOn - 2 * dist;
          if (va > onSc[f]) { onSc[f] = va; onSrc[f] = o; }
          // 相等时保留较早候选：onsets 已按帧升序，先写入的不覆盖
        }
        if (wOff > 0) {
          var vb = wOff - 2 * dist;
          if (vb > offSc[f]) { offSc[f] = vb; offSrc[f] = o; }
        }
      }
    }

    function matchAt(b, u, p, s) {
      var onFrame = u * 6;
      var offFrame = onFrame + (s === 0 ? 3 * p : 4 * p);
      var a = onFrame < frameCount ? onSc[onFrame] : 0;
      var b2 = offFrame < frameCount ? offSc[offFrame] : 0;
      return a + b2;
    }

    // ---------- 2. 反向 DP ----------
    // layers[b] = { frames:Int32Array(可达单位帧), idx:Int32Array(endU+1), B:Int32Array(r*64) }
    var layers = new Array(beats + 1);

    // 基准层 b=beats（末锚点，不计分）
    var baseIdx = new Int32Array(endU + 1).fill(-1);
    baseIdx[endU] = 0;
    var baseB = new Int32Array(COMBO); // 全 0
    layers[beats] = { frames: new Int32Array([endU]), idx: baseIdx, B: baseB };

    var marker = new Uint8Array(endU + 1);

    for (var b = beats - 1; b >= 0; b--) {
      var next = layers[b + 1];
      var anchored = anchorFrame[b] >= 0;
      var frames;
      if (anchored) {
        var au = anchorFrame[b] / 6;
        frames = new Int32Array([au]);
      } else {
        // 由下一层可达帧反推本层候选帧 u = u_next - p
        for (var fi = 0; fi < next.frames.length; fi++) {
          var un = next.frames[fi];
          for (var pq = P_MIN; pq <= P_MAX; pq++) {
            var u = un - pq;
            if (u >= 0 && u <= endU) marker[u] = 1;
          }
        }
        var list = [];
        for (var uu = 0; uu <= endU; uu++) {
          if (marker[uu]) { list.push(uu); marker[uu] = 0; }
        }
        frames = Int32Array.from(list);
      }

      var idx = new Int32Array(endU + 1).fill(-1);
      for (fi = 0; fi < frames.length; fi++) idx[frames[fi]] = fi;

      var Bcur = new Int32Array(frames.length * COMBO).fill(NEG);
      var nxB = next.B;
      var isLastBeat = (b === beats - 1);

      for (fi = 0; fi < frames.length; fi++) {
        var uCur = frames[fi];
        var baseOff = fi * COMBO;
        for (var p = P_MIN; p <= P_MAX; p++) {
          var uNext = uCur + p;
          if (uNext > endU) continue;
          var jNext = next.idx[uNext];
          if (jNext < 0) continue;
          var nextOff = jNext * COMBO;

          if (isLastBeat) {
            // 末拍：到达末锚点即终止，锚点本身不计分，也无转移代价
            for (var sLast = 0; sLast < 2; sLast++) {
              Bcur[baseOff + comboIndex(p, sLast)] = matchAt(b, uCur, p, sLast);
            }
            continue;
          }

          var pLo = p - P_STEP < P_MIN ? P_MIN : p - P_STEP;
          var pHi = p + P_STEP > P_MAX ? P_MAX : p + P_STEP;
          for (var s = 0; s < 2; s++) {
            var best = NEG;
            for (var pn = pLo; pn <= pHi; pn++) {
              var rowP = nextOff + (pn - P_MIN) * 2;
              var dP = 3 * (p > pn ? p - pn : pn - p);
              var v0 = nxB[rowP] - dP - (s !== 0 ? 7 : 0);
              var v1 = nxB[rowP + 1] - dP - (s !== 1 ? 7 : 0);
              if (v0 > best) best = v0;
              if (v1 > best) best = v1;
            }
            if (best > NEG) {
              var m = matchAt(b, uCur, p, s);
              Bcur[baseOff + comboIndex(p, s)] = m + best;
            }
          }
        }
      }
      layers[b] = { frames: frames, idx: idx, B: Bcur };
    }

    // ---------- 3. 可行性与最优分 ----------
    var startU = anchorFrame[0] / 6;
    var layer0 = layers[0];
    var j0 = layer0.idx[startU];
    if (j0 < 0) {
      return { feasible: false, reason: '锚点之间不存在满足拍长约束的网格' };
    }
    var b0off = j0 * COMBO;
    var G = NEG;
    for (var ci = 0; ci < COMBO; ci++) {
      if (layer0.B[b0off + ci] > G) G = layer0.B[b0off + ci];
    }
    if (G <= NEG) {
      return { feasible: false, reason: '锚点之间不存在满足拍长约束的网格' };
    }

    // ---------- 4. 字典序最小重建（P 升序优先，s 升序次之） ----------
    // Fv：已落定拍（0..b-1）的匹配分减去截至当前拍的全部转移代价；
    // 恒等式 Fv + B_b(u_b, p_b, s_b) = G。
    var out = [];
    var u = startU;
    var Fv = 0;

    for (var beat = 0; beat < beats; beat++) {
      var layer = layers[beat];
      var rowJ = layer.idx[u];
      if (rowJ < 0) {
        return { feasible: false, reason: '重建失败：帧不可达（内部错误）' };
      }
      var off = rowJ * COMBO;
      var prev = beat > 0 ? out[beat - 1] : null;
      var pp = prev ? prev.period / 6 : 0;
      var ss = prev ? prev.swing : 0;
      var chosenP = -1, chosenS = -1;

      outer:
      for (var p = P_MIN; p <= P_MAX; p++) {
        for (var s = 0; s < 2; s++) {
          if (layer.B[off + comboIndex(p, s)] <= NEG) continue;
          if (prev) {
            var dpv = p > pp ? p - pp : pp - p;
            if (dpv > P_STEP) continue;
            var cost = 3 * dpv + (s !== ss ? 7 : 0);
            if (Fv - cost + layer.B[off + comboIndex(p, s)] !== G) continue;
          } else {
            if (layer.B[off + comboIndex(p, s)] !== G) continue;
          }
          chosenP = p; chosenS = s;
          break outer;
        }
      }
      if (chosenP < 0) {
        return { feasible: false, reason: '重建失败：无字典序候选（内部错误）' };
      }

      var onFrame = u * 6;
      var offFrame = onFrame + (chosenS === 0 ? 3 * chosenP : 4 * chosenP);
      var onScore = onFrame < frameCount ? onSc[onFrame] : 0;
      var offScore = offFrame < frameCount ? offSc[offFrame] : 0;
      var penalty = prev
        ? 3 * (chosenP > pp ? chosenP - pp : pp - chosenP) + (chosenS !== ss ? 7 : 0)
        : 0;
      if (prev) Fv -= penalty;
      Fv += onScore + offScore;

      out.push({
        frame: onFrame,
        period: chosenP * 6,
        swing: chosenS,
        onMatch: onScore > 0 ? onSrc[onFrame] : null,
        offMatch: offScore > 0 ? offSrc[offFrame] : null,
        onScore: onScore,
        offScore: offScore,
        penalty: penalty
      });
      u += chosenP;
    }

    // 末拍之后必须恰好落在末锚点（DP 已保证，这里做一次显式校验）
    if (u !== endU) {
      return { feasible: false, reason: '末锚点对齐校验失败（内部错误）' };
    }
    if (Fv !== G) {
      return { feasible: false, reason: '总分校验失败（内部错误）' };
    }

    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var totalPenalty = 0;
    for (var q = 0; q < out.length; q++) totalPenalty += out[q].penalty;
    return {
      feasible: true,
      score: G,
      beats: out,
      stats: {
        elapsedMs: t1 - t0,
        totalPenalty: totalPenalty,
        layerFrames: layers.reduce(function (a, l) { return a + l.frames.length; }, 0)
      }
    };
  }

  /** 规范要求的输入校验，返回 {ok:true, anchorFrame} 或 {ok:false,errors:[...]} */
  function validate(cfg) {
    var errors = [];
    var beats = cfg.beats, frameCount = cfg.frameCount;
    if (!Number.isInteger(beats) || beats < 1 || beats > 192) {
      errors.push('beats 须为 1..192 的整数');
    }
    if (!Number.isInteger(frameCount) || frameCount < 1) {
      errors.push('完整帧数非法');
    }
    var anchorFrame = new Int32Array(beats + 1).fill(-1);
    var anchors = cfg.anchors || [];
    var seenBeat = Object.create(null);
    var lastFrame = -1;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!Array.isArray(a) || a.length !== 2 ||
          !Number.isInteger(a[0]) || !Number.isInteger(a[1])) {
        errors.push('锚点 #' + i + ' 须为 [拍号, 帧号] 整数对'); continue;
      }
      var ab = a[0], af = a[1];
      if (ab < 0 || ab > beats) { errors.push('锚点拍号 ' + ab + ' 超出 0..' + beats); continue; }
      if (seenBeat[ab]) { errors.push('锚点拍号 ' + ab + ' 重复'); }
      seenBeat[ab] = 1;
      if (af % 6 !== 0) { errors.push('锚点帧 ' + af + ' 不是 6 的倍数'); }
      if (af < 0 || af > frameCount) { errors.push('锚点帧 ' + af + ' 超出完整帧范围 0..' + frameCount); }
      if (af <= lastFrame) { errors.push('锚点帧号须随拍号严格递增（冲突帧 ' + af + '）'); }
      lastFrame = af;
      anchorFrame[ab] = af;
    }
    if (!seenBeat[0]) errors.push('缺少拍号 0 的锚点');
    if (!seenBeat[beats]) errors.push('缺少拍号 ' + beats + ' 的末锚点');

    var onsets = cfg.onsets || [];
    if (onsets.length > 24000) errors.push('起音候选数超过 24000');
    var seenFrame = Object.create(null);
    for (var j = 0; j < onsets.length; j++) {
      var o = onsets[j];
      if (!Array.isArray(o) || o.length !== 3 ||
          !Number.isInteger(o[0]) || !Number.isInteger(o[1]) || !Number.isInteger(o[2])) {
        errors.push('onsets #' + j + ' 须为 [帧号, 正拍权重, 反拍权重] 整数三元组'); continue;
      }
      if (o[0] < 0 || o[0] >= frameCount) errors.push('onset 帧 ' + o[0] + ' 超出范围');
      if (seenFrame[o[0]]) errors.push('onset 帧 ' + o[0] + ' 重复');
      seenFrame[o[0]] = 1;
      if (o[1] < 0 || o[1] > 1000 || o[2] < 0 || o[2] > 1000) {
        errors.push('onset 帧 ' + o[0] + ' 权重须在 0..1000');
      }
    }
    return { ok: errors.length === 0, errors: errors, anchorFrame: anchorFrame };
  }

  var api = { solve: solve, validate: validate, P_MIN: P_MIN, P_MAX: P_MAX, NEG: NEG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OnsetSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
