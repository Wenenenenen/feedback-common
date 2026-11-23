/*
 * 正交预览渲染（最多 192×128）。
 * 相机：o 左上角像素的射线原点，stepX/stepY 为像素间距（保留原长度），
 *       d 为射线方向（保留原长度），t 闭区间。
 * 三种图：depth 深度、normal 法线、lit 受光（含自阴影）。
 * 每个像素保留完整 trace，供点击展开格、根与选中原因。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./math.js'), require('./ray.js'));
  } else {
    global.ReliefRender = factory(global.ReliefMath, global.ReliefRay);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (M, ReliefRay) {
  'use strict';

  const MAX_W = 192;
  const MAX_H = 128;

  function validateCamera(cam) {
    const errors = [];
    const needVec = (v, name, len) => {
      if (!Array.isArray(v) || v.length !== len || !v.every(Number.isFinite)) {
        errors.push(`${name} 必须是 ${len} 个有限数`);
      }
    };
    if (!cam) { errors.push('缺少 camera'); return errors; }
    needVec(cam.o, 'camera.o', 3);
    needVec(cam.stepX, 'camera.stepX', 3);
    needVec(cam.stepY, 'camera.stepY', 3);
    needVec(cam.d, 'camera.d', 3);
    if (!Array.isArray(cam.t) || cam.t.length !== 2 ||
      !Number.isFinite(cam.t[0]) || !Number.isFinite(cam.t[1]) || cam.t[1] < cam.t[0]) {
      errors.push('camera.t 必须是 [tmin, tmax] 闭区间');
    }
    if (!Array.isArray(cam.size) || cam.size.length !== 2 ||
      !Number.isInteger(cam.size[0]) || !Number.isInteger(cam.size[1]) ||
      cam.size[0] <= 0 || cam.size[1] <= 0) {
      errors.push('camera.size 必须是两个正整数 [宽, 高]');
    } else if (cam.size[0] > MAX_W || cam.size[1] > MAX_H) {
      errors.push(`预览尺寸不能超过 ${MAX_W}×${MAX_H}`);
    }
    return errors;
  }

  // 第 (px, py) 个像素的世界射线（原点 = o + px*stepX + py*stepY，方向 d 原长度）
  function cameraRay(cam, px, py) {
    const add = (a, k, b) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
    let o = add(cam.o, px, cam.stepX);
    o = add(o, py, cam.stepY);
    return { o, d: cam.d.slice() };
  }

  function clamp01(x) { return Math.min(1, Math.max(0, x)); }

  // 深度归一化：t 在相机闭区间内线性映射到 [0,1]，近亮远暗
  function depthShade(t, cam) {
    const [lo, hi] = cam.t;
    if (hi === lo) return 1;
    return clamp01(1 - (t - lo) / (hi - lo));
  }

  function encodeNormal(n) {
    return [
      Math.round(clamp01(n[0] * 0.5 + 0.5) * 255),
      Math.round(clamp01(n[1] * 0.5 + 0.5) * 255),
      Math.round(clamp01(n[2] * 0.5 + 0.5) * 255),
    ];
  }

  /*
   * 渲染整个预览。
   * light: { d, t } 方向保留原长度，t 为阴影射线闭区间 [tmin, tmax]。
   * 返回 { width, height, pixels, depthRange }，
   * pixels[y][x] = { rgb, hit, trace, shadow }。
   */
  function render(field, cam, light) {
    const errors = validateCamera(cam);
    if (errors.length) throw new Error('相机参数无效：' + errors.join('；'));
    const [width, height] = cam.size;
    const pixels = [];
    let dMin = Infinity, dMax = -Infinity;

    for (let py = 0; py < height; py++) {
      const row = [];
      for (let px = 0; px < width; px++) {
        const { o, d } = cameraRay(cam, px, py);
        const trace = ReliefRay.traceRay(field, o, d, cam.t[0], cam.t[1]);
        const cell = { x: px, y: py, rgb: [24, 26, 32], hit: null, trace, shadow: null };

        if (trace.hit) {
          cell.hit = trace.hit;
          dMin = Math.min(dMin, trace.hit.t);
          dMax = Math.max(dMax, trace.hit.t);

          const sh = ReliefRay.shadowRay(field, trace.hit.point, light.d, light.t[0], light.t[1]);
          cell.shadow = sh;
          row.push(cell);
        } else {
          row.push(cell);
        }
      }
      pixels.push(row);
    }

    return { width, height, pixels, depthRange: [dMin, dMax] };
  }

  // 按指定模式着色（不重算射线）
  function shade(result, mode, cam, light) {
    const missBg = [24, 26, 32];
    const checker = [30, 33, 40];
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        const p = result.pixels[y][x];
        if (!p.hit) {
          p.rgb = ((x + y) & 1) ? checker : missBg;
          continue;
        }
        if (mode === 'depth') {
          const s = depthShade(p.hit.t, cam);
          const g = Math.round(255 * s);
          p.rgb = [g, g, g];
        } else if (mode === 'normal') {
          p.rgb = encodeNormal(p.hit.normal);
        } else {
          // lit：向上方定向光的朗伯受光，自阴影处压暗为环境光
          const L = M.normalize(light.d);
          const n = p.hit.normal;
          const ndl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
          const ambient = 0.12;
          const lit = p.shadow && p.shadow.shadowed ? ambient : ambient + 0.88 * ndl;
          p.rgb = [
            Math.round(255 * clamp01(lit)),
            Math.round(244 * clamp01(lit)),
            Math.round(225 * clamp01(lit)),
          ];
        }
      }
    }
  }

  // 写入 canvas（每像素一个方块，最近邻，保持锐利）
  function drawToCanvas(result, canvas, scale) {
    const s = scale || 4;
    canvas.width = result.width * s;
    canvas.height = result.height * s;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(result.width, result.height);
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        const [r, g, b] = result.pixels[y][x].rgb;
        const k = (y * result.width + x) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    // 先 1:1 放离屏再放大，保证最近邻
    const off = document.createElement('canvas');
    off.width = result.width; off.height = result.height;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  return {
    MAX_W, MAX_H,
    validateCamera, cameraRay, depthShade, encodeNormal,
    render, shade, drawToCanvas,
  };
});
