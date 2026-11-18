/*
 * render.js — 320×240 纯 CPU 光线步进渲染
 * 轨道相机（azimuth/elevation/distance），按叶节点着色，
 * 差集内壁（negated）降明度区分；miss 与 iteration_limit 用不同底色。
 */
(function (global, factory) {
  const deps = (typeof module === 'object' && module.exports)
    ? { Mat4: require('./mat4.js'), RayMarch: require('./raymarch.js') }
    : { Mat4: global.Mat4, RayMarch: global.RayMarch };
  const mod = factory(deps.Mat4, deps.RayMarch);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else global.Render = mod;
})(typeof self !== 'undefined' ? self : globalThis, function (Mat4, RayMarch) {
  'use strict';

  const WIDTH = 320;
  const HEIGHT = 240;
  const FOV_Y = (50 * Math.PI) / 180;

  // 稳定的按 id 调色板（HSL 均分，亮度固定）
  function leafColor(id, index, total, negated) {
    const hue = Math.round((index * 360) / Math.max(total, 1) + 17) % 360;
    const sat = 62;
    const light = negated ? 30 : 62;
    return hslToRgb(hue, sat, light);
  }

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
  }

  function makeCamera() {
    return { azimuth: 0.6, elevation: 0.35, distance: 6, target: [0, 0, 0] };
  }

  function cameraPosition(cam) {
    const ce = Math.cos(cam.elevation), se = Math.sin(cam.elevation);
    const ca = Math.cos(cam.azimuth), sa = Math.sin(cam.azimuth);
    const [tx, ty, tz] = cam.target;
    return [
      tx + cam.distance * ce * sa,
      ty + cam.distance * se,
      tz + cam.distance * ce * ca,
    ];
  }

  // 相机基轴：forward / right / up
  function cameraBasis(cam) {
    const eye = cameraPosition(cam);
    const forward = Mat4.normalize3(Mat4.sub3(cam.target, eye));
    const worldUp = [0, 1, 0];
    const right = Mat4.normalize3(Mat4.cross3(forward, worldUp));
    const up = Mat4.cross3(right, forward);
    return { eye, forward, right, up };
  }

  // 像素 (px,py)（左上原点）对应世界射线
  function pixelRay(cam, px, py) {
    const { eye, forward, right, up } = cameraBasis(cam);
    const aspect = WIDTH / HEIGHT;
    const tanHalf = Math.tan(FOV_Y / 2);
    const nx = ((px + 0.5) / WIDTH) * 2 - 1;
    const ny = 1 - ((py + 0.5) / HEIGHT) * 2;
    let dir = Mat3.addScaled(forward, right, nx * tanHalf * aspect);
    dir = Mat3.addScaled(dir, up, ny * tanHalf);
    dir = Mat4.normalize3(dir);
    return { origin: eye, direction: dir };
  }

  // 小向量辅助（避免给 mat4 加一堆只在这里用的函数）
  const Mat3 = {
    addScaled(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; },
  };

  const MISS_RGB = [16, 19, 26];
  const LIMIT_RGB = [92, 62, 24];   // 耗尽：暗琥珀，与未命中的深蓝灰区分

  /*
   * 渲染到 ImageData。
   * leafIndex: Map<leafId, number>；返回统计与每个像素的命中信息（供点击拾取）。
   */
  function render(tree, cam, imageData, leafIndex, leafCount, maxSteps) {
    const data = imageData.data;
    const pixelInfo = new Array(WIDTH * HEIGHT);
    const stats = { hit: 0, miss: 0, iteration_limit: 0 };
    const lightDir = Mat4.normalize3([0.4, 0.8, 0.5]);

    let pi = 0;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++, pi++) {
        const ray = pixelRay(cam, px, py);
        const r = RayMarch.traceShade(tree, ray.origin, ray.direction, maxSteps);
        stats[r.status] = (stats[r.status] || 0) + 1;
        let rgb;
        if (r.status === 'hit') {
          const base = leafColor(r.leaf, leafIndex.get(r.leaf) || 0, leafCount, r.negated);
          const lambert = Math.max(0, Mat4.dot3(r.normal, lightDir));
          const shade = 0.35 + 0.65 * lambert;
          rgb = base.map((v) => Math.round(Math.min(255, v * shade)));
          pixelInfo[pi] = {
            leaf: r.leaf, negated: r.negated, t: r.t,
            point: r.point, normal: r.normal,
          };
        } else if (r.status === 'miss') {
          rgb = MISS_RGB;
        } else {
          rgb = LIMIT_RGB;
        }
        const o = pi * 4;
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
      }
    }
    return { stats, pixelInfo };
  }

  return { WIDTH, HEIGHT, FOV_Y, makeCamera, cameraPosition, cameraBasis, pixelRay, render, leafColor, MISS_RGB, LIMIT_RGB };
});
