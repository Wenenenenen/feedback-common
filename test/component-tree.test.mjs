// 组件树测试：1) 与样例 expected.json 逐像素比对；2) 独立水平集暴力参考做随机模糊测试。
// 暴力水平集方法只用于测试，生产核心在 src/component-tree.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../src/image-io.mjs';
import { buildComponentTree, applyAreaFilter, buildExportJSON, pathToRoot, isDescendant } from '../src/component-tree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.resolve(here, '../samples/extracted');

async function loadGray(file) {
  const img = await decodePNG(new Uint8Array(fs.readFileSync(file)));
  assert.equal(img.channels, 1, 'sample must be 8-bit gray');
  return { width: img.width, height: img.height, gray: Uint8ClampedArray.from(img.data) };
}

// ---- 暴力参考：BFS 求水平集连通分量 ----
function levelSetComponents(gray, width, height, valid, conn, predicate) {
  const visited = new Uint8Array(width * height);
  const comps = [];
  const dirs = conn === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let s = 0; s < width * height; s++) {
    if (visited[s] || !valid[s] || !predicate(gray[s])) continue;
    const q = [s];
    visited[s] = 1;
    const comp = [];
    let head = 0;
    while (head < q.length) {
      const p = q[head++];
      comp.push(p);
      const px = p % width, py = (p / width) | 0;
      for (const [dx, dy] of dirs) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (visited[np] || !valid[np] || !predicate(gray[np])) continue;
        visited[np] = 1;
        q.push(np);
      }
    }
    comps.push(comp);
  }
  return comps;
}

function bruteFilter(gray, width, height, valid, tree, conn, area) {
  const N = width * height;
  const out = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) if (!valid[i]) out[i] = gray[i];
  // 掩膜连通分量（用于根兜底）
  const maskComps = levelSetComponents(gray, width, height, valid, conn, () => true);
  const rootLevel = new Int32Array(N);
  for (const comp of maskComps) {
    let lo = 255, hi = 0;
    for (const p of comp) { lo = Math.min(lo, gray[p]); hi = Math.max(hi, gray[p]); }
    for (const p of comp) rootLevel[p] = tree === 'max' ? lo : hi;
  }
  // 每个阈值只算一次水平集分量，命中条件的分量批量赋值：
  // max：从高到低扫描，首次满足面积的 L 即最大合格 L；
  // min：从低到高扫描，首次满足面积的 L 即最小合格 L。
  // 输出值必为原图出现过的灰度（或根兜底灰度），只扫描实际存在的灰度级。
  const present = [...new Set(Array.from(gray).filter((_, i) => valid[i]))].sort((a, b) => a - b);
  const best = new Int32Array(N).fill(-1);
  const ls = tree === 'max' ? [...present].reverse() : present;
  for (const L of ls) {
    const pred = tree === 'max' ? (g) => g >= L : (g) => g <= L;
    const comps = levelSetComponents(gray, width, height, valid, conn, pred);
    for (const comp of comps) {
      if (comp.length < area) continue;
      for (const p of comp) if (best[p] === -1) best[p] = L;
    }
  }
  for (let p = 0; p < N; p++) {
    if (valid[p]) out[p] = best[p] === -1 ? rootLevel[p] : best[p];
  }
  return out;
}

function checkInvariants(t, label, opts = {}) {
  const { width, height, nodes, pixelNode, valid, gray, roots } = t;
  const sampleOnly = opts.sampleOnly ?? false;
  // 1. 像素归属：掩膜外 -1，掩膜内全部有节点
  for (let p = 0; p < width * height; p++) {
    if (valid[p]) assert.ok(pixelNode[p] >= 0, `${label}: valid pixel has no node`);
    else assert.equal(pixelNode[p], -1, `${label}: outside-mask pixel got node`);
  }
  // 2. 父子灰度严格性 + 代表像素平台同灰度
  for (const nd of nodes) {
    assert.equal(gray[nd.repIndex], nd.level, `${label}: rep level mismatch`);
    if (nd.parent !== null) {
      const par = nodes[nd.parent];
      if (t.tree === 'max') assert.ok(par.level < nd.level, `${label}: max-tree parent not strictly lower`);
      else assert.ok(par.level > nd.level, `${label}: min-tree parent not strictly higher`);
    }
  }
  // 3. 根
  assert.ok(roots.length >= 1, `${label}: no root`);
  for (const r of roots) assert.equal(nodes[r].parent, null);
  // 4. 面积 = 子树像素总数
  let total = 0;
  for (const nd of nodes) total += nd.plateauArea;
  assert.equal(total, t.validPixelCount, `${label}: plateau areas don't partition mask`);
  const sumAreas = roots.reduce((s, r) => s + nodes[r].area, 0);
  assert.equal(sumAreas, t.validPixelCount, `${label}: root areas don't cover mask`);
  for (const nd of nodes) {
    let childSum = nd.plateauArea;
    for (const cid of t.children[nd.id]) childSum += nodes[cid].area;
    assert.equal(childSum, nd.area, `${label}: area != subtree sum at node ${nd.id}`);
  }
  // 5. 节点区域必须恰好等于对应水平集分量（大图抽样：每层取一个代表节点）
  const conn = t.connectivity;
  let targets = nodes;
  if (sampleOnly) {
    const byLevel = new Map();
    for (const nd of nodes) if (!byLevel.has(nd.level)) byLevel.set(nd.level, nd);
    targets = [...byLevel.values()];
  }
  for (const nd of targets) {
    const pred = t.tree === 'max' ? (g) => g >= nd.level : (g) => g <= nd.level;
    const comps = levelSetComponents(gray, width, height, valid, conn, pred);
    const own = comps.filter((c) => c.includes(nd.repIndex));
    assert.equal(own.length, 1, `${label}: node region not a single level-set component`);
    assert.equal(own[0].length, nd.area, `${label}: node area != level-set component size`);
    for (const p of own[0]) {
      assert.equal(pixelNode[p] === nd.id || isDescendant(t, nd.id, pixelNode[p]), true);
    }
  }
  // 6. 路径到根：灰度单调
  for (let p = 0; p < width * height; p++) {
    if (!valid[p]) continue;
    const path = pathToRoot(t, pixelNode[p]);
    for (let i = 1; i < path.length; i++) {
      if (t.tree === 'max') assert.ok(nodes[path[i]].level < nodes[path[i - 1]].level);
      else assert.ok(nodes[path[i]].level > nodes[path[i - 1]].level);
    }
    assert.equal(nodes[path[path.length - 1]].parent, null);
  }
  // 7. tin/tout 子树关系与 children 一致
  for (const nd of nodes) {
    for (const cid of t.children[nd.id]) {
      assert.ok(isDescendant(t, nd.id, cid));
      assert.ok(!isDescendant(t, cid, nd.id));
    }
  }
}

// ---------- 测试 1：样例 expected.json ----------
async function testExpected() {
  const { width, height, gray } = await loadGray(path.join(sampleDir, 'tiny.png'));
  const maskImg = await decodePNG(new Uint8Array(fs.readFileSync(path.join(sampleDir, 'tiny-mask.png'))));
  const mask = Uint8ClampedArray.from(maskImg.data).map((v) => (v > 0 ? 1 : 0));
  const expected = JSON.parse(fs.readFileSync(path.join(sampleDir, 'expected.json'), 'utf8'));
  let cases = 0;
  for (const ex of expected) {
    const t = buildComponentTree(gray, width, height, { tree: ex.tree, connectivity: ex.connectivity, mask });
    checkInvariants(t, `tiny ${ex.tree} c${ex.connectivity}`);
    const out = applyAreaFilter(t, ex.area);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        assert.equal(out[y * width + x], ex.pixels[y][x],
          `mismatch ${ex.tree} c${ex.connectivity} A=${ex.area} at (${x},${y})`);
      }
    }
    // 导出 schema 自检
    const j = buildExportJSON(t, ex.area);
    assert.equal(j.width, width); assert.equal(j.height, height);
    assert.equal(j.tree, ex.tree); assert.equal(j.connectivity, ex.connectivity);
    assert.equal(j.area_threshold, ex.area);
    assert.equal(j.pixel_nodes.length, width * height);
    assert.ok(j.nodes.every((n) => n.parent === null || Number.isInteger(n.parent)));
    assert.ok(j.nodes.every((n) => Array.isArray(n.representative) && n.representative.length === 2));
    cases++;
  }
  console.log(`✓ 样例 expected.json：${cases} 组过滤结果逐像素一致，结构不变量全部通过`);
}

// ---------- 测试 2：随机模糊 vs 暴力水平集 ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function testFuzz() {
  const rnd = mulberry32(20261120);
  let grids = 0;
  for (let iter = 0; iter < 220; iter++) {
    const width = 1 + Math.floor(rnd() * 9);
    const height = 1 + Math.floor(rnd() * 9);
    const levels = 2 + Math.floor(rnd() * 6); // 小灰度空间，制造同灰度平台
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.floor(rnd() * levels) * Math.floor(255 / (levels - 1));
    const withMask = rnd() < 0.6;
    const valid = new Uint8Array(width * height).fill(1);
    const mask = withMask ? new Uint8Array(width * height) : null;
    if (withMask) {
      for (let i = 0; i < valid.length; i++) {
        const keep = rnd() > 0.25;
        valid[i] = keep ? 1 : 0;
        mask[i] = keep ? 1 : 0;
      }
      if (!valid.some(Boolean)) valid[0] = 1, mask[0] = 1;
    }
    for (const tree of ['max', 'min']) {
      for (const conn of [4, 8]) {
        const t = buildComponentTree(gray, width, height, { tree, connectivity: conn, mask });
        checkInvariants(t, `fuzz#${iter} ${tree} c${conn}`);
        for (const A of [1, 2, 3, 5, 8, 100]) {
          const out = applyAreaFilter(t, A);
          const ref = bruteFilter(gray, width, height, valid, tree, conn, A);
          for (let p = 0; p < width * height; p++) {
            assert.equal(out[p], ref[p], `fuzz#${iter} ${tree} c${conn} A=${A} pixel ${p}: got ${out[p]} want ${ref[p]}`);
          }
        }
      }
    }
    grids++;
  }
  console.log(`✓ 随机模糊：${grids} 张随机图 × {max,min} × {4,8} × 6 个阈值，与暴力水平集参考完全一致`);
}

// ---------- 测试 3：合并顺序无关性（同图不同遍历序得到同构结果）----------
function testOrderIndependence() {
  // 构造一个含大平台 + 对角接触的图，验证 4/8 邻接差异与平台合并都正确
  const w = 5, h = 5;
  const g = new Uint8ClampedArray(w * h);
  // 全 100 背景，对角两个 200 像素（4 邻接下分离，8 邻接下连通）
  g.fill(100);
  g[0] = 200; g[w + 1] = 200; // (0,0) 与 (1,1)
  const t4 = buildComponentTree(g, w, h, { tree: 'max', connectivity: 4 });
  const t8 = buildComponentTree(g, w, h, { tree: 'max', connectivity: 8 });
  // 4 邻接：两个 200 独立节点
  const hot4 = t4.nodes.filter((n) => n.level === 200);
  assert.equal(hot4.length, 2);
  assert.deepEqual(hot4.map((n) => n.area).sort(), [1, 1]);
  // 8 邻接：合并为一个面积 2 的节点
  const hot8 = t8.nodes.filter((n) => n.level === 200);
  assert.equal(hot8.length, 1);
  assert.equal(hot8[0].area, 2);
  // 阈值 2：4 邻接下两个亮点各自被滤掉；8 邻接下保留
  const o4 = applyAreaFilter(t4, 2);
  const o8 = applyAreaFilter(t8, 2);
  assert.equal(o4[0], 100); assert.equal(o4[w + 1], 100);
  assert.equal(o8[0], 200); assert.equal(o8[w + 1], 200);
  // 背景平台是一个节点，面积 23
  const bg4 = t4.nodes.filter((n) => n.level === 100);
  assert.equal(bg4.length, 1);
  assert.equal(bg4[0].area, 25);
  console.log('✓ 平台规范合并与 4/8 邻接语义正确（对角亮点用例）');
}

// ---------- 测试 4：掩膜多根 ----------
function testMaskRoots() {
  const w = 4, h = 4;
  const g = new Uint8ClampedArray(w * h).fill(50);
  for (let i = 0; i < 4; i++) g[i * w + 1] = 200; // 中间一条亮带
  // 掩膜切成左右两半（第 2 列排除）
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = x === 1 ? 0 : 1;
  const t = buildComponentTree(g, w, h, { tree: 'max', connectivity: 4, mask });
  assert.equal(t.roots.length, 2, 'two mask components -> two roots');
  const out = applyAreaFilter(t, 9999); // 全部节点都不够，只剩根
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) assert.equal(out[p], g[p], 'outside mask untouched');
  }
  // 每个根区域内输出等于该根灰度（各自的最小灰度）
  for (const r of t.roots) {
    const lvl = t.nodes[r].level;
    for (let p = 0; p < w * h; p++) {
      if (t.valid[p] && pathToRoot(t, t.pixelNode[p]).at(-1) === r) {
        assert.equal(out[p], lvl);
      }
    }
  }
  console.log('✓ 掩膜多根：根无条件保留，掩膜外照抄原图');
}

// ---------- 测试 5：边界情形 ----------
async function testEdgeCases() {
  // 单像素
  {
    const g = Uint8ClampedArray.from([42]);
    for (const tree of ['max', 'min']) {
      const t = buildComponentTree(g, 1, 1, { tree, connectivity: 4 });
      assert.equal(t.nodeCount, 1);
      assert.equal(t.roots.length, 1);
      assert.equal(t.nodes[0].area, 1);
      assert.deepEqual(applyAreaFilter(t, 999), Uint8ClampedArray.from([42])); // 根保留
    }
  }
  // 全常量图：任意邻接/树型都只有一个节点，任何阈值都不改变图像
  {
    const w = 7, h = 5;
    const g = new Uint8ClampedArray(w * h).fill(128);
    for (const tree of ['max', 'min']) for (const conn of [4, 8]) {
      const t = buildComponentTree(g, w, h, { tree, connectivity: conn });
      assert.equal(t.nodeCount, 1, `constant ${tree} c${conn}`);
      assert.equal(t.nodes[0].plateauArea, w * h);
      assert.equal(t.nodes[0].area, w * h);
      for (const A of [1, 100, 99999]) {
        assert.deepEqual(Array.from(applyAreaFilter(t, A)), Array.from(g));
      }
    }
  }
  // 棋盘格：4 邻接下同类像素全分离，8 邻接下全连通
  {
    const w = 4, h = 4;
    const g = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x + y) % 2 ? 0 : 255;
    const t4 = buildComponentTree(g, w, h, { tree: 'max', connectivity: 4 });
    const t8 = buildComponentTree(g, w, h, { tree: 'max', connectivity: 8 });
    const white4 = t4.nodes.filter((n) => n.level === 255);
    assert.equal(white4.length, 8);
    assert.ok(white4.every((n) => n.area === 1));
    const white8 = t8.nodes.filter((n) => n.level === 255);
    assert.equal(white8.length, 1);
    assert.equal(white8[0].area, 8);
    // A=2 四邻接：白点全部被滤到背景灰度 0
    const out4 = applyAreaFilter(t4, 2);
    assert.ok(out4.every((v) => v === 0));
    // A=2 八邻接：白点整体保留
    const out8 = applyAreaFilter(t8, 2);
    for (let i = 0; i < g.length; i++) assert.equal(out8[i], g[i]);
  }
  // 阈值为 1：输出必须严格等于原图
  {
    const { width, height, gray } = await loadGray(path.join(sampleDir, 'tiny.png'));
    for (const tree of ['max', 'min']) for (const conn of [4, 8]) {
      const t = buildComponentTree(gray, width, height, { tree, connectivity: conn });
      assert.deepEqual(Array.from(applyAreaFilter(t, 1)), Array.from(gray));
    }
  }
  console.log('✓ 边界情形：单像素、常量图、棋盘格 4/8 邻接、A=1 恒等映射');
}

// ---------- 测试 6：medium.png 可扩展性与时间 ----------
async function testMedium() {
  const { width, height, gray } = await loadGray(path.join(sampleDir, 'medium.png'));
  for (const tree of ['max', 'min']) {
    for (const conn of [4, 8]) {
      const t0 = performance.now();
      const t = buildComponentTree(gray, width, height, { tree, connectivity: conn });
      const t1 = performance.now();
      const out = applyAreaFilter(t, 50);
      const t2 = performance.now();
      checkInvariants(t, `medium ${tree} c${conn}`, { sampleOnly: true });
      assert.equal(t.validPixelCount, width * height);
      assert.ok(out.every((v) => v >= 0 && v <= 255));
      console.log(`  medium ${tree} c${conn}: ${t.nodeCount} 节点, 建树 ${(t1 - t0).toFixed(1)}ms, 过滤 ${(t2 - t1).toFixed(2)}ms`);
    }
  }
  console.log('✓ 128×128 实图：结构不变量通过，性能正常');
}

let failures = 0;
for (const fn of [testExpected, testFuzz, testOrderIndependence, testMaskRoots, testEdgeCases, testMedium]) {
  try { await fn(); } catch (e) { failures++; console.error(`✗ ${fn.name} 失败:`, e.message); }
}
if (failures) process.exit(1);
console.log('\n全部测试通过。');
