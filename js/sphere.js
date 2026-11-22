/* Orthographic sphere preview.
   Color at each pixel is the white-light RGB of the unpolarized reflectance
   spectrum at that pixel's incidence angle (azimuth carries no information for
   a parallel-film stack), plus a soft Lambert-like relief so the sphere reads
   as a sphere rather than flat rings. */
(function (global) {
  'use strict';

  function SphereView(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts; // {onPick(angleDeg)}
    this.angle = 0;
    this.rgbByAngle = null; // [[r,g,b], ...] per integer degree 0..85
    this._drag = false;
    this._bind();
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  SphereView.prototype.setData = function (rgbByAngle, angleDeg) {
    this.rgbByAngle = rgbByAngle;
    this.angle = angleDeg;
    this.render();
  };

  SphereView.prototype.setAngle = function (angleDeg) {
    this.angle = angleDeg;
    this.render();
  };

  SphereView.prototype._bind = function () {
    const pick = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const R = Math.min(rect.width, rect.height) / 2 - 2;
      const nx = (clientX - rect.left - cx) / R;
      const ny = (clientY - rect.top - cy) / R;
      const rho = Math.hypot(nx, ny);
      if (rho > 1) return;
      const theta = Math.asin(Math.min(1, rho)) * 180 / Math.PI;
      this.opts.onPick(Math.round(theta * 10) / 10);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this._drag = true;
      this.canvas.setPointerCapture(e.pointerId);
      pick(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this._drag) pick(e.clientX, e.clientY);
    });
    const end = () => { this._drag = false; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  };

  SphereView.prototype.render = function () {
    const cssSize = this.canvas.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(cssSize * dpr);
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssSize;
    const cx = W / 2;
    const cy = W / 2;
    const R = W / 2 - 2;
    ctx.clearRect(0, 0, W, W);

    if (!this.rgbByAngle) return;

    // Paint the sphere pixel-by-pixel at device resolution
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const table = this.rgbByAngle;
    const n = table.length - 1; // index 0..n maps 0..85 deg
    const rPx = R * dpr;
    const cPx = size / 2;
    for (let py = 0; py < size; py++) {
      const dy = (py - cPx) / rPx;
      for (let px = 0; px < size; px++) {
        const dx = (px - cPx) / rPx;
        const rho2 = dx * dx + dy * dy;
        if (rho2 > 1) continue;
        const theta = Math.asin(Math.min(1, Math.sqrt(rho2)));
        const deg = theta * 180 / Math.PI;
        const f = Math.max(0, Math.min(1, deg / 85)) * n;
        const i0 = Math.floor(f);
        const i1 = Math.min(n, i0 + 1);
        const frac = f - i0;
        const c0 = table[i0];
        const c1 = table[i1];
        // relief: gentle shading from a light at upper-left, never below 0.72
        const nz = Math.sqrt(Math.max(0, 1 - rho2));
        const shade = 0.72 + 0.28 * Math.max(0, -0.55 * dx - 0.55 * dy + 0.82 * nz);
        const o = (py * size + px) * 4;
        data[o] = Math.min(255, (c0[0] * (1 - frac) + c1[0] * frac) * shade);
        data[o + 1] = Math.min(255, (c0[1] * (1 - frac) + c1[1] * frac) * shade);
        data[o + 2] = Math.min(255, (c0[2] * (1 - frac) + c1[2] * frac) * shade);
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // rim
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssVar('--sphere-rim');
    ctx.stroke();

    // graticule: concentric rings every 15 deg and radial spokes every 30 deg
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = cssVar('--sphere-grid');
    ctx.lineWidth = 1;
    for (const deg of [15, 30, 45, 60, 75]) {
      const rr = R * Math.sin(deg * Math.PI / 180);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let a = 0; a < 360; a += 30) {
      const rad = a * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
      ctx.stroke();
    }
    ctx.restore();

    // current-angle marker: ring placed on the +x meridian (azimuth 0 deg)
    const mr = R * Math.sin(this.angle * Math.PI / 180);
    const mx = cx + mr;
    const my = cy;
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = cssVar('--marker-ring');
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--marker-dot');
    ctx.fill();

    // angle labels: 0 deg at the center pole, 85 deg on the rim meridian
    ctx.fillStyle = cssVar('--sphere-label');
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('0°', cx, cy + 14);
    ctx.textAlign = 'left';
    ctx.fillText('85°', cx + R - 30, cy - 8);
  };

  global.SphereView = SphereView;
})(typeof window !== 'undefined' ? window : globalThis);
