/* =============================================================================
   Boxed Hermite 提取器 — 3D stage + 2D slice renderer
   Hand-written WebGL-free canvas 3D (painter's algorithm). Depth is fine for
   the wireframe-on-isosurface look we need and keeps the page dependency-free.
   ========================================================================== */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const AXIS_NUM = { x: 0, y: 1, z: 2 };

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.hypot(a[0], a[1], a[2]); }
  function unit(a) { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function nodeWorldAt(origin, spacing, node) {
    return [
      origin[0] + spacing[0] * node[0],
      origin[1] + spacing[1] * node[1],
      origin[2] + spacing[2] * node[2],
    ];
  }

  // ---------------------------------------------------------------------------
  // Camera: orbit around a target, perspective projection.
  // ---------------------------------------------------------------------------

  class Camera {
    constructor() {
      this.yaw = -0.72;
      this.pitch = 0.46;
      this.distance = 3.2;
      this.target = [0, 0, 0];
      this.fov = 1.02;
    }

    basis() {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const eyeDir = [cp * sy, sp, cp * cy]; // from target toward eye
      const eye = add(this.target, scale(eyeDir, this.distance));
      const forward = unit(sub(this.target, eye));
      const right = unit(cross(forward, [0, 1, 0]));
      const up = cross(right, forward);
      return { eye: eye, forward: forward, right: right, up: up };
    }

    project(p, width, height) {
      const b = this.basis();
      const rel = sub(p, b.eye);
      const z = dot(rel, b.forward);
      if (z <= 1e-6) return null;
      const x = dot(rel, b.right);
      const y = dot(rel, b.up);
      const f = (height * 0.5) / Math.tan(this.fov * 0.5);
      return {
        x: width * 0.5 + (x / z) * f,
        y: height * 0.5 - (y / z) * f,
        z: z,
        scale: f / z,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Theme tokens read from CSS custom properties.
  // ---------------------------------------------------------------------------

  function readTheme(el) {
    const cs = getComputedStyle(el || document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: g('--stage') || '#f1f3ee',
      fg: g('--fg') || '#16211d',
      muted: g('--muted') || '#5d6a63',
      faint: g('--faint') || '#8b968f',
      line: g('--line') || '#d2d8cd',
      lineStrong: g('--line-strong') || '#b3bcae',
      accent: g('--accent') || '#0e7567',
      lower: g('--lower') || '#2d5aa0',
      upper: g('--upper') || '#a25c07',
      warm: g('--warm') || '#a25c07',
      danger: g('--danger') || '#a92e24',
      panel: g('--panel') || '#f7f8f4',
    };
  }

  function cssVarColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------------------------------------------------------------------------
  // Model → drawable geometry helpers
  // ---------------------------------------------------------------------------

  function boundsOf(origin, spacing, dims) {
    const lo = origin.slice();
    const hi = [
      origin[0] + spacing[0] * (dims[0] - 1),
      origin[1] + spacing[1] * (dims[1] - 1),
      origin[2] + spacing[2] * (dims[2] - 1),
    ];
    return { lo: lo, hi: hi, center: scale(add(lo, hi), 0.5), size: sub(hi, lo) };
  }

  function frameCamera(camera, bounds, aspect) {
    const s = bounds.size;
    const radius = 0.5 * Math.hypot(s[0], s[1], s[2]) || 1;
    camera.target = bounds.center.slice();
    camera.distance = radius / Math.tan(camera.fov * 0.5) * 1.02;
    // Keep perspective flattering for wide stages.
    if (aspect > 1.6) camera.distance *= 0.94;
  }

  // ---------------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------------

  class Scene {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.camera = new Camera();
      this.model = null;
      this.data = null;
      this.theme = readTheme(canvas);
      this.layers = { wire: true, iso: true, cells: true, hits: true, normals: true, unconstrained: false, guides: true };
      this.selection = null;
      this.hoverVertex = null;
      this._hoverIndex = null;
      this.slice = null;
      this.animating = false;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.onPick = null;
      this._bind();
      this.resize();
    }

    _bind() {
      const c = this.canvas;
      let dragging = false;
      let mode = 'orbit';
      let last = null;
      let moved = 0;

      const pointer = (ev) => {
        const r = c.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      };

      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        c.setPointerCapture(e.pointerId);
        dragging = true;
        moved = 0;
        mode = e.shiftKey ? 'pan' : 'orbit';
        last = pointer(e);
        c.parentElement.classList.add('dragging');
        e.preventDefault();
      });

      c.addEventListener('pointermove', (e) => {
        const p = pointer(e);
        if (dragging && last) {
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          moved += Math.abs(dx) + Math.abs(dy);
          if (mode === 'orbit') {
            this.camera.yaw -= dx * 0.008;
            this.camera.pitch = clamp(this.camera.pitch + dy * 0.007, -1.45, 1.45);
          } else {
            this._pan(dx, dy);
          }
          last = p;
          this.draw();
          e.preventDefault();
        } else {
          const cell = this._pickCell(p);
          const key = cell ? cell.v.index : null;
          if (key !== this._hoverIndex) {
            this._hoverIndex = key;
            this.hoverVertex = cell ? cell.v : null;
            this.draw();
            c.style.cursor = cell ? 'pointer' : 'grab';
          }
        }
      });

      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        last = null;
        c.parentElement.classList.remove('dragging');
        if (moved < 5 && this.onPick) {
          this.onPick(this._pickCell(pointer(e)), pointer(e));
        }
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', () => {
        dragging = false;
        last = null;
        c.parentElement.classList.remove('dragging');
      });

      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const f = Math.exp(e.deltaY * 0.0012);
        this.camera.distance = clamp(this.camera.distance * f, 0.05, 5000);
        this.draw();
      }, { passive: false });

      c.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _pan(dx, dy) {
      const b = this.camera.basis();
      const r = this.canvas.getBoundingClientRect();
      const fovScale = (2 * Math.tan(this.camera.fov * 0.5)) / Math.max(1, r.height);
      const dist = this.camera.distance * fovScale;
      this.camera.target = add(this.camera.target,
        add(scale(b.right, -dx * dist), scale(b.up, dy * dist)));
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.cssW = w;
      this.cssH = h;
      this.draw();
    }

    setTheme() {
      this.theme = readTheme(this.canvas);
      this.draw();
    }

    setScene(data, model) {
      const prevData = this.data;
      this.data = data;
      this.model = model;
      this.selection = null;
      if (data) {
        const b = boundsOf(data.origin, data.spacing, data.dims);
        this.bounds = b;
        if (data !== prevData) this._fitted = false;
        if (!this._fitted) {
          frameCamera(this.camera, b, this.cssW / Math.max(1, this.cssH));
          this._fitted = true;
        }
      }
      this.draw();
    }

    /** Fit the camera to the isosurface when one exists, else the domain. */
    fitToContent() {
      this._fitted = false;
      if (!this.data) { this.draw(); return; }
      const b = boundsOf(this.data.origin, this.data.spacing, this.data.dims);
      this.camera.target = b.center.slice();
      let radius = 0.5 * Math.hypot(b.size[0], b.size[1], b.size[2]) || 1;
      if (this.model && this.model.vertices.length) {
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        for (const v of this.model.vertices) {
          for (let i = 0; i < 3; i++) {
            mn[i] = Math.min(mn[i], v.position[i]);
            mx[i] = Math.max(mx[i], v.position[i]);
          }
        }
        // Grow by half a cell so the wireframe context stays visible.
        const pad = 1.5 * Math.max(this.data.spacing[0], this.data.spacing[1], this.data.spacing[2]);
        const centre = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
        const size = [mx[0] - mn[0] + pad, mx[1] - mn[1] + pad, mx[2] - mn[2] + pad];
        this.camera.target = centre;
        radius = 0.5 * Math.hypot(size[0], size[1], size[2]);
      }
      this.camera.distance = radius / Math.tan(this.camera.fov * 0.5) * 1.0;
      this.draw();
    }

    resetView() {
      if (this.bounds) frameCamera(this.camera, this.bounds, this.cssW / Math.max(1, this.cssH));
      this.draw();
    }

    /** Return the nearest cell vertex under a screen point, or null. */
    _pickCell(p) {
      if (!this.model || !this.model.vertices.length) return null;
      let best = null;
      for (const v of this.model.vertices) {
        const s = this.camera.project(v.position, this.cssW, this.cssH);
        if (!s) continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        const rad = Math.max(7, 12 * this._zoomFactor());
        if (d < rad && (!best || d < best.d)) best = { v: v, screen: s, d: d };
      }
      return best;
    }

    _zoomFactor() {
      if (!this.bounds) return 1;
      const radius = 0.5 * Math.hypot(this.bounds.size[0], this.bounds.size[1], this.bounds.size[2]) || 1;
      const f = (this.cssH * 0.5) / Math.tan(this.camera.fov * 0.5);
      return clamp((f / this.camera.distance) * radius / this.cssH, 0.4, 3);
    }

    _line(ctx, a, b, color, width, dash) {
      ctx.beginPath();
      if (dash) ctx.setLineDash(dash);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.cssW, H = this.cssH;
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const th = this.theme;

      if (!this.data) return;

      const P = (p) => this.camera.project(p, W, H);
      const sel = this.selection;
      const dims = this.data.dims;
      const origin = this.data.origin;
      const spacing = this.data.spacing;
      const lo = this.bounds.lo;
      const hi = this.bounds.hi;
      const onSlice = (cell) => cell && this.slice && this.slice.enabled && cell[this.slice.axis] === this.slice.layer;

      // ---- grid plane (z = lo) ------------------------------------------
      if (this.layers.wire) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        const stepX = Math.max(1, Math.ceil(dims[0] / 14));
        const stepY = Math.max(1, Math.ceil(dims[1] / 14));
        for (let i = 0; i < dims[0]; i += stepX) {
          const a = P([origin[0] + spacing[0] * i, origin[1], origin[2]]);
          const b = P([origin[0] + spacing[0] * i, hi[1], origin[2]]);
          if (a && b) this._line(ctx, a, b, th.line, 1);
        }
        for (let j = 0; j < dims[1]; j += stepY) {
          const a = P([origin[0], origin[1] + spacing[1] * j, origin[2]]);
          const b = P([hi[0], origin[1] + spacing[1] * j, origin[2]]);
          if (a && b) this._line(ctx, a, b, th.line, 1);
        }
        ctx.restore();
      }

      // ---- domain box ---------------------------------------------------
      const corners = [
        [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
        [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
      ].map(P);
      const boxEdges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.save();
      for (const [a, b] of boxEdges) {
        if (corners[a] && corners[b]) this._line(ctx, corners[a], corners[b], th.lineStrong, 1);
      }
      ctx.restore();

      // ---- slice plane (behind the geometry) ----------------------------
      if (this.slice && this.slice.enabled) this._drawSlicePlane(ctx, P, th);

      // ---- the three cell edges around the current slice layer, as a
      //      faint "layer plate", so the slice has a 3D counterpart ------
      if (this.slice && this.slice.enabled && this.model && this.layers.cells) {
        ctx.save();
        ctx.globalAlpha = 0.2;
        const a = this.slice.axis;
        const k = this.slice.layer;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        for (let iv = 0; iv < dims[v] - 1; iv += Math.max(1, Math.ceil((dims[v] - 1) / 22))) {
          for (let iu = 0; iu < dims[u] - 1; iu += Math.max(1, Math.ceil((dims[u] - 1) / 26))) {
            const cell = [0, 0, 0];
            cell[a] = k; cell[u] = iu; cell[v] = iv;
            if (!this.model.cellIndex.has(cell.join(','))) continue;
            const p0 = nodeWorldAt(origin, spacing, cell);
            const p1x = p0.slice(), p1y = p0.slice();
            p1x[u] += spacing[u]; p1y[v] += spacing[v];
            const s0 = P(p0), s1 = P(p1x), s2 = P(p1y);
            if (s0 && s1 && s2) {
              ctx.beginPath();
              ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
              ctx.closePath();
              ctx.fillStyle = th.accent;
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }

      // ---- isosurface triangles (painter's order) -----------------------
      const model = this.model;
      if (model && this.layers.iso && model.triangles.length) {
        const tris = [];
        for (let t = 0; t < model.triangles.length; t++) {
          const tri = model.triangles[t];
          const va = model.vertices[tri[0]].position;
          const vb = model.vertices[tri[1]].position;
          const vc = model.vertices[tri[2]].position;
          const sa = P(va), sb = P(vb), sc = P(vc);
          if (!sa || !sb || !sc) continue;
          const z = (sa.z + sb.z + sc.z) / 3;
          const n = cross(sub(vb, va), sub(vc, va));
          const centre = scale(add(add(va, vb), vc), 1 / 3);
          const view = unit(sub(this.camera.basis().eye, centre));
          const facing = dot(unit(n), view);
          const focused = onSlice(model.vertices[tri[0]].cell) || onSlice(model.vertices[tri[1]].cell) || onSlice(model.vertices[tri[2]].cell);
          tris.push({ sa, sb, sc, z, facing, focused });
        }
        tris.sort((p, q) => q.z - p.z);
        ctx.save();
        for (const tr of tris) {
          const lum = clamp(0.55 + 0.45 * Math.abs(tr.facing), 0.35, 1);
          ctx.beginPath();
          ctx.moveTo(tr.sa.x, tr.sa.y);
          ctx.lineTo(tr.sb.x, tr.sb.y);
          ctx.lineTo(tr.sc.x, tr.sc.y);
          ctx.closePath();
          ctx.fillStyle = th.accent;
          ctx.globalAlpha = (tr.focused ? 0.22 : 0.1) * lum;
          ctx.fill();
          ctx.globalAlpha = tr.focused ? 0.55 : 0.22;
          ctx.strokeStyle = th.accent;
          ctx.lineWidth = tr.focused ? 0.7 : 0.4;
          ctx.stroke();
        }
        ctx.restore();
      }

      // ---- topology diagnostics: boundary and non-manifold edges -------
      if (model && this.layers.topology) {
        const drawEdgeSet = (list, color, width, dash, alpha) => {
          if (!list || !list.length) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.globalAlpha = alpha;
          if (dash) ctx.setLineDash(dash);
          for (const e of list) {
            const va = model.vertices[e.a], vb = model.vertices[e.b];
            if (!va || !vb) continue;
            const sa = P(va.position), sb = P(vb.position);
            if (!sa || !sb) continue;
            ctx.beginPath();
            ctx.moveTo(sa.x, sa.y);
            ctx.lineTo(sb.x, sb.y);
            ctx.stroke();
          }
          ctx.restore();
        };
        drawEdgeSet(model.boundaryEdges, th.warm, 1.4, [4, 3], 0.9);
        drawEdgeSet(model.nonmanifoldEdges, th.danger, 2.2, null, 0.95);
      }

      // ---- selected + hovered cells and the current slice cell ----------
      const drawCellBox = (cell, color, width, dash) => {
        const p0 = nodeWorldAt(origin, spacing, cell);
        const p1 = [p0[0] + spacing[0], p0[1] + spacing[1], p0[2] + spacing[2]];
        const cs = [
          [p0[0], p0[1], p0[2]], [p1[0], p0[1], p0[2]], [p1[0], p1[1], p0[2]], [p0[0], p1[1], p0[2]],
          [p0[0], p0[1], p1[2]], [p1[0], p0[1], p1[2]], [p1[0], p1[1], p1[2]], [p0[0], p1[1], p1[2]],
        ].map(P);
        ctx.save();
        if (dash) ctx.setLineDash(dash);
        for (const [a, b] of boxEdges) {
          if (cs[a] && cs[b]) this._line(ctx, cs[a], cs[b], color, width);
        }
        ctx.restore();
      };

      if (model && this.layers.cells) {
        if (this.hoverVertex && (!sel || this.hoverVertex.index !== sel.virtualIndex)) {
          drawCellBox(this.hoverVertex.cell, th.muted, 1);
        }
        if (sel && sel.virtualIndex != null && model.vertices[sel.virtualIndex]) {
          drawCellBox(model.vertices[sel.virtualIndex].cell, th.accent, 2.1);
        }
        if (sel && sel.sliceCell && (!model.cellIndex || model.cellIndex.has(sel.sliceCell.join(',')))) {
          drawCellBox(sel.sliceCell, th.warm, 1.3, [4, 3]);
        }
      }

      // ---- selected-cell detail: hits, normals, solutions ---------------
      if (sel && sel.virtualIndex != null && model && model.vertices[sel.virtualIndex]) {
        const v = model.vertices[sel.virtualIndex];
        const sPos = P(v.position);
        const sUn = P(v.unconstrained);
        const sC = P(v.centroid);

        if (this.layers.guides && sC && sPos) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          this._line(ctx, sC, sPos, th.faint, 0.9, [2, 4]);
          ctx.restore();
        }
        if (this.layers.guides && sUn && sPos) {
          ctx.save();
          ctx.globalAlpha = 0.85;
          this._line(ctx, sPos, sUn, th.muted, 1.1, [3, 3]);
          ctx.restore();
          this._marker(ctx, sUn, 4, 'square', th.muted, th.panel);
        }

        for (const r of v.residuals) {
          const hp = P(r.hit);
          const np = P(add(r.hit, scale(r.normal, this._normalLen(v))));
          if (this.layers.normals && hp && np) {
            this._line(ctx, hp, np, th.warm, 1.5);
            this._arrowHead(ctx, hp, np, th.warm);
          }
          if (this.layers.hits && hp) {
            this._marker(ctx, hp, 3.6, 'diamond', th.danger, th.panel);
          }
          if (this.layers.guides && hp && sPos) {
            ctx.save();
            ctx.globalAlpha = 0.3;
            this._line(ctx, hp, sPos, th.danger, 0.8, [2, 3]);
            ctx.restore();
          }
        }

        if (sPos) {
          this._marker(ctx, sPos, 6, 'circle', th.accent, th.panel);
          ctx.save();
          ctx.beginPath();
          ctx.arc(sPos.x, sPos.y, 10, 0, TAU);
          ctx.strokeStyle = th.accent;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
      }

      // ---- axis triad ---------------------------------------------------
      this._triad(ctx, th);
    }

    _tag(ctx, s, text, bg, fg) {
      ctx.save();
      ctx.font = '500 9.5px "IBM Plex Mono", monospace';
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(s.x + 7, s.y - 14, w, 13);
      ctx.globalAlpha = 1;
      ctx.fillStyle = fg;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, s.x + 11, s.y - 7);
      ctx.restore();
    }

    _normalLen(v) {
      const b = v.box;
      const s = Math.max(b.upper[0] - b.lower[0], b.upper[1] - b.lower[1], b.upper[2] - b.lower[2]);
      return s * 0.42;
    }

    _marker(ctx, s, r, shape, fill, halo) {
      ctx.save();
      ctx.beginPath();
      if (shape === 'circle') ctx.arc(s.x, s.y, r, 0, TAU);
      else if (shape === 'square') ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
      else if (shape === 'diamond') {
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
      }
      ctx.fillStyle = fill;
      ctx.fill();
      if (halo) {
        ctx.strokeStyle = halo;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    _arrowHead(ctx, from, to, color) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const s = 4;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - ux * s - uy * s * 0.55, to.y - uy * s + ux * s * 0.55);
      ctx.lineTo(to.x - ux * s + uy * s * 0.55, to.y - uy * s - ux * s * 0.55);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    _drawSlicePlane(ctx, P, th) {
      const sl = this.slice;
      const origin = this.data.origin;
      const spacing = this.data.spacing;
      const dims = this.data.dims;
      const a = sl.axis;
      const idx = sl.layer;
      if (idx < 0 || idx > dims[a] - 1) return;
      const u = (a + 1) % 3, v = (a + 2) % 3;
      const planeVal = origin[a] + spacing[a] * idx;
      const p00 = [0, 0, 0], p10 = [0, 0, 0], p11 = [0, 0, 0], p01 = [0, 0, 0];
      const set = (p, uu, vv) => {
        p[a] = planeVal;
        p[u] = origin[u] + spacing[u] * uu;
        p[v] = origin[v] + spacing[v] * vv;
      };
      set(p00, 0, 0); set(p10, dims[u] - 1, 0); set(p11, dims[u] - 1, dims[v] - 1); set(p01, 0, dims[v] - 1);
      const q = [p00, p10, p11, p01].map(P);
      if (q.some((x) => !x)) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.fillStyle = th.accent;
      ctx.globalAlpha = 0.06;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.restore();
    }

    _triad(ctx, th) {
      const ox = 26, oy = this.cssH - 26;
      const L = 20;
      const b = this.camera.basis();
      const axes = [
        { v: [1, 0, 0], c: th.danger, label: 'x' },
        { v: [0, 1, 0], c: th.accent, label: 'y' },
        { v: [0, 0, 1], c: th.lower, label: 'z' },
      ];
      ctx.save();
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const ax of axes) {
        const sx = dot(ax.v, b.right) * L;
        const sy = -dot(ax.v, b.up) * L;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + sx, oy + sy);
        ctx.strokeStyle = ax.c;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.fillStyle = ax.c;
        ctx.fillText(ax.label, ox + sx * 1.25, oy + sy * 1.25);
      }
      ctx.beginPath();
      ctx.arc(ox, oy, 1.6, 0, TAU);
      ctx.fillStyle = th.faint;
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Slice view (2D, one cell layer)
  // ---------------------------------------------------------------------------

  class SliceView {
    constructor(canvas, tooltipEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltipEl;
      this.theme = readTheme(canvas);
      this.data = null;
      this.model = null;
      this.slice = { axis: 2, layer: 0 };
      this.selection = null;
      this.hover = null;
      this.onPick = null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._bind();
      this.resize();
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('pointermove', (e) => {
        const p = this._local(e);
        const hit = this._hitTest(p);
        if ((hit && hit.key) !== (this.hover && this.hover.key)) {
          this.hover = hit;
          this.draw();
          if (hit) this._showTip(e, hit); else this._hideTip();
        } else if (hit) {
          this._showTip(e, hit);
        }
        c.style.cursor = hit ? 'pointer' : 'crosshair';
      });
      c.addEventListener('pointerleave', () => {
        this.hover = null;
        this._hideTip();
        this.draw();
      });
      c.addEventListener('click', (e) => {
        const hit = this._hitTest(this._local(e));
        if (hit && this.onPick) this.onPick(hit);
      });
    }

    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _showTip(e, hit) {
      if (!this.tooltip) return;
      const r = this.canvas.getBoundingClientRect();
      this.tooltip.hidden = false;
      this.tooltip.textContent = hit.tip;
      const x = e.clientX - r.left + 12;
      const y = e.clientY - r.top + 12;
      this.tooltip.style.left = Math.min(x, r.width - 130) + 'px';
      this.tooltip.style.top = Math.min(y, r.height - 34) + 'px';
    }

    _hideTip() {
      if (this.tooltip) this.tooltip.hidden = true;
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.cssW = w;
      this.cssH = h;
      this.draw();
    }

    setTheme() {
      this.theme = readTheme(this.canvas);
      this.draw();
    }

    setScene(data, model, slice) {
      this.data = data;
      this.model = model;
      if (slice) this.slice = slice;
      this.draw();
    }

    setSlice(slice) {
      this.slice = slice;
      this.draw();
    }

    setSelection(sel) {
      this.selection = sel;
      this.draw();
    }

    /** Map the slice axes' grid coordinates to canvas pixels.
     *  When `focus` is on and a cell is selected, the window narrows to a
     *  neighbourhood around it so per-cell detail stays legible. */
    _layout() {
      const d = this.data;
      const a = this.slice.axis;
      const u = (a + 1) % 3, v = (a + 2) % 3;
      const pad = 18;
      let u0 = 0, u1 = d.dims[u] - 1;
      let v0 = 0, v1 = d.dims[v] - 1;
      const sel = this.selection;
      if (this.focus && sel && sel.cell && sel.cell[a] === this.slice.layer) {
        const half = 3.4;
        u0 = Math.max(0, sel.cell[u] + 0.5 - half);
        u1 = Math.min(d.dims[u] - 1, sel.cell[u] + 0.5 + half);
        v0 = Math.max(0, sel.cell[v] + 0.5 - half);
        v1 = Math.min(d.dims[v] - 1, sel.cell[v] + 0.5 + half);
      }
      const iw = Math.max(1e-6, u1 - u0);
      const jw = Math.max(1e-6, v1 - v0);
      const availW = this.cssW - pad * 2;
      const availH = this.cssH - pad * 2;
      const s = Math.min(availW / iw, availH / jw);
      const ox = this.cssW / 2 - (u0 + u1) / 2 * s;
      const oy = this.cssH / 2 + (v0 + v1) / 2 * s;
      return { u, v, pad, s, ox, oy, iw, jw, u0, u1, v0, v1 };
    }

    _inWindow(L) {
      return (uu, vv) => uu >= L.u0 - 1e-9 && uu <= L.u1 + 1e-9 && vv >= L.v0 - 1e-9 && vv <= L.v1 + 1e-9;
    }

    _toPx(uu, vv) {
      const L = this._layout();
      return { x: L.ox + uu * L.s, y: L.oy - vv * L.s };
    }

    _fromPx(x, y) {
      const L = this._layout();
      return { u: (x - L.ox) / L.s, v: (L.oy - y) / L.s };
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      const th = this.theme;
      const d = this.data;
      if (!d) return;
      const a = this.slice.axis;
      const layer = this.slice.layer;
      const L = this._layout();
      const { u, v } = L;
      const dims = d.dims;
      const origin = d.origin;
      const spacing = d.spacing;
      const model = this.model;

      const inWin = this._inWindow(L);
      // ---- node-layer sign field, drawn as cell quadrants ---------------
      const fillU = Math.max(1, Math.ceil((dims[u] - 1) / 64));
      const fillV = Math.max(1, Math.ceil((dims[v] - 1) / 64));
      for (let vv = 0; vv < dims[v] - 1; vv += fillV) {
        for (let uu = 0; uu < dims[u] - 1; uu += fillU) {
          if (!inWin(uu + 0.5, vv + 0.5)) continue;
          const node = [0, 0, 0];
          node[a] = layer;
          node[u] = uu;
          node[v] = vv;
          const idx = node[0] + dims[0] * (node[1] + dims[1] * node[2]);
          const s = d.signs[idx];
          const p0 = this._toPx(uu, vv);
          const cellW = Math.max(1, L.s * fillU);
          const cellH = Math.max(1, L.s * fillV);
          ctx.fillStyle = s < 0 ? th.accent : th.muted;
          ctx.globalAlpha = s < 0 ? 0.14 : 0.04;
          ctx.fillRect(p0.x, p0.y - cellH, cellW, cellH);
        }
      }
      ctx.globalAlpha = 1;

      // ---- faint regular grid -------------------------------------------
      ctx.strokeStyle = th.line;
      ctx.lineWidth = 0.7;
      ctx.globalAlpha = 0.65;
      const stepU = Math.max(1, Math.ceil((dims[u] - 1) / 28));
      const stepV = Math.max(1, Math.ceil((dims[v] - 1) / 22));
      for (let uu = 0; uu < dims[u]; uu += stepU) {
        if (uu < L.u0 - 1e-9 || uu > L.u1 + 1e-9) continue;
        const p0 = this._toPx(uu, L.v0), p1 = this._toPx(uu, L.v1);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      for (let vv = 0; vv < dims[v]; vv += stepV) {
        if (vv < L.v0 - 1e-9 || vv > L.v1 + 1e-9) continue;
        const p0 = this._toPx(L.u0, vv), p1 = this._toPx(L.u1, vv);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ---- node dots ----------------------------------------------------
      const nodeStep = Math.max(1, Math.ceil(Math.max(dims[u], dims[v]) / 48));
      if (L.s * nodeStep >= 5) {
        for (let vv = 0; vv < dims[v]; vv += nodeStep) {
          for (let uu = 0; uu < dims[u]; uu += nodeStep) {
            if (!inWin(uu, vv)) continue;
            const node = [0, 0, 0];
            node[a] = layer; node[u] = uu; node[v] = vv;
            const idx = node[0] + dims[0] * (node[1] + dims[1] * node[2]);
            const s = d.signs[idx];
            const p = this._toPx(uu, vv);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.8, 0, TAU);
            if (s < 0) { ctx.fillStyle = th.accent; ctx.fill(); }
            else { ctx.strokeStyle = th.faint; ctx.lineWidth = 1; ctx.stroke(); }
          }
        }
      }

      // ---- axis labels ---------------------------------------------------
      ctx.save();
      ctx.fillStyle = th.faint;
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(['x', 'y', 'z'][u], this.cssW - 9, this.cssH - 5);
      ctx.textAlign = 'left';
      ctx.fillText(['x', 'y', 'z'][v], 4, 11);
      ctx.restore();

      if (!model) return;
      const sel = this.selection;
      const hoverCell = this.hover && this.hover.kind === 'cell' ? this.hover.cell : null;

      // ---- mixed-cell footprints (lower corner on this layer) -----------
      for (const vtx of model.vertices) {
        const cell = vtx.cell;
        if (cell[a] !== layer) continue;
        if (!inWin(cell[u] + 0.5, cell[v] + 0.5)) continue;
        const p0 = this._toPx(cell[u], cell[v]);
        const w = L.s, h = L.s;
        ctx.fillStyle = th.accent;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(p0.x, p0.y - h, w, h);
        ctx.globalAlpha = 0.42;
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(p0.x + 0.5, p0.y - h + 0.5, w - 1, h - 1);
        ctx.globalAlpha = 1;
      }

      // ---- crossing edges belonging to cells of this slab ----------------
      // A slab is the set of cells whose lower corner sits on `layer`; its
      // crossings live on the two node planes z = layer and z = layer + 1.
      const seen = new Set();
      for (const vtx of model.vertices) {
        if (vtx.cell[a] !== layer) continue;
        for (const r of vtx.residuals) {
          const ax = AXIS_NUM[r.axis];
          if (ax === a) continue;
          if (r.node[a] !== layer && r.node[a] !== layer + 1) continue;
          const key = r.axis + ':' + r.node.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const uu = r.node[u] + (ax === u ? r.t : 0);
          const vv = r.node[v] + (ax === v ? r.t : 0);
          if (!inWin(uu, vv)) continue;
          const p = this._toPx(uu, vv);
          const edited = this.editedKeys && this.editedKeys.indexOf(key) >= 0;
          ctx.save();
          if (edited) {
            ctx.beginPath();
            ctx.rect(p.x - 3.8, p.y - 3.8, 7.6, 7.6);
            ctx.strokeStyle = th.warm;
            ctx.lineWidth = 1.7;
            ctx.stroke();
            ctx.fillStyle = th.warm;
            ctx.globalAlpha = 0.22;
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.8, 0, TAU);
            ctx.fillStyle = th.danger;
            ctx.fill();
            ctx.strokeStyle = th.panel;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // ---- selected cell: outline, normals, solutions, vertex -----------
      if (sel && sel.cell && sel.cell[a] === layer) {
        const p0 = this._toPx(sel.cell[u], sel.cell[v]);
        ctx.save();
        ctx.strokeStyle = th.fg;
        ctx.lineWidth = 2;
        ctx.strokeRect(p0.x + 1.5, p0.y - L.s + 1.5, L.s - 3, L.s - 3);
        ctx.restore();
      } else if (sel && sel.cell && sel.cell[a] + 1 === layer) {
        const p0 = this._toPx(sel.cell[u], sel.cell[v]);
        ctx.save();
        ctx.strokeStyle = th.fg;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(p0.x + 1.5, p0.y - L.s + 1.5, L.s - 3, L.s - 3);
        ctx.restore();
      }
      if (hoverCell && hoverCell[a] === layer && (!sel || !sel.cell || sel.cell.join() !== hoverCell.join())) {
        const p0 = this._toPx(hoverCell[u], hoverCell[v]);
        ctx.strokeStyle = th.muted;
        ctx.lineWidth = 1.3;
        ctx.strokeRect(p0.x + 1, p0.y - L.s + 1, L.s - 2, L.s - 2);
      }

      // ---- selected cell: hits, normals and both solutions, in-plane ----
      if (sel && sel.detail && sel.detail.cell && sel.detail.cell[a] === layer) {
        const vv = sel.detail;
        const cell = vv.cell;
        const toU = (p) => (p[u] - origin[u]) / spacing[u] - cell[u];
        const toV = (p) => (p[v] - origin[v]) / spacing[v] - cell[v];
        const at = (uu, vvv) => this._toPx(cell[u] + uu, cell[v] + vvv);
        const pad = 0.08;

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = th.accent;
        ctx.globalAlpha = 0.75;
        const c0 = at(-pad, -pad), c1 = at(1 + pad, 1 + pad);
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(c0.x, c1.y, c1.x - c0.x, c0.y - c1.y);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        const P = (p) => {
          const q = at(toU(p), toV(p));
          return q;
        };
        const ctr = P(vv.centroid);
        const un = P(vv.unconstrained);
        const fin = P(vv.position);

        // normal arrows
        const nlen = 0.34;
        for (const r of vv.residuals) {
          const hp = P(r.hit);
          const tip = at(toU(r.hit) + r.normal[u] * nlen, toV(r.hit) + r.normal[v] * nlen);
          ctx.strokeStyle = th.warm;
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(hp.x, hp.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
          this._arrow(ctx, hp, tip, th.warm);

          ctx.beginPath(); ctx.moveTo(hp.x, hp.y); ctx.lineTo(fin.x, fin.y);
          ctx.strokeStyle = th.danger; ctx.globalAlpha = 0.32; ctx.lineWidth = 0.9;
          ctx.stroke(); ctx.globalAlpha = 1;

          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 2.5, 0, TAU);
          ctx.fillStyle = th.danger; ctx.fill();
          ctx.strokeStyle = th.panel; ctx.lineWidth = 1; ctx.stroke();
        }

        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = th.faint;
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y); ctx.lineTo(un.x, un.y); ctx.lineTo(fin.x, fin.y); ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.rect(un.x - 3, un.y - 3, 6, 6);
        ctx.fillStyle = th.muted; ctx.fill();
        ctx.strokeStyle = th.panel; ctx.lineWidth = 1; ctx.stroke();

        ctx.beginPath();
        ctx.arc(fin.x, fin.y, 4, 0, TAU);
        ctx.fillStyle = th.accent; ctx.fill();
        ctx.strokeStyle = th.panel; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
      }

    }

    _arrow(ctx, from, to, color) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l, s = 4.5;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - ux * s - uy * s * 0.55, to.y - uy * s + ux * s * 0.55);
      ctx.lineTo(to.x - ux * s + uy * s * 0.55, to.y - uy * s - ux * s * 0.55);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    _hitTest(p) {
      if (!this.model || !this.data) return null;
      const a = this.slice.axis;
      const layer = this.slice.layer;
      const dims = this.data.dims;
      const { u, v } = this._layout();

      // crossing points first
      let bestPt = null;
      const seen = new Set();
      for (const vtx of this.model.vertices) {
        for (const r of vtx.residuals) {
          const ax = AXIS_NUM[r.axis];
          if (r.node[a] !== layer || ax === a) continue;
          const key = r.axis + ':' + r.node.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const uu = r.node[u] + (ax === u ? r.t : 0);
          const vv = r.node[v] + (ax === v ? r.t : 0);
          const sp = this._toPx(uu, vv);
          const dd = Math.hypot(sp.x - p.x, sp.y - p.y);
          if (dd < 7 && (!bestPt || dd < bestPt.d)) {
            bestPt = {
              kind: 'edge', d: dd, key: 'e' + key,
              edgeKey: key,
              tip: r.axis + ' ' + r.node.join(',') + ' · t=' + r.t.toFixed(3),
            };
          }
        }
      }
      if (bestPt) return bestPt;

      const f = this._fromPx(p.x, p.y);
      const uu = Math.floor(f.u);
      const vv = Math.floor(f.v);
      if (uu < 0 || vv < 0 || uu > dims[u] - 2 || vv > dims[v] - 2) return null;
      const cell = [0, 0, 0];
      cell[a] = layer; cell[u] = uu; cell[v] = vv;
      const id = this.model.cellIndex.get(cell.join(','));
      if (id !== undefined) {
        return { kind: 'cell', key: 'c' + cell.join(','), cell: cell, tip: '混合单元 [' + cell.join(', ') + '] · 顶点 #' + id };
      }
      return { kind: 'cell', key: 'c' + cell.join(','), cell: cell, tip: '同号单元 [' + cell.join(', ') + ']' };
    }
  }


  // ---------------------------------------------------------------------------
  // Cell detail: an orthographic close-up of one mixed cell.
  // Draws the cell box, every crossing hit and its normal, the centroid, the
  // unconstrained solution and the final box-constrained vertex.
  // ---------------------------------------------------------------------------

  class CellDetailView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.theme = readTheme(canvas);
      this.vertex = null;
      this.yaw = -0.62;
      this.pitch = 0.42;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._bind();
      this.resize();
    }

    _bind() {
      const c = this.canvas;
      let drag = false, lx = 0, ly = 0;
      c.addEventListener('pointerdown', (e) => {
        drag = true; lx = e.clientX; ly = e.clientY;
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.yaw -= (e.clientX - lx) * 0.012;
        this.pitch = clamp(this.pitch + (e.clientY - ly) * 0.01, -1.3, 1.3);
        lx = e.clientX; ly = e.clientY;
        this.draw();
      });
      const up = () => { drag = false; };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoomK = clamp((this.zoomK || 1) * Math.exp(e.deltaY * -0.001), 0.6, 3);
        this.draw();
      }, { passive: false });
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.cssW = w;
      this.cssH = h;
      this.draw();
    }

    setTheme() { this.theme = readTheme(this.canvas); this.draw(); }

    setVertex(v) {
      // Keep the camera orientation when switching cells.
      this.vertex = v;
      this.draw();
    }

    _project(p, centre, half) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const rx = cy, rz = -sy;
      const ux = sy * sp, uy = cp, uz = cy * sp;
      const dx = p[0] - centre[0], dy = p[1] - centre[1], dz = p[2] - centre[2];
      const sx = (dx * rx + dz * rz) / half;
      const sy2 = (dx * ux + dy * uy + dz * uz) / half;
      const depth = (dx * sy * cp + dy * (-sp) + dz * cy * cp) / half;
      const k = (this.zoomK || 1);
      const scale = Math.min(this.cssW, this.cssH) * 0.34 * k;
      return {
        x: this.cssW / 2 + sx * scale,
        y: this.cssH / 2 - sy2 * scale,
        d: depth,
      };
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      const th = this.theme;
      const v = this.vertex;
      if (!v) {
        ctx.fillStyle = th.faint;
        ctx.font = '11px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('选择一个混合单元', this.cssW / 2, this.cssH / 2);
        return;
      }
      const lo = v.box.lower, hi = v.box.upper;
      const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const half = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
      const P = (p) => this._project(p, centre, half);

      // cell box
      const cs = [
        [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
        [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
      ].map(P);
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.save();
      ctx.strokeStyle = th.lineStrong;
      ctx.lineWidth = 1.1;
      for (const [a, b] of edges) {
        ctx.beginPath();
        ctx.moveTo(cs[a].x, cs[a].y);
        ctx.lineTo(cs[b].x, cs[b].y);
        ctx.stroke();
      }
      // faint back faces for depth
      ctx.globalAlpha = 0.04;
      ctx.fillStyle = th.accent;
      const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      for (const f of faces) {
        ctx.beginPath();
        ctx.moveTo(cs[f[0]].x, cs[f[0]].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(cs[f[i]].x, cs[f[i]].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      const c = P(v.centroid);
      const un = P(v.unconstrained);
      const fin = P(v.position);

      // target point c
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2, 0, TAU);
      ctx.fillStyle = th.faint;
      ctx.fill();
      ctx.restore();

      // hit → final solution (residual) and full normals
      const normalLen = half * 0.5;
      for (const r of v.residuals) {
        const hp = P(r.hit);
        const tip = P([
          r.hit[0] + r.normal[0] * normalLen / half * half,
          r.hit[1] + r.normal[1] * normalLen,
          r.hit[2] + r.normal[2] * normalLen,
        ]);
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = th.danger;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(hp.x, hp.y);
        ctx.lineTo(fin.x, fin.y);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = th.warm;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hp.x, hp.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        const dx = tip.x - hp.x, dy = tip.y - hp.y;
        const l = Math.hypot(dx, dy) || 1;
        const ux2 = dx / l, uy2 = dy / l, s2 = 4.5;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - ux2 * s2 - uy2 * s2 * 0.55, tip.y - uy2 * s2 + ux2 * s2 * 0.55);
        ctx.lineTo(tip.x - ux2 * s2 + uy2 * s2 * 0.55, tip.y - uy2 * s2 - ux2 * s2 * 0.55);
        ctx.closePath();
        ctx.fillStyle = th.warm;
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(hp.x, hp.y - 3.4);
        ctx.lineTo(hp.x + 3.4, hp.y);
        ctx.lineTo(hp.x, hp.y + 3.4);
        ctx.lineTo(hp.x - 3.4, hp.y);
        ctx.closePath();
        ctx.fillStyle = th.danger;
        ctx.fill();
        ctx.strokeStyle = th.panel;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      // unconstrained (may lie outside the box) with dashed link to final
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = th.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(un.x, un.y);
      ctx.lineTo(fin.x, fin.y);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(un.x - 3.4, un.y - 3.4, 6.8, 6.8);
      ctx.fillStyle = th.muted;
      ctx.fill();
      ctx.strokeStyle = th.panel;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // final vertex
      ctx.save();
      ctx.beginPath();
      ctx.arc(fin.x, fin.y, 4.8, 0, TAU);
      ctx.fillStyle = th.accent;
      ctx.fill();
      ctx.strokeStyle = th.panel;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();

      // labels (avoid collisions by pushing them apart)
      ctx.save();
      ctx.font = '9.5px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      const close = Math.hypot(fin.x - un.x, fin.y - un.y) < 18;
      ctx.fillStyle = th.fg;
      ctx.fillText('x*', fin.x + 7, fin.y - 7);
      ctx.fillStyle = th.muted;
      ctx.fillText('无约束', un.x + (close ? 9 : 7), un.y + (close ? 15 : 11));
      ctx.restore();

      // cell size readout in model units
      const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      ctx.save();
      ctx.font = '9.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = th.faint;
      ctx.textAlign = 'left';
      ctx.fillText('单元尺寸 ' + size.map((x) => x.toPrecision(3)).join(' × '), 8, this.cssH - 8);
      ctx.restore();
    }
  }

  function attachTooltipStyles() {
    if (document.getElementById('bhe-tooltip-style')) return;
    const st = document.createElement('style');
    st.id = 'bhe-tooltip-style';
    st.textContent = '.canvas-tip{position:absolute;pointer-events:none;background:var(--fg);color:var(--bg);' +
      'font:500 10.5px/1.4 "IBM Plex Mono",monospace;padding:3px 7px;border-radius:4px;white-space:nowrap;z-index:3;}';
    document.head.appendChild(st);
  }

  window.BHEView = {
    Camera: Camera,
    Scene: Scene,
    SliceView: SliceView,
    CellDetailView: CellDetailView,
    readTheme: readTheme,
    cssVarColor: cssVarColor,
    boundsOf: boundsOf,
    frameCamera: frameCamera,
    attachTooltipStyles: attachTooltipStyles,
  };
})();
