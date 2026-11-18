// UV 二维视图：镜像面区分着色，选中角高亮并绘制该面 UV 基方向。
export class UVView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mesh = null;
    this.corners = null;
    this.selected = -1;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.mesh || !this.onPick) return;
      const r = canvas.getBoundingClientRect();
      const [u, v] = this._toUV(e.clientX - r.left, e.clientY - r.top);
      let best = -1, bestD = 0.02 * this.scale_;
      for (let i = 0; i < this.corners.length; i++) {
        const c = this.corners[i];
        const d = Math.hypot(c.uv[0] - u, c.uv[1] - v);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) this.onPick(best);
    });
  }

  setData(mesh, corners) {
    this.mesh = mesh;
    this.corners = corners;
    // 视野适配：包含 [0,1]² 与全部 UV
    let minU = 0, maxU = 1, minV = 0, maxV = 1;
    for (const f of mesh.faces) for (const uv of f.uv) {
      minU = Math.min(minU, uv[0]); maxU = Math.max(maxU, uv[0]);
      minV = Math.min(minV, uv[1]); maxV = Math.max(maxV, uv[1]);
    }
    const padU = (maxU - minU) * 0.08 + 1e-3, padV = (maxV - minV) * 0.08 + 1e-3;
    this.range = { minU: minU - padU, maxU: maxU + padU, minV: minV - padV, maxV: maxV + padV };
    this.draw();
  }

  setSelected(i) { this.selected = i; this.draw(); }

  _toXY(u, v, w, h) {
    const r = this.range;
    return [((u - r.minU) / (r.maxU - r.minU)) * w, h - ((v - r.minV) / (r.maxV - r.minV)) * h];
  }

  _toUV(x, y) {
    const r = this.range;
    const w = this.canvas.width, h = this.canvas.height;
    return [r.minU + (x / w) * (r.maxU - r.minU), r.minV + (1 - y / h) * (r.maxV - r.minV)];
  }

  get scale_() { return this.range ? this.range.maxU - this.range.minU : 1; }

  draw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, w, h);
    if (!this.mesh) return;
    const toXY = (u, v) => this._toXY(u, v, w, h);

    // 网格线（整数 UV）
    ctx.strokeStyle = '#2a2e36';
    ctx.lineWidth = 1;
    for (let i = Math.ceil(this.range.minU); i <= Math.floor(this.range.maxU); i++) {
      const [x] = toXY(i, 0);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let j = Math.ceil(this.range.minV); j <= Math.floor(this.range.maxV); j++) {
      const [, y] = toXY(0, j);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // [0,1]² 边界
    ctx.strokeStyle = '#4a5160';
    const [x0, y1] = toXY(0, 0), [x1, y0] = toXY(1, 1);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    // 面：正向蓝、镜像橙
    for (const f of this.mesh.faces) {
      const d1 = [f.uv[1][0] - f.uv[0][0], f.uv[1][1] - f.uv[0][1]];
      const d2 = [f.uv[2][0] - f.uv[0][0], f.uv[2][1] - f.uv[0][1]];
      const det = d1[0] * d2[1] - d2[0] * d1[1];
      ctx.beginPath();
      f.uv.forEach((uv, i) => {
        const [x, y] = toXY(uv[0], uv[1]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = det >= 0 ? 'rgba(80,120,240,0.25)' : 'rgba(240,150,50,0.3)';
      ctx.strokeStyle = det >= 0 ? '#5a7fe0' : '#e09a4a';
      ctx.fill();
      ctx.stroke();
    }

    // 选中角：标记 + UV 基方向箭头（+u 红、+v 绿）
    if (this.selected >= 0 && this.corners) {
      const c = this.corners[this.selected];
      const [x, y] = toXY(c.uv[0], c.uv[1]);
      const len = this.scale_ * 0.12;
      const arrow = (du, dv, color) => {
        const [ax, ay] = toXY(c.uv[0] + du, c.uv[1] + dv);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ax, ay); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(ax, ay, 3 * (window.devicePixelRatio || 1), 0, 7); ctx.fill();
      };
      arrow(len, 0, '#e05050');
      arrow(0, len, '#50c050');
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5 * (window.devicePixelRatio || 1), 0, 7); ctx.stroke();
    }
  }
}
