// 横段二值掩码的裁区拓扑核算核心模块（浏览器与 Node 测试共用）。
//
// 设计原则：
//  - 只保存/处理横段（run-length），任何地方都不分配 width*height 的逐像素整图；
//  - 前景四连通、背景八连通均用“横段 + 并查集”自行核算，不调用现成连通域接口；
//  - 所有统计都针对给定裁区（半开整数矩形 [x0,y0,x1,y1)）重新计算；
//  - 前景周长 = 每条前景格边中，未与裁区内另一前景格共享的单位边数，
//    因此裁区边界上的切边照常计入；
//  - 结果是确定的纯函数：同一输入与裁区必然得到完全相同的输出。
//
// 坐标约定：左上角 (0,0)，x 为列、向右增大，y 为行、向下增大；
// 横段 [y, x0, x1) 表示第 y 行第 x0..x1-1 列，左闭右开。

// 双用模块：
//  - 浏览器经典 <script>：挂 window.RunMaskTopology（file:// 直开也可）；
//  - Node：module.exports 导出，且该写法可被 ESM 命名导入静态识别。
'use strict';

const LIMITS = {
  maxWidth: 1_000_000,
  maxHeight: 1_000_000,
  maxRuns: 200_000,
};

class MaskFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaskFormatError';
  }
}

// ---------- 小工具 ----------

function intFrom(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new MaskFormatError(`${label} 必须是整数，收到 ${String(value)}`);
    }
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  throw new MaskFormatError(`${label} 必须是整数，收到 ${JSON.stringify(value)}`);
}

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// 把一行内无序、重复、交叠、相邻的区间合并成有序、互不交叠且至少隔 1 格的规范区间。
function mergeIntervals(intervals) {
  if (intervals.length <= 1) return intervals.slice();
  intervals.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const out = [];
  for (const seg of intervals) {
    const x0 = seg[0];
    const x1 = seg[1];
    if (!(x1 > x0)) continue; // 空段/反向段丢弃
    const last = out[out.length - 1];
    if (!last || x0 > last[1]) {
      out.push([x0, x1]);
    } else if (x1 > last[1]) {
      // x0 <= last[1]：交叠或首尾相邻（半开坐标下 x0 === last[1] 为相邻），按并集合并
      last[1] = x1;
    }
  }
  return out;
}

function entryToRun(entry, index) {
  if (Array.isArray(entry)) {
    if (entry.length < 3) {
      throw new MaskFormatError(`第 ${index} 条横段不是 [y,x0,x1] 三元组：${JSON.stringify(entry)}`);
    }
    return [entry[0], entry[1], entry[2]];
  }
  if (entry && typeof entry === 'object') {
    const y = entry.y ?? entry.row ?? entry[0];
    const x0 = entry.x0 ?? entry.start ?? entry.left ?? entry.x;
    const x1 = entry.x1 ?? entry.end ?? entry.right ?? entry.to;
    if (y === undefined || x0 === undefined || x1 === undefined) {
      throw new MaskFormatError(`第 ${index} 条横段缺少 y/x0/x1：${JSON.stringify(entry)}`);
    }
    return [y, x0, x1];
  }
  throw new MaskFormatError(`第 ${index} 条横段格式无法识别：${JSON.stringify(entry)}`);
}

// ---------- 解析与规范化 ----------

// 输入可为 samples/run-mask.json 的对象（或其已解析 JSON 字符串）。
// 返回紧凑的规范掩码：rows: Map<y, Array<[x0,x1]>>，ys 为升序有段行。
function parseMask(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || typeof data !== 'object') {
    throw new MaskFormatError('JSON 顶层必须是对象，形如 {width, height, runs}');
  }

  const width = intFrom(data.width ?? data.w ?? data.cols ?? data.colsCount, 'width');
  const height = intFrom(data.height ?? data.h ?? data.rows ?? data.rowsCount, 'height');
  if (!(width >= 1 && height >= 1)) {
    throw new MaskFormatError(`width/height 必须为正整数，收到 ${width}×${height}`);
  }
  if (width > LIMITS.maxWidth || height > LIMITS.maxHeight) {
    throw new MaskFormatError(`宽高超过支持上限 ${LIMITS.maxWidth}：${width}×${height}`);
  }

  const rawRuns = data.runs ?? data.segments ?? data.runLengths ?? data.data;
  if (!Array.isArray(rawRuns)) {
    throw new MaskFormatError('runs 必须是数组，每项为 [行号,起始列,结束列]');
  }

  const warnings = [];
  if (rawRuns.length > LIMITS.maxRuns) {
    warnings.push(`横段数 ${rawRuns.length} 超过标称上限 ${LIMITS.maxRuns}，仍会尝试计算`);
  }

  /** @type {Map<number, Array<[number,number]>>} */
  const grouped = new Map();
  let validCount = 0;

  for (let i = 0; i < rawRuns.length; i++) {
    let [y, x0, x1] = entryToRun(rawRuns[i], i);
    y = intFrom(y, `第 ${i} 条横段的行号`);
    x0 = intFrom(x0, `第 ${i} 条横段的起始列`);
    x1 = intFrom(x1, `第 ${i} 条横段的结束列`);

    if (y < 0 || y >= height) {
      warnings.push(`第 ${i} 条横段行号 ${y} 越界（height=${height}），已跳过`);
      continue;
    }
    // 宽容地把越界横坐标裁回图像范围；范围内数据不受影响。
    const cx0 = clampInt(Math.min(x0, x1), 0, width);
    const cx1 = clampInt(Math.max(x0, x1), 0, width);
    if (cx1 <= cx0) {
      warnings.push(`第 ${i} 条横段 [${x0},${x1}) 裁剪后为空，已跳过`);
      continue;
    }
    if (x0 < 0 || x1 > width || x0 > x1) {
      warnings.push(`第 ${i} 条横段坐标 [${x0},${x1}) 越界或反向，已规整为 [${cx0},${cx1})`);
    }
    let arr = grouped.get(y);
    if (!arr) {
      arr = [];
      grouped.set(y, arr);
    }
    arr.push([cx0, cx1]);
    validCount++;
  }

  /** @type {Map<number, Array<[number,number]>>} */
  const rows = new Map();
  let canonicalRunCount = 0;
  const ys = [...grouped.keys()].sort((a, b) => a - b);
  for (const y of ys) {
    const merged = mergeIntervals(grouped.get(y));
    if (merged.length) {
      rows.set(y, merged);
      canonicalRunCount += merged.length;
    }
  }

  return {
    width,
    height,
    rows,
    ys: ys.filter((y) => rows.has(y)),
    rawRunCount: rawRuns.length,
    validRunCount: validCount,
    canonicalRunCount,
    warnings,
  };
}

// 也允许直接把 parseMask 的结果传给 analyze。
function asMask(data) {
  if (data && data.rows instanceof Map && Array.isArray(data.ys)) return data;
  return parseMask(data);
}

// ---------- 裁区 ----------

// 接受 {x0,y0,x1,y1}，也接受 {x,y,width,height} / {left,top,right,bottom}。
// 输出始终是裁到原图范围内、方向归一的半开整数矩形。
function normalizeCrop(crop, width, height) {
  const c = crop || {};
  let x0 = c.x0 ?? c.left ?? c.x ?? 0;
  let y0 = c.y0 ?? c.top ?? c.y ?? 0;
  let x1 = c.x1 ?? c.right;
  let y1 = c.y1 ?? c.bottom;
  if (x1 === undefined && c.width !== undefined) x1 = Number(x0) + Number(c.width);
  if (y1 === undefined && c.height !== undefined) y1 = Number(y0) + Number(c.height);
  if (x1 === undefined) x1 = width;
  if (y1 === undefined) y1 = height;

  x0 = Math.floor(Number(x0));
  y0 = Math.floor(Number(y0));
  x1 = Math.ceil(Number(x1));
  y1 = Math.ceil(Number(y1));
  if (![x0, y0, x1, y1].every(Number.isFinite)) {
    throw new MaskFormatError('裁区坐标必须是整数');
  }
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];

  x0 = clampInt(x0, 0, width);
  x1 = clampInt(x1, 0, width);
  y0 = clampInt(y0, 0, height);
  y1 = clampInt(y1, 0, height);
  if (x1 < x0) x1 = x0;
  if (y1 < y0) y1 = y0;
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

// ---------- 并查集 ----------

function makeParent(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  return p;
}

function findRoot(parent, a) {
  let r = a;
  while (parent[r] !== r) r = parent[r];
  while (parent[a] !== a) {
    const next = parent[a];
    parent[a] = r;
    a = next;
  }
  return r;
}

function unionRoots(parent, size, a, b) {
  let ra = findRoot(parent, a);
  let rb = findRoot(parent, b);
  if (ra === rb) return ra;
  if (size[ra] < size[rb]) [ra, rb] = [rb, ra];
  parent[rb] = ra;
  size[ra] += size[rb];
  return ra;
}

// ---------- 包围框工具 ----------

function newBBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}
function addBBox(b, x0, y0, x1, y1) {
  if (x0 < b.minX) b.minX = x0;
  if (y0 < b.minY) b.minY = y0;
  if (x1 > b.maxX) b.maxX = x1;
  if (y1 > b.maxY) b.maxY = y1; // 调用方传 y1 = y+1（半开）
}
function finalBBox(b) {
  return {
    x0: b.minX,
    y0: b.minY,
    x1: b.maxX,
    y1: b.maxY,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
  };
}

// ============================================================
// 主核算
// ============================================================

function analyzeMask(data, cropInput = null) {
  const mask = asMask(data);
  const { width, height } = mask;
  const crop = normalizeCrop(cropInput ?? { x0: 0, y0: 0, x1: width, y1: height }, width, height);
  const cw = crop.x1 - crop.x0;
  const ch = crop.y1 - crop.y0;

  // ---------- 1. 裁出前景横段（保持 y、x 升序） ----------
  /** @type {Array<{y:number,x0:number,x1:number,node:number}>} */
  const fgRuns = [];
  /** @type {Map<number, typeof fgRuns>} */
  const fgRows = new Map();
  const fgYs = [];

  for (const y of mask.ys) {
    if (y < crop.y0) continue;
    if (y >= crop.y1) break;
    const src = mask.rows.get(y);
    /** @type {typeof fgRuns} */
    const row = [];
    for (const [a, b] of src) {
      const x0 = Math.max(a, crop.x0);
      const x1 = Math.min(b, crop.x1);
      if (x0 < x1) {
        const run = { y, x0, x1, node: fgRuns.length };
        fgRuns.push(run);
        row.push(run);
      }
    }
    if (row.length) {
      fgRows.set(y, row);
      fgYs.push(y);
    }
  }

  const nFg = fgRuns.length;
  const fgParent = makeParent(nFg);
  const fgSize = new Int32Array(nFg);
  fgSize.fill(1);
  const covTop = new Int32Array(nFg);
  const covBottom = new Int32Array(nFg);

  // ---------- 2. 相邻行扫描：前景四连通合并 + 横边覆盖长度 ----------
  // 仅当行号严格相邻（y-1）才可能四连通。半开区间严格相交才算上下重叠。
  for (let yi = 0; yi < fgYs.length; yi++) {
    const y = fgYs[yi];
    const prev = fgRows.get(y - 1);
    if (!prev) continue;
    const cur = fgRows.get(y);

    let j = 0;
    for (const r of cur) {
      while (j < prev.length && prev[j].x1 <= r.x0) j++;
      let k = j;
      while (k < prev.length && prev[k].x0 < r.x1) {
        const q = prev[k];
        const overlap = Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0);
        // 上一行区间互不相交，故这些 overlap 之和即 r 上边被盖住的单位边数。
        covTop[r.node] += overlap;
        covBottom[q.node] += overlap;
        unionRoots(fgParent, fgSize, r.node, q.node);
        k++;
      }
    }
  }

  // ---------- 3. 汇总前景组件：面积 / 周长 / 包围框 / 锚点 ----------
  /** @type {Map<number, any>} */
  const fgMap = new Map();
  for (let i = 0; i < nFg; i++) {
    const r = fgRuns[i];
    const root = findRoot(fgParent, i);
    let c = fgMap.get(root);
    if (!c) {
      c = {
        root,
        area: 0,
        perimeter: 0,
        runCount: 0,
        bbox: newBBox(),
        anchorY: Infinity,
        anchorX: Infinity,
      };
      fgMap.set(root, c);
    }
    const len = r.x1 - r.x0;
    c.area += len;
    c.runCount++;
    // 每条极大横段自带左右两条暴露竖边；横边未被上/下行前景盖住的部分暴露。
    // 裁区外不参与覆盖计算，所以裁区边界边自动计入。
    c.perimeter += 2 + (len - covTop[i]) + (len - covBottom[i]);
    addBBox(c.bbox, r.x0, r.y, r.x1, r.y + 1);
    if (r.y < c.anchorY || (r.y === c.anchorY && r.x0 < c.anchorX)) {
      c.anchorY = r.y;
      c.anchorX = r.x0;
    }
  }

  // 编号规则：最靠上的格优先；同一最上行取最靠左的格。
  const fgSorted = [...fgMap.values()].sort(
    (a, b) => (a.anchorY - b.anchorY) || (a.anchorX - b.anchorX),
  );
  const fgRootToNumber = new Map();
  const components = fgSorted.map((c, idx) => {
    const number = idx + 1;
    fgRootToNumber.set(c.root, number);
    const bbox = finalBBox(c.bbox);
    return {
      number,
      area: c.area,
      perimeter: c.perimeter,
      runCount: c.runCount,
      bbox,
      anchor: { x: c.anchorX, y: c.anchorY },
    };
  });
  const runCompNumber = new Int32Array(nFg);
  for (let i = 0; i < nFg; i++) {
    runCompNumber[i] = fgRootToNumber.get(findRoot(fgParent, i)) ?? 0;
  }

  const foregroundPixels = components.reduce((s, c) => s + c.area, 0);
  const totalPerimeter = components.reduce((s, c) => s + c.perimeter, 0);

  // ---------- 4. 背景横段 + 八连通并查集 ----------
  // 每行背景段数 <= 该行前景段数 + 1，故背景节点总数 <= nFg + ch。
  const capBg = nFg + ch + 1;
  const bgX0 = new Uint32Array(capBg);
  const bgX1 = new Uint32Array(capBg);
  const bgY = new Int32Array(capBg);
  const bgParent = new Int32Array(capBg);
  const bgSize = new Int32Array(capBg);
  const bgArea = new Float64Array(capBg);
  const bgMinX = new Int32Array(capBg);
  const bgMinY = new Int32Array(capBg);
  const bgMaxX = new Int32Array(capBg);
  const bgMaxY = new Int32Array(capBg);
  const bgTouch = new Uint8Array(capBg);

  // rowStart[li] / rowStart[li+1] 为本裁区第 li 行对应的背景段下标区间。
  const rowStart = new Uint32Array(ch + 1);
  let nBg = 0;

  const bgFind = (a) => findRoot(bgParent, a);
  function bgUnion(a, b) {
    let ra = findRoot(bgParent, a);
    let rb = findRoot(bgParent, b);
    if (ra === rb) return ra;
    if (bgSize[ra] < bgSize[rb]) [ra, rb] = [rb, ra];
    bgParent[rb] = ra;
    bgSize[ra] += bgSize[rb];
    bgArea[ra] += bgArea[rb];
    bgTouch[ra] |= bgTouch[rb];
    if (bgMinX[rb] < bgMinX[ra]) bgMinX[ra] = bgMinX[rb];
    if (bgMinY[rb] < bgMinY[ra]) bgMinY[ra] = bgMinY[rb];
    if (bgMaxX[rb] > bgMaxX[ra]) bgMaxX[ra] = bgMaxX[rb];
    if (bgMaxY[rb] > bgMaxY[ra]) bgMaxY[ra] = bgMaxY[rb];
    return ra;
  }

  function addBgRun(y, x0, x1) {
    const id = nBg++;
    bgX0[id] = x0;
    bgX1[id] = x1;
    bgY[id] = y;
    bgParent[id] = id;
    bgSize[id] = 1;
    bgArea[id] = x1 - x0;
    bgMinX[id] = x0;
    bgMaxX[id] = x1;
    bgMinY[id] = y;
    bgMaxY[id] = y + 1;
    // 背景格只要落在裁区四条边上，该背景组件就与“外部”相通，不计孔。
    bgTouch[id] =
      y === crop.y0 || y === crop.y1 - 1 || x0 === crop.x0 || x1 === crop.x1 ? 1 : 0;
    return id;
  }

  for (let li = 0; li < ch; li++) {
    const y = crop.y0 + li;
    rowStart[li] = nBg;

    // 4.1 由该行前景段反推出背景段
    const fg = fgRows.get(y);
    /** @type {number[]} */
    const curIds = [];
    let cursor = crop.x0;
    if (fg) {
      for (const r of fg) {
        if (r.x0 > cursor) curIds.push(addBgRun(y, cursor, r.x0));
        if (r.x1 > cursor) cursor = r.x1;
      }
    }
    if (cursor < crop.x1) curIds.push(addBgRun(y, cursor, crop.x1));

    // 4.2 与上一行背景段做八连通合并
    if (li > 0 && curIds.length) {
      const ps = rowStart[li - 1];
      const pe = rowStart[li]; // 本行新增前的 nBg 即上一行区间右端
      let j = ps;
      for (const ci of curIds) {
        const a0 = bgX0[ci];
        const a1 = bgX1[ci];
        // 八连通（允许对角）：相邻行两段列集合距离 <= 1。
        // 半开区间下等价于 a0 <= b1 且 b0 <= a1（端点相等即对角相邻）。
        while (j < pe && bgX1[j] < a0) j++;
        let k = j;
        while (k < pe && bgX0[k] <= a1) {
          bgUnion(ci, k);
          k++;
        }
      }
    }
  }
  rowStart[ch] = nBg;

  // ---------- 5. 汇总背景组件，贴边者为外部，其余为孔 ----------
  /** @type {Map<number, any>} */
  const holeMap = new Map();
  for (let i = 0; i < nBg; i++) {
    const root = bgFind(i);
    if (bgTouch[root]) continue;
    let h = holeMap.get(root);
    if (!h) {
      h = {
        root,
        area: bgArea[root],
        runCount: 0,
        anchorY: Infinity,
        anchorX: Infinity,
        probe: null,
        probeLen: -1,
        bbox: {
          minX: bgMinX[root],
          minY: bgMinY[root],
          maxX: bgMaxX[root],
          maxY: bgMaxY[root],
        },
      };
      holeMap.set(root, h);
    }
    h.runCount++;
    const x0 = bgX0[i];
    const x1 = bgX1[i];
    const y = bgY[i];
    if (y < h.anchorY || (y === h.anchorY && x0 < h.anchorX)) {
      h.anchorY = y;
      h.anchorX = x0;
    }
    // 选最长横段中点作为跨裁区跟踪的内部探针。
    const len = x1 - x0;
    if (len > h.probeLen) {
      h.probeLen = len;
      h.probe = { x: x0 + Math.floor(len / 2), y };
    }
  }

  const holesSorted = [...holeMap.values()].sort(
    (a, b) => (a.anchorY - b.anchorY) || (a.anchorX - b.anchorX),
  );
  const bgRootToHoleNumber = new Map();
  const holes = holesSorted.map((h, idx) => {
    const number = idx + 1;
    bgRootToHoleNumber.set(h.root, number);
    return {
      number,
      area: h.area,
      runCount: h.runCount,
      bbox: finalBBox(h.bbox),
      anchor: { x: h.anchorX, y: h.anchorY },
      probe: h.probe,
    };
  });

  // 每个背景横段节点对应的孔编号（外部为 0），供渲染与点选。
  const bgHoleNumber = new Int32Array(nBg);
  for (let i = 0; i < nBg; i++) {
    const num = bgRootToHoleNumber.get(bgFind(i));
    if (num) bgHoleNumber[i] = num;
  }

  const cropArea = cw * ch;
  const holePixels = holes.reduce((s, h) => s + h.area, 0);
  const backgroundPixels = cropArea - foregroundPixels;

  // 规范横段（裁后、原图坐标），固定按 y 再 x 排序。
  const runs = fgRuns.map((r) => [r.y, r.x0, r.x1]);

  const stats = {
    rawRunCount: mask.rawRunCount,
    canonicalRunCount: mask.canonicalRunCount,
    cropRunCount: runs.length,
    cropX0: crop.x0,
    cropY0: crop.y0,
    cropX1: crop.x1,
    cropY1: crop.y1,
    cropWidth: cw,
    cropHeight: ch,
    cropArea,
    foregroundPixels,
    backgroundPixels,
    foregroundComponents: components.length,
    holes: holes.length,
    holePixels,
    totalPerimeter,
  };

  const result = {
    width,
    height,
    crop,
    stats,
    components,
    holes,
    runs,
    warnings: mask.warnings,
    // 内部索引（不参与 JSON 导出），供点选/渲染/跟踪使用。
    index: {
      fgRows,
      fgYs,
      fgRuns,
      fgParent,
      runCompNumber,
      rowStart,
      bgX0,
      bgX1,
      bgY,
      bgParent,
      bgHoleNumber,
      nBg,
    },
  };
  return result;
}

// ---------- 坐标点查询：判断某原图像素属于哪个组件 / 孔 / 外部 ----------

// 在升序且互不相交的横段数组中找包含 x 的段。
function findRunAtX(list, x) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = list[mid];
    if (x < r.x0) hi = mid - 1;
    else if (x >= r.x1) lo = mid + 1;
    else return r;
  }
  return null;
}

function locateAt(analysis, x, y) {
  x = Math.floor(Number(x));
  y = Math.floor(Number(y));
  const { crop, index } = analysis;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { kind: 'invalid' };
  if (x < crop.x0 || x >= crop.x1 || y < crop.y0 || y >= crop.y1) {
    return { kind: 'outside-crop', x, y };
  }

  const fgRow = index.fgRows.get(y);
  if (fgRow) {
    const r = findRunAtX(fgRow, x);
    if (r) {
      return { kind: 'foreground', number: index.runCompNumber[r.node], x, y };
    }
  }

  const li = y - crop.y0;
  const s = index.rowStart[li];
  const e = index.rowStart[li + 1];
  // 背景段同样升序不交，二分定位。
  let lo = s;
  let hi = e - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (x < index.bgX0[mid]) hi = mid - 1;
    else if (x >= index.bgX1[mid]) lo = mid + 1;
    else {
      found = mid;
      break;
    }
  }
  if (found >= 0) {
    const holeNumber = index.bgHoleNumber[found];
    if (holeNumber > 0) return { kind: 'hole', number: holeNumber, x, y };
    return { kind: 'external', x, y };
  }
  // 理论上不可达：每行整行都被前景或背景段覆盖。
  return { kind: 'external', x, y };
}

// 跨裁区跟踪一个探针点：在新裁区结果里它仍是孔、已通外部还是落到裁区外。
function trackProbe(analysis, probe) {
  if (!probe) return { status: 'none' };
  const loc = locateAt(analysis, probe.x, probe.y);
  if (loc.kind === 'outside-crop') return { status: 'outside', ...loc };
  if (loc.kind === 'hole') {
    const hole = analysis.holes[loc.number - 1];
    return { status: 'hole', number: loc.number, hole, ...loc };
  }
  if (loc.kind === 'external') return { status: 'external', ...loc };
  if (loc.kind === 'foreground') return { status: 'foreground', ...loc };
  return { status: 'invalid' };
}

// ---------- 导出 ----------

// 构造可直接 JSON.stringify 的导出对象：
// 裁区内规范横段（原图坐标）+ 完整标量统计；组件/孔明细放在顶层数组。
function buildExport(analysis) {
  return {
    format: 'run-mask-crop@1',
    coordinateSystem: 'original-image',
    width: analysis.width,
    height: analysis.height,
    crop: { ...analysis.crop },
    runs: analysis.runs.map((r) => [r[0], r[1], r[2]]),
    stats: { ...analysis.stats },
    components: analysis.components.map((c) => ({
      number: c.number,
      area: c.area,
      perimeter: c.perimeter,
      runCount: c.runCount,
      bbox: c.bbox,
      anchor: c.anchor,
    })),
    holes: analysis.holes.map((h) => ({
      number: h.number,
      area: h.area,
      runCount: h.runCount,
      bbox: h.bbox,
      anchor: h.anchor,
    })),
  };
}

// 确定性 JSON：不含时间戳等易变字段，便于“改裁区再改回”逐字符比对。
function exportJSON(analysis, indent = 2) {
  return JSON.stringify(buildExport(analysis), null, indent);
}

const RunMaskTopology = {
  LIMITS,
  MaskFormatError,
  parseMask,
  mergeIntervals,
  normalizeCrop,
  analyzeMask,
  locateAt,
  trackProbe,
  buildExport,
  exportJSON,
};

if (typeof globalThis !== 'undefined') {
  globalThis.RunMaskTopology = RunMaskTopology;
}
// 直接对象字面量导出，保证 Node ESM 命名导入可被 cjs-module-lexer 静态识别。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LIMITS,
    MaskFormatError,
    parseMask,
    mergeIntervals,
    normalizeCrop,
    analyzeMask,
    locateAt,
    trackProbe,
    buildExport,
    exportJSON,
  };
}

