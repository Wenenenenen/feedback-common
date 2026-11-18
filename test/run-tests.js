/*
 * Node 测试（node test/run-tests.js），不依赖任何第三方包。
 * 覆盖：约定参照例、穿角限制、隔离区未到达、顺序无关、冲突/去重、
 * 独立暴力多源 Dijkstra 交叉验证、PNG 编解码往返。
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MGSPng = require("../app/png.js");
const MGSSegment = require("../app/segment.js");

const SAMPLE_DIR = path.join(__dirname, "..", "samples", "extracted");
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.error("  ✗ " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}
function loadGray(file) {
  const buf = fs.readFileSync(path.join(SAMPLE_DIR, file));
  return MGSPng.decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
function loadMask(file) {
  const im = loadGray(file);
  const mask = new Uint8Array(im.width * im.height);
  for (let i = 0; i < mask.length; i++) mask[i] = im.gray[i] > 0 ? 1 : 0;
  return { width: im.width, height: im.height, mask };
}

/* ---------- 独立参考实现：每标签各跑一次朴素 Dijkstra，再按约定裁决 ---------- */
function referenceSegment(gray, w, h, mask, connectivity, seeds) {
  const n = w * h;
  const labels = [...new Set(seeds.map((s) => s.label))].sort((a, b) => a - b);
  const ortho = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const diag = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const perLabel = labels.map((lab) => {
    const dist = new Float64Array(n).fill(Infinity);
    const q = seeds.filter((s) => s.label === lab).map((s) => s.y * w + s.x);
    for (const idx of q) dist[idx] = 0;
    // O(n^2) 的松弛 Dijkstra（样例小，够用且完全独立于生产实现）
    const done = new Uint8Array(n);
    for (let it = 0; it < n; it++) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && (mask ? mask[i] : 1) && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u < 0) break;
      done[u] = 1;
      const ux = u % w, uy = (u / w) | 0;
      const edges = ortho.map((d) => [d, 10]);
      if (connectivity === 8) for (const d of diag) edges.push([d, 14]);
      for (const [[dx, dy], step] of edges) {
        const vx = ux + dx, vy = uy + dy;
        if (vx < 0 || vy < 0 || vx >= w || vy >= h) continue;
        const v = vy * w + vx;
        if (mask && !mask[v]) continue;
        if (step === 14 && mask) {
          if (!mask[uy * w + (ux + dx)] || !mask[(uy + dy) * w + ux]) continue;
        }
        const nd = dist[u] + step * (256 + Math.abs(gray[u] - gray[v]));
        if (nd < dist[v]) dist[v] = nd;
      }
    }
    return dist;
  });
  const out = new Uint16Array(n);
  const tie = new Uint8Array(n);
  const reached = new Uint8Array(n);
  const excluded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) { excluded[i] = 1; continue; }
    let best = Infinity, winner = 0, tied = false;
    for (let k = 0; k < labels.length; k++) {
      const d = perLabel[k][i];
      if (d < best) { best = d; winner = labels[k]; tied = false; }
      else if (d === best && isFinite(d)) { tied = true; }
    }
    if (isFinite(best)) {
      reached[i] = 1;
      if (tied) tie[i] = 1; else out[i] = winner;
    }
  }
  return { labels: out, tie, reached, excluded, perLabel };
}

console.log("== 1. PNG 解码（与 Python zlib 同款 DEFLATE 流）==");
test("解码 plateau.png 为 7x5 全 100 灰度", () => {
  const im = loadGray("plateau.png");
  assert.strictEqual(im.width, 7);
  assert.strictEqual(im.height, 5);
  assert.deepStrictEqual([...new Set(im.gray)], [100]);
});
test("解码 mask.png 为 0/255 二值，65x49", () => {
  const im = loadGray("mask.png");
  assert.strictEqual(im.width, 65);
  const set = new Set(im.gray);
  assert.ok(set.has(0) && set.has(255) && set.size === 2);
});
test("编码-解码往返保持像素一致", () => {
  const src = loadGray("material.png");
  const ab = MGSPng.encodeGray(src.width, src.height, src.gray);
  const back = MGSPng.decode(ab);
  assert.strictEqual(back.width, src.width);
  assert.strictEqual(back.height, src.height);
  for (let i = 0; i < src.gray.length; i++) {
    assert.strictEqual(back.gray[i], src.gray[i], "像素 " + i);
  }
});
test("生成的 PNG 能被 Node 原生 zlib 解出（流格式合规）", () => {
  const g = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
  const ab = MGSPng.encodeGray(64, 64, g);
  const bytes = new Uint8Array(ab);
  // 找 IDAT
  let pos = 8; const chunks = [];
  while (pos < bytes.length) {
    const len = new DataView(ab, pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === "IDAT") chunks.push(bytes.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  assert.strictEqual(raw.length, 64 * 65);
});

console.log("== 2. 约定参照例 ==");
test("plateau：x=3 整列为分界，左侧标签1右侧标签2", () => {
  const im = loadGray("plateau.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "plateau.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { connectivity: markers.connectivity, seeds: markers.seeds });
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const i = y * im.width + x;
      if (x < 3) assert.strictEqual(r.labels[i], 1, `(${x},${y}) 应属 1`);
      else if (x > 3) assert.strictEqual(r.labels[i], 2, `(${x},${y}) 应属 2`);
      else assert.strictEqual(r.tie[i], 1, `(${x},${y}) 应为分界`);
    }
  }
});
test("tie-tail：(3,1)..(3,6) 分界；横线上其余像素左右分属 1/2", () => {
  const im = loadGray("tie-tail.png");
  const mk = loadMask("tie-tail-mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "tie-tail.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: markers.connectivity, seeds: markers.seeds });
  for (let y = 1; y <= 6; y++) {
    const i = y * 7 + 3;
    assert.strictEqual(r.tie[i], 1, `(3,${y}) 应为分界`);
  }
  // 横线 y=1：x<3 标签1，x>3 标签2
  for (let x = 0; x < 7; x++) {
    if (x === 3) continue;
    assert.strictEqual(r.labels[7 + x], x < 3 ? 1 : 2);
  }
  // 尾巴 y=2..6 的 x=0,1,2,4,5,6 在掩膜外
  for (let y = 2; y <= 6; y++) {
    for (let x = 0; x < 7; x++) {
      if (x === 3) continue;
      assert.strictEqual(r.excluded[y * 7 + x], 1);
    }
  }
});
test("tie-tail 关键性质：分界不阻断传播（尾巴通过分界列继续延伸）", () => {
  const im = loadGray("tie-tail.png");
  const mk = loadMask("tie-tail-mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "tie-tail.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: markers.connectivity, seeds: markers.seeds });
  // 尾巴全部可达，且 (3,2..6) 全部为分界（若分界阻断传播，深处会变成未到达）
  for (let y = 2; y <= 6; y++) {
    const i = y * 7 + 3;
    assert.strictEqual(r.reached[i], 1, `尾巴 (3,${y}) 必须可达`);
    assert.strictEqual(r.tie[i], 1, `尾巴 (3,${y}) 必须是分界`);
  }
});

console.log("== 3. material 用例与掩膜隔离区 ==");
test("掩膜隔开的无种子区域保持未到达", () => {
  const im = loadGray("material.png");
  const mk = loadMask("mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "markers.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: markers.connectivity, seeds: markers.seeds });
  // 横缝下方区域 x>=52（y>=26）：与种子被 x=52 竖缝 + y=25 横缝隔开
  const isolatedRight = [];
  for (let y = 26; y < im.height; y++) {
    for (let x = 52; x < im.width; x++) {
      if (mk.mask[y * im.width + x]) isolatedRight.push([x, y]);
    }
  }
  assert.ok(isolatedRight.length > 0);
  for (const [x, y] of isolatedRight) {
    const i = y * im.width + x;
    assert.strictEqual(r.reached[i], 0, `(${x},${y}) 应未到达`);
    assert.strictEqual(r.excluded[i], 0, `(${x},${y}) 在掩膜内，不是排除`);
  }
  // 缝本身是掩膜外 → 排除（竖缝在 x=52，横缝在 y=25）
  assert.strictEqual(r.excluded[25 * im.width + 52], 1);
  assert.strictEqual(r.excluded[52], 1);
});
test("种子所在像素代价为 0 且归自身标签", () => {
  const im = loadGray("material.png");
  const mk = loadMask("mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "markers.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: markers.connectivity, seeds: markers.seeds });
  for (const s of markers.seeds) {
    const i = s.y * im.width + s.x;
    assert.strictEqual(r.cost[i], 0);
    assert.strictEqual(r.labels[i], s.label);
  }
});
test("边代价整数化：正交=10*(256+|Δg|)，对角=14*(256+|Δg|)", () => {
  // 1x3 灰度 [0, 10, 0]，种子在左端
  const gray = Uint8ClampedArray.from([0, 10, 0]);
  const r = MGSSegment.segment(gray, 3, 1,
    { connectivity: 4, seeds: [{ label: 1, x: 0, y: 0 }] });
  assert.strictEqual(r.cost[1], 10 * 266);
  assert.strictEqual(r.cost[2], 10 * 266 + 10 * 266);
});

console.log("== 4. 八邻域穿角限制 ==");
test("对角边两侧正交像素任一被掩膜挡住时不可走", () => {
  // 3x3：仅四角与中心有效；中心到角的对角边因侧像素无效而全部禁行
  const w = 3, h = 3;
  const gray = new Uint8ClampedArray(w * h).fill(100);
  const mask = new Uint8Array(w * h);
  for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2], [1, 1]]) mask[y * w + x] = 1;
  const r = MGSSegment.segment(gray, w, h,
    { mask, connectivity: 8, seeds: [{ label: 1, x: 1, y: 1 }] });
  for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2]]) {
    assert.strictEqual(r.reached[y * w + x], 0, `角 (${x},${y}) 不应被对角边到达`);
  }
});
test("侧像素均有效时对角边可走，代价=14*(256+|Δg|)", () => {
  const w = 2, h = 2;
  const gray = Uint8ClampedArray.from([100, 110, 110, 120]);
  const r = MGSSegment.segment(gray, w, h,
    { connectivity: 8, seeds: [{ label: 1, x: 0, y: 0 }] });
  assert.strictEqual(r.cost[3], 14 * (256 + 20));
});

console.log("== 5. 顺序无关 / 去重 / 冲突 ==");
test("打乱种子顺序结果完全一致", () => {
  const im = loadGray("material.png");
  const mk = loadMask("mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "markers.json"), "utf8"));
  const r1 = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: 4, seeds: markers.seeds });
  const shuffled = [...markers.seeds].reverse();
  const r2 = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: 4, seeds: shuffled });
  for (let i = 0; i < r1.labels.length; i++) {
    assert.strictEqual(r1.labels[i], r2.labels[i]);
    assert.strictEqual(r1.tie[i], r2.tie[i]);
    assert.strictEqual(r1.cost[i], r2.cost[i]);
  }
});
test("同坐标同标签重复种子去重；同坐标异标签冲突拒绝", () => {
  const gray = new Uint8ClampedArray(9).fill(50);
  const r = MGSSegment.segment(gray, 3, 3, {
    connectivity: 4,
    seeds: [{ label: 1, x: 0, y: 0 }, { label: 1, x: 0, y: 0 }]
  });
  assert.strictEqual(r.duplicates.length, 1);
  assert.strictEqual(r.seedCount, 1);
  assert.throws(() => MGSSegment.segment(gray, 3, 3, {
    connectivity: 4,
    seeds: [{ label: 1, x: 0, y: 0 }, { label: 2, x: 0, y: 0 }]
  }), /冲突/);
});
test("路径允许经过其他标签种子，但该种子仍归自己（代价0）", () => {
  // 1x4：标签1 在 x=0，标签2 在 x=2
  const gray = new Uint8ClampedArray([5, 5, 5, 5]);
  const r = MGSSegment.segment(gray, 4, 1, {
    connectivity: 4,
    seeds: [{ label: 1, x: 0, y: 0 }, { label: 2, x: 2, y: 0 }]
  });
  assert.strictEqual(r.labels[2], 2);
  assert.strictEqual(r.cost[2], 0);
  assert.strictEqual(r.labels[0], 1);
  // x=1 两标签距离相等 → 分界；x=3 归标签2
  assert.strictEqual(r.tie[1], 1);
  assert.strictEqual(r.labels[3], 2);
});
test("三方平局：三个等距标签的公共像素必须判为分界（不能被挤掉）", () => {
  // 3x3 全同灰度；标签1=(0,1)、标签2=(1,0)、标签3=(1,2)，中心 (1,1) 距三者各 1 条正交边
  const gray = new Uint8ClampedArray(9).fill(50);
  const r = MGSSegment.segment(gray, 3, 3, {
    connectivity: 4,
    seeds: [
      { label: 1, x: 0, y: 1 },
      { label: 2, x: 1, y: 0 },
      { label: 3, x: 1, y: 2 }
    ]
  });
  const center = 4;
  assert.strictEqual(r.tie[center], 1, "三方等距中心应为分界");
  assert.strictEqual(r.labels[center], 0);
  assert.strictEqual(r.cost[center], 10 * 256);
  // 三个种子各自归自己、代价 0（(1,0)=idx1、(0,1)=idx3、(1,2)=idx7）
  assert.strictEqual(r.labels[1], 2);
  assert.strictEqual(r.labels[3], 1);
  assert.strictEqual(r.labels[7], 3);
});
test("四方平局：四角标签在 5x5 中心等距，中心判分界", () => {
  const w = 5, h = 5;
  const gray = new Uint8ClampedArray(w * h).fill(77);
  const r = MGSSegment.segment(gray, w, h, {
    connectivity: 4,
    seeds: [
      { label: 1, x: 0, y: 0 }, { label: 2, x: 4, y: 0 },
      { label: 3, x: 0, y: 4 }, { label: 4, x: 4, y: 4 }
    ]
  });
  const center = 2 * w + 2;
  assert.strictEqual(r.tie[center], 1);
  assert.strictEqual(r.labels[center], 0);
});
test("第三方距离更大时不误判分界（仍是唯一最优）", () => {
  // 1x5：标签1@x0、标签2@x4、标签3@x4(异标签不能同坐标，改用 y 不行——一维)
  // 改为：标签1@x0、标签2@x4，标签3 放在 x4 不行；构造标签3 远在另一行
  const w = 5, h = 2;
  const gray = new Uint8ClampedArray(w * h).fill(50);
  const r = MGSSegment.segment(gray, w, h, {
    connectivity: 4,
    seeds: [
      { label: 1, x: 0, y: 0 },
      { label: 2, x: 4, y: 0 },
      { label: 3, x: 4, y: 1 }
    ]
  });
  // (2,0)：到标签1、2 各 2 边 → 二者平局分界；标签3 需 3 边，不参与
  assert.strictEqual(r.tie[2], 1);
  // (0,1)：仅标签1 最近，唯一归属
  assert.strictEqual(r.labels[5], 1);
  assert.strictEqual(r.tie[5], 0);
});

console.log("== 6. 与独立暴力实现交叉验证（随机小图 + 多标签多种子）==");
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
for (const conn of [4, 8]) {
  test(`随机网格 ${conn} 邻域：与朴素 Dijkstra 裁决逐像素一致`, () => {
    const rand = rng(conn === 4 ? 1234 : 5678);
    for (let trial = 0; trial < 40; trial++) {
      const w = 4 + Math.floor(rand() * 8);
      const h = 4 + Math.floor(rand() * 8);
      const gray = Uint8ClampedArray.from({ length: w * h }, () => Math.floor(rand() * 256));
      const mask = new Uint8Array(w * h).fill(1);
      // 随机挖洞（保留部分连通）
      for (let i = 0; i < w * h; i++) if (rand() < 0.18) mask[i] = 0;
      const labCount = 2 + Math.floor(rand() * 4);
      const seeds = [];
      const used = new Set();
      for (let k = 0; k < labCount * 2; k++) {
        const x = Math.floor(rand() * w), y = Math.floor(rand() * h);
        const key = y * w + x;
        if (!mask[key] || used.has(key)) continue;
        used.add(key);
        seeds.push({ label: 1 + (k % labCount), x, y });
      }
      if (seeds.length < 2) continue;
      const r = MGSSegment.segment(gray, w, h, { mask, connectivity: conn, seeds });
      const ref = referenceSegment(gray, w, h, mask, conn, seeds);
      for (let i = 0; i < w * h; i++) {
        assert.strictEqual(r.labels[i], ref.labels[i],
          `trial${trial} conn${conn} idx${i} 标签不符`);
        assert.strictEqual(r.tie[i], ref.tie[i],
          `trial${trial} conn${conn} idx${i} 分界不符`);
        assert.strictEqual(r.excluded[i], ref.excluded[i]);
        assert.strictEqual(r.reached[i], ref.reached[i]);
        if (r.reached[i]) {
          assert.ok(isFinite(r.cost[i]));
          // 成本也要与参照实现的获胜标签距离一致
          const winner = r.labels[i] || (r.tie[i] ? ref.labels[i] : 0);
          if (!r.tie[i]) {
            const li = [...new Set(seeds.map((s) => s.label))].sort((a, b) => a - b)
              .indexOf(r.labels[i]);
            assert.strictEqual(r.cost[i], ref.perLabel[li][i]);
          }
        }
      }
    }
  });
}

console.log("== 7. 统计与导出辅助 ==");
test("buildStats：面积、灰度均值、左闭右开 bbox、计数正确", () => {
  // 2x2 全归标签1，灰度 [10,20,30,40]
  const gray = Uint8ClampedArray.from([10, 20, 30, 40]);
  const r = MGSSegment.segment(gray, 2, 2,
    { connectivity: 4, seeds: [{ label: 1, x: 0, y: 0 }] });
  const stats = MGSSegment.buildStats(r, gray, [{ label: 1, x: 0, y: 0 }]);
  assert.strictEqual(stats.perLabel[0].area, 4);
  assert.strictEqual(stats.perLabel[0].meanGray, 25);
  assert.deepStrictEqual(stats.perLabel[0].bbox, [0, 0, 2, 2]);
  assert.strictEqual(stats.counts.reached, 4);
  assert.strictEqual(stats.counts.unreached, 0);
  assert.strictEqual(stats.counts.excluded, 0);
});
test("边界/未到达 PNG 像素约定：边界255；未到达255、掩膜外128、其余0", () => {
  const im = loadGray("tie-tail.png");
  const mk = loadMask("tie-tail-mask.png");
  const markers = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "tie-tail.json"), "utf8"));
  const r = MGSSegment.segment(im.gray, im.width, im.height,
    { mask: mk.mask, connectivity: markers.connectivity, seeds: markers.seeds });
  const boundary = new Uint8Array(r.width * r.height);
  const unreached = new Uint8Array(r.width * r.height);
  for (let i = 0; i < boundary.length; i++) {
    boundary[i] = r.tie[i] ? 255 : 0;
    unreached[i] = r.excluded[i] ? 128 : (!r.reached[i] ? 255 : 0);
  }
  assert.strictEqual(boundary[7 + 3], 255);
  assert.strictEqual(boundary[7], 0);
  assert.strictEqual(unreached[0], 128); // 掩膜外
  // 本用例无未到达（都可达或被排除）
  assert.ok(!unreached.some((v) => v === 255));
});

console.log(`\n${process.exitCode ? "存在失败用例" : `全部 ${passed} 项通过`}`);
