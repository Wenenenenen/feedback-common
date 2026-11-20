import type { Diagnostic, ParameterizeResult, UV } from '../core/types.js';
import { signedDoubleArea2 } from '../core/vec.js';
import { chartColor, STATUS } from './colors.js';
import type { Store } from './state.js';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = (v: number, digits = 3): string => {
  if (!Number.isFinite(v)) return String(v);
  if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(2);
  return v.toFixed(digits);
};

export function renderOverview(host: HTMLElement, badge: HTMLElement, meta: HTMLElement, store: Store): void {
  const result = store.result;
  const input = store.input;
  host.innerHTML = '';
  meta.innerHTML = '';
  if (!result || !input) {
    badge.className = 'badge neutral';
    badge.textContent = input ? '仅网格' : '未载入';
    return;
  }

  const errorCount = result.errors.filter((e) => e.severity === 'error').length;
  const warnCount = result.warnings.length;
  const chartCount = result.stats.charts;
  const validCharts = result.stats.validCharts;

  if (errorCount > 0) {
    badge.className = 'badge err';
    badge.textContent = `失败 · ${errorCount} 错误`;
  } else if (chartCount > 0 && validCharts === chartCount) {
    badge.className = 'badge ok';
    badge.textContent = warnCount > 0 ? `通过 · ${warnCount} 警告` : '通过';
  } else {
    badge.className = 'badge warn';
    badge.textContent = '无有效图表';
  }

  const stats: [string, string, string?][] = [
    ['图表', `${validCharts}/${chartCount}`, chartCount > 0 && validCharts === chartCount ? 'good' : chartCount > 0 ? 'bad' : undefined],
    ['边界环', String(result.stats.boundaryLoops), result.stats.boundaryLoops === chartCount ? 'good' : undefined],
    ['cut 顶点', String(result.stats.cutVertices)],
    ['三角面', String(result.stats.faces)],
    ['切缝', String(result.stats.seams)],
    ['内部点', String(result.stats.interiorVertices)],
    ['翻转面', String(result.stats.flippedFaces), result.stats.flippedFaces > 0 ? 'bad' : 'good'],
    ['近零面', String(result.stats.nearZeroFaces), result.stats.nearZeroFaces > 0 ? 'warn' : undefined],
    ['最大残差', result.stats.maxResidual === 0 ? '0' : result.stats.maxResidual.toExponential(1), result.stats.maxResidual > 1e-8 ? 'bad' : 'good'],
  ];

  for (const [k, v, tone] of stats) {
    const cell = el('div', 'stat');
    cell.append(el('div', 'k', k), el('div', `v${tone ? ` ${tone}` : ''}${v.length > 8 ? ' small' : ''}`, v));
    host.append(cell);
  }

  if (store.sourceName) meta.append(el('span', '', store.sourceName));
  meta.append(el('span', '', `网格 ${input.vertices.length}V / ${input.faces.length}F`));
  meta.append(el('span', '', `用时 ${fmt(result.timings.totalMs, 1)} ms`));
}

export function renderSeams(
  host: HTMLElement,
  count: HTMLElement,
  store: Store,
  onChange: (seams: [number, number][]) => void,
  onHoverSeam: (edge: [number, number] | null) => void,
): void {
  host.innerHTML = '';
  count.textContent = String(store.seams.length);
  if (store.seams.length === 0) {
    host.append(el('p', 'empty', '暂无切缝'));
    return;
  }
  store.seams
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .forEach((edge) => {
      const row = el('div', 'seam-row');
      row.append(el('span', 'swatch'));
      const label = el('span', '', `(${edge[0]}, ${edge[1]})`);
      row.append(label);
      const del = el('button', 'del', '✕');
      del.type = 'button';
      del.title = '删除切缝';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        onChange(store.seams.filter((s) => !(s[0] === edge[0] && s[1] === edge[1])));
      });
      row.append(del);
      row.addEventListener('mouseenter', () => onHoverSeam(edge));
      row.addEventListener('mouseleave', () => onHoverSeam(null));
      host.append(row);
    });
}

export function renderCharts(host: HTMLElement, count: HTMLElement, store: Store): void {
  host.innerHTML = '';
  const result = store.result;
  count.textContent = String(result?.charts.length ?? 0);
  if (!result || result.charts.length === 0) {
    host.append(el('p', 'empty', '暂无图表'));
    return;
  }
  for (const chart of result.charts) {
    const row = el('div', `chart-row${chart.valid ? '' : ' invalid'}`);
    const swatch = el('span', 'swatch');
    swatch.style.background = chartColor(chart.index);
    row.append(swatch);
    row.append(el('span', '', `图表 ${chart.index}`));
    row.append(
      el(
        'span',
        'meta',
        `${chart.faces.length}F · E=${chart.topology.euler} · 环${chart.topology.boundaryLoops} · 残差${chart.residuals.max.toExponential(0)}`,
      ),
    );
    if (chart.flippedFaces.length > 0) {
      const warn = el('span', 'meta');
      warn.style.color = STATUS.critical;
      warn.textContent = `翻转${chart.flippedFaces.length}`;
      row.append(warn);
    }
    row.addEventListener('click', () => {
      store.select({
        chart: chart.index,
        face: chart.faces[0] ?? null,
        faces: chart.faces,
        cutVertex: null,
      });
    });
    row.addEventListener('mouseenter', () => {
      store.select({ chart: chart.index, faces: chart.faces });
    });
    host.append(row);
  }
}

const CODE_LABEL: Record<string, string> = {
  'invalid-input': '输入格式',
  'invalid-vertex': '无效顶点',
  'invalid-face': '无效面',
  'invalid-index': '索引越界',
  'empty-mesh': '空网格',
  'triangle-limit': '超过面数限制',
  'degenerate-face': '退化面',
  'non-manifold-edge': '非流形边',
  'inconsistent-orientation': '方向不一致',
  'non-manifold-vertex': '非流形顶点',
  'seam-degenerate': '退化切缝',
  'seam-not-found': '切缝不存在',
  'seam-on-boundary': '边界上的切缝',
  'duplicate-seam': '重复切缝',
  'chart-not-disk': '非圆盘图表',
  'boundary-branching': '边界分叉',
  'degenerate-boundary': '退化边界',
  'singular-system': '奇异方程',
  'solver-failed': '求解失败',
};

export function describeElements(d: Diagnostic): string {
  const parts: string[] = [];
  const e = d.elements;
  if (!e) return '';
  if (e.chart !== undefined) parts.push(`图表 ${e.chart}`);
  if (e.faces?.length) {
    const shown = e.faces.slice(0, 8).join(', ');
    parts.push(`面 [${shown}${e.faces.length > 8 ? ` … +${e.faces.length - 8}` : ''}]`);
  }
  if (e.vertices?.length) {
    const shown = e.vertices.slice(0, 8).join(', ');
    parts.push(`顶点 [${shown}${e.vertices.length > 8 ? ` … +${e.vertices.length - 8}` : ''}]`);
  }
  if (e.edges?.length) {
    const shown = e.edges.slice(0, 6).map((x) => `(${x[0]},${x[1]})`).join(' ');
    parts.push(`边 [${shown}${e.edges.length > 6 ? ` … +${e.edges.length - 6}` : ''}]`);
  }
  if (e.seam) parts.push(`切缝 (${e.seam[0]}, ${e.seam[1]})`);
  if (e.cutVertices?.length) {
    const shown = e.cutVertices.slice(0, 8).join(', ');
    parts.push(`cut 顶点 [${shown}${e.cutVertices.length > 8 ? ` … +${e.cutVertices.length - 8}` : ''}]`);
  }
  if (e.loops?.length) {
    const describe = (loop: number[], i: number): string => {
      const verts = e.loopVertices?.[i];
      const shown = (verts ?? loop).slice(0, 6).map(String).join(', ');
      const more = (verts ?? loop).length > 6 ? ` … +${(verts ?? loop).length - 6}` : '';
      return `(${loop.length}: ${shown}${more})`;
    };
    parts.push(`边界环 ${e.loops.map(describe).join(' ')}`);
  }
  if (e.vertexFans?.length) parts.push(`扇数量 ${e.vertexFans.map((f) => f.fans.length).join('/')}`);
  return parts.join(' · ');
}

export function renderDiagnostics(host: HTMLElement, count: HTMLElement, store: Store): void {
  host.innerHTML = '';
  const result: ParameterizeResult | null = store.result;
  const items: Diagnostic[] = result
    ? [...result.errors, ...result.warnings]
    : [];
  count.textContent = String(items.length);
  if (items.length === 0) {
    host.append(el('p', 'empty', result ? '没有发现拓扑或求解问题' : '暂无诊断'));
    return;
  }
  const ordered = items
    .slice()
    .sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));

  for (const d of ordered) {
    const card = el('div', `diag ${d.severity}`);
    const top = el('div', 'top');
    top.append(el('span', 'code', CODE_LABEL[d.code] ?? d.code));
    card.append(top);
    card.append(el('div', 'msg', d.message));
    const where = describeElements(d);
    if (where) card.append(el('div', 'where', where));
    card.addEventListener('click', () => {
      const face = d.elements?.faces?.[0] ?? null;
      const chart = d.elements?.chart ?? null;
      const faces =
        chart !== null && store.result ? store.result.charts[chart]?.faces ?? [] : d.elements?.faces ?? [];
      store.select({ face, chart, faces, cutVertex: d.elements?.cutVertices?.[0] ?? null });
    });
    host.append(card);
  }
}

export function renderExportSummary(host: HTMLElement, store: Store): void {
  host.innerHTML = '';
  const result = store.result;
  if (!result) {
    host.textContent = '—';
    return;
  }
  const splitCount = new Set(
    result.cutVertices.filter((cv) => cv.corners.length > 1).map((cv) => cv.originalVertex),
  ).size;
  host.innerHTML = [
    `逐角 UV：${result.cornerUV.length} 角`,
    `拆分顶点：${splitCount} 个原始顶点`,
    `图表诊断：${result.errors.length + result.warnings.length} 条`,
  ].join('<br>');
}

const e3 = (v: number): string => (v === 0 ? '0' : v.toExponential(2));

/**
 * Inspector: the selected face's chart, split-vertex correspondence, UV
 * double-area and its three per-vertex equation residuals.
 */
export function renderInspector(host: HTMLElement, tag: HTMLElement, store: Store): void {
  host.innerHTML = '';
  const result = store.result;
  const input = store.input;
  const fi = store.selection.face;
  if (!result || !input || fi === null || !input.faces[fi]) {
    tag.textContent = '—';
    host.append(el('p', 'empty', '在三维视图或 UV 视图中选择一个面'));
    return;
  }
  tag.textContent = `面 ${fi}`;
  const chartIndex = result.faceChart[fi] ?? -1;
  const chart = chartIndex >= 0 ? result.charts[chartIndex] : undefined;

  const kv = (k: string, v: string, tone?: 'good' | 'bad' | 'warn'): void => {
    const row = el('div', 'kv');
    row.append(el('span', 'k', k), el('span', `v${tone ? ` ${tone}` : ''}`, v));
    host.append(row);
  };

  kv('图表', chartIndex >= 0 ? String(chartIndex) : '—', chart && !chart.valid ? 'bad' : undefined);
  kv('顶点索引', input.faces[fi].join(', '));

  const cutIds = [0, 1, 2].map((c) => result.cornerCutVertex[fi * 3 + c] ?? -1);
  kv('cut 顶点', cutIds.join(', '));

  const uvs = [0, 1, 2].map((c) => result.cornerUV[fi * 3 + c]);
  if (uvs.every((uv) => uv !== null)) {
    const [a, b, c] = uvs as [UV, UV, UV];
    const area2 = signedDoubleArea2(a, b, c);
    const tone = area2 < -1e-10 ? 'bad' : Math.abs(area2) <= 1e-10 ? 'warn' : 'good';
    kv('UV 双面积', e3(area2), tone);
    const label = area2 < -1e-10 ? '翻转' : Math.abs(area2) <= 1e-10 ? '近零' : '正常';
    kv('朝向', label, tone);
  } else {
    kv('UV 双面积', '—（未求解）', 'bad');
  }

  // Equation residual per corner: the chart's Laplacian residual at the cut vertex.
  host.append(el('div', 'subhead', '方程残差（按角）'));
  const resid = el('div', 'resid');
  const values = cutIds.map((cv) => {
    const r = chart?.residuals.interior.find((x) => x.cutVertex === cv);
    return { cv, value: r?.normalized ?? null, onBoundary: chart?.boundaryVertices.includes(cv) ?? false };
  });
  const chartMax = Math.max(
    chart?.residuals.max ?? 0,
    ...values.map((v) => v.value ?? 0),
  );
  const anyInterior = values.some((v) => v.value !== null);
  const maxValue = anyInterior ? Math.max(chartMax, 1e-12) : Math.max(chartMax, 1e-12);
  for (let c = 0; c < 3; c++) {
    const entry = values[c];
    const row = el('div', `row${entry.value !== null && entry.value > 1e-8 ? ' bad' : ''}`);
    row.append(el('span', '', `角 ${c}`));
    const track = el('div', 'track');
    const bar = el('div', 'bar');
    if (entry.value === null) {
      bar.style.width = '0%';
      track.title = entry.onBoundary ? '边界点（固定）' : '无内部方程';
    } else {
      const t = entry.value / maxValue;
      bar.style.width = `${Math.max(1.5, t * 100).toFixed(1)}%`;
    }
    track.append(bar);
    row.append(track);
    row.append(
      el(
        'span',
        'val',
        entry.value === null ? (entry.onBoundary ? '边界' : '—') : e3(entry.value),
      ),
    );
    resid.append(row);
  }
  const scale = el('div', 'scale');
  scale.append(
    el('span', '', anyInterior ? '0' : '该面三个角都在边界上（固定）'),
    el('span', '', `图表 max ${e3(chartMax)}`),
  );
  resid.append(scale);
  host.append(resid);

  if (chart) {
    kv('图表残差', `max ${e3(chart.residuals.max)} · mean ${e3(chart.residuals.mean)}`, chart.residuals.max > 1e-8 ? 'bad' : 'good');
  }

  if (store.selection.chart !== null && store.selection.faces.length > 1) {
    kv('选中图表面数', String(store.selection.faces.length));
  }
}
