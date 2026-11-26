/*
 * flow-inbetween-review 纯逻辑引擎
 *
 * 规则来源：samples 内 format.txt
 *  - 位移单位 1/8 像素；z=0 表示无深度，跳过
 *  - 往返检查：沿整条位移到另一帧，floor(坐标+0.5) 选最近像素；
 *    越界、对方 z=0、或任一轴两侧有符号位移相加绝对值 > 8 单位 => 未通过
 *  - 档位 n∈[1,63]，t=n/64；a 投影 p+t*f/8，b 投影 p+(1-t)*f/8
 *  - 双线性投到四邻，时间权重 a:1-t / b:t，忽略零权重与越界
 *  - 目的像素先找最小非零深度 zmin，再在 [zmin, zmin+容差] 内
 *    优先保留全部往返通过者，没有通过者才保留该层全部未通过者
 *  - RGB 按贡献权重归一化加权平均，就近取整，半整数取较大值
 *  - 空洞补色：补洞前曼哈顿距离最近的非空像素，同距取行列号最小；全空黑
 *
 * 本文件不依赖 DOM，可直接在 Node 中 require，也由 build 脚本内联进网页。
 */
'use strict';

const PASS_BIT = 0x80000000;
const IDX_MASK = 0x7fffffff;

/* ---------------- PPM / BIN 严格解析 ---------------- */

/**
 * 严格解析 8 位 P6：
 *   必须为 P6\n 、十进制宽 + 空格 + 高 + \n、255 + \n，随后恰好 W*H*3 字节。
 * 任何不符抛出带文件名的 Error。
 */
function parsePPM(bytes, fileName) {
  const name = fileName || 'PPM';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const fail = (msg) => { throw new Error(`${name}: ${msg}`); };

  if (u.length < 2 || u[0] !== 0x50 /* P */ || u[1] !== 0x36 /* 6 */) {
    fail('不是 P6 格式');
  }
  let i = 2;
  if (u[i] !== 0x0a) fail('文件头必须为 P6 后紧跟换行');
  i += 1;

  const readNum = () => {
    let v = 0;
    let any = false;
    while (i < u.length && u[i] >= 0x30 && u[i] <= 0x39) {
      v = v * 10 + (u[i] - 0x30);
      if (v > 0x7fffffff) fail('尺寸数值过大');
      any = true;
      i += 1;
    }
    if (!any) fail('文件头缺少十进制数值');
    return v;
  };

  const width = readNum();
  if (u[i] !== 0x20) fail('宽高之间必须是单个空格');
  i += 1;
  const height = readNum();
  if (u[i] !== 0x0a) fail('高度后必须是换行');
  i += 1;
  const maxVal = readNum();
  if (maxVal !== 255) fail(`仅支持 8 位最大值 255，读到 ${maxVal}`);
  if (u[i] !== 0x0a) fail('最大值 255 后必须是换行');
  i += 1;
  const headerLen = i;

  if (width < 1 || height < 1) fail('宽、高各至少为 1');
  const need = width * height * 3;
  const got = u.length - headerLen;
  if (got < need) {
    fail(`数据截断：需要 ${need} 字节 RGB，实际只剩 ${got} 字节`);
  }
  if (got > need) {
    fail(`数据多余：声明 ${width}×${height} 应含 ${need} 字节，实际 ${got} 字节`);
  }
  const rgb = u.slice(headerLen, headerLen + need);
  return { width, height, rgb, header: u.slice(0, headerLen) };
}

/**
 * 解析无头 BIN：栅格顺序 6 字节小端记录 int16 dx, int16 dy, uint16 z。
 * 记录数必须与像素数一致。
 */
function parseBIN(bytes, width, height, fileName) {
  const name = fileName || 'BIN';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = width * height;
  if (u.length !== n * 6) {
    throw new Error(
      `${name}: 尺寸错配/截断：${width}×${height} 应有 ${n * 6} 字节，实际 ${u.length} 字节`
    );
  }
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const dx = new Int16Array(n);
  const dy = new Int16Array(n);
  const z = new Uint16Array(n);
  let o = 0;
  for (let k = 0; k < n; k += 1, o += 6) {
    dx[k] = dv.getInt16(o, true);
    dy[k] = dv.getInt16(o + 2, true);
    z[k] = dv.getUint16(o + 4, true);
  }
  return { dx, dy, z };
}

/**
 * 成组载入并交叉校验。任何一项失败都抛出，调用方负责保留上一次画面。
 * files: { aPPM, bPPM, aBIN, bBIN }，每项 { name, bytes }
 */
function loadDataset(files) {
  const a = parsePPM(files.aPPM.bytes, files.aPPM.name);
  const b = parsePPM(files.bPPM.bytes, files.bPPM.name);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `尺寸错配：${files.aPPM.name} 为 ${a.width}×${a.height}，` +
      `${files.bPPM.name} 为 ${b.width}×${b.height}`
    );
  }
  const W = a.width;
  const H = a.height;
  const fa = parseBIN(files.aBIN.bytes, W, H, files.aBIN.name);
  const fb = parseBIN(files.bBIN.bytes, W, H, files.bBIN.name);
  return {
    width: W,
    height: H,
    rgbA: a.rgb,
    rgbB: b.rgb,
    flowA: fa,
    flowB: fb,
    names: {
      aPPM: files.aPPM.name,
      bPPM: files.bPPM.name,
      aBIN: files.aBIN.name,
      bBIN: files.bBIN.name,
    },
  };
}

/* ---------------- 往返检查 ---------------- */

/**
 * 逐像素往返通过标志（Uint8Array，1=通过）。自身 z=0 不算通过。
 */
function computeRoundTrip(flowSelf, flowOther, W, H) {
  const n = W * H;
  const pass = new Uint8Array(n);
  const { dx, dy, z } = flowSelf;
  for (let p = 0; p < n; p += 1) {
    if (z[p] === 0) continue;
    const px = p % W;
    const py = (p - px) / W;
    // floor(坐标 + 0.5) 选最近像素；位移单位 1/8
    const fx = px + dx[p] / 8;
    const fy = py + dy[p] / 8;
    const qx = Math.floor(fx + 0.5);
    const qy = Math.floor(fy + 0.5);
    if (qx < 0 || qx >= W || qy < 0 || qy >= H) continue;
    const q = qy * W + qx;
    if (flowOther.z[q] === 0) continue;
    if (Math.abs(dx[p] + flowOther.dx[q]) > 8) continue;
    if (Math.abs(dy[p] + flowOther.dy[q]) > 8) continue;
    pass[p] = 1;
  }
  return pass;
}

/* ---------------- 核心渲染 ---------------- */

/**
 * 曼哈顿距离补洞（两遍精确距离变换）。
 * 非空 = head[d] !== -1（投影后有任意贡献，与最终分类无关）。
 * 同距按行优先线性索引（即行列号最小）择优；全空 label 保持 -1。
 */
function fillHoles(head, W, H) {
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const dist = new Int32Array(N).fill(0x7fffffff);
  for (let d = 0; d < N; d += 1) {
    if (head[d] !== -1) {
      label[d] = d;
      dist[d] = 0;
    }
  }
  const relax = (d, nb) => {
    if (label[nb] < 0) return;
    const nd = dist[nb] + 1;
    if (nd < dist[d] || (nd === dist[d] && label[nb] < label[d])) {
      dist[d] = nd;
      label[d] = label[nb];
    }
  };
  // 前向：上、左
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      const d = row + x;
      if (dist[d] === 0) continue;
      if (y > 0) relax(d, d - W);
      if (x > 0) relax(d, d - 1);
    }
  }
  // 反向：下、右
  for (let y = H - 1; y >= 0; y -= 1) {
    const row = y * W;
    for (let x = W - 1; x >= 0; x -= 1) {
      const d = row + x;
      if (dist[d] === 0) continue;
      if (y + 1 < H) relax(d, d + W);
      if (x + 1 < W) relax(d, d + 1);
    }
  }
  return { label, dist };
}

/**
 * 渲染一个中间档。n∈[1,63]，t=n/64。
 * 返回带分类、补洞来源和贡献链表的完整结果，供预览与点选共用。
 */
function renderFrame(ds, n, tolerance, passes) {
  const W = ds.width;
  const H = ds.height;
  const N = W * H;
  const t = n / 64;
  const oneMinusT = 1 - t;
  const tol = Math.max(0, Math.min(65535, tolerance | 0));

  const passA = passes.passA;
  const passB = passes.passB;

  // 贡献以链表挂在目的像素上。每条贡献：
  //   cSrc[k]  高位置 PASS_BIT，低 31 位为源像素索引
  //   cSide[k] 0=来自 a，1=来自 b
  //   cZ[k]    源深度（非零）
  //   cW[k]    总权重 = 双线性系数 × 时间权重
  //   cNext[k] 链表下一项
  const cap = N * 8 + 16;
  const cSrc = new Uint32Array(cap);
  const cSide = new Uint8Array(cap);
  const cZ = new Uint16Array(cap);
  const cW = new Float64Array(cap);
  const cNext = new Int32Array(cap);
  const head = new Int32Array(N).fill(-1);
  let count = 0;

  const pushContribution = (dst, srcIdx, side, zVal, w, ok) => {
    const k = count;
    cSrc[k] = (srcIdx & IDX_MASK) | (ok ? PASS_BIT : 0);
    cSide[k] = side;
    cZ[k] = zVal;
    cW[k] = w;
    cNext[k] = head[dst];
    head[dst] = k;
    count += 1;
  };

  const projectSide = (side) => {
    const flow = side === 0 ? ds.flowA : ds.flowB;
    const timeW = side === 0 ? oneMinusT : t;
    const pass = side === 0 ? passA : passB;
    const { dx, dy, z } = flow;
    for (let p = 0; p < N; p += 1) {
      if (z[p] === 0) continue; // 无深度，跳过
      const px = p % W;
      const py = (p - px) / W;
      // a: p + t*f/8 ；b: p + (1-t)*f/8
      const step = side === 0 ? t : oneMinusT;
      const fx = px + (dx[p] / 8) * step;
      const fy = py + (dy[p] / 8) * step;

      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const wx = [1 - ax, ax];
      const wy = [1 - ay, ay];

      for (let jy = 0; jy < 2; jy += 1) {
        const gy = y0 + jy;
        if (gy < 0 || gy >= H) continue;
        for (let jx = 0; jx < 2; jx += 1) {
          const gx = x0 + jx;
          if (gx < 0 || gx >= W) continue;
          const bilin = wx[jx] * wy[jy];
          if (bilin === 0) continue; // 忽略零权重
          const w = bilin * timeW;
          if (w === 0) continue;
          pushContribution(gy * W + gx, p, side, z[p], w, pass[p] === 1);
        }
      }
    }
  };

  projectSide(0);
  projectSide(1);

  // 目的像素汇总
  const out = new Uint8Array(N * 3);
  const cls = new Uint8Array(N);     // 1=通过者供色 2=仅未通过者供色
  const zMinArr = new Uint16Array(N);
  const fillSrc = new Int32Array(N).fill(-1);

  for (let d = 0; d < N; d += 1) {
    if (head[d] === -1) continue; // 空洞，稍后补
    let zmin = 65535;
    for (let k = head[d]; k !== -1; k = cNext[k]) {
      if (cZ[k] < zmin) zmin = cZ[k];
    }
    const zhi = Math.min(65535, zmin + tol);
    zMinArr[d] = zmin;

    // 该层是否存在往返通过贡献
    let hasPass = false;
    for (let k = head[d]; k !== -1; k = cNext[k]) {
      if (cZ[k] >= zmin && cZ[k] <= zhi && (cSrc[k] & PASS_BIT) !== 0) {
        hasPass = true;
        break;
      }
    }

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let wSum = 0;
    for (let k = head[d]; k !== -1; k = cNext[k]) {
      if (cZ[k] < zmin || cZ[k] > zhi) continue;
      if (hasPass && (cSrc[k] & PASS_BIT) === 0) continue;
      const src = cSrc[k] & IDX_MASK;
      const rgb = cSide[k] === 0 ? ds.rgbA : ds.rgbB;
      const o3 = src * 3;
      const w = cW[k];
      rSum += rgb[o3] * w;
      gSum += rgb[o3 + 1] * w;
      bSum += rgb[o3 + 2] * w;
      wSum += w;
    }

    const o3 = d * 3;
    // 归一化加权平均，就近取整，半整数取较大值（floor(v+0.5)）
    out[o3] = clamp255(Math.floor(rSum / wSum + 0.5));
    out[o3 + 1] = clamp255(Math.floor(gSum / wSum + 0.5));
    out[o3 + 2] = clamp255(Math.floor(bSum / wSum + 0.5));
    cls[d] = hasPass ? 1 : 2;
  }

  // 补洞：在补洞前的非空集合上求曼哈顿最近来源
  const { label } = fillHoles(head, W, H);
  for (let d = 0; d < N; d += 1) {
    if (head[d] !== -1) continue;
    const src = label[d];
    if (src < 0) {
      cls[d] = 4; // 全空黑色，out 已为零
      continue;
    }
    fillSrc[d] = src;
    const s3 = src * 3;
    const d3 = d * 3;
    // 复制该非空像素补好的颜色（其分类为 1/2 的结果色）
    out[d3] = out[s3];
    out[d3 + 1] = out[s3 + 1];
    out[d3 + 2] = out[s3 + 2];
    cls[d] = 3;
  }

  return {
    n,
    t,
    tolerance: tol,
    width: W,
    height: H,
    rgb: out,
    cls,
    zMin: zMinArr,
    fillSrc,
    // 贡献链表（点选用）
    _head: head,
    _cSrc: cSrc,
    _cSide: cSide,
    _cZ: cZ,
    _cW: cW,
    _cNext: cNext,
    _count: count,
  };
}

function clamp255(v) {
  return v > 255 ? 255 : v < 0 ? 0 : v;
}

/**
 * 点选：返回该像素的最小深度与供色来源明细。
 */
function inspectPixel(result, ds, x, y) {
  const W = result.width;
  const H = result.height;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const d = y * W + x;
  const c = result.cls[d];
  const base = {
    x,
    y,
    cls: c,
    rgb: [result.rgb[d * 3], result.rgb[d * 3 + 1], result.rgb[d * 3 + 2]],
  };
  if (result.endpoint) {
    return { ...base, endpoint: true, sideName: result.n === 0 ? 'a（前帧）' : 'b（后帧）' };
  }
  if (c === 3) {
    const s = result.fillSrc[d];
    return {
      ...base,
      fillFrom: { x: s % W, y: (s / W) | 0, index: s },
      note: '补洞像素：颜色复制自补洞前最近的非空像素（同距取行列号最小）',
    };
  }
  if (c === 4) {
    return { ...base, note: '全空：无任何非空像素可达，填黑' };
  }
  // c === 1 或 2：列出该目的像素全部贡献及深度层筛选情况
  const zmin = result.zMin[d];
  const zhi = Math.min(65535, zmin + result.tolerance);
  const items = [];
  let hasPassInLayer = false;
  for (let k = result._head[d]; k !== -1; k = result._cNext[k]) {
    const src = result._cSrc[k] & IDX_MASK;
    const side = result._cSide[k];
    const ok = (result._cSrc[k] & PASS_BIT) !== 0;
    const inLayer = result._cZ[k] >= zmin && result._cZ[k] <= zhi;
    if (inLayer && ok) hasPassInLayer = true;
    items.push({
      side,
      sideName: side === 0 ? 'a（前帧）' : 'b（后帧）',
      srcX: src % W,
      srcY: (src / W) | 0,
      z: result._cZ[k],
      weight: result._cW[k],
      pass: ok,
      inLayer,
    });
  }
  for (const it of items) {
    it.used = it.inLayer && (!hasPassInLayer || it.pass);
  }
  return { ...base, zmin, layerHigh: zhi, hasPassInLayer, contributors: items };
}

/* ---------------- 分类图与 PPM 编码 ---------------- */

const CLASS_NAMES = ['端点原图', '往返通过供色', '仅未通过供色', '补洞复制', '全空黑色'];

function encodePPM(rgb, W, H) {
  const header = strBytes(`P6\n${W} ${H}\n255\n`);
  return concatBytes([header, rgb]);
}

function encodeP5(cls, W, H) {
  const header = strBytes(`P5\n${W} ${H}\n255\n`);
  return concatBytes([header, cls]);
}

function strBytes(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  return Uint8Array.from(Array.from(s).map((ch) => ch.charCodeAt(0)));
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 端点帧：直接返回原帧与全 0 分类图（端点不做投影与补洞）。 */
function endpointFrame(ds, side) {
  const W = ds.width;
  const H = ds.height;
  const N = W * H;
  const rgb = (side === 0 ? ds.rgbA : ds.rgbB).slice();
  const cls = new Uint8Array(N);
  return {
    n: side === 0 ? 0 : 64,
    t: side === 0 ? 0 : 1,
    tolerance: null,
    width: W,
    height: H,
    rgb,
    cls,
    zMin: new Uint16Array(N),
    fillSrc: new Int32Array(N).fill(-1),
    endpoint: true,
  };
}

const api = {
  parsePPM,
  parseBIN,
  loadDataset,
  computeRoundTrip,
  renderFrame,
  fillHoles,
  inspectPixel,
  encodePPM,
  encodeP5,
  endpointFrame,
  CLASS_NAMES,
  PASS_BIT,
  IDX_MASK,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowEngine = api;
}
export {
  parsePPM,
  parseBIN,
  loadDataset,
  computeRoundTrip,
  renderFrame,
  fillHoles,
  inspectPixel,
  encodePPM,
  encodeP5,
  endpointFrame,
  CLASS_NAMES,
  PASS_BIT,
  IDX_MASK,
};
