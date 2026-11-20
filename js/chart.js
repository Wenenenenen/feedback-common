/**
 * 收敛曲线：SVG 折线图，纵轴为相对残差（对数刻度），支持多通道序列。
 * 自带十字线 + 全序列 tooltip；文本一律 textContent，不拼接 HTML。
 */

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
const SERIES_COLORS_DARK = ['#3987e5', '#d95926', '#199e70'];
const CHANNEL_NAMES = ['R / 灰', 'G', 'B'];

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * @param {object} opts
 * @param {{iter:number, relResidual:number}[][]} series 每通道的 history
 * @param {number} tol 容差参考线
 * @param {boolean} dark
 */
export function renderConvergenceChart(container, series, tol, dark) {
  container.replaceChildren();
  const colors = dark ? SERIES_COLORS_DARK : SERIES_COLORS;
  const css = getComputedStyle(document.documentElement);
  const inkMuted = css.getPropertyValue('--text-muted').trim() || '#898781';
  const grid = css.getPropertyValue('--gridline').trim() || '#e1e0d9';
  const axis = css.getPropertyValue('--axis').trim() || '#c3c2b7';
  const ink = css.getPropertyValue('--text-primary').trim() || '#0b0b0b';

  const W = 720;
  const H = 300;
  const M = { top: 24, right: 20, bottom: 44, left: 64 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': '共轭梯度收敛曲线，纵轴为相对残差对数刻度',
    class: 'conv-svg',
  });

  const maxIter = Math.max(...series.map((s) => s.length - 1), 1);
  const allVals = series.flatMap((s) => s.map((d) => d.relResidual)).filter((v) => v > 0);
  let yMin = Math.min(...allVals, tol);
  let yMax = Math.max(...allVals, 1);
  yMin = Math.max(1e-16, yMin * 0.5);
  yMax = Math.min(10, yMax * 1.5);
  const lgMin = Math.floor(Math.log10(yMin));
  const lgMax = Math.ceil(Math.log10(yMax));

  const xScale = (it) => M.left + (it / maxIter) * iw;
  const yScale = (v) => {
    const lv = Math.log10(Math.max(v, 1e-16));
    return M.top + ((lgMax - lv) / (lgMax - lgMin)) * ih;
  };

  // 网格 + y 轴对数刻度
  for (let e = lgMin; e <= lgMax; e++) {
    const y = yScale(Math.pow(10, e));
    svg.appendChild(el('line', {
      x1: M.left, x2: M.left + iw, y1: y, y2: y,
      stroke: grid, 'stroke-width': 1,
    }));
    const t = el('text', {
      x: M.left - 8, y: y + 4, 'text-anchor': 'end',
      'font-size': 11, fill: inkMuted, class: 'chart-tick',
    });
    t.textContent = `1e${e}`;
    svg.appendChild(t);
  }
  // x 轴刻度（最多 8 个）
  const xStep = Math.max(1, Math.ceil(maxIter / 8));
  for (let it = 0; it <= maxIter; it += xStep) {
    const x = xScale(it);
    const t = el('text', {
      x, y: M.top + ih + 20, 'text-anchor': 'middle',
      'font-size': 11, fill: inkMuted, class: 'chart-tick',
    });
    t.textContent = String(it);
    svg.appendChild(t);
  }
  // 轴线
  svg.appendChild(el('line', {
    x1: M.left, x2: M.left, y1: M.top, y2: M.top + ih,
    stroke: axis, 'stroke-width': 1,
  }));
  svg.appendChild(el('line', {
    x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih,
    stroke: axis, 'stroke-width': 1,
  }));

  // 轴标题
  const yTitle = el('text', {
    x: 16, y: M.top + ih / 2, 'text-anchor': 'middle',
    'font-size': 12, fill: ink,
    transform: `rotate(-90 16 ${M.top + ih / 2})`,
  });
  yTitle.textContent = '相对残差 ‖r‖/‖b‖（对数）';
  svg.appendChild(yTitle);
  const xTitle = el('text', {
    x: M.left + iw / 2, y: H - 6, 'text-anchor': 'middle',
    'font-size': 12, fill: ink,
  });
  xTitle.textContent = 'CG 迭代次数';
  svg.appendChild(xTitle);

  // 容差参考线
  if (tol >= yMin && tol <= yMax) {
    const yt = yScale(tol);
    svg.appendChild(el('line', {
      x1: M.left, x2: M.left + iw, y1: yt, y2: yt,
      stroke: inkMuted, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
    }));
    const tt = el('text', {
      x: M.left + iw - 4, y: yt - 5, 'text-anchor': 'end',
      'font-size': 11, fill: inkMuted,
    });
    tt.textContent = `tol = ${tol.toExponential(0)}`;
    svg.appendChild(tt);
  }

  // 数据序列
  series.forEach((hist, si) => {
    if (!hist || hist.length === 0) return;
    const d = hist.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.iter).toFixed(2)},${yScale(p.relResidual).toFixed(2)}`).join(' ');
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: colors[si], 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // 终点标记（带表面色 2px 环）
    const last = hist[hist.length - 1];
    svg.appendChild(el('circle', {
      cx: xScale(last.iter), cy: yScale(last.relResidual), r: 4.5,
      fill: colors[si], stroke: dark ? '#1a1a19' : '#fcfcfb', 'stroke-width': 2,
    }));
  });

  // 十字线 + 捕获层
  const cross = el('line', {
    y1: M.top, y2: M.top + ih, stroke: inkMuted, 'stroke-width': 1,
    'stroke-dasharray': '3 3', visibility: 'hidden',
  });
  svg.appendChild(cross);
  const dots = series.map((_, si) => el('circle', {
    r: 4, fill: colors[si], stroke: dark ? '#1a1a19' : '#fcfcfb',
    'stroke-width': 2, visibility: 'hidden',
  }));
  dots.forEach((d) => svg.appendChild(d));

  const overlay = el('rect', {
    x: M.left, y: M.top, width: iw, height: ih,
    fill: 'transparent', class: 'chart-hit',
  });
  svg.appendChild(overlay);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;

  // 事件绑在 SVG 根上：路径/圆点等子元素不会挡住指针捕获
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const py = ((ev.clientY - rect.top) / rect.height) * H;
    if (py < M.top || py > M.top + ih) return;
    const it = Math.round(((px - M.left) / iw) * maxIter);
    if (it < 0 || it > maxIter) return;
    const x = xScale(Math.min(it, maxIter));
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    tooltip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = `迭代 ${Math.min(it, maxIter)}`;
    tooltip.appendChild(head);
    series.forEach((hist, si) => {
      if (!hist || hist.length === 0) return;
      const point = hist[Math.min(it, hist.length - 1)];
      dots[si].setAttribute('cx', xScale(point.iter));
      dots[si].setAttribute('cy', yScale(point.relResidual));
      dots[si].setAttribute('visibility', 'visible');
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('span');
      key.className = 'tt-key';
      key.style.setProperty('--key-color', colors[si]);
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = CHANNEL_NAMES[si] || `通道 ${si}`;
      const val = document.createElement('strong');
      val.textContent = point.relResidual.toExponential(3);
      row.append(key, name, val);
      tooltip.appendChild(row);
    });
    tooltip.hidden = false;
    const cw = container.clientWidth;
    const localX = (x / W) * rect.width;
    tooltip.style.left = `${Math.min(localX + 14, cw - 150)}px`;
    tooltip.style.top = `${(M.top / H) * rect.height + 8}px`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tooltip.hidden = true;
  });

  // 图例（>=2 序列时）
  if (series.length >= 2) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    series.forEach((_, si) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-line';
      sw.style.background = colors[si];
      const label = document.createElement('span');
      label.textContent = CHANNEL_NAMES[si] || `通道 ${si}`;
      item.append(sw, label);
      legend.appendChild(item);
    });
    container.append(svg, tooltip, legend);
  } else {
    container.append(svg, tooltip);
  }
}
