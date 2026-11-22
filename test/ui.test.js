import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { analyze } from "../src/analyzer.js";
import { createPacketTable } from "../src/ui/packet-table.js";
import { renderClockChart } from "../src/ui/clock-chart.js";

// jsdom gives us a DOM but no layout; clientWidth/Height stay 0, which the
// chart already guards with a fallback width.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.DataView = DataView;

async function loadSwitch() {
  const b = await readFile(new URL("../samples/switch.ts", import.meta.url));
  return analyze(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

test("packet table renders windowed rows and selects a packet", async () => {
  const r = await loadSwitch();
  const host = document.createElement("div");
  let activated = -1;
  const table = createPacketTable(host, {
    getRows: () => r.packets,
    onRowActivate: (i) => { activated = i; },
  });
  table.render();
  const rows = host.querySelectorAll(".prow");
  assert.ok(rows.length > 0 && rows.length <= r.packets.length);
  // First rendered row corresponds to packet index 0
  assert.equal(rows[0].dataset.index, "0");

  table.select(8, false);
  assert.equal(activated, 8);
  const selected = host.querySelector(".prow.selected");
  assert.ok(selected);
});

test("packet table filters feed through getRows", async () => {
  const r = await loadSwitch();
  const host = document.createElement("div");
  let onlyPid256 = true;
  const table = createPacketTable(host, {
    getRows: () => r.packets.filter((p) => p.pid === 256),
    onRowActivate: () => {},
  });
  table.render();
  for (const row of host.querySelectorAll(".prow")) {
    const idx = Number(row.dataset.index);
    if (r.packets[idx].pid !== 256) onlyPid256 = false;
  }
  assert.ok(onlyPid256);
});

test("clock chart renders SVG polylines and segment boundaries", async () => {
  const r = await loadSwitch();
  const host = document.createElement("div");
  let clicked = -1;
  const pcrPoints = r.clockPoints.filter((p) => p.kind === "PCR");
  renderClockChart(host, {
    points: pcrPoints,
    kindFilter: "PCR",
    onSelectPacket: (i) => { clicked = i; },
  });
  const svg = host.querySelector("svg");
  assert.ok(svg);
  assert.ok(host.querySelectorAll("polyline").length >= 1);
  assert.ok(host.querySelectorAll("circle.clock-point").length === pcrPoints.length);
  // Wrap marker is present for the PCR wrap sample
  assert.ok(host.querySelector(".kind-wrap"));

  // Empty state
  const empty = document.createElement("div");
  renderClockChart(empty, { points: [], kindFilter: "PCR", onSelectPacket() {} });
  assert.ok(empty.querySelector(".chart-empty"));
});

test("chart points carry raw and unwrapped values", async () => {
  const r = await loadSwitch();
  const host = document.createElement("div");
  renderClockChart(host, {
    points: r.clockPoints.filter((p) => p.kind === "PTS"),
    kindFilter: "PTS",
    onSelectPacket() {},
  });
  // Hover tooltip built on demand; verify the data feeding it via analyzer output
  const pts = r.clockPoints.filter((p) => p.kind === "PTS");
  assert.ok(pts.every((p) => typeof p.raw === "bigint" && typeof p.unwrapped === "bigint"));
  assert.ok(host.querySelectorAll("circle.clock-point").length === pts.length);
});
