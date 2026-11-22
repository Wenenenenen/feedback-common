// SVG clock chart: packet index on X, unwrapped clock seconds on Y.
// Segments are drawn as separate polylines with a gap; raw modular values and
// delta kinds are available in the hover tooltip and via click-to-packet.

const SERIES_COLORS = {
  PCR: "var(--series-blue)",
  PTS: "var(--series-orange)",
  DTS: "var(--series-aqua)",
};
const KIND_MARKER = {
  wrap: "▲",
  regression: "▼",
  jump: "◆",
};

export function renderClockChart(container, { points, kindFilter, onSelectPacket }) {
  container.replaceChildren();
  if (!points.length) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "该 PID 没有时钟采样。";
    container.append(empty);
    return;
  }

  const W = Math.max(320, container.clientWidth || 720);
  const H = 300;
  const M = { top: 24, right: 20, bottom: 44, left: 64 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  // Segments reset the clock, so they do not share a meaningful absolute
  // origin. Plot each segment's *relative* seconds (time since that segment's
  // first sample); the absolute unwrapped value stays available in the tooltip
  // and in the packet detail. This keeps every segment non-negative and stops
  // a reset from drawing a diagonal line back across the chart.
  const segBase = new Map();
  for (const p of points) {
    if (!segBase.has(p.segmentId)) segBase.set(p.segmentId, p.seconds);
  }
  const plotPoints = points.map((p) => ({
    ...p,
    plotSeconds: p.seconds - segBase.get(p.segmentId),
  }));

  const xs = plotPoints.map((p) => p.packetIndex);
  const ys = plotPoints.map((p) => p.plotSeconds);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const yMin = 0;
  const yPad = (yMax - yMin || 1) * 0.08;

  const x = (v) => M.left + ((v - xMin) / ((xMax - xMin) || 1)) * plotW;
  const y = (v) => M.top + plotH - ((v - (yMin - yPad)) / ((yMax - yMin) + 2 * yPad || 1)) * plotH;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "clock-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${kindFilter || "时钟"} 展开值随包号变化图`);

  // Grid + Y ticks (5 lines). Ticks span the real data range [0, yMax] so no
  // negative label is ever drawn; headroom above the top point is padding only.
  for (let i = 0; i <= 4; i++) {
    const val = yMin + (yMax - yMin) * (i / 4);
    const gy = y(val);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", M.left); line.setAttribute("x2", W - M.right);
    line.setAttribute("y1", gy); line.setAttribute("y2", gy);
    line.setAttribute("class", "grid-line");
    svg.append(line);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", M.left - 8); label.setAttribute("y", gy + 4);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "end");
    label.textContent = formatSeconds(val);
    svg.append(label);
  }

  // X ticks (up to 6 packet indices)
  const tickCount = Math.min(6, points.length);
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.round(xMin + ((xMax - xMin) * i) / Math.max(1, tickCount - 1));
    const gx = x(idx);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", gx); label.setAttribute("y", H - M.bottom + 18);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = `#${idx}`;
    svg.append(label);
  }

  // Axis titles
  const xTitle = document.createElementNS(svgNS, "text");
  xTitle.setAttribute("x", M.left + plotW / 2);
  xTitle.setAttribute("y", H - 6);
  xTitle.setAttribute("class", "axis-title");
  xTitle.setAttribute("text-anchor", "middle");
  xTitle.textContent = "包号（文件内顺序）";
  svg.append(xTitle);

  const yTitle = document.createElementNS(svgNS, "text");
  yTitle.setAttribute("x", 14); yTitle.setAttribute("y", M.top + plotH / 2);
  yTitle.setAttribute("class", "axis-title");
  yTitle.setAttribute("transform", `rotate(-90 14 ${M.top + plotH / 2})`);
  yTitle.setAttribute("text-anchor", "middle");
  yTitle.textContent = "分段内相对时钟（秒）";
  svg.append(yTitle);

  // Segment boundary verticals
  const segIds = [...new Set(plotPoints.map((p) => p.segmentId))];
  for (const segId of segIds) {
    const segPoints = plotPoints.filter((p) => p.segmentId === segId);
    if (segId > 0) {
      const bx = x(segPoints[0].packetIndex);
      const bline = document.createElementNS(svgNS, "line");
      bline.setAttribute("x1", bx); bline.setAttribute("x2", bx);
      bline.setAttribute("y1", M.top); bline.setAttribute("y2", M.top + plotH);
      bline.setAttribute("class", "segment-boundary");
      svg.append(bline);
      const reason = segPoints[0].segmentReason;
      if (reason) {
        const tag = document.createElementNS(svgNS, "text");
        tag.setAttribute("x", bx + 4); tag.setAttribute("y", M.top + 12);
        tag.setAttribute("class", "segment-tag");
        tag.textContent = reasonLabel(reason);
        svg.append(tag);
      }
    }
  }

  // One polyline per segment so discontinuities show as gaps, not diagonal jumps
  for (const segId of segIds) {
    const segPoints = plotPoints.filter((p) => p.segmentId === segId);
    if (segPoints.length < 2) continue;
    const pl = document.createElementNS(svgNS, "polyline");
    pl.setAttribute("points", segPoints.map((p) => `${x(p.packetIndex)},${y(p.plotSeconds)}`).join(" "));
    pl.setAttribute("class", "clock-line");
    pl.setAttribute("stroke", SERIES_COLORS[kindFilter] || "var(--series-blue)");
    svg.append(pl);
  }

  // Points, with special markers for wrap/regression/jump
  for (const p of plotPoints) {
    const c = document.createElementNS(svgNS, "circle");
    c.setAttribute("cx", x(p.packetIndex));
    c.setAttribute("cy", y(p.plotSeconds));
    c.setAttribute("r", p.deltaKind === "normal" || p.deltaKind === "first" ? 3.5 : 5);
    c.setAttribute("class", `clock-point clock-point-${p.deltaKind}`);
    c.dataset.index = String(p.packetIndex);
    svg.append(c);

    if (KIND_MARKER[p.deltaKind]) {
      const m = document.createElementNS(svgNS, "text");
      m.setAttribute("x", x(p.packetIndex) + 7);
      m.setAttribute("y", y(p.plotSeconds) - 6);
      m.setAttribute("class", `kind-marker kind-${p.deltaKind}`);
      m.textContent = KIND_MARKER[p.deltaKind];
      svg.append(m);
    }
  }

  // Crosshair + hover layer
  const cross = document.createElementNS(svgNS, "line");
  cross.setAttribute("y1", M.top); cross.setAttribute("y2", M.top + plotH);
  cross.setAttribute("class", "crosshair");
  cross.setAttribute("visibility", "hidden");
  svg.append(cross);
  const hoverDot = document.createElementNS(svgNS, "circle");
  hoverDot.setAttribute("r", 6);
  hoverDot.setAttribute("class", "hover-dot");
  hoverDot.setAttribute("visibility", "hidden");
  svg.append(hoverDot);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;

  const hit = document.createElementNS(svgNS, "rect");
  hit.setAttribute("x", M.left); hit.setAttribute("y", M.top);
  hit.setAttribute("width", plotW); hit.setAttribute("height", plotH);
  hit.setAttribute("class", "hit-layer");
  svg.append(hit);

  // Listen on the whole SVG: data-point circles sit above the transparent hit
  // rect, so binding only to that rect would miss clicks landing on a marker.
  const nearestAt = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let nearest = plotPoints[0];
    let nd = Infinity;
    for (const p of plotPoints) {
      const d = Math.abs(x(p.packetIndex) - px);
      if (d < nd) { nd = d; nearest = p; }
    }
    return nearest;
  };
  const insidePlot = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const py = ((ev.clientY - rect.top) / rect.height) * H;
    // Small tolerance so points sitting exactly on the plot edge still count.
    const t = 2;
    return px >= M.left - t && px <= W - M.right + t &&
      py >= M.top - t && py <= M.top + plotH + t;
  };

  svg.addEventListener("pointermove", (ev) => {
    if (!insidePlot(ev)) return;
    const nearest = nearestAt(ev.clientX);
    const nx = x(nearest.packetIndex);
    cross.setAttribute("x1", nx); cross.setAttribute("x2", nx);
    cross.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", nx);
    hoverDot.setAttribute("cy", y(nearest.plotSeconds));
    hoverDot.setAttribute("visibility", "visible");
    tooltip.replaceChildren(buildTooltip(nearest));
    tooltip.hidden = false;
    const rect = svg.getBoundingClientRect();
    tooltip.style.left = `${(nx / W) * rect.width + 12}px`;
    tooltip.style.top = `${(y(nearest.plotSeconds) / H) * rect.height + 8}px`;
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
  svg.addEventListener("click", (ev) => {
    if (!insidePlot(ev)) return;
    const nearest = nearestAt(ev.clientX);
    onSelectPacket?.(nearest.packetIndex);
  });

  container.append(svg, tooltip);
}

function buildTooltip(p) {
  const frag = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "tt-title";
  title.textContent = `#${p.packetIndex} · PID ${p.pid} · ${p.kind}`;
  frag.append(title);
  const rows = [
    ["原始值", p.raw.toString()],
    ["展开值", p.unwrapped.toString()],
    ["分段内秒", formatSeconds(p.plotSeconds)],
    ["绝对秒", formatSeconds(p.seconds)],
    ["增量", `${p.delta > 0n ? "+" : ""}${p.delta.toString()}`],
    ["判定", deltaLabel(p.deltaKind)],
    ["分段", String(p.segmentId)],
  ];
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.className = "tt-row";
    const kk = document.createElement("span");
    kk.className = "tt-key";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "tt-val";
    vv.textContent = v;
    r.append(kk, vv);
    frag.append(r);
  }
  const hint = document.createElement("div");
  hint.className = "tt-hint";
  hint.textContent = "点击回到该包";
  frag.append(hint);
  return frag;
}

function reasonLabel(reason) {
  return { start: "起始", discontinuity: "显式不连续", program_switch: "节目切换" }[reason] || reason;
}
function deltaLabel(kind) {
  return {
    first: "首个采样", normal: "正常", wrap: "回绕",
    regression: "小幅倒退", jump: "异常前跳",
  }[kind] || kind;
}
function formatSeconds(v) {
  if (Math.abs(v) < 1) return v.toExponential(2);
  if (Math.abs(v) < 100) return v.toFixed(4);
  return v.toFixed(2);
}
