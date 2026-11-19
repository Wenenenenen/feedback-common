/*
 * charts.js — 三个 Canvas 图表，共享同一套主题 token 与联动悬停
 *  JitterChart   到达抖动散点：x=槽位，y=时间(µs)，阶梯截止线，四状态不同形状
 *  PlayoutStrip 播放槽条带：每槽一格，按 source/补偿/late 着色
 *  WaveformChart PCM 波形：补偿区间背景着色，播放头，点击/拖动定位
 *
 * 尺寸原则：每次 draw() 都实时测量画布 CSS 宽度，避免首屏布局未定时缓存错误宽度；
 * 容器尺寸变化由 ResizeObserver 触发重绘。
 */

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setupCanvas(canvas, cssH) {
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function themeColors() {
  return {
    grid: cssToken("--grid"),
    axis: cssToken("--axis"),
    ink: cssToken("--text-primary"),
    muted: cssToken("--muted"),
    accepted: cssToken("--c-accepted"),
    late: cssToken("--c-late"),
    duplicate: cssToken("--c-duplicate"),
    invalid: cssToken("--c-invalid"),
    concealZero: cssToken("--c-conceal-zero"),
    concealDecay: cssToken("--c-conceal-decay"),
    deadline: cssToken("--c-deadline"),
  };
}

function niceTimeTicks(maxUs) {
  const target = 6;
  const rough = maxUs / target;
  const steps = [10000, 20000, 25000, 50000, 100000, 200000, 250000, 500000, 1000000, 2000000, 5000000];
  const step = steps.find((s) => s >= rough) || 10000000;
  const ticks = [];
  for (let v = 0; v <= maxUs + 1; v += step) ticks.push(v);
  return ticks;
}

export const fmtUs = (us) => {
  if (us === null || us === undefined) return "—";
  if (Math.abs(us) >= 1000) return `${(us / 1000).toFixed(us % 1000 === 0 ? 0 : 1)} ms`;
  return `${us} µs`;
};

/* 观察容器尺寸变化，自动重绘（首次有数据后生效） */
function observeResize(chart) {
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", () => chart.draw());
    return;
  }
  const ro = new ResizeObserver(() => chart.draw());
  ro.observe(chart.canvas.parentElement);
}

export class JitterChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.points = [];
    this.deadlinePts = [];
    this.total = 1;
    this.maxUs = 10000;
    this.hoverPoint = null;
    this.onHover = null;
    this.H = 340;
    this.m = { l: 64, r: 16, t: 16, b: 38 };
    this._bind();
    observeResize(this);
  }

  setData(result) {
    this.total = result.header.total;
    this.points = result.packets
      .filter((p) => p.slot !== null && p.arrival_us !== null)
      .map((p) => ({ slot: p.slot, arrival: p.arrival_us, status: p.status, id: p.id, deadline: p.deadline_us }));
    this.deadlinePts = result.slots.map((s) => ({ slot: s.slot, deadline: s.deadline_us }));
    this.maxUs = Math.max(10000, ...this.points.map((p) => Math.max(p.arrival, p.deadline ?? 0)));
    this.draw();
  }

  _geo() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const { m, H } = this;
    const pw = w - m.l - m.r;
    const ph = H - m.t - m.b;
    const x = (slot) => m.l + (this.total <= 1 ? pw / 2 : (slot / (this.total - 1)) * pw);
    const y = (us) => m.t + ph - (us / this.maxUs) * ph;
    return { w, m, pw, ph, x, y };
  }

  draw() {
    if (this.points.length === 0) return;
    const { ctx, w, h: H } = setupCanvas(this.canvas, this.H);
    const { m, pw, ph, x, y } = this._geo();
    const c = themeColors();
    ctx.clearRect(0, 0, w, H);

    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const t of niceTimeTicks(this.maxUs)) {
      const yy = y(t);
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.l, yy);
      ctx.lineTo(m.l + pw, yy);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.textAlign = "right";
      ctx.fillText(fmtUs(t), m.l - 8, yy);
    }

    const xTickStep = Math.max(1, Math.ceil(this.total / 10));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let k = 0; k < this.total; k += xTickStep) {
      ctx.fillStyle = c.muted;
      ctx.fillText(String(k), x(k), m.t + ph + 8);
    }
    ctx.fillText("槽位 k", m.l + pw / 2, m.t + ph + 22);

    ctx.strokeStyle = c.axis;
    ctx.beginPath();
    ctx.moveTo(m.l, m.t);
    ctx.lineTo(m.l, m.t + ph);
    ctx.lineTo(m.l + pw, m.t + ph);
    ctx.stroke();

    // 每槽截止时间：阶梯虚线
    ctx.strokeStyle = c.deadline;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i < this.deadlinePts.length; i++) {
      const d = this.deadlinePts[i];
      const x0 = x(Math.max(0, d.slot - 0.5));
      const x1 = x(Math.min(this.total - 1, d.slot + 0.5));
      const yy = y(d.deadline);
      ctx.moveTo(i === 0 ? x(d.slot) : x0, yy);
      ctx.lineTo(x1, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of this.points) {
      this._mark(ctx, x(p.slot), y(p.arrival), p.status, c, this.hoverPoint?.id === p.id);
    }
  }

  _mark(ctx, x, y, status, c, emphasized) {
    const r = emphasized ? 7 : 5;
    ctx.lineWidth = 2;
    if (status === "accepted") {
      ctx.fillStyle = c.accepted;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (status === "late") {
      ctx.fillStyle = c.late;
      ctx.beginPath();
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x + r + 1, y + r);
      ctx.lineTo(x - r - 1, y + r);
      ctx.closePath();
      ctx.fill();
    } else if (status === "duplicate") {
      ctx.fillStyle = c.duplicate;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else {
      ctx.strokeStyle = c.invalid;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r + 1, y - r + 1);
      ctx.lineTo(x + r - 1, y + r - 1);
      ctx.moveTo(x + r - 1, y - r + 1);
      ctx.lineTo(x - r + 1, y + r - 1);
      ctx.stroke();
    }
    if (emphasized) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _bind() {
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { x, y } = this._geo();
      let best = null;
      let bestD = 16;
      for (const p of this.points) {
        const d = Math.hypot(x(p.slot) - mx, y(p.arrival) - my);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      this.hoverPoint = best;
      this.draw();
      if (best) {
        this.tooltip.hidden = false;
        this.tooltip.style.left = `${e.clientX - rect.left + 12}px`;
        this.tooltip.style.top = `${e.clientY - rect.top + 12}px`;
        const c = themeColors();
        this.tooltip.innerHTML =
          `<b>${best.id}</b> · 槽 ${best.slot}<br>` +
          `到达 ${fmtUs(best.arrival)} · 截止 ${fmtUs(best.deadline)}<br>` +
          `状态 <span style="color:${c[best.status]}">${best.status}</span>`;
        if (this.onHover) this.onHover(best.slot);
      } else {
        this.tooltip.hidden = true;
        if (this.onHover) this.onHover(null);
      }
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hoverPoint = null;
      this.tooltip.hidden = true;
      if (this.onHover) this.onHover(null);
      this.draw();
    });
  }
}

export class PlayoutStrip {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.slots = [];
    this.total = 0;
    this.H = 64;
    this.onHover = null;
    this._bind();
    observeResize(this);
  }

  setData(result) {
    this.slots = result.slots;
    this.total = result.slots.length;
    this.draw();
  }

  draw() {
    if (this.total === 0) return;
    const { ctx, w, h: H } = setupCanvas(this.canvas, this.H);
    const c = themeColors();
    ctx.clearRect(0, 0, w, H);
    const pad = 8;
    const cw = w - pad * 2;
    const cellW = cw / this.total;
    for (const s of this.slots) {
      let color;
      if (s.source !== null) color = c.accepted;
      else if (s.status === "late") color = c.late;
      else if (s.conceal && s.conceal.startsWith("repeat_decay")) color = c.concealDecay;
      else color = c.concealZero;
      ctx.fillStyle = color;
      const x = pad + s.slot * cellW;
      ctx.fillRect(x + (cellW > 3 ? 1 : 0), 10, Math.max(1, cellW - 2), 30);
    }
    ctx.fillStyle = c.muted;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.ceil(this.total / 10));
    for (let k = 0; k < this.total; k += step) {
      ctx.fillText(String(k), pad + (k + 0.5) * cellW, 52);
    }
  }

  _bind() {
    this.canvas.addEventListener("mousemove", (e) => {
      const w = this.canvas.clientWidth;
      const rect = this.canvas.getBoundingClientRect();
      const pad = 8;
      const cw = w - pad * 2;
      const k = Math.floor((e.clientX - rect.left - pad) / (cw / this.total));
      if (k < 0 || k >= this.total) {
        this.tooltip.hidden = true;
        if (this.onHover) this.onHover(null);
        return;
      }
      const s = this.slots[k];
      this.tooltip.hidden = false;
      this.tooltip.style.left = `${e.clientX - rect.left + 12}px`;
      this.tooltip.style.top = `${e.clientY - rect.top - 8}px`;
      const src = s.source ? `包 <b>${s.source}</b>` : `无接收包（${s.conceal ?? "补偿"}）`;
      this.tooltip.innerHTML = `槽 ${s.slot}<br>截止 ${fmtUs(s.deadline_us)}<br>来源：${src}`;
      if (this.onHover) this.onHover(k);
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.tooltip.hidden = true;
      if (this.onHover) this.onHover(null);
    });
  }
}

export class WaveformChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.playheadSec = 0;
    this.onSeek = null;
    this.H = 220;
    this.m = { l: 48, r: 12, t: 12, b: 26 };
    this._bind();
    observeResize(this);
  }

  setData(result) {
    this.result = result;
    const { channels, fpp, total } = result.header;
    this.channels = channels;
    this.totalFrames = fpp * total;
    this._buildPeaks(result.pcm);
    this._buildConcealRanges(result);
    this.playheadSec = 0;
    this.draw();
  }

  /* 峰值与宽度解耦：先按帧存归一化 min/max，绘制时再按列聚合 */
  _buildPeaks(pcm) {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const totalFrames = this.totalFrames;
    // 每帧一个 min/max（6000 槽 × 480 = 288 万帧上限，按帧直接存内存可接受；
    // 为控制内存改为按固定 2400 段聚合）
    const buckets = 2400;
    this.bucketN = buckets;
    this.mins = new Float32Array(buckets);
    this.maxs = new Float32Array(buckets);
    this.mins.fill(1);
    this.maxs.fill(-1);
    const framesPerBucket = totalFrames / buckets;
    for (let f = 0; f < totalFrames; f++) {
      const b = Math.min(buckets - 1, Math.floor(f / framesPerBucket));
      for (let ch = 0; ch < this.channels; ch++) {
        const s = view.getInt16((f * this.channels + ch) * 2, true) / 32768;
        if (s < this.mins[b]) this.mins[b] = s;
        if (s > this.maxs[b]) this.maxs[b] = s;
      }
    }
  }

  _buildConcealRanges(result) {
    const { fpp } = result.header;
    this.fpp = fpp;
    this.ranges = [];
    let start = null;
    let kind = null;
    const push = (end) => this.ranges.push({ start, end, kind });
    for (const s of result.slots) {
      const concealed = s.source === null;
      const k = s.conceal && s.conceal.startsWith("repeat_decay") ? "decay" : "zero";
      if (concealed && start === null) {
        start = s.slot;
        kind = k;
      } else if (concealed && k !== kind) {
        push(s.slot - 1);
        start = s.slot;
        kind = k;
      } else if (!concealed && start !== null) {
        push(s.slot - 1);
        start = null;
      }
    }
    if (start !== null) push(result.slots.length - 1);
  }

  _geo() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const { m, H } = this;
    const pw = w - m.l - m.r;
    const ph = H - m.t - m.b;
    const xForFrame = (frame) => m.l + (frame / this.totalFrames) * pw;
    return { w, m, pw, ph, zeroY: m.t + ph / 2, xForFrame };
  }

  setPlayhead(sec) {
    this.playheadSec = sec;
    this.draw();
  }

  draw() {
    if (!this.result) return;
    const { ctx, w, h: H } = setupCanvas(this.canvas, this.H);
    const c = themeColors();
    const { m, pw, ph, zeroY, xForFrame } = this._geo();
    ctx.clearRect(0, 0, w, H);

    // 补偿区间背景
    for (const r of this.ranges) {
      const x0 = xForFrame(r.start * this.fpp);
      const x1 = xForFrame((r.end + 1) * this.fpp);
      ctx.fillStyle = r.kind === "decay" ? c.concealDecay : c.concealZero;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0, m.t, x1 - x0, ph);
      ctx.globalAlpha = 1;
    }

    // 时间刻度网格
    ctx.strokeStyle = c.grid;
    ctx.fillStyle = c.muted;
    ctx.font = "10px system-ui, sans-serif";
    const dur = this.totalFrames / this.result.header.rate;
    const tickN = 6;
    for (let i = 0; i <= tickN; i++) {
      const x = m.l + (i / tickN) * pw;
      ctx.beginPath();
      ctx.moveTo(x, m.t);
      ctx.lineTo(x, m.t + ph);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(`${((dur * i) / tickN).toFixed(1)}s`, x, m.t + ph + 6);
    }

    ctx.strokeStyle = c.axis;
    ctx.beginPath();
    ctx.moveTo(m.l, zeroY);
    ctx.lineTo(m.l + pw, zeroY);
    ctx.stroke();

    // 波形：每个像素列聚合覆盖到的 bucket
    ctx.fillStyle = c.accepted;
    const cols = Math.max(1, Math.floor(pw));
    const bucketsPerCol = this.bucketN / cols;
    for (let col = 0; col < cols; col++) {
      const b0 = Math.floor(col * bucketsPerCol);
      const b1 = Math.max(b0 + 1, Math.ceil((col + 1) * bucketsPerCol));
      let mn = 1;
      let mx = -1;
      for (let b = b0; b < b1 && b < this.bucketN; b++) {
        if (this.mins[b] < mn) mn = this.mins[b];
        if (this.maxs[b] > mx) mx = this.maxs[b];
      }
      const x = m.l + col;
      const y0 = zeroY - mx * (ph / 2);
      const y1 = zeroY - mn * (ph / 2);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // 播放头
    const px = xForFrame(this.playheadSec * this.result.header.rate);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, m.t);
    ctx.lineTo(px, m.t + ph);
    ctx.stroke();
  }

  _bind() {
    const seek = (e) => {
      if (!this.result) return;
      const rect = this.canvas.getBoundingClientRect();
      const { m, pw } = this._geo();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - m.l) / pw));
      const dur = this.totalFrames / this.result.header.rate;
      if (this.onSeek) this.onSeek(ratio * dur);
    };
    this.canvas.addEventListener("click", seek);
    this.canvas.addEventListener("mousemove", (e) => {
      if (e.buttons === 1) seek(e);
    });
  }
}
