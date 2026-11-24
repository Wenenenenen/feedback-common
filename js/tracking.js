/*
 * 跟踪：manifest 校验 → 按轴中位数筛离群 → 内点重估中位数 → 累加轨迹 → 分镜头。
 *
 * 约定（与 samples/stabilized-aperture-cases.zip/说明.txt 一致）：
 *  - pairs[t] 为帧 t-1 → t 的点对 [x0,y0,x1,y1]（有符号像素坐标），pairs[0] 为空；
 *  - 位移 d = (x1-x0, y1-y0)；每轴先求中位数（偶数取两中值平均）；
 *  - 任一轴偏离该中位数「超过」threshold 的点记为离群；用剩余点重新求中位数并累加到 p_t；
 *  - 显式切点帧、或内点少于三组：该帧 p_t 置零并另起镜头（切点两侧不共用平滑结果）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPTrack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FRAMES = 1800;
  const MAX_TOTAL_PIXELS = 25000000;
  const MAX_PAIRS = 128;
  const MAX_SIDE = 16384;
  const MIN_INLIERS = 3;

  function median(values) {
    const n = values.length;
    if (n === 0) return NaN;
    const a = Float64Array.from(values);
    a.sort();
    const h = n >> 1;
    return n % 2 === 1 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  function fail(path, message) {
    return { ok: false, errors: [{ path, message }] };
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  /** 归一化 pins：接受若干常见写法，统一为 [{frame, x, y}]。 */
  function normalisePins(raw, frameCount) {
    if (raw == null) return { ok: true, pins: [] };
    if (!Array.isArray(raw)) return { ok: false, message: 'pins 必须是数组' };
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      let frame; let x; let y;
      if (Array.isArray(p)) {
        if (p.length !== 3) return { ok: false, message: `pins[${i}] 应为 [帧号, ux, uy]` };
        [frame, x, y] = p;
      } else if (p && typeof p === 'object') {
        frame = p.frame != null ? p.frame : (p.index != null ? p.index : p.t);
        if (Array.isArray(p.value)) { x = p.value[0]; y = p.value[1]; }
        else if (Array.isArray(p.offset)) { x = p.offset[0]; y = p.offset[1]; }
        else { x = p.ux != null ? p.ux : p.x; y = p.uy != null ? p.uy : p.y; }
      } else {
        return { ok: false, message: `pins[${i}] 格式无法识别` };
      }
      if (!isInt(frame) || frame < 0 || frame >= frameCount) {
        return { ok: false, message: `pins[${i}].frame 必须是 0…${frameCount - 1} 的整数` };
      }
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        return { ok: false, message: `pins[${i}] 偏移必须是有限数` };
      }
      if (seen.has(frame)) return { ok: false, message: `pins 中帧 ${frame} 重复指定` };
      seen.add(frame);
      out.push({ frame, x, y });
    }
    out.sort((a, b) => a.frame - b.frame);
    return { ok: true, pins: out };
  }

  /**
   * 校验 manifest（已是 JSON 对象）。frameSizes 可选：来自实际 PNG/PPM 头的尺寸，
   * 用于核对 frames 列表中每张图的宽高一致与像素预算。
   */
  function parseManifest(raw, frameSizes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('manifest.json', '顶层必须是对象');
    }
    const frames = raw.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      return fail('manifest.json: frames', '必须是非空数组');
    }
    const frameCount = frames.length;
    if (frameCount > MAX_FRAMES) {
      return fail('manifest.json: frames', `帧数 ${frameCount} 超过上限 ${MAX_FRAMES}`);
    }
    for (let i = 0; i < frameCount; i++) {
      if (typeof frames[i] !== 'string' || frames[i].length === 0) {
        return fail(`manifest.json: frames[${i}]`, '必须是非空字符串路径');
      }
    }

    if (!Array.isArray(raw.pairs)) {
      return fail('manifest.json: pairs', '必须是数组');
    }
    if (raw.pairs.length !== frameCount) {
      return fail('manifest.json: pairs', `长度 ${raw.pairs.length} 与帧数 ${frameCount} 不一致`);
    }
    const pairs = [];
    for (let t = 0; t < frameCount; t++) {
      const src = raw.pairs[t];
      if (!Array.isArray(src)) return fail(`manifest.json: pairs[${t}]`, '必须是数组');
      if (t === 0 && src.length !== 0) {
        return fail('manifest.json: pairs[0]', '首帧没有前一帧，必须为空');
      }
      if (src.length > MAX_PAIRS) {
        return fail(`manifest.json: pairs[${t}]`, `点对数 ${src.length} 超过上限 ${MAX_PAIRS}`);
      }
      const list = new Array(src.length);
      for (let k = 0; k < src.length; k++) {
        const pt = src[k];
        if (!Array.isArray(pt) || pt.length !== 4 || !pt.every(isFiniteNumber)) {
          return fail(`manifest.json: pairs[${t}][${k}]`, '必须为 [x0,y0,x1,y1] 四个有限数');
        }
        list[k] = [pt[0], pt[1], pt[2], pt[3]];
      }
      pairs.push(list);
    }

    // 显式切点
    let cuts = [];
    if (raw.cuts != null) {
      if (!Array.isArray(raw.cuts)) return fail('manifest.json: cuts', '必须是数组');
      const set = new Set();
      for (let i = 0; i < raw.cuts.length; i++) {
        const c = raw.cuts[i];
        if (!isInt(c) || c < 0 || c >= frameCount) {
          return fail(`manifest.json: cuts[${i}]`, `必须是 0…${frameCount - 1} 的整数`);
        }
        set.add(c);
      }
      cuts = [...set].sort((a, b) => a - b);
    }

    if (raw.threshold != null && (!isFiniteNumber(raw.threshold) || raw.threshold < 0)) {
      return fail('manifest.json: threshold', '必须是非负有限数');
    }
    const threshold = raw.threshold == null ? 0 : raw.threshold;

    // 裁幅：缺省时取整幅
    let cropW; let cropH;
    if (raw.crop != null) {
      if (!Array.isArray(raw.crop) || raw.crop.length !== 2 || !raw.crop.every(isInt)) {
        return fail('manifest.json: crop', '必须是 [宽, 高] 两个整数');
      }
      [cropW, cropH] = raw.crop;
    }
    if (raw.margin != null && (!isInt(raw.margin) || raw.margin < 0)) {
      return fail('manifest.json: margin', '必须是非负整数');
    }
    const margin = raw.margin == null ? 0 : raw.margin;
    if (raw.lambda != null && (!isFiniteNumber(raw.lambda) || raw.lambda < 0 || raw.lambda > 10000)) {
      return fail('manifest.json: lambda', '必须在 0…10000 之间');
    }
    const lambda = raw.lambda == null ? 0 : raw.lambda;

    const pinRes = normalisePins(raw.pins, frameCount);
    if (!pinRes.ok) return fail('manifest.json: pins', pinRes.message);

    // 尺寸：优先用实际解码得到的尺寸
    let width = null;
    let height = null;
    if (frameSizes) {
      if (!Array.isArray(frameSizes) || frameSizes.length !== frameCount) {
        return fail('frames', '解码结果与 manifest.frames 数量不一致');
      }
      let total = 0;
      for (let i = 0; i < frameCount; i++) {
        const s = frameSizes[i];
        if (!s || !isFiniteNumber(s.width) || !isFiniteNumber(s.height) || s.width < 1 || s.height < 1) {
          return fail(`frames[${i}]`, '尺寸非法');
        }
        if (s.width > MAX_SIDE || s.height > MAX_SIDE) {
          return fail(`frames[${i}]`, `尺寸 ${s.width}×${s.height} 超过上限 ${MAX_SIDE}`);
        }
        if (width == null) { width = s.width; height = s.height; }
        else if (s.width !== width || s.height !== height) {
          return fail(`frames[${i}]`, `尺寸 ${s.width}×${s.height} 与首帧 ${width}×${height} 不一致`);
        }
        total += s.width * s.height;
      }
      if (total > MAX_TOTAL_PIXELS) {
        return fail('manifest.json: frames', `累计像素 ${total} 超过上限 ${MAX_TOTAL_PIXELS}`);
      }
    }
    if (cropW == null && width != null) { cropW = width; cropH = height; }

    return {
      ok: true,
      errors: [],
      manifest: {
        frames, frameCount, pairs, cuts, threshold, cropW, cropH, margin, lambda,
        pins: pinRes.pins, width, height,
      },
    };
  }

  /**
   * 计算逐帧轨迹与镜头。
   * 返回 { p: [Float64Array(Float64Array x,y)], shots: [{start,end}], frameShot: Int32Array,
   *        cutFlags: Uint8Array, weakFlags: Uint8Array, inlierCounts: Int32Array,
   *        step: [Float64Array x,y] }
   * 镜头为左闭右开 [start,end)。
   */
  function track(manifest) {
    const n = manifest.frameCount;
    const pairs = manifest.pairs;
    const cutSet = new Set(manifest.cuts || []);
    const threshold = manifest.threshold;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const stepX = new Float64Array(n);
    const stepY = new Float64Array(n);
    const inlierCounts = new Int32Array(n);
    const cutFlags = new Uint8Array(n);
    const weakFlags = new Uint8Array(n);
    const frameShot = new Int32Array(n);
    const shots = [];

    let shotStart = 0;
    let shotIndex = 0;

    const beginShot = (t) => {
      if (t > shotStart) {
        shots.push({ start: shotStart, end: t, index: shotIndex });
        shotIndex++;
      }
      shotStart = t;
    };

    for (let t = 1; t < n; t++) {
      const isCut = cutSet.has(t);
      if (isCut) {
        cutFlags[t] = 1;
        px[t] = 0; py[t] = 0;
        beginShot(t);
        for (let k = t; k <= t; k++) frameShot[k] = shotIndex;
        continue;
      }
      const pts = pairs[t];
      if (pts.length === 0) {
        weakFlags[t] = 1;
        px[t] = 0; py[t] = 0;
        beginShot(t);
        continue;
      }
      const dx = new Float64Array(pts.length);
      const dy = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k++) {
        dx[k] = pts[k][2] - pts[k][0];
        dy[k] = pts[k][3] - pts[k][1];
      }
      const mx = median(dx);
      const my = median(dy);
      let count = 0;
      let sx = 0;
      let sy = 0;
      const keepX = [];
      const keepY = [];
      for (let k = 0; k < pts.length; k++) {
        if (Math.abs(dx[k] - mx) <= threshold && Math.abs(dy[k] - my) <= threshold) {
          count++;
          keepX.push(dx[k]);
          keepY.push(dy[k]);
        }
      }
      inlierCounts[t] = count;
      if (count < MIN_INLIERS) {
        weakFlags[t] = 1;
        px[t] = 0; py[t] = 0;
        beginShot(t);
        continue;
      }
      const mx2 = median(keepX);
      const my2 = median(keepY);
      sx = mx2; sy = my2;
      px[t] = px[t - 1] + sx;
      py[t] = py[t - 1] + sy;
      stepX[t] = sx; stepY[t] = sy;
    }

    shots.push({ start: shotStart, end: n, index: shotIndex });
    // frameShot 可能在切点前留下旧值，最后统一按 shots 回填
    for (const s of shots) {
      for (let t = s.start; t < s.end; t++) frameShot[t] = s.index;
    }

    return {
      p: [px, py], step: [stepX, stepY], shots, frameShot,
      cutFlags, weakFlags, inlierCounts, threshold,
    };
  }

  return {
    MAX_FRAMES, MAX_TOTAL_PIXELS, MAX_PAIRS, MAX_SIDE, MIN_INLIERS,
    median, parseManifest, track, normalisePins,
  };
});
