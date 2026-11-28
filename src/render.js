// render.js —— Canvas 视图：平移缩放、分层绘制、交点命中检测
import { strandColor } from './svg.js';

export class View {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 20;
    this.tx = 0;
    this.ty = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.model = null;
    this.retained = new Map();
    this.above = null;
    this.pinSet = new Set();
    this.selectedCid = -1;
    this.hoverCid = -1;
    this.highlight = new Set(); // 需要强调的 cid（矛盾链等）
    this.highlightStrands = new Set(); // 上述交点涉及的线条，避免逐线展开集合
    this.showMarkers = true;
    this.dark = false;
    this.onSelect = null;
    this.onBackground = null;
    this._bind();
    // 显式调试/测试句柄：页面自有对象，控制台可访问 window.__view
    if (typeof window !== 'undefined') window.__view = this;
  }

  setData(model, retained, above, pinSet) {
    this.model = model;
    this.retained = retained;
    this.above = above;
    this.pinSet = pinSet;
    this.selectedCid = -1;
    this.hoverCid = -1;
    this.setHighlight(new Set());
    this.resize();
    this.fit();
  }

  /** 设置高亮交点集，同步预算涉及的线条集合。 */
  setHighlight(cids) {
    this.highlight = cids;
    const sids = new Set();
    if (this.model) {
      for (const cid of cids) {
        const c = this.model.crossings[cid];
        sids.add(c.h);
        sids.add(c.v);
      }
    }
    this.highlightStrands = sids;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 世界坐标 -> 屏幕坐标。 */
  toScreen(x, y) {
    return [x * this.scale + this.tx, y * this.scale + this.ty];
  }
  toWorld(sx, sy) {
    return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale];
  }

  fit() {
    if (!this.model) return;
    const { minX, minY, maxX, maxY } = this.model.bounds;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const pad = 40;
    this.scale = Math.min((this.w - pad * 2) / w, (this.h - pad * 2) / h);
    this.scale = Math.max(this.scale, 0.05);
    this.tx = (this.w - w * this.scale) / 2 - minX * this.scale;
    this.ty = (this.h - h * this.scale) / 2 - minY * this.scale;
    this.draw();
  }

  _bind() {
    const c = this.canvas;
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    c.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = this.tx; oy = this.ty;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragging) {
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        this.tx = ox + dx;
        this.ty = oy + dy;
        this.draw();
      } else {
        const cid = this.pick(mx, my);
        if (cid !== this.hoverCid) {
          this.hoverCid = cid;
          c.style.cursor = cid >= 0 ? 'pointer' : 'grab';
          this.draw();
        }
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        const rect = c.getBoundingClientRect();
        const cid = this.pick(e.clientX - rect.left, e.clientY - rect.top);
        if (cid >= 0) this.onSelect?.(cid);
        else this.onBackground?.();
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const [wx, wy] = this.toWorld(mx, my);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(400, Math.max(0.02, this.scale * factor));
      this.tx = mx - wx * this.scale;
      this.ty = my - wy * this.scale;
      this.draw();
    }, { passive: false });
  }

  /** 屏幕坐标命中最近交点（10px 内）。交点坐标为整数，按邻近整数格在哈希表中查找。 */
  pick(mx, my) {
    if (!this.model || !this.showMarkers) return -1;
    const tol = 10;
    const [wx, wy] = this.toWorld(mx, my);
    const r = tol / this.scale; // 世界坐标容差半径
    const x0 = Math.floor(wx - r), x1 = Math.ceil(wx + r);
    const y0 = Math.floor(wy - r), y1 = Math.ceil(wy + r);
    let best = -1, bestD = tol * tol;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = this.model.crossingMap.get(`${x},${y}`);
        if (!c) continue;
        const [px, py] = this.toScreen(c.x, c.y);
        const dx = px - mx, dy = py - my;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c.cid; }
      }
    }
    return best;
  }

  draw() {
    const ctx = this.ctx;
    if (!this.model) return;
    ctx.fillStyle = this.dark ? '#15181d' : '#fafaf7';
    ctx.fillRect(0, 0, this.w, this.h);
    this._drawGrid();
    this._drawStrands();
    if (this.showMarkers) this._drawMarkers();
  }

  _drawGrid() {
    const ctx = this.ctx;
    if (this.scale < 6) return;
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.w, this.h);
    ctx.strokeStyle = this.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
      const [sx] = this.toScreen(x, 0);
      ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h);
    }
    for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
      const [, sy] = this.toScreen(0, y);
      ctx.moveTo(0, sy); ctx.lineTo(this.w, sy);
    }
    ctx.stroke();
  }

  _drawStrands() {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    const lw = Math.max(0.6, Math.min(this.scale * 0.18, 12));
    ctx.lineWidth = lw;
    const hasHighlight = this.highlightStrands.size > 0;
    for (const st of this.model.strands) {
      const paths = this.retained.get(st.id);
      if (!paths || paths.length === 0) continue;
      const emph = hasHighlight && this.highlightStrands.has(st.id);
      ctx.strokeStyle = strandColor(st.id, this.dark);
      ctx.globalAlpha = hasHighlight && !emph ? 0.18 : 1;
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.beginPath();
        const [sx0, sy0] = this.toScreen(path[0][0], path[0][1]);
        ctx.moveTo(sx0, sy0);
        for (let i = 1; i < path.length; i++) {
          const [sx, sy] = this.toScreen(path[i][0], path[i][1]);
          ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawMarkers() {
    const ctx = this.ctx;
    const r = Math.max(2.2, Math.min(this.scale * 0.12, 6));
    const crossings = this.model.crossings;
    // 视口世界坐标范围，跳过视口外的点
    const [wx0, wy0] = this.toWorld(0, 0);
    const [wx1, wy1] = this.toWorld(this.w, this.h);
    const inView = (c) => c.x >= wx0 && c.x <= wx1 && c.y >= wy0 && c.y <= wy1;
    // 普通交点：合并为一次填充，避免逐个改 fillStyle
    ctx.fillStyle = this.dark ? 'rgba(255,255,255,0.85)' : 'rgba(30,30,30,0.8)';
    ctx.beginPath();
    for (let cid = 0; cid < crossings.length; cid++) {
      if (cid === this.selectedCid || cid === this.hoverCid ||
          this.pinSet.has(cid) || this.highlight.has(cid)) continue;
      const c = crossings[cid];
      if (!inView(c)) continue;
      const [sx, sy] = this.toScreen(c.x, c.y);
      ctx.moveTo(sx + r, sy);
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    // 锁定交点：方块
    for (const cid of this.pinSet) {
      if (cid === this.selectedCid) continue;
      const c = crossings[cid];
      if (!inView(c)) continue;
      const [sx, sy] = this.toScreen(c.x, c.y);
      ctx.fillStyle = '#d97706';
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      ctx.strokeStyle = this.dark ? '#15181d' : '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
    }
    // 矛盾链强调
    if (this.highlight.size > 0) {
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      for (const cid of this.highlight) {
        const c = crossings[cid];
        if (!inView(c)) continue;
        const [sx, sy] = this.toScreen(c.x, c.y);
        ctx.beginPath();
        ctx.arc(sx, sy, r * 1.9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // 悬停/选中
    const drawRing = (cid, color, rr) => {
      if (cid < 0) return;
      const c = crossings[cid];
      const [sx, sy] = this.toScreen(c.x, c.y);
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    drawRing(this.hoverCid, '#2563eb', r * 1.7);
    drawRing(this.selectedCid, '#059669', r * 2.1);
  }
}
