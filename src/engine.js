/*
 * 种子引导二元图割引擎（纯计算，不依赖 DOM）
 *
 * 能量定义（samples/seed-cut-matte-cases.zip 内 README.txt）：
 *   颜色按字节 /255 直接参与运算，不做伽马变换。
 *   D_p(l) = || c_p - m_l ||²                     每个像素对两类种子均值的颜色代价
 *   beta   = 1 / (2 * 全部右/下邻边颜色平方差均值)；均值为 0 时 beta = 0
 *   w_pq   = lambda * exp(-beta * || c_p - c_q ||²)
 *   E(l)   = Σ_p D_p(l_p) + Σ_{pq} w_pq * [l_p ≠ l_q]
 *
 * 二元亚模能量由 s-t 最小割精确最小化。种子为硬约束：终端容量取
 * K = 全部有限项之和 + 1，严格大于任何有限割，因此最优割不会切开种子。
 * 最大流使用自带的迭代 Dinic，不调用任何现成分割 / 最大流接口。
 */
(function (root) {
  'use strict';

  /*
   * 该函数会被 toString() 后放进 Blob Worker 执行，因此必须完全自成一体：
   * 所有常量与辅助函数都定义在其内部，不引用外部闭包。
   */
  function matteWorkerEntry(self) {
    'use strict';

    var RESIDUAL_EPS = 1e-12;

    function toIndexArray(value, N, name) {
      if (value == null) return new Uint32Array(0);
      if (!(value instanceof Uint32Array) && !(value instanceof Int32Array) && !Array.isArray(value)) {
        throw new Error(name + ' 格式不正确');
      }
      var out = new Uint32Array(value.length);
      for (var i = 0; i < value.length; i++) {
        var v = value[i];
        if (!Number.isInteger(v) || v < 0 || v >= N) {
          throw new Error(name + ' 超出图片范围');
        }
        out[i] = v;
      }
      return out;
    }

    function solveJob(job, progress) {
      var t0 = Date.now();
      var w = job.w | 0;
      var h = job.h | 0;
      if (!(w >= 1 && w <= 256 && h >= 1 && h <= 256)) {
        throw new Error('图片尺寸必须在 1..256 之间');
      }
      var N = w * h;
      var rgb = job.rgb;
      if (!rgb || rgb.length !== N * 3) {
        throw new Error('RGB 数据长度与尺寸不一致');
      }
      if (!(rgb instanceof Uint8Array)) rgb = new Uint8Array(rgb);

      var lambda = Number(job.lambda);
      if (!isFinite(lambda) || lambda < 0 || lambda > 20) {
        throw new Error('lambda 必须在 0 到 20 之间');
      }

      var fgRaw = toIndexArray(job.fg, N, '前景种子');
      var bgRaw = toIndexArray(job.bg, N, '背景种子');
      if (fgRaw.length === 0) throw new Error('缺少前景种子：请至少画一个前景种子');
      if (bgRaw.length === 0) throw new Error('缺少背景种子：请至少画一个背景种子');

      var isFg = new Uint8Array(N);
      var isBg = new Uint8Array(N);
      var i, k;
      for (i = 0; i < fgRaw.length; i++) isFg[fgRaw[i]] = 1;
      for (i = 0; i < bgRaw.length; i++) isBg[bgRaw[i]] = 1;
      var fgCount = 0;
      var bgCount = 0;
      for (i = 0; i < N; i++) {
        if (isFg[i] && isBg[i]) {
          throw new Error('种子冲突：像素 (' + (i % w) + ', ' + ((i / w) | 0) + ') 同时被标为前景和背景');
        }
        if (isFg[i]) fgCount++;
        if (isBg[i]) bgCount++;
      }

      // ---- 两类种子的颜色均值 ----
      var m1 = new Float64Array(3);
      var m0 = new Float64Array(3);
      for (i = 0; i < N; i++) {
        if (!isFg[i] && !isBg[i]) continue;
        var o = i * 3;
        if (isFg[i]) { m1[0] += rgb[o]; m1[1] += rgb[o + 1]; m1[2] += rgb[o + 2]; }
        if (isBg[i]) { m0[0] += rgb[o]; m0[1] += rgb[o + 1]; m0[2] += rgb[o + 2]; }
      }
      m1[0] /= fgCount * 255; m1[1] /= fgCount * 255; m1[2] /= fgCount * 255;
      m0[0] /= bgCount * 255; m0[1] /= bgCount * 255; m0[2] /= bgCount * 255;

      // ---- 一元项 D0 / D1 ----
      var D0 = new Float64Array(N);
      var D1 = new Float64Array(N);
      for (i = 0; i < N; i++) {
        o = i * 3;
        var r = rgb[o] / 255, g = rgb[o + 1] / 255, b = rgb[o + 2] / 255;
        var a0 = r - m0[0], b0 = g - m0[1], c0 = b - m0[2];
        var a1 = r - m1[0], b1 = g - m1[1], c1 = b - m1[2];
        D0[i] = a0 * a0 + b0 * b0 + c0 * c0;
        D1[i] = a1 * a1 + b1 * b1 + c1 * c1;
      }

      // ---- 右 / 下无向四邻边，各取一次 ----
      var edgeCount = (w - 1) * h + (h - 1) * w;
      var eA = new Int32Array(edgeCount);
      var eB = new Int32Array(edgeCount);
      var eDiff = new Float64Array(edgeCount);
      var sumDiff = 0;
      var e = 0;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var p = y * w + x;
          var op = p * 3;
          if (x + 1 < w) {
            var q = p + 1;
            var oq = q * 3;
            var dr = (rgb[op] - rgb[oq]) / 255;
            var dg = (rgb[op + 1] - rgb[oq + 1]) / 255;
            var db = (rgb[op + 2] - rgb[oq + 2]) / 255;
            var d = dr * dr + dg * dg + db * db;
            eA[e] = p; eB[e] = q; eDiff[e] = d; sumDiff += d; e++;
          }
          if (y + 1 < h) {
            var q2 = p + w;
            var oq2 = q2 * 3;
            var dr2 = (rgb[op] - rgb[oq2]) / 255;
            var dg2 = (rgb[op + 1] - rgb[oq2 + 1]) / 255;
            var db2 = (rgb[op + 2] - rgb[oq2 + 2]) / 255;
            var d2 = dr2 * dr2 + dg2 * dg2 + db2 * db2;
            eA[e] = p; eB[e] = q2; eDiff[e] = d2; sumDiff += d2; e++;
          }
        }
      }
      var meanDiff = edgeCount > 0 ? sumDiff / edgeCount : 0;
      var beta = meanDiff === 0 ? 0 : 1 / (2 * meanDiff);

      var weights = new Float64Array(edgeCount);
      var finite = 0;
      for (i = 0; i < edgeCount; i++) {
        var wt = lambda * Math.exp(-beta * eDiff[i]);
        weights[i] = wt;
        finite += wt;
      }
      for (i = 0; i < N; i++) finite += D0[i] + D1[i];
      var K = finite + 1;

      if (progress) progress({ phase: 'build' });

      // ---- 构图：残留网络，每条 addPair 生成一对方向相反的残留边 ----
      var SRC = N;
      var SNK = N + 1;
      var nodeCount = N + 2;
      var arcCapacity = 2 * edgeCount + 4 * N + 2 * (fgCount + bgCount);
      var head = new Int32Array(nodeCount).fill(-1);
      var to = new Int32Array(arcCapacity);
      var next = new Int32Array(arcCapacity);
      var cap = new Float64Array(arcCapacity);
      var arcCount = 0;

      function addPair(u, v, cuv, cvu) {
        to[arcCount] = v; cap[arcCount] = cuv; next[arcCount] = head[u]; head[u] = arcCount; arcCount++;
        to[arcCount] = u; cap[arcCount] = cvu; next[arcCount] = head[v]; head[v] = arcCount; arcCount++;
      }
      for (i = 0; i < N; i++) {
        if (D0[i] > 0) addPair(SRC, i, D0[i], 0);
        if (D1[i] > 0) addPair(i, SNK, D1[i], 0);
      }
      for (i = 0; i < N; i++) {
        if (isFg[i]) addPair(SRC, i, K, 0);
        if (isBg[i]) addPair(i, SNK, K, 0);
      }
      for (i = 0; i < edgeCount; i++) {
        if (weights[i] > 0) addPair(eA[i], eB[i], weights[i], weights[i]);
      }

      // ---- Dinic 最大流（迭代） ----
      var level = new Int32Array(nodeCount);
      var iter = new Int32Array(nodeCount);
      var queue = new Int32Array(nodeCount);
      var pathNode = new Int32Array(nodeCount);
      var pathArc = new Int32Array(nodeCount);
      var maxFlow = 0;
      var phases = 0;
      var augmentations = 0;

      function bfs() {
        level.fill(-1);
        var qh = 0, qt = 0;
        level[SRC] = 0;
        queue[qt++] = SRC;
        while (qh < qt) {
          var u = queue[qh++];
          var lu = level[u] + 1;
          for (var a = head[u]; a !== -1; a = next[a]) {
            var v = to[a];
            if (cap[a] > RESIDUAL_EPS && level[v] < 0) {
              level[v] = lu;
              if (v === SNK) return true;
              queue[qt++] = v;
            }
          }
        }
        return level[SNK] >= 0;
      }

      function augmentOnce() {
        var len = 0;
        var u = SRC;
        for (;;) {
          if (u === SNK) {
            var f = Infinity;
            var cutAt = -1;
            for (var j = 0; j < len; j++) {
              var a = pathArc[j];
              if (cap[a] < f) { f = cap[a]; cutAt = j; }
            }
            for (j = 0; j < len; j++) {
              a = pathArc[j];
              cap[a] -= f;
              cap[a ^ 1] += f;
            }
            iter[pathNode[cutAt]] = pathArc[cutAt];
            return f;
          }
          var ai = iter[u];
          while (ai !== -1) {
            if (cap[ai] > RESIDUAL_EPS && level[to[ai]] === level[u] + 1) break;
            ai = next[ai];
          }
          iter[u] = ai;
          if (ai === -1) {
            level[u] = -1;
            if (len === 0) return 0;
            len--;
            u = pathNode[len];
            iter[u] = next[iter[u]];
            continue;
          }
          pathNode[len] = u;
          pathArc[len] = ai;
          len++;
          u = to[ai];
        }
      }

      while (bfs()) {
        phases++;
        iter.set(head);
        for (;;) {
          var f = augmentOnce();
          if (!(f > 0)) break;
          maxFlow += f;
          augmentations++;
        }
        if (progress) progress({ phase: 'flow', phases: phases, augmentations: augmentations });
      }

      // ---- 源点残留可达集合 = 前景 ----
      var reach = new Uint8Array(nodeCount);
      var qh = 0, qt = 0;
      reach[SRC] = 1;
      queue[qt++] = SRC;
      while (qh < qt) {
        var uu = queue[qh++];
        for (var aa = head[uu]; aa !== -1; aa = next[aa]) {
          if (cap[aa] > RESIDUAL_EPS && !reach[to[aa]]) {
            reach[to[aa]] = 1;
            queue[qt++] = to[aa];
          }
        }
      }
      var labels = new Uint8Array(N);
      for (i = 0; i < N; i++) labels[i] = reach[i] ? 1 : 0;

      // 硬约束自检：最优割绝不能切开种子
      for (i = 0; i < N; i++) {
        if (isFg[i] && !labels[i]) throw new Error('内部错误：前景种子未被保留');
        if (isBg[i] && labels[i]) throw new Error('内部错误：背景种子未被保留');
      }

      // ---- 按标签重算两项能量 ----
      var unary = 0;
      var boundary = 0;
      for (i = 0; i < N; i++) unary += labels[i] ? D1[i] : D0[i];
      for (i = 0; i < edgeCount; i++) {
        if (labels[eA[i]] !== labels[eB[i]]) boundary += weights[i];
      }

      // ---- 前景连通域计数（4 邻接，允许分离区域） ----
      var seen = new Uint8Array(N);
      var components = 0;
      var stack = new Int32Array(N);
      for (i = 0; i < N; i++) {
        if (!labels[i] || seen[i]) continue;
        components++;
        var sp = 0;
        stack[sp++] = i;
        seen[i] = 1;
        while (sp > 0) {
          var v2 = stack[--sp];
          var vx = v2 % w;
          var vy = (v2 / w) | 0;
          if (vx > 0) { var n1 = v2 - 1; if (labels[n1] && !seen[n1]) { seen[n1] = 1; stack[sp++] = n1; } }
          if (vx + 1 < w) { var n2 = v2 + 1; if (labels[n2] && !seen[n2]) { seen[n2] = 1; stack[sp++] = n2; } }
          if (vy > 0) { var n3 = v2 - w; if (labels[n3] && !seen[n3]) { seen[n3] = 1; stack[sp++] = n3; } }
          if (vy + 1 < h) { var n4 = v2 + w; if (labels[n4] && !seen[n4]) { seen[n4] = 1; stack[sp++] = n4; } }
        }
      }

      if (progress) progress({ phase: 'done' });

      return {
        labels: labels,
        beta: beta,
        meanDiff: meanDiff,
        m0: [m0[0], m0[1], m0[2]],
        m1: [m1[0], m1[1], m1[2]],
        lambda: lambda,
        fgCount: fgCount,
        bgCount: bgCount,
        unary: unary,
        boundary: boundary,
        total: unary + boundary,
        maxFlow: maxFlow,
        finiteUpper: finite,
        seedCapacity: K,
        fgComponents: components,
        phases: phases,
        augmentations: augmentations,
        ms: Date.now() - t0
      };
    }

    // 供主线程回退路径使用；在 Worker 中同样只是一个附加属性。
    self.matteSolveJob = solveJob;

    self.onmessage = function (ev) {
      var job = ev.data;
      if (!job || job.type !== 'solve') return;
      var started = Date.now();
      try {
        var out = solveJob(job, function (p) {
          self.postMessage({
            type: 'progress',
            id: job.id,
            phase: p.phase,
            phases: p.phases || 0,
            elapsed: Date.now() - started
          });
        });
        out.type = 'result';
        out.id = job.id;
        out.wallMs = Date.now() - started;
        self.postMessage(out, [out.labels.buffer]);
      } catch (err) {
        self.postMessage({
          type: 'error',
          id: job.id,
          message: err && err.message ? err.message : String(err)
        });
      }
    };
  }

  var workerSource = '(' + matteWorkerEntry.toString() + ')(self);';

  root.MatteEngine = {
    workerSource: workerSource,
    entry: matteWorkerEntry,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { workerSource: workerSource, entry: matteWorkerEntry };
  }
})(typeof self !== 'undefined' ? self : globalThis);
