/*
 * 骨骼动作混合引擎（纯计算，无 DOM 依赖）
 * 规则（来自样例包 格式说明.md）：
 *  - 右手坐标、Y 向上；矩阵行主序、作用于列向量；TRS = T*R*S；四元数 [x,y,z,w]
 *  - 轨道 STEP/LINEAR；向量线性插值；旋转归一化后最短弧 slerp，点积接近 1 用 nlerp
 *  - 时刻精确落键取该键；循环采样区间 [0, duration)；缺轨用绑定值
 *  - 根仅索引 0；剥离根 t 的 X/Z 保留 Y；用端点差和完整循环次数构造连续根平移
 *  - 帧 k 时刻 k/60；alpha(k)=clamp((k-start_frame)/fade_frames,0,1)
 *  - 骨骼权重 alpha*mask[i]，局部 TRS 混合后求层级
 *  - 每步 [k-1,k] 根累计增量 = (1-a)*A连续根增量 + a*B连续根增量，a=alpha(k-0.5)*mask[0]
 *  - 速度作用于各自动作时钟（非负）；根累计初值 0
 *  - 蒙皮矩阵 world*inverse_bind，位置按权重线性混合；演员最终位置另加累计根平移
 * 所有姿态与根位移都是帧号 k 的纯函数：拖动与连续播放结果一致。
 */
(function (global) {
  'use strict';

  var FPS = 60;

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  /* ---------------- 四元数 / 向量 ---------------- */

  function qNorm(q) {
    var l = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(l > 0)) return [0, 0, 0, 1];
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  // 最短弧 slerp；点积接近 1 时退化为归一化线性插值
  function qSlerp(a, b, t) {
    a = qNorm(a); b = qNorm(b);
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    var d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (d > 0.9995) {
      return qNorm([
        a[0] + (bx - a[0]) * t,
        a[1] + (by - a[1]) * t,
        a[2] + (bz - a[2]) * t,
        a[3] + (bw - a[3]) * t
      ]);
    }
    d = clamp(d, -1, 1);
    var th = Math.acos(d), s = Math.sin(th);
    var wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return qNorm([
      a[0] * wa + bx * wb,
      a[1] * wa + by * wb,
      a[2] * wa + bz * wb,
      a[3] * wa + bw * wb
    ]);
  }

  function vLerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /* ---------------- 矩阵（行主序，列向量） ---------------- */

  function matMul(a, b) {
    var o = new Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] +
                       a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
      }
    }
    return o;
  }

  // TRS = T * R * S
  function composeTRS(t, q, s) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    var r00 = 1 - (yy + zz), r01 = xy - wz, r02 = xz + wy;
    var r10 = xy + wz, r11 = 1 - (xx + zz), r12 = yz - wx;
    var r20 = xz - wy, r21 = yz + wx, r22 = 1 - (xx + yy);
    return [
      r00 * s[0], r01 * s[1], r02 * s[2], t[0],
      r10 * s[0], r11 * s[1], r12 * s[2], t[1],
      r20 * s[0], r21 * s[1], r22 * s[2], t[2],
      0, 0, 0, 1
    ];
  }

  function transformPoint(m, p) {
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]
    ];
  }

  /* ---------------- 校验与装载 ---------------- */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isVec(v, n) {
    if (!Array.isArray(v) || v.length !== n) return false;
    for (var i = 0; i < n; i++) if (!isNum(v[i])) return false;
    return true;
  }
  function fail(msg) { throw new Error(msg); }

  function validate(data) {
    if (!data || typeof data !== 'object') fail('文件不是合法的 JSON 对象');

    // ---- bones ----
    var bones = data.bones;
    if (!Array.isArray(bones) || bones.length < 1) fail('bones 缺失或为空');
    if (bones.length > 64) fail('骨骼数量超过 64（' + bones.length + '）');
    var nb = bones.length, i, j;
    for (i = 0; i < nb; i++) {
      var b = bones[i];
      if (!b) fail('bones[' + i + '] 缺失');
      if (!Number.isInteger(b.parent)) fail('bones[' + i + '].parent 不是整数');
      if (!isVec(b.t, 3)) fail('bones[' + i + '].t 应为 3 维向量');
      if (!isVec(b.r, 4)) fail('bones[' + i + '].r 应为 4 维四元数');
      if (!isVec(b.s, 3)) fail('bones[' + i + '].s 应为 3 维向量');
      if (!(b.s[0] > 0 && b.s[1] > 0 && b.s[2] > 0)) fail('bones[' + i + '].s 必须为正缩放');
      if (!isVec(b.inverse_bind, 16)) fail('bones[' + i + '].inverse_bind 应为 16 个数（行主序）');
    }
    for (i = 1; i < nb; i++) {
      if (bones[i].parent < 0 || bones[i].parent >= nb) fail('bones[' + i + '].parent 越界');
      if (bones[i].parent === i) fail('bones[' + i + '] 的父骨骼是自己（存在环）');
    }
    if (bones[0].parent !== -1 && (bones[0].parent < 0 || bones[0].parent >= nb))
      fail('bones[0].parent 越界');
    // 无环检查（先于根位置检查，环是更根本的结构错误）
    for (i = 0; i < nb; i++) {
      var seen = {}, cur = i;
      while (cur !== -1) {
        if (seen[cur]) fail('骨骼层级存在环（bones[' + i + '] 向上回溯时重复）');
        seen[cur] = true;
        cur = bones[cur].parent;
      }
    }
    if (bones[0].parent !== -1) fail('根骨骼必须位于索引 0 且 parent=-1');

    // ---- mesh ----
    var mesh = data.mesh;
    if (!mesh || typeof mesh !== 'object') fail('mesh 缺失');
    var pos = mesh.positions;
    if (!Array.isArray(pos) || pos.length < 1) fail('mesh.positions 缺失或为空');
    if (pos.length > 10000) fail('顶点数超过 10000（' + pos.length + '）');
    var nv = pos.length;
    for (i = 0; i < nv; i++) if (!isVec(pos[i], 3)) fail('mesh.positions[' + i + '] 应为 3 维向量');
    if (!Array.isArray(mesh.triangles)) fail('mesh.triangles 缺失');
    for (i = 0; i < mesh.triangles.length; i++) {
      var tri = mesh.triangles[i];
      if (!Array.isArray(tri) || tri.length !== 3) fail('mesh.triangles[' + i + '] 应为 3 个索引');
      for (j = 0; j < 3; j++) {
        if (!Number.isInteger(tri[j]) || tri[j] < 0 || tri[j] >= nv)
          fail('mesh.triangles[' + i + '] 索引越界');
      }
    }
    if (!Array.isArray(mesh.joints) || mesh.joints.length !== nv) fail('mesh.joints 长度应与顶点数一致');
    if (!Array.isArray(mesh.weights) || mesh.weights.length !== nv) fail('mesh.weights 长度应与顶点数一致');
    for (i = 0; i < nv; i++) {
      var js = mesh.joints[i], ws = mesh.weights[i];
      if (!Array.isArray(js) || !Array.isArray(ws) || js.length !== ws.length)
        fail('顶点 ' + i + ' 的 joints/weights 长度不一致');
      if (js.length < 1 || js.length > 4) fail('顶点 ' + i + ' 的权重数应为 1~4');
      var sum = 0;
      for (j = 0; j < ws.length; j++) {
        if (!isNum(ws[j])) fail('顶点 ' + i + ' 的权重不是数字');
        if (ws[j] < 0) fail('顶点 ' + i + ' 的权重为负（' + ws[j] + '）');
        if (!Number.isInteger(js[j]) || js[j] < 0 || js[j] >= nb)
          fail('顶点 ' + i + ' 的关节索引越界');
        sum += ws[j];
      }
      if (Math.abs(sum - 1) > 1e-6) fail('顶点 ' + i + ' 的权重和为 ' + sum + '，应在 1±1e-6 内');
    }

    // ---- clips ----
    var clips = data.clips;
    if (!Array.isArray(clips) || clips.length !== 2) fail('需要恰好两段动作（clips 长度应为 2）');
    var outClips = [];
    for (var c = 0; c < 2; c++) {
      var clip = clips[c];
      if (!clip || typeof clip !== 'object') fail('clips[' + c + '] 缺失');
      if (!isNum(clip.duration) || clip.duration <= 0) fail('clips[' + c + '].duration 应为正数');
      if (!Array.isArray(clip.tracks)) fail('clips[' + c + '].tracks 缺失');
      var map = new Map();
      for (i = 0; i < clip.tracks.length; i++) {
        var tr = clip.tracks[i];
        if (!Number.isInteger(tr.bone) || tr.bone < 0 || tr.bone >= nb)
          fail('clips[' + c + '].tracks[' + i + '].bone 越界');
        if (tr.path !== 't' && tr.path !== 'r' && tr.path !== 's')
          fail('clips[' + c + '].tracks[' + i + '].path 应为 t/r/s');
        if (tr.mode !== 'STEP' && tr.mode !== 'LINEAR')
          fail('clips[' + c + '].tracks[' + i + '].mode 应为 STEP/LINEAR');
        var dim = tr.path === 'r' ? 4 : 3;
        var times = tr.times, values = tr.values;
        if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length || times.length < 1)
          fail('clips[' + c + '].tracks[' + i + '] times/values 长度不一致');
        if (Math.abs(times[0]) > 1e-9 || Math.abs(times[times.length - 1] - clip.duration) > 1e-9)
          fail('clips[' + c + '].tracks[' + i + '] 键时间应覆盖 0 与 duration');
        for (j = 0; j < times.length; j++) {
          if (!isNum(times[j])) fail('clips[' + c + '].tracks[' + i + '] 键时间不是数字');
          if (j > 0 && !(times[j] > times[j - 1])) fail('clips[' + c + '].tracks[' + i + '] 键时间应严格递增');
          if (!isVec(values[j], dim)) fail('clips[' + c + '].tracks[' + i + '].values[' + j + '] 维度应为 ' + dim);
        }
        var key = tr.bone + ':' + tr.path;
        if (map.has(key)) fail('clips[' + c + '] 存在重复轨道（bone ' + tr.bone + ' path ' + tr.path + '）');
        map.set(key, tr);
      }
      outClips.push({ duration: clip.duration, map: map, rootT: map.get('0:t') || null });
    }

    // ---- config ----
    var cfgIn = data.config || {};
    var cfg = {
      start_frame: isNum(cfgIn.start_frame) ? cfgIn.start_frame : 0,
      fade_frames: isNum(cfgIn.fade_frames) ? cfgIn.fade_frames : 30,
      speed_a: isNum(cfgIn.speed_a) ? cfgIn.speed_a : 1,
      speed_b: isNum(cfgIn.speed_b) ? cfgIn.speed_b : 1,
      mask: []
    };
    if (cfg.fade_frames < 0) fail('config.fade_frames 不能为负');
    if (cfg.speed_a < 0 || cfg.speed_b < 0) fail('播放速度只取非负值');
    var maskIn = Array.isArray(cfgIn.mask) ? cfgIn.mask : [];
    for (i = 0; i < nb; i++) {
      var m = isNum(maskIn[i]) ? maskIn[i] : 1;
      if (m < 0 || m > 1) fail('config.mask[' + i + '] 应在 [0,1]');
      cfg.mask.push(m);
    }

    return { bones: bones, mesh: mesh, clips: outClips, config: cfg, boneCount: nb, vertCount: nv };
  }

  /* ---------------- 轨道采样 ---------------- */

  function sampleTrack(track, time) {
    var times = track.times, values = track.values;
    var last = times.length - 1;
    if (time <= times[0]) return values[0];
    if (time >= times[last]) return values[last];
    var lo = 0, hi = last;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= time) lo = mid; else hi = mid;
    }
    if (time === times[lo]) return values[lo]; // 精确落键
    if (track.mode === 'STEP') return values[lo];
    var u = (time - times[lo]) / (times[lo + 1] - times[lo]);
    if (track.path === 'r') return qSlerp(values[lo], values[lo + 1], u);
    return vLerp(values[lo], values[lo + 1], u);
  }

  // 单段动作在（已折算到 [0,duration) 的）时刻的骨骼局部 TRS；缺轨用绑定值
  function sampleLocal(model, clip, bone, time) {
    var b = model.bones[bone];
    var tt = clip.map.get(bone + ':t');
    var tr = clip.map.get(bone + ':r');
    var ts = clip.map.get(bone + ':s');
    return {
      t: tt ? sampleTrack(tt, time).slice() : b.t.slice(),
      r: tr ? qNorm(sampleTrack(tr, time)) : qNorm(b.r),
      s: ts ? sampleTrack(ts, time).slice() : b.s.slice()
    };
  }

  function wrapTime(time, duration) {
    var w = time - Math.floor(time / duration) * duration;
    // 防止浮点使 w == duration
    return w >= duration ? 0 : w;
  }

  /* ---------------- 连续根平移 ---------------- */

  // 某段动作在未回绕时钟 time 下的连续根水平位移（端点差 × 完整循环次数 + 循环内采样）
  function rootContinuousXZ(model, clip, time) {
    var d = clip.duration;
    var cycles = Math.floor(time / d);
    var tt = time - cycles * d;
    if (tt >= d) { cycles += 1; tt = 0; }
    var track = clip.rootT;
    var bind = model.bones[0].t;
    var base = track ? sampleTrack(track, tt) : bind;
    var s0 = track ? track.values[0] : bind;
    var s1 = track ? track.values[track.values.length - 1] : bind;
    return [
      base[0] + cycles * (s1[0] - s0[0]),
      base[2] + cycles * (s1[2] - s0[2])
    ];
  }

  /* ---------------- 淡化 ---------------- */

  function alphaAt(cfg, k) {
    if (!(cfg.fade_frames > 0)) return k >= cfg.start_frame ? 1 : 0;
    return clamp((k - cfg.start_frame) / cfg.fade_frames, 0, 1);
  }

  /* ---------------- 姿态求值（帧 k 的纯函数） ---------------- */

  function poseAt(model, cfg, k) {
    var alpha = alphaAt(cfg, k);
    var clipA = model.clips[0], clipB = model.clips[1];
    var tA = wrapTime(k / FPS * cfg.speed_a, clipA.duration);
    var tB = wrapTime(k / FPS * cfg.speed_b, clipB.duration);
    var nb = model.boneCount;
    var locals = new Array(nb);
    for (var i = 0; i < nb; i++) {
      var la = sampleLocal(model, clipA, i, tA);
      var lb = sampleLocal(model, clipB, i, tB);
      var w = alpha * cfg.mask[i];
      locals[i] = {
        t: vLerp(la.t, lb.t, w),
        r: qSlerp(la.r, lb.r, w),
        s: vLerp(la.s, lb.s, w)
      };
    }
    // 剥离混合根的水平平移，保留 Y
    locals[0].t = [0, locals[0].t[1], 0];
    // 层级求值（父索引顺序任意，用记忆化递归）
    var worlds = new Array(nb);
    var done = new Array(nb).fill(false);
    function worldOf(i) {
      if (done[i]) return worlds[i];
      var local = composeTRS(locals[i].t, locals[i].r, locals[i].s);
      var p = model.bones[i].parent;
      var w = p < 0 ? local : matMul(worldOf(p), local);
      worlds[i] = w; done[i] = true;
      return w;
    }
    for (i = 0; i < nb; i++) worldOf(i);
    return { alpha: alpha, locals: locals, worlds: worlds };
  }

  /* ---------------- 根位移累计 ----------------
   * accum(k) = Σ_{j=1..k} (1-a_j)*ΔA_j + a_j*ΔB_j，a_j = alpha(j-0.5)*mask[0]
   * Δ 为各自动作时钟下连续根水平位移之差（循环跨界不回跳）。
   */
  function makeRootAccumulator(model, cfg) {
    var cacheK = 0, cacheX = 0, cacheZ = 0;
    var clipA = model.clips[0], clipB = model.clips[1];
    var m0 = cfg.mask[0];
    function stepDelta(j) {
      var a = alphaAt(cfg, j - 0.5) * m0;
      var tA1 = (j - 1) / FPS * cfg.speed_a, tA2 = j / FPS * cfg.speed_a;
      var tB1 = (j - 1) / FPS * cfg.speed_b, tB2 = j / FPS * cfg.speed_b;
      var pA1 = rootContinuousXZ(model, clipA, tA1), pA2 = rootContinuousXZ(model, clipA, tA2);
      var pB1 = rootContinuousXZ(model, clipB, tB1), pB2 = rootContinuousXZ(model, clipB, tB2);
      return [
        (1 - a) * (pA2[0] - pA1[0]) + a * (pB2[0] - pB1[0]),
        (1 - a) * (pA2[1] - pA1[1]) + a * (pB2[1] - pB1[1])
      ];
    }
    return {
      accum: function (k) {
        if (k < cacheK) { cacheK = 0; cacheX = 0; cacheZ = 0; }
        while (cacheK < k) {
          cacheK++;
          var d = stepDelta(cacheK);
          cacheX += d[0]; cacheZ += d[1];
        }
        return [cacheX, 0, cacheZ];
      }
    };
  }

  // 独立纯净版（用于校验/导出，不依赖外部状态）
  function rootAccumAt(model, cfg, k) {
    var acc = makeRootAccumulator(model, cfg);
    return acc.accum(k);
  }

  /* ---------------- 蒙皮 ---------------- */

  function skinMatrices(model, worlds) {
    var out = new Array(model.boneCount);
    for (var i = 0; i < model.boneCount; i++) {
      out[i] = matMul(worlds[i], model.bones[i].inverse_bind);
    }
    return out;
  }

  // 返回 Float64Array(3*nv)，已加上累计根平移
  function skinVertices(model, worlds, rootAccum) {
    var sm = skinMatrices(model, worlds);
    var mesh = model.mesh, nv = model.vertCount;
    var out = new Float64Array(nv * 3);
    for (var v = 0; v < nv; v++) {
      var p = mesh.positions[v];
      var js = mesh.joints[v], ws = mesh.weights[v];
      var x = 0, y = 0, z = 0;
      for (var j = 0; j < js.length; j++) {
        var m = sm[js[j]], w = ws[j];
        x += w * (m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3]);
        y += w * (m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7]);
        z += w * (m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]);
      }
      out[v * 3] = x + rootAccum[0];
      out[v * 3 + 1] = y + rootAccum[1];
      out[v * 3 + 2] = z + rootAccum[2];
    }
    return out;
  }

  /* ---------------- 导出 ---------------- */

  function exportFrames(model, cfg, from, to) {
    var acc = makeRootAccumulator(model, cfg);
    var frames = [];
    for (var k = from; k <= to; k++) {
      var pose = poseAt(model, cfg, k);
      var root = acc.accum(k);
      frames.push({
        k: k,
        time: k / FPS,
        alpha: pose.alpha,
        root: root,
        bones: pose.locals.map(function (l) {
          return { t: l.t.slice(), r: l.r.slice(), s: l.s.slice() };
        })
      });
    }
    return {
      meta: {
        fps: FPS,
        from: from, to: to,
        start_frame: cfg.start_frame,
        fade_frames: cfg.fade_frames,
        speed_a: cfg.speed_a,
        speed_b: cfg.speed_b,
        mask: cfg.mask.slice(),
        note: 'bones 为混合后的局部 TRS（根已剥离水平平移）；root 为累计根位移（水平）。'
      },
      frames: frames
    };
  }

  var Engine = {
    FPS: FPS,
    validate: validate,
    poseAt: poseAt,
    alphaAt: alphaAt,
    makeRootAccumulator: makeRootAccumulator,
    rootAccumAt: rootAccumAt,
    rootContinuousXZ: rootContinuousXZ,
    skinVertices: skinVertices,
    skinMatrices: skinMatrices,
    exportFrames: exportFrames,
    composeTRS: composeTRS,
    matMul: matMul,
    transformPoint: transformPoint,
    qSlerp: qSlerp,
    sampleTrack: sampleTrack
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else global.SkeletalEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
