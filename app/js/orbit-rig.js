// 自包含轨道控制器：旋转 / 平移 / 缩放，触屏双指。不依赖 three 示例包。
import * as THREE from 'three';

export class OrbitRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3();
    this.spherical = new THREE.Spherical();
    this.minDistance = 0.05;
    this.maxDistance = 200;
    this.rotateSpeed = 0.005;
    this.panSpeed = 0.0015;
    this.zoomSpeed = 0.0012;
    this.enabled = true;
    this._pointers = new Map();
    this._mode = null; // 'rotate' | 'pan'
    this._last = new THREE.Vector2();
    this._pinchDist = 0;
    this.syncFromCamera();

    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  syncFromCamera() {
    const off = this.camera.position.clone().sub(this.target);
    this.spherical.setFromVector3(off);
  }

  setTarget(v) {
    const dir = this.camera.position.clone().sub(this.target);
    this.target.copy(v);
    this.camera.position.copy(v).add(dir);
    this.syncFromCamera();
  }

  frame(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.target.copy(center);
    this.spherical.radius = Math.max(size * 1.6, this.minDistance);
    this.spherical.phi = Math.PI * 0.38;
    this.spherical.theta = Math.PI * 0.25;
    this._apply();
  }

  _apply() {
    this.spherical.radius = Math.max(
      this.minDistance, Math.min(this.maxDistance, this.spherical.radius));
    this.spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, this.spherical.phi));
    const off = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(off);
    this.camera.lookAt(this.target);
  }

  _down(e) {
    if (!this.enabled) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._last.set(e.clientX, e.clientY);
    if (this._pointers.size === 1) {
      this._mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
    } else if (this._pointers.size === 2) {
      this._mode = 'pinch';
      const pts = [...this._pointers.values()];
      this._pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  }

  _move(e) {
    if (!this._pointers.has(e.pointerId) || !this.enabled) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size >= 2) {
      const pts = [...this._pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this._pinchDist > 0) {
        this.spherical.radius *= this._pinchDist / dist;
      }
      this._pinchDist = dist;
      // 双指平移
      const mid = new THREE.Vector2(
        (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      this._pan(mid.x - this._last.x, mid.y - this._last.y);
      this._last.copy(mid);
      this._apply();
      return;
    }

    const dx = e.clientX - this._last.x;
    const dy = e.clientY - this._last.y;
    this._last.set(e.clientX, e.clientY);
    if (this._mode === 'rotate') {
      this.spherical.theta -= dx * this.rotateSpeed;
      this.spherical.phi -= dy * this.rotateSpeed;
    } else if (this._mode === 'pan') {
      this._pan(dx, dy);
    }
    this._apply();
  }

  _pan(dx, dy) {
    const scale = this.spherical.radius * this.panSpeed;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
  }

  _up(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinchDist = 0;
    if (this._pointers.size === 1) {
      const p = [...this._pointers.values()][0];
      this._last.set(p.x, p.y);
      this._mode = 'rotate';
    }
    if (this._pointers.size === 0) this._mode = null;
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.spherical.radius *= 1 + Math.sign(e.deltaY) * this.zoomSpeed * 40;
    this._apply();
  }
}
