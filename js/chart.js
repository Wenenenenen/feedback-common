/* Generic inline-SVG line chart with hairline grid, crosshair and tooltip.
   No external dependencies. Theme via CSS custom properties. */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MARGIN = { top: 16, right: 16, bottom: 34, left: 44 };

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step;
    if (norm <= 1) step = 1 * mag;
    else if (norm <= 2) step = 2 * mag;
    else if (norm <= 5) step = 5 * mag;
    else step = 10 * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function LineChart(container, opts) {
    this.container = container;
    this.opts = opts; // {xLabel, unit, xTicks, yMaxFixed, onCursor}
    this.series = [];
    this.cursorX = null;
    this._build();
  }

  LineChart.prototype._build = function () {
    this.wrap = document.createElement('div');
    this.wrap.className = 'chart-wrap';
    this.svg = el('svg', { class: 'chart-svg', viewBox: '0 0 640 300', role: 'img' });
    this.gridG = el('g', {});
    this.dataG = el('g', {});
    this.axisG = el('g', { class: 'chart-axis' });
    this.cursorG = el('g', { class: 'chart-cursor' });
    this.cursorLine = el('line', { class: 'cursor-line', y1: MARGIN.top, y2: 300 - MARGIN.bottom });
    this.cursorDot = el('circle', { class: 'cursor-dot', r: 4.5 });
    this.cursorG.appendChild(this.cursorLine);
    this.cursorG.appendChild(this.cursorDot);
    this.svg.appendChild(this.gridG);
    this.svg.appendChild(this.dataG);
    this.svg.appendChild(this.axisG);
    this.svg.appendChild(this.cursorG);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;

    this.wrap.appendChild(this.svg);
    this.wrap.appendChild(this.tooltip);
    this.container.appendChild(this.wrap);

    this._tooltipNodes = [];
    this.svg.addEventListener('pointermove', (e) => this._onMove(e));
    this.svg.addEventListener('pointerleave', () => this._hideCursor());
  };

  LineChart.prototype._scales = function () {
    const w = 640;
    const h = 300;
    const xs = this.xDomain;
    const x0 = xs[0];
    const x1 = xs[xs.length - 1];
    const plotW = w - MARGIN.left - MARGIN.right;
    const plotH = h - MARGIN.top - MARGIN.bottom;
    return {
      x: (v) => MARGIN.left + ((v - x0) / (x1 - x0)) * plotW,
      y: (v) => MARGIN.top + plotH - (v / this.yMax) * plotH,
      plotW: plotW,
      plotH: plotH
    };
  };

  LineChart.prototype.setData = function (xDomain, yMax, series) {
    this.xDomain = xDomain;
    this.yMax = yMax;
    this.series = series.filter((s) => s.visible);
    this._render();
  };

  LineChart.prototype.setCursor = function (xVal) {
    this.cursorX = xVal;
    this._renderCursor();
  };

  LineChart.prototype._render = function () {
    const sc = this._scales();
    this.gridG.textContent = '';
    this.axisG.textContent = '';
    this.dataG.textContent = '';

    // horizontal grid + y ticks (0..yMax)
    const yTicks = niceTicks(0, this.yMax, 4);
    for (const t of yTicks) {
      if (t > this.yMax + 1e-9) continue;
      const y = sc.y(t);
      this.gridG.appendChild(el('line', {
        class: 'grid-line', x1: MARGIN.left, x2: 640 - MARGIN.right, y1: y, y2: y
      }));
      const label = el('text', { class: 'axis-label', x: MARGIN.left - 8, y: y + 4, 'text-anchor': 'end' });
      label.textContent = this._fmt(t);
      this.axisG.appendChild(label);
    }

    // x ticks
    const ticks = this.opts.xTicks || niceTicks(this.xDomain[0], this.xDomain[this.xDomain.length - 1], 6);
    for (const t of ticks) {
      const x = sc.x(t);
      this.gridG.appendChild(el('line', {
        class: 'grid-line vertical', x1: x, x2: x, y1: MARGIN.top, y2: 300 - MARGIN.bottom
      }));
      const label = el('text', { class: 'axis-label', x: x, y: 300 - MARGIN.bottom + 18, 'text-anchor': 'middle' });
      label.textContent = String(t);
      this.axisG.appendChild(label);
    }
    const xLabel = el('text', {
      class: 'axis-title', x: MARGIN.left + sc.plotW / 2, y: 296, 'text-anchor': 'middle'
    });
    xLabel.textContent = this.opts.xLabel;
    this.axisG.appendChild(xLabel);

    // series paths
    for (const s of this.series) {
      let d = '';
      for (let i = 0; i < this.xDomain.length; i++) {
        const px = sc.x(this.xDomain[i]);
        const py = sc.y(s.values[i]);
        d += (i === 0 ? 'M' : 'L') + px.toFixed(2) + ' ' + py.toFixed(2) + ' ';
      }
      const path = el('path', {
        class: 'series-line' + (s.dash ? ' dashed' : ''),
        d: d, stroke: s.color, 'stroke-width': 2, fill: 'none',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      });
      this.dataG.appendChild(path);
    }
    this._renderCursor();
  };

  LineChart.prototype._renderCursor = function () {
    if (this.cursorX === null || !this.xDomain) {
      this.cursorG.style.display = 'none';
      return;
    }
    this.cursorG.style.display = '';
    const sc = this._scales();
    // snap to nearest sampled x
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < this.xDomain.length; i++) {
      const dd = Math.abs(this.xDomain[i] - this.cursorX);
      if (dd < best) { best = dd; idx = i; }
    }
    const x = sc.x(this.xDomain[idx]);
    this.cursorLine.setAttribute('x1', x);
    this.cursorLine.setAttribute('x2', x);
    if (this.series.length > 0) {
      const s0 = this.series[0];
      this.cursorDot.setAttribute('cx', x);
      this.cursorDot.setAttribute('cy', sc.y(s0.values[idx]));
      this.cursorDot.setAttribute('fill', s0.color);
    } else {
      this.cursorDot.setAttribute('cx', x);
      this.cursorDot.setAttribute('cy', MARGIN.top);
    }
  };

  LineChart.prototype._onMove = function (event) {
    if (!this.xDomain) return;
    const rect = this.svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * 640;
    const sc = this._scales();
    const x0 = this.xDomain[0];
    const x1 = this.xDomain[this.xDomain.length - 1];
    const xVal = x0 + ((px - MARGIN.left) / sc.plotW) * (x1 - x0);
    if (xVal < x0 || xVal > x1) {
      this._hideCursor();
      return;
    }
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < this.xDomain.length; i++) {
      const dd = Math.abs(this.xDomain[i] - xVal);
      if (dd < best) { best = dd; idx = i; }
    }
    this.setCursor(this.xDomain[idx]);
    this._showTooltip(event, idx);
    if (this.opts.onCursor) this.opts.onCursor(this.xDomain[idx]);
  };

  LineChart.prototype._showTooltip = function (event, idx) {
    const xVal = this.xDomain[idx];
    let html = `<div class="tt-head">${this.opts.ttTitle(xVal)}</div>`;
    for (const s of this.series) {
      html += `<div class="tt-row"><span class="tt-key"><span class="tt-swatch" style="background:${s.color}"></span>${s.name}</span>` +
        `<span class="tt-val">${(s.values[idx] * 100).toFixed(1)}%</span></div>`;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    const wrapRect = this.wrap.getBoundingClientRect();
    let left = event.clientX - wrapRect.left + 14;
    let top = event.clientY - wrapRect.top - 8;
    const tw = this.tooltip.offsetWidth;
    if (left + tw > wrapRect.width - 4) left = event.clientX - wrapRect.left - tw - 14;
    if (top + this.tooltip.offsetHeight > wrapRect.height) top = wrapRect.height - this.tooltip.offsetHeight - 4;
    this.tooltip.style.left = left + 'px';
    this.tooltip.style.top = Math.max(4, top) + 'px';
  };

  LineChart.prototype._hideCursor = function () {
    this.cursorG.style.display = 'none';
    this.tooltip.hidden = true;
  };

  LineChart.prototype._fmt = function (v) {
    if (Math.abs(v) >= 1) return String(Math.round(v * 100) / 100);
    return String(Math.round(v * 100) / 100);
  };

  global.LineChart = LineChart;
})(typeof window !== 'undefined' ? window : globalThis);
