// view3d.js — 纯 Canvas 三维查看器：轨道旋转、凸包面、扬声器、源方向射线、点击点查
(function () {
  const CAM_DIST = 3.2;

  class View3D {
    constructor(canvas, scene) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.scene = scene;
      this.yaw = -0.6;
      this.pitch = 0.35;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.highlightFace = -1;
      this.sourceVec = null;          // 当前帧方向（已缩放）
      this.zero = false;
      this.onPick = null;             // 回调 (info)
      this._drag = null;
      this._bind();
      this.resize();
    }

    setScene(scene) {
      this.scene = scene;
      this.highlightFace = -1;
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._computeScale();
      this.draw();
    }

    // 扬声器坐标缩放到单位球显示
    _scaled(vi) {
      const c = this.scene.coords[vi];
      const k = 1 / this.scene.radius;
      return [c[0] * k, c[1] * k, c[2] * k];
    }

    _computeScale() {
      this.cx = this.w / 2;
      this.cy = this.h / 2;
      this.scale = Math.min(this.w, this.h) * 0.36;
    }

    _rot() {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // 世界 -> 相机：先绕 y（yaw），再绕 x（pitch）
      return (p) => {
        const x1 = p[0] * cy - p[2] * sy;
        const z1 = p[0] * sy + p[2] * cy;
        const y2 = p[1] * cp - z1 * sp;
        const z2 = p[1] * sp + z1 * cp;
        return [x1, y2, z2];
      };
    }

    _project(p) {
      const r = this._rot()(p);
      const f = CAM_DIST / (CAM_DIST - r[2]);
      return { x: this.cx + r[0] * this.scale * f, y: this.cy - r[1] * this.scale * f, z: r[2] };
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => {
        this._drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (!this._drag) { this._hoverPick(e); return; }
        const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this._drag.moved = true;
        this.yaw = this._drag.yaw - dx * 0.01;
        this.pitch = Math.max(-1.45, Math.min(1.45, this._drag.pitch + dy * 0.01));
        this.draw();
      });
      const end = (e) => {
        if (this._drag && !this._drag.moved) this._clickPick(e);
        this._drag = null;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', () => { this._drag = null; });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoom = (this.zoom || 1) * (e.deltaY > 0 ? 1.08 : 0.92);
        this.zoom = Math.max(0.5, Math.min(2.5, this.zoom));
        this.scale = Math.min(this.w, this.h) * 0.36 * this.zoom;
        this.draw();
      }, { passive: false });
    }

    _facesAt(px, py) {
      // 投影每个面片，命中测试（取 z 最小者）
      const hits = [];
      for (let fi = 0; fi < this.scene.faces.length; fi++) {
        const f = this.scene.faces[fi];
        const pts = f.v.map((vi) => this._project(this._scaled(vi)));
        if (this._pointInTri(px, py, pts)) {
          const zavg = (pts[0].z + pts[1].z + pts[2].z) / 3;
          hits.push({ fi, z: zavg });
        }
      }
      hits.sort((a, b) => a.z - b.z);
      return hits;
    }

    _pointInTri(px, py, t) {
      const d1 = this._sign(px, py, t[0], t[1]);
      const d2 = this._sign(px, py, t[1], t[2]);
      const d3 = this._sign(px, py, t[2], t[0]);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(neg && pos);
    }
    _sign(px, py, a, b) {
      return (px - b.x) * (a.y - b.y) - (b.x - a.x) * (py - b.y);
    }

    _clickPick(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const hits = this._facesAt(px, py);
      if (hits.length && this.onPick) {
        this.highlightFace = hits[0].fi;
        this.onPick({ type: 'face', faceIndex: hits[0].fi, all: hits.map((h) => h.fi) });
        this.draw();
      } else {
        // 扬声器点查
        const sp = this._speakerAt(px, py);
        if (sp >= 0 && this.onPick) {
          this.onPick({ type: 'speaker', index: sp });
        }
      }
    }

    _hoverPick(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      this.canvas.style.cursor = (this._facesAt(px, py).length || this._speakerAt(px, py) >= 0) ? 'pointer' : 'default';
    }

    _speakerAt(px, py) {
      let best = -1, bd = 14;
      for (let vi = 0; vi < this.scene.n; vi++) {
        const p = this._project(this._scaled(vi));
        const d = Math.hypot(p.x - px, p.y - py);
        if (d < bd) { bd = d; best = vi; }
      }
      return best;
    }

    setFrame({ faceIndex, sourceVec, zero }) {
      this.highlightFace = faceIndex;
      this.sourceVec = sourceVec;
      this.zero = !!zero;
      this.draw();
    }

    draw() {
      if (!this.scene) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      this._drawGrid();
      this._drawFaces();
      this._drawSource();
      this._drawSpeakers();
      this._drawOrigin();
    }

    _drawGrid() {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || 'rgba(127,127,127,.18)';
      ctx.lineWidth = 1;
      const R = 1.05;
      for (const axis of [[[R, 0, 0], [-R, 0, 0]], [[0, R, 0], [0, -R, 0]], [[0, 0, R], [0, 0, -R]]]) {
        const a = this._project(axis[0]), b = this._project(axis[1]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }

    _drawFaces() {
      const ctx = this.ctx;
      const styles = getComputedStyle(document.documentElement);
      const faceFill = styles.getPropertyValue('--face-fill').trim();
      const faceEdge = styles.getPropertyValue('--face-edge').trim();
      const hotFill = styles.getPropertyValue('--face-hot').trim();
      for (let fi = 0; fi < this.scene.faces.length; fi++) {
        const f = this.scene.faces[fi];
        const pts = f.v.map((vi) => this._project(this._scaled(vi)));
        const hot = fi === this.highlightFace;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.closePath();
        ctx.fillStyle = hot ? hotFill : faceFill;
        ctx.fill();
        ctx.strokeStyle = hot ? styles.getPropertyValue('--accent').trim() : faceEdge;
        ctx.lineWidth = hot ? 2 : 1;
        ctx.stroke();
      }
    }

    _drawSpeakers() {
      const ctx = this.ctx;
      const styles = getComputedStyle(document.documentElement);
      const spColor = styles.getPropertyValue('--speaker').trim();
      const activeColor = styles.getPropertyValue('--accent').trim();
      const activeSet = new Set();
      if (this.highlightFace >= 0) {
        this.scene.faces[this.highlightFace].vSorted.forEach((vi) => activeSet.add(vi));
      }
      for (let vi = 0; vi < this.scene.n; vi++) {
        const p = this._project(this._scaled(vi));
        const active = activeSet.has(vi);
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = active ? activeColor : spColor;
        ctx.fill();
        ctx.strokeStyle = styles.getPropertyValue('--speaker-ring').trim();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = styles.getPropertyValue('--fg').trim();
        ctx.font = '600 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(this.scene.ids[vi]), p.x, p.y - 10);
      }
    }

    _drawOrigin() {
      const ctx = this.ctx;
      const p = this._project([0, 0, 0]);
      const styles = getComputedStyle(document.documentElement);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = styles.getPropertyValue('--origin').trim();
      ctx.fill();
    }

    _drawSource() {
      if (!this.sourceVec) return;
      const ctx = this.ctx;
      const styles = getComputedStyle(document.documentElement);
      // 归一到单位球方向显示
      const l = Math.hypot(this.sourceVec[0], this.sourceVec[1], this.sourceVec[2]);
      const tip = this.sourceVec.map((x) => (x / l) * 1.25);
      const a = this._project([0, 0, 0]);
      const b = this._project(tip);
      ctx.save();
      ctx.strokeStyle = this.zero
        ? styles.getPropertyValue('--danger').trim()
        : styles.getPropertyValue('--source').trim();
      ctx.lineWidth = 2.5;
      ctx.setLineDash(this.zero ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // 箭头
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 9 * Math.cos(ang - 0.4), b.y - 9 * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - 9 * Math.cos(ang + 0.4), b.y - 9 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  window.View3D = View3D;
})();
