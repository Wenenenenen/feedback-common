/* sliceview.js — 三轴切片 Canvas 渲染与框选交互，纯手写。 */
'use strict';
window.VF = window.VF || {};

VF.CLASS_COLORS = {
  1: '#e8e2d0', // SURFACE
  2: '#1b2538', // EXTERIOR（与底色接近，画网格区分）
  3: '#7c6cf0', // SOLID_INTERIOR
  4: '#27c093', // EMPTY_CAVITY
};
// 16 材质的稳定调色板（表面体素按材质着色时用）
VF.MATERIAL_COLORS = [
  '#e8e2d0', '#5b8def', '#f0a35e', '#ef6e6e', '#38d6c0',
  '#b48cf0', '#8fd35c', '#f0d35e', '#5ec8f0', '#f07ebc',
  '#c9a06b', '#9aa7c7', '#6bf0a8', '#f0955e', '#8f9bf0', '#e0e060',
];

VF.SliceView = class {
  constructor(canvas, getCtx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getCtx = getCtx; // 返回 { st, opts }
    this.axis = 2;        // 0=x, 1=y, 2=z
    this.slice = 0;
    this.drag = null;     // 框选拖拽
    this.hover = null;
    this._bind();
  }

  setAxis(a) { this.axis = a; this.drag = null; this.draw(); }

  maxSlice() {
    const st = this.getCtx().st;
    if (!st) return 0;
    return st.dims[this.axis] - 1;
  }

  setSlice(s) {
    this.slice = Math.max(0, Math.min(this.maxSlice(), s | 0));
    this.draw();
  }

  // 切片平面上的两轴
  _planeAxes() {
    return this.axis === 0 ? [1, 2] : this.axis === 1 ? [0, 2] : [0, 1];
  }

  _voxelAt(ev) {
    const { st } = this.getCtx();
    const rect = this.canvas.getBoundingClientRect();
    const [au, av] = this._planeAxes();
    const nu = st.dims[au], nv = st.dims[av];
    const cell = Math.min(rect.width / nu, rect.height / nv);
    const ox = (rect.width - cell * nu) / 2;
    const oy = (rect.height - cell * nv) / 2;
    const u = Math.floor((ev.clientX - rect.left - ox) / cell);
    const v = Math.floor((ev.clientY - rect.top - oy) / cell);
    if (u < 0 || u >= nu || v < 0 || v >= nv) return null;
    const coord = [0, 0, 0];
    coord[this.axis] = this.slice;
    coord[au] = u; coord[av] = v;
    return coord;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      const p = this._voxelAt(ev);
      if (!p) return;
      this.drag = { p0: p, p1: p, button: ev.button };
      c.setPointerCapture(ev.pointerId);
      this.draw();
    });
    c.addEventListener('pointermove', (ev) => {
      const p = this._voxelAt(ev);
      this.hover = p;
      if (this.drag && p) { this.drag.p1 = p; this.draw(); }
      else this.draw();
    });
    c.addEventListener('pointerup', (ev) => {
      if (!this.drag) return;
      const d = this.drag; this.drag = null;
      if (d.button === 2) return;
      // SPEC §6 框顺序：[i0, i1, j0, j1, k0, k1]
      const b = [
        Math.min(d.p0[0], d.p1[0]), Math.max(d.p0[0], d.p1[0]),
        Math.min(d.p0[1], d.p1[1]), Math.max(d.p0[1], d.p1[1]),
        Math.min(d.p0[2], d.p1[2]), Math.max(d.p0[2], d.p1[2]),
      ];
      this.onBoxSelect && this.onBoxSelect(b);
      this.draw();
    });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  draw() {
    const { st, opts } = this.getCtx();
    if (!st) return;
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) {
      this.canvas.width = W * dpr; this.canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#11182a';
    ctx.fillRect(0, 0, W, H);
    const [au, av] = this._planeAxes();
    const nu = st.dims[au], nv = st.dims[av];
    const cell = Math.floor(Math.min(W / nu, H / nv));
    const ox = Math.floor((W - cell * nu) / 2);
    const oy = Math.floor((H - cell * nv) / 2);
    const { Nx, Sxy } = st;
    const idxOf = (u, v) => {
      const coord = [0, 0, 0];
      coord[this.axis] = this.slice; coord[au] = u; coord[av] = v;
      return coord[0] + coord[1] * Nx + coord[2] * Sxy;
    };

    // 漏孔集合（本切片相关）
    const leakSet = new Set();
    if (st.leaks && st.leaks.length) {
      for (const p of st.leaks) {
        for (const q of [p.fromExterior, p.toEnclosed]) {
          if (q[this.axis] === this.slice) leakSet.add(q[0] + q[1] * Nx + q[2] * Sxy);
        }
      }
    }

    for (let v = 0; v < nv; v++) {
      for (let u = 0; u < nu; u++) {
        const idx = idxOf(u, v);
        const cls = st.classification[idx];
        let fill;
        if (cls === 1) {
          fill = opts.colorByMaterial && st.surfMat[idx] >= 0
            ? VF.MATERIAL_COLORS[(st.surfMat[idx] - 1) % 16]
            : VF.CLASS_COLORS[1];
        } else fill = VF.CLASS_COLORS[cls] || '#222';
        ctx.fillStyle = fill;
        ctx.fillRect(ox + u * cell, oy + v * cell, cell, cell);
        if (leakSet.has(idx)) {
          ctx.fillStyle = 'rgba(255,84,112,.85)';
          ctx.beginPath();
          ctx.arc(ox + u * cell + cell / 2, oy + v * cell + cell / 2, Math.max(2, cell / 3), 0, 7);
          ctx.fill();
        }
      }
    }
    // 网格线
    if (cell >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let u = 0; u <= nu; u++) { ctx.moveTo(ox + u * cell + .5, oy); ctx.lineTo(ox + u * cell + .5, oy + nv * cell); }
      for (let v = 0; v <= nv; v++) { ctx.moveTo(ox, oy + v * cell + .5); ctx.lineTo(ox + nu * cell, oy + v * cell + .5); }
      ctx.stroke();
    }
    ctx.strokeStyle = '#5b8def';
    ctx.strokeRect(ox + .5, oy + .5, nu * cell - 1, nv * cell - 1);

    // 框选矩形
    if (this.drag) {
      const c0 = this.drag.p0, c1 = this.drag.p1;
      const u0 = Math.min(c0[au], c1[au]), u1 = Math.max(c0[au], c1[au]);
      const v0 = Math.min(c0[av], c1[av]), v1 = Math.max(c0[av], c1[av]);
      ctx.fillStyle = 'rgba(91,141,239,.22)';
      ctx.strokeStyle = '#9cc0ff';
      ctx.lineWidth = 2;
      ctx.fillRect(ox + u0 * cell, oy + v0 * cell, (u1 - u0 + 1) * cell, (v1 - v0 + 1) * cell);
      ctx.strokeRect(ox + u0 * cell, oy + v0 * cell, (u1 - u0 + 1) * cell, (v1 - v0 + 1) * cell);
    }
    this._cell = cell; this._origin = [ox, oy];
  }

  infoAt() {
    if (!this.hover) return null;
    const { st } = this.getCtx();
    const [i, j, k] = this.hover;
    const idx = i + j * st.Nx + k * st.Sxy;
    return {
      coord: this.hover.slice(),
      cls: VF.CLASS_NAME[st.classification[idx]],
      material: st.surfMat[idx],
      triId: st.surfTri[idx],
      d2: Number.isFinite(st.surfD2[idx]) ? st.surfD2[idx] : null,
    };
  }
};
