// 导出 SVG/JSON 测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildTopology, buildGeometry } from "../app/core.js";
import { buildSvg, buildJson } from "../app/exporter.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadCase(name) {
  const fx = JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
  const topo = buildTopology({
    width: fx.width, height: fx.height,
    values: Uint16Array.from(fx.values),
    mask: Uint8Array.from(fx.mask),
    levels: fx.levels.map((l) => l.level),
  });
  return { fx, geom: buildGeometry(topo, fx.origin, fx.spacing) };
}

test("SVG: 仅真正闭环写 Z，开放线无 Z 且不封口", () => {
  const { geom } = loadCase("slit");
  const svg = buildSvg(geom);
  const closedCount = geom.levels.reduce((n, lv) =>
    n + lv.lines.filter((l) => !l.open).length, 0);
  const openCount = geom.levels.reduce((n, lv) =>
    n + lv.lines.filter((l) => l.open).length, 0);
  assert.ok(openCount > 0);
  assert.equal(closedCount, 0);
  // 开放线场景：任何 path 的绘制命令都不以 Z 收尾（Z 前必为坐标数字）
  assert.equal((svg.match(/\dZ"/g) || []).length, 0, "开放线场景 SVG 不含封口 Z");
  // 每条开放 path 的 d 以坐标结尾而非 Z（只统计 <path> 元素，排除 <g> 元数据）
  const pathDs = (svg.match(/<path[^>]*d="[^"]+"/g) || []);
  assert.equal(pathDs.length, openCount);
  for (const d of pathDs) assert.ok(!/Z"$/.test(d));
});

test("SVG: 闭环场景每条闭环 path 以 Z 结尾", () => {
  const { geom } = loadCase("annulus");
  const svg = buildSvg(geom);
  const closedCount = geom.levels.reduce((n, lv) =>
    n + lv.lines.filter((l) => !l.open).length, 0);
  assert.equal(closedCount, 2);
  assert.equal((svg.match(/\dZ"/g) || []).length, closedCount);
  assert.ok(svg.startsWith('<?xml version="1.0"'));
  assert.ok(svg.includes('viewBox="0 0'));
});

test("SVG: 携带 origin/spacing/level/测量值元数据", () => {
  const { geom } = loadCase("radial");
  const svg = buildSvg(geom, { imageName: "radial.png" });
  assert.ok(svg.includes('data-origin-x="10"'));
  assert.ok(svg.includes('data-spacing-x="0.5"'));
  assert.ok(svg.includes('data-spacing-y="2"'));
  assert.ok(svg.includes('data-image="radial.png"'));
  assert.ok(svg.includes('data-level="100.5"'));
  assert.ok(/data-length="[\d.]+"/.test(svg));
  assert.ok(/data-area="[\d.]+"/.test(svg));
});

test("JSON: 保留开闭/父环/物理点/长度/面积，开放线面积为 null", () => {
  const { fx, geom } = loadCase("annulus");
  const j = buildJson(geom, { image: "annulus.png", nodesX: fx.width, nodesY: fx.height });
  assert.equal(j.schema, "saddle-contour-atlas/1");
  assert.deepEqual(j.origin, fx.origin);
  assert.deepEqual(j.spacing, fx.spacing);
  const lv = j.levels[0];
  assert.equal(lv.lines.length, 2);
  for (const line of lv.lines) {
    assert.equal(typeof line.open, "boolean");
    assert.ok(Array.isArray(line.points));
    assert.equal(line.pointCount, line.points.length);
    assert.ok(line.length > 0);
    if (line.open) assert.equal(line.area, null);
    else assert.ok(line.area > 0);
  }
  const inner = lv.lines.reduce((a, b) => (a.area < b.area ? a : b));
  const outer = lv.lines.reduce((a, b) => (a.area > b.area ? a : b));
  assert.equal(inner.parentId, outer.id);
  assert.equal(outer.parentId, null);
});

test("导出随间距同步：改 spacing 后 SVG/JSON 坐标与测量值全部重算", () => {
  const { fx } = loadCase("radial");
  const topo = buildTopology({
    width: fx.width, height: fx.height,
    values: Uint16Array.from(fx.values),
    mask: Uint8Array.from(fx.mask),
    levels: fx.levels.map((l) => l.level),
  });
  const g1 = buildGeometry(topo, [0, 0], [1, 1]);
  const g2 = buildGeometry(topo, [10, -5], [2, 3]);
  const j1 = buildJson(g1);
  const j2 = buildJson(g2);
  const p1 = j1.levels[0].lines[0].points[0];
  const p2 = j2.levels[0].lines[0].points[0];
  assert.ok(Math.abs(p2[0] - (10 + 2 * p1[0])) < 1e-7);
  assert.ok(Math.abs(p2[1] - (-5 + 3 * p1[1])) < 1e-7);
  assert.notDeepEqual(j1.levels[0].lines[0].length, j2.levels[0].lines[0].length);
  const svg2 = buildSvg(g2);
  assert.ok(svg2.includes('data-spacing-x="2"'));
  assert.ok(svg2.includes('data-spacing-y="3"'));
});

test("空等值线（constant 用例）导出不报错且结构完整", () => {
  const { geom } = loadCase("constant");
  const svg = buildSvg(geom);
  const j = buildJson(geom);
  assert.ok(svg.includes("<svg"));
  assert.equal(j.levels.reduce((n, lv) => n + lv.lines.length, 0), 0);
});
