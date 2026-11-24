/*
 * Canvas 图表：反卷积总览（|c| 包络 / dB）与单窗带符号波形。
 * 颜色全部取自 CSS 角色变量，随主题切换重绘；轴/网格为弱化的发丝线。
 * 浏览器专用（全局 SHMChart）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHMChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAD = { l: 56, r: 14, t: 14, b: 26 };

  function cssVar(el, name, fallback) {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback || '#888';
  }

  function palette(el) {
    return {
      surface: cssVar(el, '--surface-1', '#fcfcfb'),
      surface2: cssVar(el, '--surface-2', '#fff'),
      text: cssVar(el, '--text-primary', '#0b0b0b'),
      text2: cssVar(el, '--text-secondary', '#52514e'),
      muted: cssVar(el, '--text-muted', '#7c7b74'),
      grid: cssVar(el, '--grid', '#e4e4e0'),
      zero: cssVar(el, '--zero-line', '#a8a79f'),
      s1: cssVar(el, '--series-1', '#2a78d6'),
      s2: cssVar(el, '--series-2', '#eb6834'),
      s3: cssVar(el, '--series-3', '#1baf7a'),
      s4: cssVar(el, '--series-4', '#eda100'),
      good: cssVar(el, '--good', '#0ca30c'),
      warning: cssVar(el, '--warning', '#fab219'),
      fill: cssVar(el, '--window-fill', 'rgba(42,120,214,.1)'),
      border: cssVar(el, '--border-strong', '#c4c4bd'),
      critical: cssVar(el, '--critical', '#d03b3b'),
    };
  }

  /* 画布按 DPR 缩放；返回 CSS 像素尺寸的上下文。 */
  function prepare(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width));
    // 高度取自 CSS（clientHeight），绝不回读设置过的 attribute，否则每次重绘都会按 DPR 放大一次
    const h = Math.max(40, Math.round(canvas.clientHeight || rect.height || 200));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  }

  function niceTicks(min, max, target) {
    if (!(max > min)) return [min];
    const span = max - min;
    const raw = span / Math.max(2, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    const out = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-9; v += step) out.push(v);
    return out;
  }

  function fmtFrame(v) {
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtCompact(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (a >= 1) return v.toFixed(a >= 100 ? 0 : (a >= 10 ? 1 : 2));
    if (a >= 1e-3) return v.toFixed(3);
    return v.toExponential(1);
  }

  function fmtSigned(v, digits) {
    if (!Number.isFinite(v)) return '—';
    const d = digits == null ? 4 : digits;
    const s = v < 0 ? '−' : '+';
    const a = Math.abs(v);
    return s + (a >= 1e4 || (a > 0 && a < 1e-3) ? a.toExponential(2) : a.toFixed(d));
  }

  function withAlpha(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex;
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /* --------------------------------------------------------------------- */
  /* 总览                                                                   */
  /* --------------------------------------------------------------------- */

  /*
   * model: analysis（单个通道），外加
   *   zero、windows、search、view、overview{lo,hi,min,max}
   * opts: { dB:boolean, showSearch:boolean }
   */
  function drawOverview(canvas, model, opts) {
    const { ctx, w, h } = prepare(canvas);
    const P = palette(canvas);
    const r = canvas.getBoundingClientRect();
    canvas._hit = null;
    if (!model) {
      ctx.fillStyle = P.muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('载入测量包后显示反卷积幅度', w / 2, h / 2);
      return;
    }
    const ov = model.overview;
    const lo = ov.lo;
    const hi = ov.hi;
    const dB = !!(opts && opts.dB);
    const plotW = Math.max(10, w - PAD.l - PAD.r);
    const plotH = Math.max(10, h - PAD.t - PAD.b);

    // 幅度参考：视图内全部桶的最大绝对值
    let ref = 0;
    for (let i = 0; i < ov.bins; i++) {
      const a = Math.max(Math.abs(ov.min[i]), Math.abs(ov.max[i]));
      if (a > ref) ref = a;
    }
    if (!(ref > 0)) ref = 1;

    const xOf = (frame) => PAD.l + ((frame - lo) / Math.max(1, hi - lo)) * plotW;
    let yOf;
    let yTicks;
    if (dB) {
      const floorDb = -100;
      yOf = (v) => {
        const a = Math.max(Math.abs(v), ref * Math.pow(10, floorDb / 20));
        const db = 20 * Math.log10(a / ref);
        return PAD.t + plotH - ((db - floorDb) / -floorDb) * plotH;
      };
      yTicks = [0, -20, -40, -60, -80, -100].map((db) => ({ v: db, y: PAD.t + plotH - ((db - floorDb) / -floorDb) * plotH }));
    } else {
      const top = ref * 1.06;
      yOf = (v) => PAD.t + plotH - (v / top) * plotH;
      yTicks = niceTicks(0, top, 4).map((v) => ({ v, y: yOf(v) }));
    }

    // 网格
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of yTicks) {
      const y = Math.round(t.y) + 0.5;
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
    }
    ctx.stroke();

    // 搜索区间底纹 + 上沿强线
    if (opts && opts.showSearch && model.search) {
      const sx0 = xOf(model.search.start);
      const sx1 = xOf(model.search.end);
      ctx.fillStyle = withAlpha(P.s1, 0.08);
      ctx.fillRect(sx0, PAD.t, Math.max(1, sx1 - sx0), plotH);
      ctx.fillStyle = withAlpha(P.s1, 0.55);
      ctx.fillRect(sx0, PAD.t + plotH - 2, Math.max(1, sx1 - sx0), 2);
    }

    // 各阶窗底纹 + 顶部色条 + 标签
    const winColors = [P.s1, P.s2, P.s3, P.s4];
    const conflictQ = new Set();
    for (const pair of (model.conflicts || [])) { conflictQ.add(pair[0]); conflictQ.add(pair[1]); }
    const winTop = PAD.t;
    const placed = [];
    for (const win of model.windows) {
      const x0 = Math.max(PAD.l, xOf(win.start));
      const x1 = Math.min(PAD.l + plotW, xOf(win.end));
      if (x1 <= x0) { placed.push({ win, hidden: true, mid: xOf(win.center) }); continue; }
      const bad = conflictQ.has(win.q);
      ctx.fillStyle = bad ? withAlpha(P.critical, 0.12) : withAlpha(winColors[(win.q - 1) % 4], 0.13);
      ctx.fillRect(x0, winTop, Math.max(1, x1 - x0), plotH);
      ctx.fillStyle = bad ? P.critical : winColors[(win.q - 1) % 4];
      ctx.fillRect(x0, winTop, Math.max(1, x1 - x0), 3);
      placed.push({ win, x0, x1, mid: (x0 + x1) / 2, bad });
    }
    // 标签放在窗上方，重叠时错开到上一行
    let lastRowRight = -Infinity;
    let row = 0;
    const labelRows = [];
    for (const p of placed) {
      if (p.hidden) continue;
      const text = 'q' + p.win.q;
      ctx.font = '600 10px system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 8;
      let px = p.mid - tw / 2;
      px = Math.max(PAD.l, Math.min(px, PAD.l + plotW - tw));
      if (px < lastRowRight) row = row === 0 ? 1 : 0;
      else row = 0;
      labelRows.push({ p, px, tw, row, text });
      lastRowRight = px + tw;
    }
    for (const L of labelRows) {
      const y = winTop + 5 + L.row * 15;
      ctx.fillStyle = withAlpha(P.surface, 0.92);
      roundRect(ctx, L.px, y - 1, L.tw, 14, 3);
      ctx.fill();
      ctx.fillStyle = L.p.bad ? P.critical : P.text2;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(L.text, L.px + 4, y + 1.5);
    }

    // 包络折线（取每桶绝对值上界，dB 时逐点）
    ctx.strokeStyle = P.s1;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < ov.bins; i++) {
      const frame = ov.lo + ((i + 0.5) / ov.bins) * (ov.hi - ov.lo + 1);
      const amp = Math.max(Math.abs(ov.min[i]), Math.abs(ov.max[i]));
      const x = PAD.l + ((frame - lo) / Math.max(1, hi - lo)) * plotW;
      const y = yOf(amp);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 零点竖线
    if (model.zero >= lo && model.zero <= hi) {
      const zx = Math.round(xOf(model.zero)) + 0.5;
      ctx.strokeStyle = P.s2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(zx, PAD.t);
      ctx.lineTo(zx, PAD.t + plotH);
      ctx.stroke();
      const a = Math.max(Math.abs(model.zeroValue), 1e-300);
      const zy = yOf(a);
      ctx.fillStyle = P.s2;
      ctx.beginPath();
      ctx.arc(zx, zy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // N-1 原点虚线标记
    const originX = xOf(model.dataLen ? model.originFrame : lo);
    if (model.originFrame >= lo && model.originFrame <= hi) {
      ctx.save();
      ctx.strokeStyle = withAlpha(P.muted, 0.55);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(originX) + 0.5, PAD.t);
      ctx.lineTo(Math.round(originX) + 0.5, PAD.t + plotH);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = P.muted;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      if (originX + 3 < PAD.l + plotW) ctx.fillText('N-1', originX + 3, PAD.t + plotH - 3);
    }

    // 轴
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, PAD.t + plotH + 0.5);
    ctx.lineTo(PAD.l + plotW, PAD.t + plotH + 0.5);
    ctx.stroke();

    ctx.fillStyle = P.muted;
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yTicks) {
      const label = dB ? (t.v === 0 ? '0 dB' : String(t.v)) : fmtCompact(t.v);
      ctx.fillText(label, PAD.l - 8, t.y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xt = niceTicks(lo, hi, Math.max(3, Math.floor(plotW / 110)));
    for (const v of xt) {
      const x = xOf(v);
      if (x < PAD.l - 1 || x > PAD.l + plotW + 1) continue;
      ctx.fillText(fmtFrame(v), x, PAD.t + plotH + 7);
    }
    canvas._hit = { kind: 'overview', lo, hi, plotW, plotH, viewLo: lo, viewHi: hi, model, ref, yOf, xOf, PAD };
  }

  /* --------------------------------------------------------------------- */
  /* 单窗波形                                                               */
  /* --------------------------------------------------------------------- */

  /*
   * 带符号波形：横轴为原反卷积帧号（窗起点..窗终点），纵轴对称于 0。
   * win: analysis.windows[i]，dataLen 用于标出补零区。
   */
  function drawWindowWave(canvas, win, dataLen, opts) {
    const { ctx, w, h } = prepare(canvas);
    const P = palette(canvas);
    canvas._hit = null;
    if (!win) return;
    const colors = [P.s1, P.s2, P.s3, P.s4];
    const main = (opts && opts.color) || colors[(win.q - 1) % colors.length];
    const pad = { l: 44, r: 8, t: 8, b: 16 };
    const plotW = Math.max(10, w - pad.l - pad.r);
    const plotH = Math.max(10, h - pad.t - pad.b);
    const n = win.length;
    const xOf = (i) => pad.l + ((i + 0.5) / n) * plotW;
    const frameOf = (i) => win.start + i;

    let amp = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(win.samples[i]);
      if (a > amp) amp = a;
    }
    if (!(amp > 0)) amp = 1;
    const top = amp * 1.12;
    const yOf = (v) => pad.t + plotH / 2 - (v / top) * (plotH / 2);

    // 补零区底纹
    const zl = win.start < 0 ? Math.min(-win.start, n) : 0;
    const zr = win.end > dataLen ? Math.min(win.end - dataLen, n) : 0;
    if (zl > 0 || zr > 0) {
      ctx.fillStyle = withAlpha(P.muted, 0.10);
      if (zl > 0) ctx.fillRect(pad.l, pad.t, (zl / n) * plotW, plotH);
      if (zr > 0) ctx.fillRect(pad.l + ((n - zr) / n) * plotW, pad.t, (zr / n) * plotW, plotH);
    }

    // 零线
    const y0 = Math.round(yOf(0)) + 0.5;
    ctx.strokeStyle = P.zero;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y0);
    ctx.lineTo(pad.l + plotW, y0);
    ctx.stroke();

    // 波形：面积填充 + 2px 线；样本多于像素时按像素列取 min/max
    ctx.fillStyle = withAlpha(main, 0.12);
    ctx.strokeStyle = main;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (n <= plotW * 1.5) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(i);
        const y = yOf(win.samples[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // 填充到零线
      ctx.lineTo(xOf(n - 1), y0);
      ctx.lineTo(xOf(0), y0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(i);
        const y = yOf(win.samples[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      const cols = Math.max(2, Math.floor(plotW));
      const per = n / cols;
      ctx.beginPath();
      const tops = new Float64Array(cols);
      const bots = new Float64Array(cols);
      for (let c = 0; c < cols; c++) {
        const s = Math.floor(c * per);
        const e = Math.min(n, Math.max(s + 1, Math.floor((c + 1) * per)));
        let mn = win.samples[s], mx = win.samples[s];
        for (let k = s + 1; k < e; k++) {
          const v = win.samples[k];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        tops[c] = mx; bots[c] = mn;
      }
      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const x = pad.l + (c + 0.5) * (plotW / cols);
        ctx.moveTo(x, yOf(bots[c]));
        ctx.lineTo(x, yOf(tops[c]));
      }
      ctx.strokeStyle = withAlpha(main, 0.85);
      ctx.lineWidth = Math.max(1, plotW / cols);
      ctx.stroke();
    }

    // 峰值标记
    if (win.peakIndex >= 0) {
      const pi = win.peakIndex - win.start;
      const px = xOf(pi);
      const py = yOf(win.peak);
      ctx.fillStyle = P.text;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.surface;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // 轴刻度
    ctx.fillStyle = P.muted;
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtCompact(top), pad.l - 5, yOf(top) + 4);
    ctx.fillText('0', pad.l - 5, y0);
    ctx.fillText(fmtCompact(-top), pad.l - 5, yOf(-top) - 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtFrame(win.start), pad.l, h - 1);
    ctx.textAlign = 'right';
    ctx.fillText(fmtFrame(win.end - 1), pad.l + plotW, h - 1);

    canvas._hit = { kind: 'window', win, n, plotW, pad, xOf, top, yOf, main };
  }

  function windowAt(canvas, win, clientX) {
    const rect = canvas.getBoundingClientRect();
    const pad = { l: 44, r: 8 };
    const plotW = Math.max(10, rect.width - pad.l - pad.r);
    const x = clientX - rect.left;
    const frac = (x - pad.l) / plotW;
    if (frac < 0 || frac > 1) return null;
    const i = Math.min(win.length - 1, Math.max(0, Math.floor(frac * win.length)));
    return { index: i, frame: win.start + i, value: win.samples[i] };
  }

  return {
    fmtSigned,
    drawOverview, drawWindowWave, windowAt,
  };
});
