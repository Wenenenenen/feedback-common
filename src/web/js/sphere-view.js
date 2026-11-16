/*
 * 法线球：把所选 kind 的系数重建到球面，并支持点选方向读数值。
 *
 * 三条约束：
 *   - 颜色 = 当前 kind 的系数在 n 上的重建值（radiance 或 irradiance，二选一，绝不混用）。
 *   - 颜色只经过显示用曝光/色调映射；数值面板给的是线性值。
 *   - 投影为球面正交投影（`project` / `pickAt` 互为反函数），拖动可转向，
 *     单击选法线，双击回默认视角；背面（depth < 0）不绘制。
 * 无 WebGL、无外部依赖。
 */

import { evaluate, directionAngles, luminance } from './sh.js';
import { displayRgb } from './tonemap.js';

const DPR_CAP = 2;

export class NormalSphereView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   onSelect?:(dir:{x:number,y:number,z:number})=>void,
   *   onHover?:(dir:{x:number,y:number,z:number}|null)=>void,
   *   onViewChange?:(yaw:number,pitch:number)=>void
   * }} handlers
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
    // 默认视角朝向 +x 一侧（多数环境的亮瓣在 +x/+z 平面），+y 朝上
    this.yaw = 1.15;
    this.pitch = 0.3;
    this.coeffs = null;
    this.selected = { x: 1, y: 0, z: 0 };
    this.hover = null;
    this.display = { exposure: 1, mode: 'reinhard' };
    this._drag = null;
    this._imageCache = null;
    this._cacheKey = '';
    this._bound = false;
    this.bind();
  }

  bind() {
    if (this._bound) return;
    this._bound = true;
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      this._drag = { x: e.clientX, y: e.clientY, moved: 0, yaw: this.yaw, pitch: this.pitch };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this._drag) {
        const dx = e.clientX - this._drag.x;
        const dy = e.clientY - this._drag.y;
        this._drag.moved += Math.abs(dx) + Math.abs(dy);
        this.yaw = this._drag.yaw + dx * 0.01;
        this.pitch = Math.max(-1.35, Math.min(1.35, this._drag.pitch + dy * 0.01));
        this._cacheKey = '';
        this.handlers.onViewChange?.(this.yaw, this.pitch);
        this.draw();
        return;
      }
      const dir = this.pick(e);
      if (this.handlers.onHover) {
        if (dir && !sameDir(dir, this.hover)) {
          this.hover = dir;
          this.draw();
        } else if (!dir && this.hover) {
          this.hover = null;
          this.draw();
        }
      }
    });
    const finish = (e) => {
      if (!this._drag) return;
      const moved = this._drag.moved;
      this._drag = null;
      if (moved < 5) {
        const dir = this.pick(e);
        if (dir) {
          this.selected = dir;
          this.handlers.onSelect?.(dir);
          this.draw();
        }
      }
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => {
      this._drag = null;
    });
    canvas.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.handlers.onHover?.(null);
        this.draw();
      }
    });
    canvas.addEventListener('dblclick', () => {
      this.yaw = 1.15;
      this.pitch = 0.3;
      this._cacheKey = '';
      this.draw();
    });
  }

  setCoefficients(coeffs) {
    this.coeffs = coeffs;
    this._cacheKey = '';
  }

  setDisplay(display) {
    if (display.exposure === this.display.exposure && display.mode === this.display.mode) return;
    this.display = { ...this.display, ...display };
    this._cacheKey = '';
  }

  setSelected(dir) {
    this.selected = dir;
    this.draw();
  }

  /** 画布内的 (x,y) → 球面单位向量（正面 +z）。 */
  pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    return this.pickAt(px, py);
  }

  pickAt(px, py) {
    // 画布是正方形，球心在中心，半径 = 0.44（留出投影阴影与标注）
    const u = (px - 0.5) / 0.44;
    const v = (0.5 - py) / 0.44;
    const rr = u * u + v * v;
    const { right, up, forward } = this.cameraBasis();
    let dir;
    if (rr <= 1) {
      const w = Math.sqrt(Math.max(0, 1 - rr));
      dir = {
        x: u * right.x + v * up.x + w * forward.x,
        y: u * right.y + v * up.y + w * forward.y,
        z: u * right.z + v * up.z + w * forward.z,
      };
    } else {
      // 球外：投影到球面（选最近的可视方向）
      const len = Math.sqrt(rr) || 1;
      const uu = u / len;
      const vv = v / len;
      const w = 0;
      dir = {
        x: uu * right.x + vv * up.x + w * forward.x,
        y: uu * right.y + vv * up.y + w * forward.y,
        z: uu * right.z + vv * up.z + w * forward.z,
      };
    }
    const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return { x: dir.x / n, y: dir.y / n, z: dir.z / n };
  }

  /** 相机基（世界坐标）：forward 指向观察者（+z 方向的可视半球）。 */
  cameraBasis() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    // 相机方向（从原点指向相机）
    const forward = { x: cp * sy, y: sp, z: cp * cy };
    // 世界 +y 投影到屏幕 up
    let up = { x: 0, y: 1, z: 0 };
    // right = up × forward 归一化（镜像修正后屏幕上右 = +x）
    let right = {
      x: up.y * forward.z - up.z * forward.y,
      y: up.z * forward.x - up.x * forward.z,
      z: up.x * forward.y - up.y * forward.x,
    };
    let rl = Math.hypot(right.x, right.y, right.z);
    if (rl < 1e-6) {
      up = { x: 0, y: 0, z: -1 };
      right = {
        x: up.y * forward.z - up.z * forward.y,
        y: up.z * forward.x - up.x * forward.z,
        z: up.x * forward.y - up.y * forward.x,
      };
      rl = Math.hypot(right.x, right.y, right.z) || 1;
    }
    right = { x: right.x / rl, y: right.y / rl, z: right.z / rl };
    // 再把 up 正交化：up = forward × right
    up = {
      x: forward.y * right.z - forward.z * right.y,
      y: forward.z * right.x - forward.x * right.z,
      z: forward.x * right.y - forward.y * right.x,
    };
    return { right, up, forward };
  }

  /** 把世界方向投影到画布像素坐标；返回 {x,y,visible}。 */
  project(dir, w, h) {
    const { right, up, forward } = this.cameraBasis();
    const u = dir.x * right.x + dir.y * right.y + dir.z * right.z;
    const v = dir.x * up.x + dir.y * up.y + dir.z * up.z;
    const wp = dir.x * forward.x + dir.y * forward.y + dir.z * forward.z;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.44;
    return { x: cx + u * radius, y: cy - v * radius, visible: wp >= 0, depth: wp };
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    const cssW = Math.max(1, Math.round(canvas.clientWidth || 420));
    const cssH = cssW; // 正方形
    const dpr = Math.min(DPR_CAP, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this._cacheKey = '';
    }
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const key = `${this.yaw.toFixed(4)}|${this.pitch.toFixed(4)}|${w}|${h}|${
      this.display.exposure}|${this.display.mode}|${this.coeffs ? this.coeffs.length : 0}`;
    if (this._cacheKey !== key || !this._imageCache || !this.coeffs) {
      this._imageCache = this.renderSphereImage(w, h);
      this._cacheKey = key;
    }
    const off = getSphereCanvas(w, h);
    off.ctx.putImageData(this._imageCache, 0, 0);
    ctx.drawImage(off.canvas, 0, 0);

    this.drawOverlay(ctx, w, h, dpr);
  }

  renderSphereImage(w, h) {
    const image = new ImageData(w, h);
    this._pixels = image;
    const data = image.data;
    const radius = Math.min(w, h) * 0.44;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rgbLinear = new Float64Array(3);
    const out = [0, 0, 0];

    for (let y = 0; y < h; y++) {
      const v = (cy - y) / radius;
      for (let x = 0; x < w; x++) {
        const u = (x - cx) / radius;
        const rr = u * u + v * v;
        const d = (y * w + x) * 4;
        if (rr > 1) {
          data[d + 3] = 0;
          continue;
        }
        const ww = Math.sqrt(1 - rr);
        const px = (x + 0.5 - cx) / radius;
        const py = (cy - (y + 0.5)) / radius;
        const dir = this.unproject(px, py, ww);
        if (!this.coeffs) {
          data[d] = 44;
          data[d + 1] = 46;
          data[d + 2] = 52;
          data[d + 3] = 255;
          continue;
        }
        evaluate(this.coeffs, dir.x, dir.y, dir.z, rgbLinear);
        out[0] = rgbLinear[0];
        out[1] = rgbLinear[1];
        out[2] = rgbLinear[2];
        const rgb = displayRgb(out, this.display.exposure, this.display.mode, TMP);
        // 球缘轻微压暗，读得出立体
        const shade = 0.72 + 0.28 * Math.pow(ww, 0.5);
        data[d] = Math.round(rgb[0] * shade);
        data[d + 1] = Math.round(rgb[1] * shade);
        data[d + 2] = Math.round(rgb[2] * shade);
        data[d + 3] = 255;
      }
    }
    return image;
  }

  unproject(u, v, ww) {
    const { right, up, forward } = this.cameraBasis();
    const dir = {
      x: u * right.x + v * up.x + ww * forward.x,
      y: u * right.y + v * up.y + ww * forward.y,
      z: u * right.z + v * up.z + ww * forward.z,
    };
    const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return { x: dir.x / n, y: dir.y / n, z: dir.z / n };
  }

  drawOverlay(ctx, w, h, dpr) {
    const radius = Math.min(w, h) * 0.44;
    const cx = w * 0.5;
    const cy = h * 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 三个坐标轴（背面虚线）
    const axes = [
      { dir: { x: 1, y: 0, z: 0 }, label: '+x', color: '#3987e5' },
      { dir: { x: 0, y: 1, z: 0 }, label: '+y', color: '#1baf7a' },
      { dir: { x: 0, y: 0, z: 1 }, label: '+z', color: '#eda100' },
    ];
    ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const axis of axes) {
      const a = this.project(axis.dir, w, h);
      const b = this.project({ x: -axis.dir.x, y: -axis.dir.y, z: -axis.dir.z }, w, h);
      ctx.strokeStyle = axis.color;
      ctx.globalAlpha = a.depth >= 0 || b.depth >= 0 ? 0.85 : 0.28;
      ctx.lineWidth = Math.max(1.2, 1.4 * dpr);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(a.depth >= 0 ? cx : a.x, a.depth >= 0 ? cy : a.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (a.visible) {
        ctx.fillStyle = axis.color;
        ctx.fillText(axis.label, a.x, a.y);
      }
    }

    // 所选法线
    if (this.selected) {
      const s = this.project(this.selected, w, h);
      ctx.globalAlpha = s.visible ? 1 : 0.4;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, 1.8 * dpr);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(3, 4 * dpr), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b0b0b';
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.2, 1.6 * dpr), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /** 屏幕上一次点击后，返回该方向的数值读数。 */
  readout(dir) {
    if (!this.coeffs) return null;
    const rgb = new Float64Array(3);
    evaluate(this.coeffs, dir.x, dir.y, dir.z, rgb);
    const { theta, phi } = directionAngles(dir.x, dir.y, dir.z);
    return {
      direction: dir,
      theta,
      phi,
      rgb: [rgb[0], rgb[1], rgb[2]],
      luminance: luminance(rgb),
    };
  }
}

const TMP = [0, 0, 0];

function sameDir(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-6;
}


let sphereCanvas = null;
function getSphereCanvas(w, h) {
  if (!sphereCanvas || sphereCanvas.canvas.width !== w || sphereCanvas.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    sphereCanvas = { canvas, ctx: canvas.getContext('2d') };
  }
  return sphereCanvas;
}
