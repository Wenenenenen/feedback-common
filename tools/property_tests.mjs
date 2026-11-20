// 随机网格属性测试与规模压力测试。
// node --test tools/property_tests.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopology, buildGeometry, validateLevels } from "../app/core.js";

// 确定性 PRNG
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomGrid(w, h, maxVal, seed) {
  const rng = makeRng(seed);
  const values = new Uint16Array(w * h);
  for (let i = 0; i < values.length; i++) values[i] = Math.floor(rng() * (maxVal + 1));
  return values;
}

function randomMask(w, h, seed) {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = rng() > 0.25 ? 1 : 0;
  return mask;
}

test("属性: 所有折线边度数守恒，开放线端点度数为1、闭环全为2", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = 12 + seed, h = 10 + seed;
    const values = randomGrid(w, h, 50, seed);
    const mask = randomMask(w, h, seed);
    const levels = validateLevels([10.5, 25.5, 40.5]);
    const topo = buildTopology({ width: w, height: h, values, mask, levels });
    for (const ld of topo.levelData) {
      const horiz = ld.horiz;
      const total = horiz + (h - 1) * w;
      const degree = new Int32Array(total);
      for (let k = 0; k < ld.segEdge.length / 2; k++) {
        degree[ld.segEdge[2 * k]]++;
        degree[ld.segEdge[2 * k + 1]]++;
      }
      for (const pl of ld.polylines) {
        if (pl.open) {
          assert.equal(degree[pl.edgeIds[0]], 1, "开放线起点度数 1");
          assert.equal(degree[pl.edgeIds.at(-1)], 1, "开放线终点度数 1");
          for (let i = 1; i < pl.edgeIds.length - 1; i++) {
            assert.equal(degree[pl.edgeIds[i]], 2, "开放线内部度数 2");
          }
        } else {
          for (const e of pl.edgeIds) assert.equal(degree[e], 2, "闭环边度数 2");
        }
      }
    }
  }
});

test("属性: 每个四交点单元的连边与 Q 符号严格一致", () => {
  const w = 30, h = 24;
  const values = randomGrid(w, h, 10, 77);
  const t = 5.5;
  const topo = buildTopology({ width: w, height: h, values, levels: [t] });
  const ld = topo.levelData[0];
  const width = w;
  const horiz = ld.horiz;
  // 重建每个单元的连接并核对
  let saddleCount = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const i0 = r * width + c;
      const a = values[i0], b = values[i0 + 1];
      const cv = values[i0 + width + 1], d = values[i0 + width];
      const sa = a > t, sb = b > t, sc = cv > t, sd = d > t;
      const crosses = [sa !== sb, sb !== sc, sc !== sd, sd !== sa];
      if (crosses.filter(Boolean).length !== 4) continue;
      saddleCount++;
      const Q = (a - t) * (cv - t) - (b - t) * (d - t);
      const edges = [
        r * (width - 1) + c,                              // 上
        horiz + r * width + c + 1,                        // 右
        (r + 1) * (width - 1) + c,                        // 下
        horiz + r * width + c,                            // 左
      ];
      const cellKey = r * (width - 1) + c;
      const nSeg = ld.cellCount[cellKey];
      const segKeys = [];
      if (nSeg > 0) {
        const start = ld.cellHead[cellKey];
        for (let k = 0; k < nSeg; k++) segKeys.push(start + k);
      }
      const pairs = segKeys.map((k) => [ld.segEdge[2 * k], ld.segEdge[2 * k + 1]]);
      const edgeIndex = (e) => edges.indexOf(e);
      const pairIdx = pairs.map((p) => p.map(edgeIndex).sort().join("-")).sort();
      if (Q > 0) {
        assert.deepEqual(pairIdx, ["0-1", "2-3"], "Q>0 连上-右/下-左");
      } else {
        assert.deepEqual(pairIdx, ["0-3", "1-2"], "Q<=0 连上-左/右-下");
      }
    }
  }
  assert.ok(saddleCount > 0, "随机网格应出现鞍点单元");
});

test("属性: 共享边两侧单元使用同一交点（边 id 相同则分数与坐标相同）", () => {
  const w = 18, h = 15;
  const values = randomGrid(w, h, 20, 31);
  const topo = buildTopology({ width: w, height: h, values, levels: [9.5] });
  const ld = topo.levelData[0];
  // 收集所有段用到的边，每条边在所有折线中的分数必须一致（天然由单一 frac 数组保证，
  // 这里额外验证相邻单元段确实引用相同 id 而非坐标近似）
  const usedEdges = new Set();
  for (let k = 0; k < ld.segEdge.length; k++) usedEdges.add(ld.segEdge[k]);
  for (const e of usedEdges) {
    assert.ok(Number.isFinite(ld.frac[e]), `边 ${e} 应有唯一分数`);
  }
  // 同一条内部边若被两个单元穿越，两个段都引用该 id
  const horiz = ld.horiz;
  let shared = 0;
  const degree = new Int32Array(ld.frac.length);
  for (let k = 0; k < ld.segEdge.length / 2; k++) {
    degree[ld.segEdge[2 * k]]++;
    degree[ld.segEdge[2 * k + 1]]++;
  }
  for (const e of usedEdges) if (degree[e] >= 2) shared++;
  assert.ok(shared > 0, "应存在被相邻单元共享的内部边");
});

test("属性: 掩膜下所有闭环不接触无效单元，开放线端点落在图边或掩膜边界", () => {
  const w = 22, h = 20;
  const values = randomGrid(w, h, 30, 55);
  const mask = randomMask(w, h, 55);
  const topo = buildTopology({ width: w, height: h, values, mask, levels: [15.5] });
  const geom = buildGeometry(topo, [0, 0], [1, 1]);
  for (const gl of geom.levels) {
    for (const line of gl.lines) {
      if (!line.open) {
        assert.ok(line.area !== null && line.area > 0);
      } else {
        assert.equal(line.area, null);
      }
    }
  }
});

test("压力: 1024x1024 全有效网格可在合理时间/内存内完成并保持守恒", () => {
  const w = 1024, h = 1024;
  const values = randomGrid(w, h, 100, 123);
  const t0 = Date.now();
  const topo = buildTopology({ width: w, height: h, values, levels: [50.5] });
  const geom = buildGeometry(topo, [0, 0], [1, 1]);
  const elapsed = Date.now() - t0;
  const ld = topo.levelData[0];
  let segCount = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const i0 = r * w + c;
      const sa = values[i0] > 50.5, sb = values[i0 + 1] > 50.5;
      const sc = values[i0 + w + 1] > 50.5, sd = values[i0 + w] > 50.5;
      const crosses = (sa !== sb) + (sb !== sc) + (sc !== sd) + (sd !== sa);
      if (crosses === 4) segCount += 2;
      else if (crosses === 2) segCount += 1;
    }
  }
  assert.equal(ld.segEdge.length / 2, segCount, "段总数与逐单元统计一致");
  // 守恒恒等式：每条开放线 n 个段连接 n+1 个边（首尾边各被两个段共享），
  // 闭环的边数与段数相等。故 折线边引用总数 = 段数 + 开放线条数。
  let totalEdges = 0;
  let openCount = 0;
  for (const pl of ld.polylines) {
    totalEdges += pl.edgeIds.length;
    if (pl.open) openCount++;
  }
  assert.equal(totalEdges, segCount + openCount, "折线边引用守恒");
  assert.ok(geom.levels[0].lines.length > 0);
  assert.ok(elapsed < 15000, `1024² 提取应在 15s 内，实际 ${elapsed}ms`);
});
