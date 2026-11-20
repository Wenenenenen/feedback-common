// 折线图与直方图的 SVG 构建（检查台用）。
// 规范：2px 线、hairline 网格、文字用文字色而非系列色、≥2 系列带图例、
// 十字准线 + tooltip、浅/深色各自选色（不靠自动反色）。

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** 生成“好看”的坐标刻度。 */
export function niceTicks(min, max, count = 5) {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return [0];
  if (min === max) return [min];
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

export function formatNumber(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100000) return v.toExponential(1);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * 折线图。series: [{ key, label, color, values: Float32Array|number[] }]
 * xs: number[] 与 values 等长。
 * opts: { width, height, yLabel, markIndex, valueOf }
 */
export function lineChart(container, xs, series, opts = {}) {
  container.textContent = '';
  const compact = !!opts.compact;
  const width = opts.width || container.clientWidth || 460;
  const height = opts.height || 210;
  const pad = compact
    ? { l: 34, r: 8, t: 8, b: 8 }
    : { l: 52, r: 14, t: 14, b: 28 };
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);

  let ymin = Infinity, ymax = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      if (v < ymin) ymin = v;
      if (v > ymax) ymax = v;
    }
  }
  if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  if (opts.zeroBase) ymin = 0;
  const yPad = (ymax - ymin) * 0.08;
  ymin -= opts.zeroBase ? 0 : yPad;
  ymax += yPad;

  const xmin = xs.length ? xs[0] : 0;
  const xmax = xs.length ? xs[xs.length - 1] : 1;
  const sx = (v) => pad.l + (xmax === xmin ? iw / 2 : ((v - xmin) / (xmax - xmin)) * iw);
  const sy = (v) => pad.t + ih - ((v - ymin) / (ymax - ymin)) * ih;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    role: 'img', 'aria-label': opts.ariaLabel || '曲线图',
    class: 'viz-svg',
  }, container);

  const yTicks = niceTicks(ymin, ymax, compact ? 2 : 5);
  for (const t of yTicks) {
    if (t < ymin - 1e-9 || t > ymax + 1e-9) continue;
    el('line', {
      x1: pad.l, x2: pad.l + iw, y1: sy(t), y2: sy(t), class: 'viz-grid',
    }, svg);
    const label = el('text', {
      x: pad.l - 5, y: sy(t), class: 'viz-axis', 'text-anchor': 'end', 'dominant-baseline': 'middle',
    }, svg);
    label.textContent = formatNumber(t);
  }
  if (!compact) {
    const xt = niceTicks(xmin, xmax, Math.min(6, Math.max(2, Math.floor(iw / 70))));
    for (const t of xt) {
      if (t < xmin - 1e-9 || t > xmax + 1e-9) continue;
      const label = el('text', {
        x: sx(t), y: pad.t + ih + 15, class: 'viz-axis', 'text-anchor': 'middle',
      }, svg);
      label.textContent = formatNumber(t);
    }
  }
  el('line', {
    x1: pad.l, x2: pad.l + iw, y1: pad.t + ih, y2: pad.t + ih, class: 'viz-axis-line',
  }, svg);

  // 选中视差位置的竖线
  if (opts.gapMarks) {
    const bw = Math.max(1.5, Math.min(8, (iw / Math.max(1, xs.length)) * 0.55));
    for (let i = 0; i < xs.length; i++) {
      if (!opts.gapMarks[i]) continue;
      el('rect', {
        x: sx(xs[i]) - bw / 2, y: pad.t + ih * 0.2, width: bw, height: ih * 0.6,
        fill: 'var(--axis)', 'fill-opacity': 0.45, rx: 1,
      }, svg);
    }
  }
  if (Number.isFinite(opts.markIndex)) {
    el('line', {
      x1: sx(opts.markIndex), x2: sx(opts.markIndex), y1: pad.t, y2: pad.t + ih,
      class: 'viz-mark',
    }, svg);
  }

  for (const s of series) {
    let d = '';
    let pen = false;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(2)},${sy(v).toFixed(2)}`;
      pen = true;
    }
    if (s.fill) {
      // 面积淡洗（~10%）
      const nodes = [];
      let started = false, first = null, last = null;
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        if (!started) { first = i; started = true; }
        last = i;
        nodes.push(`${sx(xs[i]).toFixed(2)},${sy(v).toFixed(2)}`);
      }
      if (nodes.length) {
        el('path', {
          d: `M${sx(xs[first])},${pad.t + ih}L${nodes.join('L')}L${sx(xs[last])},${pad.t + ih}Z`,
          fill: s.color, 'fill-opacity': 0.1, stroke: 'none',
        }, svg);
      }
    }
    el('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);
    // 端点圆点（4px 半径 + 2px 表面环）
    let lastIdx = -1;
    for (let i = s.values.length - 1; i >= 0; i--) if (Number.isFinite(s.values[i])) { lastIdx = i; break; }
    if (lastIdx >= 0) {
      el('circle', {
        cx: sx(xs[lastIdx]), cy: sy(s.values[lastIdx]), r: 4,
        fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2,
      }, svg);
    }
  }

  // 十字准线 + tooltip（命中层覆盖整个绘图区）
  const cross = el('line', {
    x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, class: 'viz-cross', visibility: 'hidden',
  }, svg);
  const hit = el('rect', {
    x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair',
  }, svg);
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  container.appendChild(tip);

  const nearest = (px) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const dd = Math.abs(sx(xs[i]) - px);
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  };
  const show = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * width;
    const i = nearest(Math.max(pad.l, Math.min(pad.l + iw, px)));
    cross.setAttribute('x1', sx(xs[i])); cross.setAttribute('x2', sx(xs[i]));
    cross.setAttribute('visibility', 'visible');
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'viz-tip-head';
    head.textContent = `${opts.xLabel || 'd'} = ${formatNumber(xs[i])}`;
    tip.appendChild(head);
    for (const s of series) {
      const row = document.createElement('div');
      row.className = 'viz-tip-row';
      const key = document.createElement('span');
      key.className = 'viz-key';
      key.style.background = s.color;
      const val = document.createElement('strong');
      val.textContent = Number.isFinite(s.values[i]) ? (opts.valueFormat ? opts.valueFormat(s.values[i]) : formatNumber(s.values[i])) : '无效';
      const name = document.createElement('span');
      name.className = 'viz-tip-name';
      name.textContent = s.label;
      row.append(key, val, name);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth || 160;
    let left = ((sx(xs[i]) / width) * rect.width) + 14;
    if (left + tw > rect.width) left = ((sx(xs[i]) / width) * rect.width) - tw - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, ((sy(ymax) / height) * rect.height))}px`;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });

  return { svg, width, height };
}
