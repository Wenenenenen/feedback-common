// Windowed packet table: only the visible rows are in the DOM, so a 180k-packet
// capture stays responsive. Row height is fixed to make windowing arithmetic exact.

export const ROW_HEIGHT = 30;

const ISSUE_BADGES = {
  exact_duplicate: ["重复", "badge-dup"],
  same_cc_different: ["同号异内容", "badge-diff"],
  cc_gap: ["缺包", "badge-gap"],
  discontinuity: ["不连续", "badge-disc"],
  adaptation_only: ["仅适配", "badge-afonly"],
  tei_set: ["TEI", "badge-tei"],
  sync_lost: ["失步", "badge-sync"],
  truncated_packet: ["截断", "badge-trunc"],
  reserved_afc: ["保留AFC", "badge-tei"],
};

export function createPacketTable(host, { getRows, onRowActivate }) {
  host.classList.add("packet-table-host");
  const spacer = document.createElement("div");
  spacer.className = "table-spacer";
  const viewport = document.createElement("div");
  viewport.className = "table-viewport";
  const header = buildHeader();
  host.append(header, viewport);
  viewport.append(spacer);

  let overscan = 12;
  let selectedIndex = -1;

  function render() {
    const rows = getRows();
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
    const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + overscan * 2;
    const last = Math.min(rows.length, first + visibleCount);

    spacer.replaceChildren();
    for (let i = first; i < last; i++) {
      const row = rows[i];
      const tr = document.createElement("div");
      tr.className = "prow" + (row.index === selectedIndex ? " selected" : "");
      tr.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      tr.dataset.index = String(row.index);
      tr.append(
        cell(String(row.index), "num"),
        cell(String(row.offset), "num"),
        cell(formatPid(row.pid), "num pid-cell"),
        cell(row.pusi ? "1" : "0", "num"),
        cell(row.cc.toString(16).toUpperCase().padStart(1, "0"), "num cc-cell"),
        cell(afcLabel(row.afc), "num"),
        issueBadges(row.issues),
        clockCell(row),
      );
      tr.addEventListener("click", () => select(row.index, true));
      spacer.append(tr);
    }
  }

  function select(index, scrollIntoView) {
    selectedIndex = index;
    if (scrollIntoView) {
      const rows = getRows();
      const pos = rows.findIndex((r) => r.index === index);
      if (pos >= 0) {
        viewport.scrollTop = Math.max(0, pos * ROW_HEIGHT - viewport.clientHeight / 2);
      }
    }
    onRowActivate?.(index);
    render();
  }

  viewport.addEventListener("scroll", render, { passive: true });
  window.addEventListener("resize", render);

  return {
    render,
    select,
    refresh: render,
  };
}

function buildHeader() {
  const header = document.createElement("div");
  header.className = "table-header";
  for (const [label, cls] of [
    ["包号", "num"], ["文件偏移", "num"], ["PID", "num pid-cell"],
    ["PUSI", "num"], ["CC", "num cc-cell"], ["适配", "num"],
    ["标记", "badges"], ["PCR / PTS", "clock"],
  ]) {
    const c = document.createElement("div");
    c.className = `hcell ${cls}`;
    c.textContent = label;
    header.append(c);
  }
  return header;
}

function cell(text, cls) {
  const d = document.createElement("div");
  d.className = `cell ${cls}`;
  d.textContent = text;
  return d;
}

function issueBadges(issues) {
  const wrap = document.createElement("div");
  wrap.className = "cell badges";
  for (const iss of issues) {
    const spec = ISSUE_BADGES[iss];
    if (!spec) continue;
    const b = document.createElement("span");
    b.className = `badge ${spec[1]}`;
    b.textContent = spec[0];
    wrap.append(b);
  }
  return wrap;
}

function clockCell(row) {
  const parts = [];
  if (row.adaptation && row.adaptation.pcr !== null) {
    parts.push(`PCR ${row.adaptation.pcr.toString()}`);
  }
  if (row.pes && row.pes.pts !== null) {
    parts.push(`PTS ${row.pes.pts.toString()}`);
  }
  return cell(parts.join("  "), "clock");
}

function afcLabel(afc) {
  return { 0: "保留", 1: "载荷", 2: "仅适配", 3: "适配+载荷" }[afc] ?? String(afc);
}
function formatPid(pid) {
  return `${pid} (0x${pid.toString(16).padStart(4, "0")})`;
}
