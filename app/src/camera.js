/* 正交相机：轨道旋转/缩放，提供 worldToScreen（像素）与报告所需矩阵 */
(function (global) {
  'use strict';

  const { v3, m4 } = global.Math3D;

  class OrthoCamera {
    constructor(params) {
      this.width = params.width || 800;
      this.height = params.height || 600;
      this.verticalSpan = params.vertical_span || 3;
      this.target = v3.clone(params.target || [0, 0, 0]);
      this.upHint = v3.norm(params.up || [0, 1, 0]);

      // 以球坐标表示位置
      const offset = v3.sub(params.position || [3, 3, 4], this.target);
      this.radius = v3.len(offset) || 1;
      const dir = v3.norm(offset);
      this.theta = Math.atan2(dir[0], dir[2]); // 绕 y 方位角
      this.phi = Math.acos(Math.min(1, Math.max(-1, dir[1]))); // 与 +y 夹角
      this.near = 0.1;
      this.far = 200;
      this._updateMatrices();
    }

    get aspect() {
      return this.width / this.height;
    }

    get position() {
      const sp = Math.sin(this.phi);
      return [
        this.target[0] + this.radius * sp * Math.sin(this.theta),
        this.target[1] + this.radius * Math.cos(this.phi),
        this.target[2] + this.radius * sp * Math.cos(this.theta),
      ];
    }

    get up() {
      return this.upHint;
    }

    _updateMatrices() {
      this.viewMatrix = m4.lookAt(this.position, this.target, this.upHint);
      this.projectionMatrix = m4.ortho(this.verticalSpan, this.aspect, this.near, this.far);
      this.viewProjection = m4.multiply(this.projectionMatrix, this.viewMatrix);
    }

    rotate(dTheta, dPhi) {
      this.theta += dTheta;
      this.phi = Math.min(Math.PI - 1e-4, Math.max(1e-4, this.phi + dPhi));
      this._updateMatrices();
    }

    /* factor>1 放大（视野收窄） */
    zoom(factor) {
      this.verticalSpan = Math.min(1000, Math.max(1e-3, this.verticalSpan / factor));
      this._updateMatrices();
    }

    pan(dxScreen, dyScreen) {
      const forward = v3.norm(v3.sub(this.target, this.position));
      const right = v3.norm(v3.cross(forward, this.upHint));
      const up = v3.norm(v3.cross(forward, right));
      const sx = (dxScreen / this.height) * this.verticalSpan;
      const sy = (dyScreen / this.height) * this.verticalSpan;
      const shift = v3.add(v3.scale(right, -sx), v3.scale(up, sy));
      this.target = v3.add(this.target, shift);
      this._updateMatrices();
    }

    setSize(width, height) {
      this.width = width;
      this.height = height;
      this._updateMatrices();
    }

    /* 世界坐标 -> 屏幕像素坐标 [px, py, depth] */
    worldToScreen(p) {
      const c = m4.transformPoint(this.viewProjection, p);
      const w = c[3] || 1;
      const ndcX = c[0] / w;
      const ndcY = c[1] / w;
      return [
        (ndcX + 1) * 0.5 * this.width,
        (1 - ndcY) * 0.5 * this.height, // 屏幕 y 向下
        c[2] / w,
      ];
    }

    /* 两个世界点投影后的像素距离（误差度量核心） */
    screenDistance(worldA, worldB) {
      const a = this.worldToScreen(worldA);
      const b = this.worldToScreen(worldB);
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }

    /* 射线：屏幕像素 -> 世界空间射线 {origin, dir}，用于控制点拾取 */
    screenRay(px, py) {
      const ndcX = (px / this.width) * 2 - 1;
      const ndcY = 1 - (py / this.height) * 2;
      const h = this.verticalSpan / 2;
      const w = h * this.aspect;
      const eye = this.position;
      const forward = v3.norm(v3.sub(this.target, eye));
      const right = v3.norm(v3.cross(forward, this.upHint));
      const up = v3.norm(v3.cross(forward, right));
      const center = v3.add(eye, v3.scale(forward, 1));
      const p = v3.add(
        v3.add(center, v3.scale(right, ndcX * w)),
        v3.scale(up, ndcY * h)
      );
      return { origin: eye, dir: v3.norm(v3.sub(p, eye)) };
    }

    /* 报告用相机数据（含像素宽高与矩阵，列主序普通数组） */
    describe() {
      return {
        width: this.width,
        height: this.height,
        vertical_span: this.verticalSpan,
        position: this.position,
        target: v3.clone(this.target),
        up: v3.clone(this.upHint),
        near: this.near,
        far: this.far,
        view_matrix: Array.from(this.viewMatrix),
        projection_matrix: Array.from(this.projectionMatrix),
        view_projection_matrix: Array.from(this.viewProjection),
      };
    }
  }

  const api = { OrthoCamera };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Camera = api;
})(typeof window !== 'undefined' ? window : globalThis);
