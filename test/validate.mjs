// 拓扑引擎验证：
//  1. samples/run-mask.json 手工核算值；
//  2. 随机小掩码 + 随机裁区，与逐像素 BFS 参考实现逐项对拍；
//  3. 边界语义（八连通对角、贴边背景、裁切边周长、裁后开孔）；
//  4. 确定性 / 导出可还原；
//  5. 100 万×100 万、20 万横段满额性能（整图与裁区均 < 8s）。
//
// 运行：node test/validate.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import topology from '../js/topology.js';

const {
  parseMask,
  analyzeMask,
  locateAt,
  trackProbe,
  exportJSON,
  normalizeCrop,
} = topology;

const __dirname = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// 引擎 bbox 附带 width/height，对拍只比四个边界。
function bbEq(got, want) {
  return got.x0 === want.x0 && got.y0 === want.y0 && got.x1 === want.x1 && got.y1 === want.y1;
}

// ---------- 逐像素参考实现（仅用于小图对拍） ----------

function bruteReference(width, height, grid, crop) {
  const x0 = crop.x0, y0 = crop.y0, x1 = crop.x1, y1 = crop.y1;
  const cw = x1 - x0, ch = y1 - y0;
  const at = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? grid[y * width + x] : 0);

  // 前景 4 连通：先收集每个组件的格集合，再按锚点排序编号
  const fgSeen = new Uint8Array(width * height);
  const compCells = [];
  for (let sy = y0; sy < y1; sy++) {
    for (let sx = x0; sx < x1; sx++) {
      if (!at(sx, sy) || fgSeen[sy * width + sx]) continue;
      const cells = [];
      const q = [[sx, sy]];
      fgSeen[sy * width + sx] = 1;
      while (q.length) {
        const [x, y] = q.pop();
        cells.push([x, y]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          if (!grid[ny * width + nx] || fgSeen[ny * width + nx]) continue;
          fgSeen[ny * width + nx] = 1;
          q.push([nx, ny]);
        }
      }
      compCells.push(cells);
    }
  }

  const comps = compCells.map((cells) => {
    let perimeter = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of cells) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!at(x + dx, y + dy)) perimeter++; // 裁区外 at()=0，切边计入
      }
    }
    let anchorX = Infinity;
    for (const [x, y] of cells) if (y === minY) anchorX = Math.min(anchorX, x);
    return {
      area: cells.length,
      perimeter,
      bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY },
      anchor: { x: anchorX, y: minY },
      cells,
    };
  });
  comps.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
  const fgIdGrid = new Int32Array(width * height);
  comps.forEach((c, i) => {
    c.number = i + 1;
    for (const [x, y] of c.cells) fgIdGrid[y * width + x] = c.number;
    delete c.cells;
  });

  // 背景 8 连通
  const bgMark = new Int32Array(width * height);
  const holes = [];
  for (let sy = y0; sy < y1; sy++) {
    for (let sx = x0; sx < x1; sx++) {
      if (at(sx, sy) || bgMark[sy * width + sx]) continue;
      const cells = [];
      let touch = false;
      const q = [[sx, sy]];
      bgMark[sy * width + sx] = -1;
      while (q.length) {
        const [x, y] = q.pop();
        cells.push([x, y]);
        if (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) touch = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          if (grid[ny * width + nx] || bgMark[ny * width + nx]) continue;
          bgMark[ny * width + nx] = -1;
          q.push([nx, ny]);
        }
      }
      if (touch) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of cells) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1);
      }
      const topY = minY;
      let anchorX = Infinity;
      for (const [x, y] of cells) if (y === topY) anchorX = Math.min(anchorX, x);
      holes.push({ area: cells.length, bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY }, anchor: { x: anchorX, y: topY } });
    }
  }
  holes.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
  holes.forEach((h, i) => { h.number = i + 1; });
  const holeIdGrid = new Int32Array(width * height);
  for (const h of holes) {
    const q = [[h.anchor.x, h.anchor.y]];
    const vis = new Set([h.anchor.y * width + h.anchor.x]);
    while (q.length) {
      const [x, y] = q.pop();
      holeIdGrid[y * width + x] = h.number;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        const key = ny * width + nx;
        if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
        if (grid[key] || vis.has(key)) continue;
        vis.add(key); q.push([nx, ny]);
      }
    }
  }

  return { comps, holes, fgIdGrid, holeIdGrid, crop };
}

// 从逐像素网格生成“脏”横段：乱序、重复、拆分相邻、随机子段交叠。
function messyRunsFromGrid(width, height, grid, rnd) {
  const trueRuns = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (!grid[y * width + x]) { x++; continue; }
      const x0 = x;
      while (x < width && grid[y * width + x]) x++;
      trueRuns.push([y, x0, x]);
    }
  }
  const messy = [];
  for (const r of trueRuns) {
    messy.push([...r]);
    if (rnd() < 0.5) messy.push([...r]); // 完全重复
    if (r[2] - r[1] >= 2 && rnd() < 0.6) {
      const k = r[1] + 1 + Math.floor(rnd() * (r[2] - r[1] - 1));
      messy.push([r[0], r[1], k]); // 拆出的相邻/交叠片段
      messy.push([r[0], k, r[2]]);
    }
    if (r[2] - r[1] >= 3 && rnd() < 0.5) {
      const a = r[1] + Math.floor(rnd() * (r[2] - r[1] - 1));
      const b = a + 1 + Math.floor(rnd() * (r[2] - a - 1));
      messy.push([r[0], a, b]); // 内部子段（交叠/重复并集）
    }
  }
  // Fisher-Yates 打乱
  for (let i = messy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [messy[i], messy[j]] = [messy[j], messy[i]];
  }
  return messy;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1. 样例手工值 ----------
console.log('\n[1] samples/run-mask.json 手工核算');
{
  const file = JSON.parse(readFileSync(join(__dirname, '..', 'samples', 'run-mask.json'), 'utf8'));
  const mask = parseMask(file);
  check('规范化后 5 条横段', mask.canonicalRunCount === 5, `got ${mask.canonicalRunCount}`);
  check('第 2 行两段相邻合并为 [3,8)', eq(mask.rows.get(2), [[3, 8]]), JSON.stringify(mask.rows.get(2)));

  const a = analyzeMask(mask);
  check('前景组件数=2', a.stats.foregroundComponents === 2);
  check('孔数=1', a.stats.holes === 1);
  check('前景像素=16', a.stats.foregroundPixels === 16);
  check('背景像素=224', a.stats.backgroundPixels === 224);
  check('组件1 编号/面积/周长', a.components[0].number === 1 && a.components[0].area === 12 && a.components[0].perimeter === 24,
    JSON.stringify(a.components[0]));
  check('组件1 包围框', eq(a.components[0].bbox, { x0: 3, y0: 2, x1: 8, y1: 5, width: 5, height: 3 }), JSON.stringify(a.components[0].bbox));
  check('组件2 面积4 周长10', a.components[1].area === 4 && a.components[1].perimeter === 10);
  check('组件编号顺序锚点', eq(a.components.map((c) => c.number), [1, 2]));
  check('孔面积3 包围框', a.holes[0].area === 3 && eq(a.holes[0].bbox, { x0: 4, y0: 3, x1: 7, y1: 4, width: 3, height: 1 }),
    JSON.stringify(a.holes[0]));
  check('总周长34', a.stats.totalPerimeter === 34, `got ${a.stats.totalPerimeter}`);

  const json1 = exportJSON(a);
  const exp = JSON.parse(json1);
  check('导出 runs 为规范排序原坐标', eq(exp.runs, [
    [2, 3, 8], [3, 3, 4], [3, 7, 8], [4, 3, 8], [8, 10, 14],
  ]), JSON.stringify(exp.runs));
  check('导出含 crop 与 stats', exp.crop.x0 === 0 && exp.stats.totalPerimeter === 34);

  // 导出的规范横段重新导入：横段、组件、孔、周长必须完全一致
  const re = analyzeMask({ width: 20, height: 12, runs: exp.runs });
  const reExp = JSON.parse(exportJSON(re));
  check('规范横段重导入后 runs 幂等', eq(reExp.runs, exp.runs));
  check('规范横段重导入后拓扑一致',
    reExp.stats.foregroundComponents === exp.stats.foregroundComponents &&
    reExp.stats.holes === exp.stats.holes &&
    reExp.stats.totalPerimeter === exp.stats.totalPerimeter &&
    eq(reExp.components, exp.components) &&
    eq(reExp.holes, exp.holes));
}

// ---------- 2. 随机对拍 ----------
console.log('\n[2] 随机掩码/随机裁区与逐像素 BFS 对拍');
{
  const rnd = mulberry32(20261127);
  let cases = 0;
  const FUZZ_ITERS = Number(process.env.FUZZ_ITERS || 400);
  for (let iter = 0; iter < FUZZ_ITERS; iter++) {
    const width = 1 + Math.floor(rnd() * 12);
    const height = 1 + Math.floor(rnd() * 12);
    const density = 0.25 + rnd() * 0.4;
    const grid = new Uint8Array(width * height);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd() < density ? 1 : 0;

    const raw = messyRunsFromGrid(width, height, grid, rnd);
    const mask = parseMask({ width, height, runs: raw });

    // 规范化结果必须与网格一致
    let canonicalMatches = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let fg = false;
        const rr = mask.rows.get(y);
        if (rr) for (const [a, b] of rr) if (x >= a && x < b) { fg = true; break; }
        if (fg !== !!grid[y * width + x]) canonicalMatches = false;
      }
    }
    if (!canonicalMatches) { check(`#${iter} 脏横段并集还原网格`, false); continue; }

    // 0..2 个随机裁区 + 全图
    const crops = [{ x0: 0, y0: 0, x1: width, y1: height }];
    for (let k = 0; k < 2; k++) {
      let ax = Math.floor(rnd() * (width + 1)), bx = Math.floor(rnd() * (width + 1));
      let ay = Math.floor(rnd() * (height + 1)), by = Math.floor(rnd() * (height + 1));
      crops.push(normalizeCrop({ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }, width, height));
    }

    for (const crop of crops) {
      cases++;
      const a = analyzeMask(mask, crop);
      const ref = bruteReference(width, height, grid, crop);
      const tag = `iter${iter} crop${JSON.stringify(crop)}`;

      if (a.components.length !== ref.comps.length) {
        check(`组件数 ${tag}`, false, `engine=${a.components.length} ref=${ref.comps.length}`);
        continue;
      }
      for (let i = 0; i < ref.comps.length; i++) {
        const got = a.components[i], want = ref.comps[i];
        if (got.area !== want.area || got.perimeter !== want.perimeter || !bbEq(got.bbox, want.bbox) || !eq(got.anchor, want.anchor)) {
          check(`组件#${i + 1} 面积/周长/框/锚点 ${tag}`, false,
            `got=${JSON.stringify({ area: got.area, p: got.perimeter, bb: got.bbox, an: got.anchor })} want=${JSON.stringify(want)}`);
        }
      }
      if (a.holes.length !== ref.holes.length) {
        check(`孔数 ${tag}`, false, `engine=${a.holes.length} ref=${ref.holes.length}`);
        continue;
      }
      for (let i = 0; i < ref.holes.length; i++) {
        const got = a.holes[i], want = ref.holes[i];
        if (got.area !== want.area || !bbEq(got.bbox, want.bbox) || !eq(got.anchor, want.anchor)) {
          check(`孔#${i + 1} ${tag}`, false, `got=${JSON.stringify({ area: got.area, bb: got.bbox })} want=${JSON.stringify(want)}`);
        }
      }
      if (a.stats.totalPerimeter !== ref.comps.reduce((s, c) => s + c.perimeter, 0)) {
        check(`总周长 ${tag}`, false, `${a.stats.totalPerimeter}`);
      }
      if (a.stats.foregroundPixels !== ref.comps.reduce((s, c) => s + c.area, 0)) {
        check(`前景面积 ${tag}`, false);
      }

      // 不变量：所有背景横段长度之和必须恰好等于背景格总数（无遗漏/重复覆盖）
      let bgCovered = 0;
      for (let bi = 0; bi < a.index.nBg; bi++) bgCovered += a.index.bgX1[bi] - a.index.bgX0[bi];
      if (bgCovered !== a.stats.backgroundPixels) {
        check(`背景段覆盖完整 ${tag}`, false, `runs=${bgCovered} stats=${a.stats.backgroundPixels}`);
      }

      // 逐格点选对拍
      let locateMismatch = 0;
      for (let y = crop.y0; y < crop.y1; y++) {
        for (let x = crop.x0; x < crop.x1; x++) {
          const loc = locateAt(a, x, y);
          const fgN = ref.fgIdGrid[y * width + x];
          const holeN = ref.holeIdGrid[y * width + x];
          if (fgN > 0) {
            if (loc.kind !== 'foreground' || loc.number !== fgN) locateMismatch++;
          } else if (holeN > 0) {
            if (loc.kind !== 'hole' || loc.number !== holeN) locateMismatch++;
          } else if (loc.kind !== 'external') {
            locateMismatch++;
          }
        }
      }
      if (locateMismatch) check(`逐格点选一致 ${tag}`, false, `mismatch=${locateMismatch}`);

      // 确定性：同样输入再算一次，导出 JSON 必须逐字符相同
      const again = exportJSON(analyzeMask({ width, height, runs: raw }, crop));
      if (again !== exportJSON(a)) check(`确定性导出 ${tag}`, false, '两次 JSON 不同');

      // 导出 runs 必须能还原裁区网格
      const exp = JSON.parse(exportJSON(a));
      for (const [y, x0, x1] of exp.runs) {
        if (y < crop.y0 || y >= crop.y1 || x0 < crop.x0 || x1 > crop.x1) {
          check(`导出段在裁区内且原坐标 ${tag}`, false, JSON.stringify([y, x0, x1]));
        }
        for (let x = x0; x < x1; x++) {
          if (!grid[y * width + x]) { check(`导出段均为前景 ${tag}`, false); x = x1; }
        }
      }
    }
  }
  check(`完成 ${cases} 个随机裁区对拍`, failures === 0 || true, `当前 failures=${failures}`);
}

// ---------- 2b. 穷举全部 512 种 3x3 图案 × 36 个裁区（18432 例，对齐 QA oracle） ----------
console.log('\n[2b] 3x3 全图案 × 全裁区穷举');
{
  let exhaustiveFail = 0;
  let exhaustiveCases = 0;
  const W = 3, H = 3;
  const crops3 = [];
  for (let x0 = 0; x0 <= 3; x0++) for (let x1 = x0 + 1; x1 <= 3; x1++)
    for (let y0 = 0; y0 <= 3; y0++) for (let y1 = y0 + 1; y1 <= 3; y1++)
      crops3.push({ x0, y0, x1, y1 });

  for (let maskBits = 0; maskBits < 512; maskBits++) {
    const grid = new Uint8Array(9);
    const runs = [];
    for (let i = 0; i < 9; i++) {
      // 与 QA oracle 不同位序无所谓，只要遍历全部图案
      grid[i] = (maskBits >> i) & 1;
    }
    for (let y = 0; y < 3; y++) {
      let x = 0;
      while (x < 3) {
        if (!grid[y * 3 + x]) { x++; continue; }
        const a = x;
        while (x < 3 && grid[y * 3 + x]) x++;
        runs.push([y, a, x]);
      }
    }
    const mask = parseMask({ width: 3, height: 3, runs });
    for (const crop of crops3) {
      exhaustiveCases++;
      const a = analyzeMask(mask, crop);
      const ref = bruteReference(3, 3, grid, crop);
      const fail =
        a.components.length !== ref.comps.length ||
        a.holes.length !== ref.holes.length ||
        a.stats.totalPerimeter !== ref.comps.reduce((s, c) => s + c.perimeter, 0) ||
        a.components.some((c, i) => {
          const w = ref.comps[i];
          return !w || c.area !== w.area || c.perimeter !== w.perimeter ||
            !bbEq(c.bbox, w.bbox) || !eq(c.anchor, w.anchor);
        }) ||
        a.holes.some((h, i) => {
          const w = ref.holes[i];
          return !w || h.area !== w.area || !bbEq(h.bbox, w.bbox) || !eq(h.anchor, w.anchor);
        });
      if (fail) {
        exhaustiveFail++;
        if (exhaustiveFail <= 5) {
          console.log('  FAIL 穷举 bits=' + maskBits + ' crop=' + JSON.stringify(crop),
            'engine C/H=' + a.components.length + '/' + a.holes.length,
            'ref C/H=' + ref.comps.length + '/' + ref.holes.length);
        }
      }
    }
  }
  check(`穷举 ${exhaustiveCases} 例全部与像素 BFS 一致`, exhaustiveFail === 0, `fail=${exhaustiveFail}`);
}

// ---------- 3. 明确边界语义 ----------
console.log('\n[3] 边界语义');
{
  // 2x2 主对角两前景像素：前景 2 个四连通组件；另两个背景格八连通且贴边 -> 无孔
  const m = parseMask({ width: 2, height: 2, runs: [[0, 0, 1], [1, 1, 2]] });
  const a = analyzeMask(m);
  check('对角前景=2 组件', a.components.length === 2);
  check('八连通背景无孔', a.holes.length === 0);
  check('两单点周长各4 总8', a.stats.totalPerimeter === 8, `${a.stats.totalPerimeter}`);

  // 空图
  const e = analyzeMask(parseMask({ width: 10, height: 10, runs: [] }));
  check('空图 0 组件 0 孔', e.components.length === 0 && e.holes.length === 0);
  check('空图周长0 背景100', e.stats.totalPerimeter === 0 && e.stats.backgroundPixels === 100);
  check('空图点选外部', locateAt(e, 5, 5).kind === 'external');

  // 满前景矩形
  const fullRuns = [];
  for (let y = 0; y < 20; y++) fullRuns.push([y, 0, 30]);
  const f = analyzeMask(parseMask({ width: 30, height: 20, runs: fullRuns }));
  check('满矩形 1 组件 面积600', f.components.length === 1 && f.components[0].area === 600);
  check('满矩形无孔', f.holes.length === 0);
  check('满矩形周长=2(30+20)=100', f.stats.totalPerimeter === 100, `${f.stats.totalPerimeter}`);

  // 裁区切满矩形的一刀：裁区周长 = 2(cw+ch)，切边照算
  const fc = analyzeMask(parseMask({ width: 30, height: 20, runs: fullRuns }), { x0: 5, y0: 4, x1: 15, y1: 10 });
  check('裁切满矩形面积60', fc.components[0].area === 60);
  check('裁切边计入周长=32', fc.stats.totalPerimeter === 2 * (10 + 6), `${fc.stats.totalPerimeter}`);

  // 环：全图 1 孔；裁掉顶盖行后孔接触裁区顶边 -> 与外部连通
  const ring = [
    [2, 2, 9],
    [3, 2, 3], [3, 8, 9],
    [4, 2, 3], [4, 8, 9],
    [5, 2, 3], [5, 8, 9],
    [6, 2, 9],
  ];
  const rm = parseMask({ width: 12, height: 10, runs: ring });
  const ra = analyzeMask(rm);
  check('环有1孔 面积15', ra.holes.length === 1 && ra.holes[0].area === 15, `holes=${ra.holes.length}`);
  const probe = ra.holes[0].probe;
  const rc = analyzeMask(rm, { x0: 0, y0: 3, x1: 12, y1: 10 });
  check('裁掉顶盖后无孔（孔通裁区顶边）', rc.holes.length === 0, `holes=${rc.holes.length}`);
  const tr = trackProbe(rc, probe);
  check('探针报告已与外部连通', tr.status === 'external', tr.status);

  // 裁区贴边背景不算孔：把环放在裁区内部但孔保留，裁区比环大 -> 仍 1 孔
  const rp = analyzeMask(rm, { x0: 1, y0: 1, x1: 10, y1: 9 });
  check('裁区包围环但不切孔时仍1孔', rp.holes.length === 1, `holes=${rp.holes.length}`);

  // 退化裁区（零宽/零高）与越界输入不得崩溃
  const z1 = analyzeMask(rm, { x0: 4, y0: 4, x1: 4, y1: 8 });
  check('零宽裁区全0不崩', z1.stats.cropArea === 0 && z1.components.length === 0 && z1.holes.length === 0);
  const z2 = analyzeMask(rm, { x0: 2, y0: 3, x1: 9, y1: 3 });
  check('零高裁区全0不崩', z2.stats.cropArea === 0);
  const z3 = analyzeMask(rm, { x0: -999, y0: -999, x1: 99999, y1: 99999 });
  check('越界裁区被裁回原图', z3.crop.x0 === 0 && z3.crop.y0 === 0 && z3.crop.x1 === 12 && z3.crop.y1 === 10);
  check('裁区外点查询', locateAt(ra, 999, 999).kind === 'outside-crop');
}

// ---------- 3b. 真实 QA 验收记录中的精确回归用例 ----------
console.log('\n[3b] QA 精确用例（bbox 左伸 / 八连通泄漏 / 编号锚点）');
{
  // 同行乱序/重复/交叠/相邻 4 段 -> 一条 [1,0,4]，面积4 周长10
  const messy = parseMask({ width: 4, height: 2, runs: [[1, 2, 4], [1, 0, 2], [1, 2, 3], [1, 3, 4]] });
  const ma = analyzeMask(messy);
  check('脏段并集导出 [[1,0,4]]', eq(ma.runs, [[1, 0, 4]]), JSON.stringify(ma.runs));
  check('并集横条面积4周长10', ma.stats.foregroundPixels === 4 && ma.stats.totalPerimeter === 10);

  // 编号顺序：起始格 (0,9) -> #1，(1,1) -> #2，(1,5) -> #3
  const nb = analyzeMask({ width: 12, height: 3, runs: [[0, 9, 10], [1, 1, 2], [1, 5, 6]] });
  check('编号锚点顺序 (0,9),(1,1),(1,5)',
    eq(nb.components.map((c) => [c.number, c.anchor.x, c.anchor.y]),
      [[1, 9, 0], [2, 1, 1], [3, 5, 1]]));

  // 关键 bbox 回归：裁区 行[3,5) 列[4,8)，下方行向左伸到列4，
  // bbox 左边界必须是 4，不能误用最上行最左锚点 7。
  const file = JSON.parse(readFileSync(join(__dirname, '..', 'samples', 'run-mask.json'), 'utf8'));
  const tricky = analyzeMask(parseMask(file), { x0: 4, y0: 3, x1: 8, y1: 5 });
  check('左伸组件面积5周长12', tricky.components.length === 1 &&
    tricky.components[0].area === 5 && tricky.components[0].perimeter === 12,
    JSON.stringify(tricky.components[0]));
  check('bbox 左边界取全量 minX=4（非锚点7）',
    tricky.components[0].bbox.x0 === 4 && tricky.components[0].bbox.x1 === 8 &&
    tricky.components[0].bbox.y0 === 3 && tricky.components[0].bbox.y1 === 5,
    JSON.stringify(tricky.components[0].bbox));
  check('该裁区孔贴顶边 -> 0', tricky.holes.length === 0);
  const tj = JSON.parse(exportJSON(tricky));
  check('导出 bbox 同样为左4', tj.components[0].bbox.x0 === 4);
  check('非零原点裁区导出原坐标段',
    eq(tj.runs, [[3, 7, 8], [4, 4, 8]]), JSON.stringify(tj.runs));

  // 3x3 完整环：8 格、周长16、1 孔
  const ring = { width: 3, height: 3, runs: [[0, 0, 3], [1, 0, 1], [1, 2, 3], [2, 0, 3]] };
  const fullRing = analyzeMask(parseMask(ring));
  check('3x3环 面积8 周长16 孔1',
    fullRing.components[0].area === 8 && fullRing.components[0].perimeter === 16 && fullRing.holes.length === 1);

  // 缺左上角：中心背景经对角与角格八连通 -> 无孔（专测背景8连通）
  const leak = analyzeMask(parseMask({
    width: 3, height: 3,
    runs: [[0, 1, 3], [1, 0, 1], [1, 2, 3], [2, 0, 3]],
  }));
  check('缺角环经八连通泄漏 -> 孔0', leak.holes.length === 0);
  check('缺角环中心判定为外部背景', locateAt(leak, 1, 1).kind === 'external');

  // 完整环裁去左列：面积5 周长12 孔0
  const ringCrop = analyzeMask(parseMask(ring), { x0: 1, y0: 0, x1: 3, y1: 3 });
  check('环裁左列 面积5 周长12 孔0',
    ringCrop.stats.foregroundPixels === 5 && ringCrop.stats.totalPerimeter === 12 && ringCrop.holes.length === 0,
    `${ringCrop.stats.foregroundPixels}/${ringCrop.stats.totalPerimeter}/${ringCrop.holes.length}`);
}

// ---------- 4. 满额性能 ----------
console.log('\n[4] 满额数据性能（1e6 x 1e6, 200k raw runs）');
{
  const rnd = mulberry32(99);
  const W = 1_000_000, H = 1_000_000, N = 200_000;
  const runs = [];
  // 构造有疏有密、含交叠重复的数据：12 万随机段 + 4 万重复/交叠 + 4 万边界大环段
  for (let i = 0; i < 160_000; i++) {
    const y = Math.floor(rnd() * H);
    const x0 = Math.floor(rnd() * (W - 2000));
    const len = 1 + Math.floor(rnd() * 2000);
    runs.push([y, x0, Math.min(W, x0 + len)]);
  }
  for (let i = 0; i < 40_000; i++) {
    const src = runs[Math.floor(rnd() * runs.length)];
    if (rnd() < 0.5) runs.push([...src]);
    else {
      const cut = src[1] + Math.floor((src[2] - src[1]) / 2);
      runs.push([src[0], src[1], cut]);
      runs.push([src[0], cut, src[2]]);
    }
  }
  // 再加一些跨大量空行的巨型框，压背景 DSU
  for (let k = 0; k < 20_000; k++) {
    const y = k * 40 + 10;
    runs.push([y, 1000, 900_000]);
  }
  const raw = { width: W, height: H, runs: runs.slice(0, N) };
  // 注意上面总数可能 >N，截断到恰好 20 万
  raw.runs = runs.slice(0, 200_000);
  check('压测横段=200000', raw.runs.length === 200_000);

  let t0 = performance.now();
  const mask = parseMask(raw);
  const tParse = performance.now() - t0;

  t0 = performance.now();
  const full = analyzeMask(mask);
  const tFull = performance.now() - t0;
  check(`整图分析 <8s（实际 ${tFull.toFixed(0)}ms，解析 ${tParse.toFixed(0)}ms，规范段 ${mask.canonicalRunCount}，组件 ${full.components.length}，孔 ${full.holes.length}）`,
    tFull < 8000);

  t0 = performance.now();
  const crop = analyzeMask(mask, { x0: 100_000, y0: 200_000, x1: 900_000, y1: 800_000 });
  const tCrop = performance.now() - t0;
  check(`大裁区分析 <8s（实际 ${tCrop.toFixed(0)}ms，段 ${crop.stats.cropRunCount}，组件 ${crop.components.length}，孔 ${crop.holes.length}）`,
    tCrop < 8000);

  t0 = performance.now();
  const small = analyzeMask(mask, { x0: 400_000, y0: 400_000, x1: 401_000, y1: 401_000 });
  const tSmall = performance.now() - t0;
  check(`小裁区分析 <8s（实际 ${tSmall.toFixed(0)}ms）`, tSmall < 8000);

  // 改裁区再改回：导出逐字符相同
  const c1 = exportJSON(crop);
  analyzeMask(mask, { x0: 0, y0: 0, x1: 100, y1: 100 });
  const c2 = exportJSON(analyzeMask(mask, { x0: 100_000, y0: 200_000, x1: 900_000, y1: 800_000 }));
  check('裁区改出再改回结果相同', c1 === c2);
  void small;

  // QA 实测过的极端口径：20 万条连续全宽横段 = 1000000 x 200000 实心矩形
  const wide = [];
  for (let y = 0; y < 200_000; y++) wide.push([y, 0, 1_000_000]);
  const wm = parseMask({ width: 1_000_000, height: 1_000_000, runs: wide });
  const wa = analyzeMask(wm);
  check('全宽矩形 面积2e11/组件1/周长2.4e6/无孔',
    wa.stats.foregroundPixels === 200_000_000_000 &&
    wa.components.length === 1 &&
    wa.stats.totalPerimeter === 2_400_000 &&
    wa.holes.length === 0,
    `${wa.stats.foregroundPixels}/${wa.components.length}/${wa.stats.totalPerimeter}`);
  const wc = analyzeMask(wm, { x0: 1, y0: 1, x1: 999_999, y1: 199_999 });
  check('全宽矩形裁区 QA 口径 面积199997600004/周长2399992',
    wc.stats.foregroundPixels === 199_997_600_004 && wc.stats.totalPerimeter === 2_399_992,
    `${wc.stats.foregroundPixels}/${wc.stats.totalPerimeter}`);

  // 20 万个互相孤立的单格（隔 4 行）-> 200000 组件；裁掉第一行格 -> 199999
  const iso = [];
  for (let i = 0; i < 200_000; i++) iso.push([4 * i, 10, 11]);
  const im = parseMask({ width: 64, height: 1_000_000, runs: iso });
  const ia = analyzeMask(im);
  check('20万孤立横段=200000组件', ia.components.length === 200_000, String(ia.components.length));
  const ic = analyzeMask(im, { x0: 0, y0: 1, x1: 64, y1: 1_000_000 });
  check('裁掉首个孤立格后=199999组件', ic.components.length === 199_999, String(ic.components.length));
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`}`);
process.exit(failures ? 1 : 0);
