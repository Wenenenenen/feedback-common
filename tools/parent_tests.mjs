// 父环（嵌套闭环）专项测试：构造同心环、并列环、混合嵌套，
// 用独立的 O(R²) 点在环内参考定义交叉验证扫描线算法。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopology, buildGeometry } from "../app/core.js";

// 构造径向距离标量：节点值 = 到中心的曼哈顿/欧氏距离的量化，
// 多个阈值会产生同心闭环。
function radialGrid(w, h, cx, cy) {
  const values = new Uint16Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const dx = c - cx, dy = r - cy;
      values[r * w + c] = Math.round(Math.sqrt(dx * dx + dy * dy) * 4);
    }
  }
  return values;
}

// 独立参考：O(R²) 严格按“严格包含且面积最小”定义求父环
function referenceParents(geomLevel) {
  const closed = geomLevel.lines.filter((l) => !l.open);
  const contains = (outer, inner) => {
    // 用 inner 第一个点做射线法
    const [px, py] = inner.points[0];
    let inside = false;
    const pts = outer.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const expect = new Map();
  for (const inner of closed) {
    let best = null;
    for (const outer of closed) {
      if (outer === inner || outer.area <= inner.area) continue;
      if (contains(outer, inner)) {
        if (!best || outer.area < best.area) best = outer;
      }
    }
    expect.set(inner.id, best ? best.id : null);
  }
  return expect;
}

test("父环: 多阈值同心环的父子链与 O(R²) 参考完全一致", () => {
  const w = 81, h = 81, cx = 40, cy = 40;
  const values = radialGrid(w, h, cx, cy);
  const levels = [10.5, 30.5, 60.5, 100.5, 150.5];
  const topo = buildTopology({ width: w, height: h, values, levels });
  const geom = buildGeometry(topo, [0, 0], [1, 1]);
  for (const gl of geom.levels) {
    const closed = gl.lines.filter((l) => !l.open);
    assert.ok(closed.length >= 1, `阈值 ${gl.level} 应有闭环`);
    const expect = referenceParents(gl);
    for (const line of closed) {
      assert.equal(line.parentId, expect.get(line.id),
        `阈值 ${gl.level} 环 ${line.id} 的父环`);
    }
    // 最外层环父环为 null
    const outers = closed.filter((l) => l.area === Math.max(...closed.map((x) => x.area)));
    for (const o of outers) assert.equal(o.parentId, null);
  }
});

test("父环: 真实 annulus 夹具内环父环为外环（与样例期望一致）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(readFileSync(join(here, "fixtures", "annulus.json"), "utf8"));
  const topo = buildTopology({
    width: fx.width, height: fx.height,
    values: Uint16Array.from(fx.values),
    mask: Uint8Array.from(fx.mask),
    levels: fx.levels.map((l) => l.level),
  });
  const geom = buildGeometry(topo, fx.origin, fx.spacing);
  const closed = geom.levels[0].lines.filter((l) => !l.open);
  assert.equal(closed.length, 2, "annulus 阈值应有内外两个闭环");
  const expect = referenceParents(geom.levels[0]);
  for (const line of closed) assert.equal(line.parentId, expect.get(line.id));
  // 样例明确要求：内环父环是外环
  const inner = closed.reduce((a, b) => (a.area < b.area ? a : b));
  const outer = closed.reduce((a, b) => (a.area > b.area ? a : b));
  assert.equal(inner.parentId, outer.id);
  assert.equal(outer.parentId, null);
});

test("父环: 非均匀间距下父环关系不变（拓扑关系与几何无关）", () => {
  const w = 71, h = 71;
  const values = radialGrid(w, h, 35, 35);
  const topo = buildTopology({ width: w, height: h, values, levels: [20.5, 60.5, 120.5] });
  const g1 = buildGeometry(topo, [0, 0], [1, 1]);
  const g2 = buildGeometry(topo, [10, -5], [0.5, 2]);
  g1.levels.forEach((lv, i) => {
    const map1 = new Map(lv.lines.map((l) => [l.id, l.parentId]));
    for (const l2 of g2.levels[i].lines) {
      assert.equal(l2.parentId, map1.get(l2.id), "改间距后父环 id 不变");
    }
  });
});
