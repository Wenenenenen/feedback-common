/* view3d.js — 纯手写三维预览：正交投影 + 旋转 + 画家算法体素面渲染，无三维引擎库。 */
'use strict';
window.VF = window.VF || {};

VF.View3D = class {
  constructor(canvas, getCtx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getCtx = getCtx;
    this.yaw = 0.6; this.pitch = 0.42;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.showWire = false;
    this.showLeaks = true;
    this.faceBudget = 90000;   // 超过则降级为体素精灵点
    this._bind();
  }

  reset() { this.yaw = 0.6; this.pitch = 0.42; this.zoom = 1; this.panX = this.panY = 0; this.draw(); }

  _basis() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Ry(yaw) * Rx(pitch)
    const r = [
      [cy, sy * sp, sy * cp],
      [0, cp, -sp],
      [-sy, cy * sp, cy * cp],
    ];
    return r; // 行向量：screenX = r0·p, screenY = r1·p, depth = r2·p
  }

  _bind() {
    const c = this.canvas;
    let last = null;
    c.addEventListener('pointerdown', (ev) => {
      last = { x: ev.clientX, y: ev.clientY };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener('pointermove', (ev) => {
      if (!last) return;
      const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
      if (ev.shiftKey) { this.panX += dx; this.panY += dy; }
      else { this.yaw += dx * 0.01; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.01)); }
      last = { x: ev.clientX, y: ev.clientY };
      this.draw();
    });
    c.addEventListener('pointerup', () => { last = null; });
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.zoom = Math.max(0.15, Math.min(8, this.zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
      this.draw();
    }, { passive: false });
    c.addEventListener('dblclick', () => this.reset());
  }

  _shade(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r * factor)));
    g = Math.max(0, Math.min(255, Math.round(g * factor)));
    b = Math.max(0, Math.min(255, Math.round(b * factor)));
    return `rgb(${r},${g},${b})`;
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
    ctx.fillStyle = '#0d1322';
    ctx.fillRect(0, 0, W, H);

    const { Nx, Ny, Nz, Sxy, spacing, origin } = st;
    const r = this._basis();
    // 物理尺寸归一，使初始缩放适配视口
    const physMax = Math.max(Nx * spacing[0], Ny * spacing[1], Nz * spacing[2]);
    const baseScale = Math.min(W, H) / (physMax * 1.7);
    const s = baseScale * this.zoom;
    const proj = (px, py, pz) => {
      const x = r[0][0] * px + r[0][1] * py + r[0][2] * pz;
      const y = r[1][0] * px + r[1][1] * py + r[1][2] * pz;
      const z = r[2][0] * px + r[2][1] * py + r[2][2] * pz;
      return [W / 2 + this.panX + x * s, H / 2 + this.panY + y * s, z];
    };

    // 可绘制类别（EXTERIOR 永不画体素）
    const drawCls = new Set();
    if (opts.showSurface) drawCls.add(1);
    if (opts.showSolid) drawCls.add(3);
    if (opts.showCavity) drawCls.add(4);
    const drawable = new Uint8Array(st.total);
    let count = 0;
    for (let idx = 0; idx < st.total; idx++) {
      if (drawCls.has(st.classification[idx])) { drawable[idx] = 1; count++; }
    }
    if (count === 0) {
      this._drawEmpty(W, H);
      this._drawLeaks(st, proj);
      return;
    }

    // 画家算法遍历顺序：按深度轴系数绝对值决定轴优先级，符号决定升降序
    const axes = [0, 1, 2].sort((a, b) => Math.abs(r[2][b]) - Math.abs(r[2][a]));
    const dims = [Nx, Ny, Nz];
    const ranges = axes.map((a) => {
      const lo = 0, hi = dims[a] - 1;
      return r[2][a] >= 0 ? [lo, hi, 1] : [hi, lo, -1];
    });
    const [A1, A2, A3] = axes;
    const [r1, r2, r3] = ranges;

    // 面定义：法线、4 角偏移、明暗
    const sp = spacing;
    const faceDefs = [
      { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.82 },
      { n: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.62 },
      { n: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], shade: 1.0 },
      { n: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]], shade: 0.5 },
      { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 1.12 },
      { n: [0, 0, -1], corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], shade: 0.4 },
    ];
    const neighborOf = (idx, n) => {
      const i = idx % Nx, j = ((idx / Nx) | 0) % Ny, k = (idx / Sxy) | 0;
      const ni = i + n[0], nj = j + n[1], nk = k + n[2];
      if (ni < 0 || ni >= Nx || nj < 0 || nj >= Ny || nk < 0 || nk >= Nz) return -1;
      return ni + nj * Nx + nk * Sxy;
    };
    const colorAt = (idx) => {
      if (st.classification[idx] === 1 && opts.colorByMaterial && st.surfMat[idx] >= 0) {
        return VF.MATERIAL_COLORS[(st.surfMat[idx] - 1) % 16];
      }
      return VF.CLASS_COLORS[st.classification[idx]];
    };

    // 估算面数决定 LOD
    let faceEst = 0;
    for (let idx = 0; idx < st.total; idx++) {
      if (!drawable[idx]) continue;
      for (const f of faceDefs) {
        const nid = neighborOf(idx, f.n);
        if (nid < 0 || !drawable[nid]) faceEst++;
      }
    }
    const spriteMode = faceEst > this.faceBudget;
    this.lastMode = spriteMode ? `精灵 LOD（${faceEst} 面超预算）` : '实体面渲染';

    const phys = (i, j, k) => [
      origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2],
    ];

    const coord = [0, 0, 0];
    for (let a = r1[0]; r1[2] > 0 ? a <= r1[1] : a >= r1[1]; a += r1[2]) {
      coord[A1] = a;
      for (let b = r2[0]; r2[2] > 0 ? b <= r2[1] : b >= r2[1]; b += r2[2]) {
        coord[A2] = b;
        for (let c = r3[0]; r3[2] > 0 ? c <= r3[1] : c >= r3[1]; c += r3[2]) {
          coord[A3] = c;
          const idx = coord[0] + coord[1] * Nx + coord[2] * Sxy;
          if (!drawable[idx]) continue;
          const [px, py, pz] = phys(coord[0], coord[1], coord[2]);
          const base = colorAt(idx);
          if (spriteMode) {
            const [sx, sy] = proj(px + sp[0] / 2, py + sp[1] / 2, pz + sp[2] / 2);
            const sz = Math.max(2, Math.min(sp[0], sp[1], sp[2]) * s * 0.92);
            ctx.fillStyle = base;
            ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
          } else {
            for (const f of faceDefs) {
              const nid = neighborOf(idx, f.n);
              if (nid >= 0 && drawable[nid]) continue;
              ctx.fillStyle = this._shade(base, f.shade);
              ctx.beginPath();
              for (let q = 0; q < 4; q++) {
                const cc = f.corners[q];
                const [sx, sy] = proj(px + cc[0] * sp[0], py + cc[1] * sp[1], pz + cc[2] * sp[2]);
                if (q === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
              }
              ctx.closePath(); ctx.fill();
            }
          }
        }
      }
    }

    // 三角形线框叠加（可选）
    if (this.showWire) {
      ctx.strokeStyle = 'rgba(156,192,255,.55)';
      ctx.lineWidth = 1;
      const edges = [[0, 1], [1, 2], [2, 0]];
      ctx.beginPath();
      for (const t of st.tris) {
        if (!t.enabled) continue;
        const P = [t.v0, t.v1, t.v2];
        for (const [e0, e1] of edges) {
          const a = proj(P[e0][0], P[e0][1], P[e0][2]);
          const b = proj(P[e1][0], P[e1][1], P[e1][2]);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
      }
      ctx.stroke();
    }

    // 漏孔标记独立渲染（不受类别过滤影响，保证隐藏表面时仍可见）
    this._drawLeaks(st, proj);
  }

  _drawLeaks(st, proj) {
    if (!this.showLeaks || !st.leaks || !st.leaks.length) return;
    const ctx = this.ctx;
    const sp = st.spacing, origin = st.origin;
    const s = Math.min(sp[0], sp[1], sp[2]);
    // 半径取当前视图缩放（_drawLeaks 复用 draw 内的 proj，缩放已含在内，这里只定相对尺寸）
    const rad = 3.2;
    ctx.fillStyle = '#ff5470';
    for (const p of st.leaks) {
      for (const q of [p.fromExterior, p.toEnclosed]) {
        const px = origin[0] + (q[0] + 0.5) * sp[0];
        const py = origin[1] + (q[1] + 0.5) * sp[1];
        const pz = origin[2] + (q[2] + 0.5) * sp[2];
        const [sx, sy] = proj(px, py, pz);
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, 7);
        ctx.fill();
      }
    }
  }

  _drawEmpty(W, H) {
    const ctx = this.ctx;
    ctx.fillStyle = '#8494b2';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('当前类别过滤下无可绘制体素', W / 2, H / 2);
  }
};
