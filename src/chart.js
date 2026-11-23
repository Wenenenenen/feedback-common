/*
 * Canvas chart primitives: HiDPI line chart with crosshair + tooltip,
 * mini multiples and sparklines. Theme-aware via CSS custom properties.
 * All labels are inserted as text (canvas fillText / textContent), never HTML.
 */
(function (root) {
  'use strict';

  function cssVar(el, name) {
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  function themeColors(el) {
    return {
      surface: cssVar(el, '--surface'),
      grid: cssVar(el, '--grid'),
      axis: cssVar(el, '--axis'),
      muted: cssVar(el, '--muted'),
      ink: cssVar(el, '--ink'),
      ink2: cssVar(el, '--ink-2'),
      s1: cssVar(el, '--s1'),
      s2: cssVar(el, '--s2'),
      s3: cssVar(el, '--s3'),
    };
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) {
      const pad = Math.max(1e-12, Math.abs(min) * 0.1);
      return [min - pad, min, min + pad];
    }
    const span = max - min;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    const lo = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = lo; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
      if (ticks.length > 40) break;
    }
    return ticks;
  }

  function fmtTick(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 10000) return (v / 1000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a >= 1) return v.toFixed(a >= 100 ? 0 : (a >= 10 ? 1 : 2)).replace(/\.?0+$/, '');
    if (a >= 0.01) return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return v.toExponential(1);
  }

  function fmtValue(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000 || a < 1e-4) return v.toExponential(2);
    if (a >= 1) return v.toFixed(4);
    return v.toFixed(5);
  }

  /**
   * Multi-series line chart on a canvas.
   * spec = {
   *   series: [{name, color, values: Float64Array, width, dash}],
   *   xLength, marker (index|null), yLabel, xLabel,
   *   onHover(index|null), onSelect(index)
   * }
   */
  class LineChart {
    constructor(canvas, wrap, tipEl) {
      this.canvas = canvas;
      this.wrap = wrap;
      this.tip = tipEl;
      this.spec = null;
      this.hoverIdx = null;
      this.marker = null;
      this._raf = 0;
      this._bind();
      this._ro = new ResizeObserver(() => this.schedule());
      this._ro.observe(wrap);
    }

    _bind() {
      const pos = (ev) => {
        const r = this.canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      };
      this.wrap.addEventListener('pointermove', (ev) => {
        if (!this.spec) return;
        const { x } = pos(ev);
        const idx = this._indexAtX(x);
        if (idx !== this.hoverIdx) {
          this.hoverIdx = idx;
          this.schedule();
          if (this.spec.onHover) this.spec.onHover(idx);
        }
        this._positionTip(idx);
      });
      this.wrap.addEventListener('pointerleave', () => {
        this.hoverIdx = null;
        if (this.tip) this.tip.hidden = true;
        this.schedule();
        if (this.spec && this.spec.onHover) this.spec.onHover(null);
      });
      this.wrap.addEventListener('pointerdown', (ev) => {
        if (!this.spec) return;
        const { x } = pos(ev);
        const idx = this._indexAtX(x);
        if (idx != null && this.spec.onSelect) this.spec.onSelect(idx);
      });
      this.wrap.addEventListener('keydown', (ev) => {
        if (!this.spec) return;
        const len = this.spec.xLength;
        const cur = this.spec.marker ?? 0;
        let next = null;
        if (ev.key === 'ArrowRight') next = Math.min(len - 1, cur + 1);
        else if (ev.key === 'ArrowLeft') next = Math.max(0, cur - 1);
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = len - 1;
        else if (ev.key === 'PageUp') next = Math.max(0, cur - Math.round(len / 10));
        else if (ev.key === 'PageDown') next = Math.min(len - 1, cur + Math.round(len / 10));
        if (next != null) {
          ev.preventDefault();
          if (this.spec.onSelect) this.spec.onSelect(next);
        }
      });
    }

    setSpec(spec) {
      this.spec = spec;
      this.marker = spec.marker ?? null;
      this.schedule();
    }

    _geo() {
      const { width, height } = this.wrap.getBoundingClientRect();
      const padL = 62, padR = 16, padT = 12, padB = 30;
      return { w: width, h: height, padL, padR, padT, padB };
    }

    _indexAtX(clientX) {
      const g = this._geo();
      const plotW = g.w - g.padL - g.padR;
      if (plotW <= 0) return null;
      const len = this.spec.xLength;
      const t = (clientX - g.padL) / plotW;
      const idx = Math.round(t * (len - 1));
      return Math.max(0, Math.min(len - 1, idx));
    }

    _xPos(idx, g) {
      const len = this.spec.xLength;
      const plotW = g.w - g.padL - g.padR;
      if (len <= 1) return g.padL + plotW / 2;
      return g.padL + (idx / (len - 1)) * plotW;
    }

    schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.draw();
      });
    }

    draw() {
      const spec = this.spec;
      if (!spec) return;
      const g = this._geo();
      if (g.w <= 10 || g.h <= 10) return;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const c = this.canvas;
      const cw = Math.round(g.w * dpr), ch = Math.round(g.h * dpr);
      if (c.width !== cw || c.height !== ch) {
        c.width = cw; c.height = ch;
      }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);
      const col = themeColors(this.wrap);
      const plotW = g.w - g.padL - g.padR;
      const plotH = g.h - g.padT - g.padB;
      if (plotW < 4 || plotH < 4) return;

      // y range
      let yMin = Infinity, yMax = -Infinity;
      for (const s of spec.series) {
        if (s.hidden) continue;
        const v = s.values;
        for (let i = 0; i < v.length; i++) {
          const a = v[i];
          if (a < yMin) yMin = a;
          if (a > yMax) yMax = a;
        }
      }
      if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
      if (yMax - yMin < 1e-15) { const p = Math.max(1e-12, Math.abs(yMax) * 0.1); yMin -= p; yMax += p; }
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad; yMax += pad;
      const yToPx = (v) => g.padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

      // grid + y ticks
      ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const ticks = niceTicks(yMin, yMax, 5);
      ctx.strokeStyle = col.grid;
      ctx.lineWidth = 1;
      for (const t of ticks) {
        const y = Math.round(yToPx(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(g.padL, y);
        ctx.lineTo(g.w - g.padR, y);
        ctx.stroke();
        ctx.fillStyle = col.muted;
        ctx.fillText(fmtTick(t), g.padL - 8, y);
      }
      // zero line slightly stronger if in range
      if (yMin < 0 && yMax > 0) {
        const y0 = Math.round(yToPx(0)) + 0.5;
        ctx.strokeStyle = col.axis;
        ctx.beginPath();
        ctx.moveTo(g.padL, y0);
        ctx.lineTo(g.w - g.padR, y0);
        ctx.stroke();
      }
      // x ticks (reserve the right edge for the axis caption)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const lastIdx = spec.xLength - 1;
      const xTicks = [0, Math.round(lastIdx / 4), Math.round(lastIdx / 2), Math.round(3 * lastIdx / 4), lastIdx];
      const seen = new Set();
      const captionW = spec.xLabel ? ctx.measureText(spec.xLabel).width + 14 : 0;
      for (const xi of xTicks) {
        if (seen.has(xi)) continue;
        seen.add(xi);
        const x = this._xPos(xi, g);
        const half = ctx.measureText(String(xi)).width / 2;
        if (spec.xLabel && x + half > g.w - g.padR - captionW) continue;
        ctx.fillStyle = col.muted;
        ctx.fillText(String(xi), x, g.padT + plotH + 8);
      }
      // axis labels
      ctx.fillStyle = col.muted;
      if (spec.xLabel) {
        ctx.textAlign = 'right';
        ctx.fillText(spec.xLabel, g.w - g.padR, g.padT + plotH + 8);
      }
      if (spec.yLabel) {
        ctx.save();
        ctx.translate(11, g.padT + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(spec.yLabel, 0, 0);
        ctx.restore();
      }

      // clip plot
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.padL, g.padT, plotW, plotH);
      ctx.clip();

      for (const s of spec.series) {
        if (s.hidden) continue;
        const v = s.values;
        const n = v.length;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        if (n === 1) {
          const y = yToPx(v[0]);
          ctx.moveTo(g.padL, y);
          ctx.lineTo(g.w - g.padR, y);
        } else {
          const stepPx = plotW / (n - 1);
          if (stepPx >= 1.6) {
            for (let i = 0; i < n; i++) {
              const x = g.padL + i * stepPx;
              const y = yToPx(v[i]);
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
          } else {
            // dense: column envelope so the shape stays truthful at any width
            const buckets = Math.max(8, Math.floor(plotW));
            for (let b = 0; b < buckets; b++) {
              const i0 = Math.floor((b / buckets) * n);
              const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / buckets) * n));
              let lo = Infinity, hi = -Infinity;
              for (let i = i0; i < i1 && i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
              if (!Number.isFinite(lo)) continue;
              const x = g.padL + (b + 0.5) * (plotW / buckets);
              const ya = yToPx(hi), yb = yToPx(lo);
              if (b === 0) ctx.moveTo(x, ya); else ctx.lineTo(x, ya);
              if (yb !== ya) ctx.lineTo(x, yb);
            }
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      // hover crosshair
      const hi = this.hoverIdx;
      if (hi != null) {
        const x = Math.round(this._xPos(hi, g)) + 0.5;
        ctx.strokeStyle = col.axis;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, g.padT);
        ctx.lineTo(x, g.padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        // dots with surface ring
        for (const s of spec.series) {
          if (s.hidden) continue;
          const y = yToPx(s.values[hi]);
          if (y < g.padT - 2 || y > g.padT + plotH + 2) continue;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = col.surface;
          ctx.stroke();
        }
      }

      // marker (selected sample)
      const mi = spec.marker;
      if (mi != null && mi !== hi) {
        const x = Math.round(this._xPos(mi, g)) + 0.5;
        ctx.strokeStyle = col.ink2;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(x, g.padT);
        ctx.lineTo(x, g.padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // end labels for <=4 visible series when room permits
      this._drawEndLabels(ctx, spec, g, col, yToPx, plotW, plotH);

      // plot frame baseline
      ctx.strokeStyle = col.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.padL, g.padT + plotH + 0.5);
      ctx.lineTo(g.w - g.padR, g.padT + plotH + 0.5);
      ctx.stroke();

      this._lastGeo = g;
      this._lastRange = { yMin, yMax };
    }

    _drawEndLabels(ctx, spec, g, col, yToPx, plotW, plotH) {
      const vis = spec.series.filter((s) => !s.hidden);
      if (vis.length === 0 || vis.length > 4) return;
      // only when series separate by enough vertical distance
      const pts = vis.map((s) => ({ s, y: yToPx(s.values[s.values.length - 1]) }))
        .filter((o) => o.y >= g.padT && o.y <= g.padT + plotH);
      pts.sort((a, b) => a.y - b.y);
      let ok = true;
      for (let i = 1; i < pts.length; i++) if (pts[i].y - pts[i - 1].y < 13) ok = false;
      if (!ok) return;
      ctx.font = '600 10.5px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      for (const o of pts) {
        const w = ctx.measureText(o.s.name).width;
        ctx.fillStyle = col.surface;
        ctx.fillRect(g.w - g.padR - w - 3, o.y - 12, w + 4, 12);
        ctx.fillStyle = col.ink2;
        ctx.fillText(o.s.name, g.w - g.padR, o.y - 1);
      }
    }

    _positionTip(idx) {
      const tip = this.tip;
      if (!tip || idx == null || !this.spec) { if (tip) tip.hidden = true; return; }
      const g = this._lastGeo || this._geo();
      tip.textContent = '';
      const head = document.createElement('div');
      head.className = 'x';
      head.textContent = `n = ${idx}`;
      tip.appendChild(head);
      for (const s of this.spec.series) {
        if (s.hidden) continue;
        const row = document.createElement('div');
        row.className = 'r';
        const key = document.createElement('span');
        key.className = 'key';
        key.style.background = s.color;
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = s.name;
        const vv = document.createElement('span');
        vv.className = 'vv';
        vv.textContent = fmtValue(s.values[idx]);
        row.append(key, nm, vv);
        tip.appendChild(row);
      }
      tip.hidden = false;
      const x = this._xPos(idx, g);
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = x + 14;
      if (left + tw > g.w - 4) left = x - tw - 14;
      if (left < 4) left = 4;
      let top = g.padT + 6;
      if (top + th > g.h - 4) top = g.h - th - 4;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    }
  }

  /* --------------------------- mini chart ------------------------------- */

  function drawMini(canvas, values, opts) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(20, rect.width), h = Math.max(16, rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const col = themeColors(canvas);
    const mark = opts && opts.marker;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) { const v = values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-15) { const p = Math.max(1e-12, Math.abs(hi) * 0.1); lo -= p; hi += p; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const yPx = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
    const n = values.length;
    const xPx = (i) => n <= 1 ? w / 2 : (i / (n - 1)) * w;
    // zero line
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = col.grid;
      ctx.lineWidth = 1;
      const y = Math.round(yPx(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = (opts && opts.color) || col.s1;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    const buckets = Math.max(6, Math.floor(w));
    if (n / buckets < 1.5) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xPx(i), y = yPx(values[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      for (let b = 0; b < buckets; b++) {
        const i0 = Math.floor((b / buckets) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / buckets) * n));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i < i1 && i < n; i++) { if (values[i] < mn) mn = values[i]; if (values[i] > mx) mx = values[i]; }
        if (!Number.isFinite(mn)) continue;
        const x = (b + 0.5) * (w / buckets);
        ctx.beginPath();
        ctx.moveTo(x, yPx(mx));
        ctx.lineTo(x, yPx(mn));
        ctx.stroke();
      }
    }
    if (mark != null && mark >= 0 && mark < n) {
      const x = Math.round(xPx(mark)) + 0.5;
      ctx.strokeStyle = col.ink2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(xPx(mark), yPx(values[mark]), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = (opts && opts.color) || col.s1;
      ctx.fill();
    }
  }

  // Several series on one shared scale, for small report panels.
  function drawMiniMulti(canvas, seriesList, opts) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(20, rect.width), h = Math.max(16, rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const col = themeColors(canvas);
    let lo = Infinity, hi = -Infinity, n = 0;
    for (const s of seriesList) {
      n = Math.max(n, s.values.length);
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-15) { const p = Math.max(1e-12, Math.abs(hi) * 0.1); lo -= p; hi += p; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const yPx = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = col.grid;
      ctx.lineWidth = 1;
      const y = Math.round(yPx(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const buckets = Math.max(6, Math.floor(w));
    for (const s of seriesList) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.2;
      ctx.lineJoin = 'round';
      const vals = s.values;
      const len = vals.length;
      if (len / buckets < 1.6) {
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const x = len <= 1 ? w / 2 : (i / (len - 1)) * w;
          const y = yPx(vals[i]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        for (let b = 0; b < buckets; b++) {
          const i0 = Math.floor((b / buckets) * len);
          const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / buckets) * len));
          let mn = Infinity, mx = -Infinity;
          for (let i = i0; i < i1 && i < len; i++) { if (vals[i] < mn) mn = vals[i]; if (vals[i] > mx) mx = vals[i]; }
          if (!Number.isFinite(mn)) continue;
          const x = (b + 0.5) * (w / buckets);
          ctx.beginPath(); ctx.moveTo(x, yPx(mx)); ctx.lineTo(x, yPx(mn)); ctx.stroke();
        }
      }
    }
  }

  root.AIChart = { LineChart, drawMini, drawMiniMulti, niceTicks, fmtTick, fmtValue, themeColors };
})(typeof globalThis !== 'undefined' ? globalThis : this);
