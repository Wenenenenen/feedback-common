/*
 * camera.js — 相机基架与投影
 *
 * 约定（见样例《格式说明.md》）：
 *   forward = normalize(target - origin)
 *   right   = normalize(cross(up, forward))
 *   upReal  = cross(forward, right)
 *   视空间 Z 为正向距离（相机前方为正）。
 * 投影采用 0 <= z_clip <= w：
 *   正交:   (x,y,z,1) -> clip；ndc_z = (z-near)/(far-near)
 *   透视:   ndc_z = far/(far-near) - far*near/((far-near)*z)
 *   即 NDC 深度落在 [0,1]，越小越靠近相机。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});
  const M = HLM.math;

  function createCamera(spec) {
    const origin = spec.origin.slice();
    const target = spec.target.slice();
    const upHint = spec.up.slice();
    const forward = M.normalize(M.sub(target, origin));
    let right = M.normalize(M.cross(upHint, forward));
    if (M.length(right) < 1e-12) {
      // up 与 forward 平行时的兜底：换一个参考向量
      const ref = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      right = M.normalize(M.cross(ref, forward));
    }
    const upReal = M.cross(forward, right);

    const cam = {
      type: spec.type === 'perspective' ? 'perspective' : 'orthographic',
      origin, target, forward, right, up: upReal,
      near: spec.near, far: spec.far, aspect: spec.aspect,
      height: spec.height, fovY: spec.fov_y,
    };
    cam.projScale = projectionScales(cam);
    return cam;
  }

  /** 返回视空间 x/y 的投影缩放（clip = view * scale） */
  function projectionScales(cam) {
    if (cam.type === 'orthographic') {
      const sy = 2 / cam.height;
      return { sx: sy / cam.aspect, sy };
    }
    const sy = 1 / Math.tan(M.deg2rad(cam.fovY) / 2);
    return { sx: sy / cam.aspect, sy };
  }

  /** 世界坐标 -> 视空间坐标（z 为正向距离） */
  function toView(cam, p) {
    const d = M.sub(p, cam.origin);
    return [M.dot(d, cam.right), M.dot(d, cam.up), M.dot(d, cam.forward)];
  }

  /**
   * 视空间 -> 齐次裁剪坐标 [cx, cy, cz, cw]
   * 满足 0 <= cz <= cw 的裁剪约定。
   */
  function viewToClip(cam, v) {
    const { sx, sy } = cam.projScale;
    const n = cam.near, f = cam.far;
    if (cam.type === 'orthographic') {
      return [v[0] * sx, v[1] * sy, (v[2] - n) / (f - n), 1];
    }
    // 透视：cz/cw = f/(f-n) - f*n/((f-n)*z)
    return [
      v[0] * sx,
      v[1] * sy,
      (f * v[2] - f * n) / (f - n),
      v[2],
    ];
  }

  function worldToClip(cam, p) {
    return viewToClip(cam, toView(cam, p));
  }

  /** 齐次裁剪坐标 -> NDC（裁剪保证 w>0） */
  function clipToNdc(c) {
    return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
  }

  function worldToNdc(cam, p) {
    return clipToNdc(worldToClip(cam, p));
  }

  /**
   * NDC -> 屏幕像素。SVG/Canvas 左上为原点：
   * ndc y = +1（画面上方）映射到 y = 0。
   */
  function ndcToScreen(ndc, width, height) {
    return [
      (ndc[0] + 1) * 0.5 * width,
      (1 - ndc[1]) * 0.5 * height,
    ];
  }

  HLM.camera = {
    createCamera, toView, viewToClip, worldToClip, clipToNdc,
    worldToNdc, ndcToScreen, projectionScales,
  };
})(typeof window !== 'undefined' ? window : globalThis);
