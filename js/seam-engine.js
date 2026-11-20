// 缝线裁剪核心引擎。口径严格按 samples 内 约定.json：
//  能量：线性 RGB 亮度 L=0.2126R+0.7152G+0.0722B；
//        E=|L(x+1,y)-L(x-1,y)|+|L(x,y+1)-L(x,y-1)|，边界坐标夹取；保护像素代价为 +∞。
//  路径：竖缝每行一个像素、相邻列差 ≤1；累计代价相同时前驱取最小列，终点取最小列；
//        水平缝按转置执行；每次删除后重算能量。
//  扩图：单批 ≤ 当前轴长-1；在缩小副本上逐条删除并跟踪原坐标；
//        每条缝在原像素后插入一个像素（与原右邻线性 RGB 均值，右边界复制自身），
//        插入保护值取两邻逻辑或；发现不足则提交已找到的缝并停止。
//
// 图像结构：{ width, height, rgb: Uint8Array(3*w*h), mask: Uint8Array(w*h) }

export const LR = 0.2126, LG = 0.7152, LB = 0.0722;
export const INF = Infinity;

export function makeImage(width, height, rgb, mask) {
  return {
    width,
    height,
    rgb: rgb ?? new Uint8Array(width * height * 3),
    mask: mask ?? new Uint8Array(width * height),
  };
}

export function cloneImage(img) {
  return makeImage(img.width, img.height, img.rgb.slice(), img.mask.slice());
}

function luminanceAt(rgb, w, h, x, y) {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
  const i = (cy * w + cx) * 3;
  return LR * rgb[i] + LG * rgb[i + 1] + LB * rgb[i + 2];
}

/** 计算能量图（竖缝口径；水平缝先转置再调用）。保护像素为 +∞。 */
export function computeEnergy(img) {
  const { width: w, height: h, rgb, mask } = img;
  const E = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 0) {
        E[y * w + x] = INF;
        continue;
      }
      const lx = luminanceAt(rgb, w, h, x - 1, y);
      const rx = luminanceAt(rgb, w, h, x + 1, y);
      const uy = luminanceAt(rgb, w, h, x, y - 1);
      const dy = luminanceAt(rgb, w, h, x, y + 1);
      E[y * w + x] = Math.abs(rx - lx) + Math.abs(dy - uy);
    }
  }
  return E;
}

/**
 * 动态规划寻找竖缝。
 * 平局规则：前驱列、终点列均取最小（按列升序扫描 + 严格小于即天然满足）。
 * @returns {{path:number[], cumulative:number}|null} path[y]=列号；无合法路径返回 null
 */
export function findVerticalSeam(E, w, h) {
  const M = new Float64Array(w * h);
  const back = new Int32Array(w * h).fill(-1);
  for (let x = 0; x < w; x++) M[x] = E[x];
  for (let y = 1; y < h; y++) {
    const row = y * w, prev = (y - 1) * w;
    for (let x = 0; x < w; x++) {
      const e = E[row + x];
      if (e === INF) { M[row + x] = INF; continue; }
      let best = INF, bestCol = -1;
      for (let px = Math.max(0, x - 1); px <= Math.min(w - 1, x + 1); px++) {
        const v = M[prev + px] + e;
        if (v < best) { best = v; bestCol = px; }
      }
      M[row + x] = best;
      back[row + x] = bestCol;
    }
  }
  let endCol = -1, endCost = INF;
  const lastRow = (h - 1) * w;
  for (let x = 0; x < w; x++) {
    if (M[lastRow + x] < endCost) { endCost = M[lastRow + x]; endCol = x; }
  }
  if (endCol === -1 || endCost === INF) return null;
  const path = new Int32Array(h);
  let col = endCol;
  for (let y = h - 1; y >= 0; y--) {
    path[y] = col;
    if (y > 0) col = back[y * w + col];
  }
  return { path: Array.from(path), cumulative: endCost };
}

/** 删除一条竖缝，返回新图（宽减 1）。 */
export function removeVerticalSeam(img, seam) {
  const { width: w, height: h, rgb, mask } = img;
  if (w < 2) throw new Error('宽度不足，无法删除竖缝');
  const nw = w - 1;
  const out = makeImage(nw, h, new Uint8Array(nw * h * 3), new Uint8Array(nw * h));
  for (let y = 0; y < h; y++) {
    const cut = seam[y];
    const srcRow = y * w, dstRow = y * nw;
    out.rgb.set(rgb.subarray(srcRow * 3, (srcRow + cut) * 3), dstRow * 3);
    out.rgb.set(rgb.subarray((srcRow + cut + 1) * 3, (srcRow + w) * 3), (dstRow + cut) * 3);
    out.mask.set(mask.subarray(srcRow, srcRow + cut), dstRow);
    out.mask.set(mask.subarray(srcRow + cut + 1, srcRow + w), dstRow + cut);
  }
  return out;
}

/** 转置（用于水平缝）。 */
export function transpose(img) {
  const { width: w, height: h, rgb, mask } = img;
  const t = makeImage(h, w, new Uint8Array(h * w * 3), new Uint8Array(h * w));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * w + x, d = x * h + y;
      t.rgb[d * 3] = rgb[s * 3];
      t.rgb[d * 3 + 1] = rgb[s * 3 + 1];
      t.rgb[d * 3 + 2] = rgb[s * 3 + 2];
      t.mask[d] = mask[s];
    }
  }
  return t;
}

/** 转置坐标系中的点回原方向：转置图 (xT,yT) -> 原图 (x=yT, y=xT)。 */
function pointsBack(points) {
  return points.map(([xT, yT]) => [yT, xT]);
}

function seamToPoints(seam, w) {
  return seam.map((col, y) => [col, y]);
}

/**
 * 将工作副本（已删 prev 条缝）中的缝坐标映回批次原图坐标。
 * 规则：工作列 c 对应原图列 c +（此前原图列 ≤ c 的缝数）。
 */
export function mapSeamToSource(workSeam, previousSourceSeams) {
  return workSeam.map((c, y) => {
    let src = c;
    for (const ps of previousSourceSeams) {
      if (ps[y] <= src) src++;
    }
    return src;
  });
}

/**
 * 在批次原图 src 上按若干条（原图坐标的）竖缝插入新像素。
 * 新像素取原像素与原右邻的线性 RGB 均值（右边界复制自身）；
 * 掩膜插入值为两邻保护状态的逻辑或。
 * 导出供单元测试直接验证插入口径。
 */
export function insertVerticalSeams(src, sourceSeams) {
  const { width: w, height: h, rgb, mask } = src;
  const m = sourceSeams.length;
  const nw = w + m;
  const out = makeImage(nw, h, new Uint8Array(nw * h * 3), new Uint8Array(nw * h));
  for (let y = 0; y < h; y++) {
    const counts = new Int32Array(w); // 每行、每个原列后的插入数（允许重复列）
    for (const s of sourceSeams) counts[s[y]]++;
    let o = 0;
    const srcRow = y * w, dstRow = y * nw;
    for (let x = 0; x < w; x++) {
      const si = (srcRow + x) * 3;
      const di = (dstRow + o) * 3;
      out.rgb[di] = rgb[si];
      out.rgb[di + 1] = rgb[si + 1];
      out.rgb[di + 2] = rgb[si + 2];
      out.mask[dstRow + o] = mask[srcRow + x];
      o++;
      for (let k = 0; k < counts[x]; k++) {
        const ni = (dstRow + o) * 3;
        if (x === w - 1) {
          // 右边界：复制自身
          out.rgb[ni] = rgb[si];
          out.rgb[ni + 1] = rgb[si + 1];
          out.rgb[ni + 2] = rgb[si + 2];
          out.mask[dstRow + o] = mask[srcRow + x];
        } else {
          const ri = (srcRow + x + 1) * 3;
          out.rgb[ni] = Math.round((rgb[si] + rgb[ri]) / 2);
          out.rgb[ni + 1] = Math.round((rgb[si + 1] + rgb[ri + 1]) / 2);
          out.rgb[ni + 2] = Math.round((rgb[si + 2] + rgb[ri + 2]) / 2);
          out.mask[dstRow + o] =
            mask[srcRow + x] !== 0 || mask[srcRow + x + 1] !== 0 ? 255 : 0;
        }
        o++;
      }
    }
  }
  return out;
}

/**
 * 竖缝扩图一个批次。
 * @returns {{image, found, requested, discoverEvents, applyEvent}}
 */
function expandVerticalBatch(src, requested, axis, batchIndex, seamIndexBase) {
  const work = cloneImage(src);
  const sourceSeams = [];
  const discoverEvents = [];
  let stopReason = null;
  for (let k = 0; k < requested; k++) {
    const E = computeEnergy(work);
    const found = findVerticalSeam(E, work.width, work.height);
    if (!found) { stopReason = 'no-legal-path'; break; }
    const sourceSeam = mapSeamToSource(found.path, sourceSeams);
    discoverEvents.push({
      kind: 'expand-discover',
      axis,
      batch: batchIndex,
      index: seamIndexBase + k,
      width: work.width,
      height: work.height,
      cumulative: found.cumulative,
      seam: axis === 'x'
        ? seamToPoints(found.path)
        : pointsBack(seamToPoints(found.path)),
    });
    sourceSeams.push(sourceSeam);
    const removed = removeVerticalSeam(work, found.path);
    work.rgb = removed.rgb;
    work.mask = removed.mask;
    work.width = removed.width;
  }
  const image = sourceSeams.length ? insertVerticalSeams(src, sourceSeams) : cloneImage(src);
  const applyEvent = {
    kind: 'expand-apply',
    axis,
    batch: batchIndex,
    startWidth: src.width,
    startHeight: src.height,
    endWidth: image.width,
    endHeight: image.height,
    requested,
    found: sourceSeams.length,
    stopReason,
    seams: sourceSeams.map((s) =>
      axis === 'x' ? seamToPoints(s) : pointsBack(seamToPoints(s))),
  };
  return { image, found: sourceSeams.length, requested, discoverEvents, applyEvent, stopReason };
}

/**
 * 执行一次完整用户操作（两个轴按 order 顺序处理）。
 * @returns 结果图像、逐步事件 trace、实际完成量与停止原因
 */
export function runOperation(sourceImg, targetWidth, targetHeight, order) {
  const trace = [];
  let cur = cloneImage(sourceImg);
  let stopReason = null;
  const applied = { x: 0, y: 0 };
  const axes = order === 'width-first' ? ['x', 'y'] : ['y', 'x'];
  let seamCounter = 0;

  for (const axis of axes) {
    if (stopReason) break;
    const curLen = axis === 'x' ? cur.width : cur.height;
    const target = axis === 'x' ? targetWidth : targetHeight;
    if (target === curLen) continue;

    if (target < curLen) {
      // 缩：逐条寻缝删除，每次重算能量
      const need = curLen - target;
      let done = 0;
      while (done < need) {
        const frame = axis === 'x' ? cur : transpose(cur);
        const E = computeEnergy(frame);
        const found = findVerticalSeam(E, frame.width, frame.height);
        if (!found) { stopReason = 'no-legal-path'; break; }
        trace.push({
          kind: 'shrink',
          axis,
          index: seamCounter++,
          width: cur.width,
          height: cur.height,
          cumulative: found.cumulative,
          seam: axis === 'x'
            ? seamToPoints(found.path)
            : pointsBack(seamToPoints(found.path)),
        });
        const removed = removeVerticalSeam(frame, found.path);
        cur = axis === 'x' ? removed : transpose(removed);
        done++;
        applied[axis]++;
      }
    } else {
      // 扩：分批，每批在缩小副本上发现、映回批次原图插入
      let remaining = target - curLen;
      let batchIndex = 0;
      while (remaining > 0) {
        const requested = Math.min(remaining, cur.width - 1);
        const oriented = axis === 'x' ? cur : transpose(cur);
        const batch = expandVerticalBatch(oriented, requested, axis, batchIndex, seamCounter);
        for (const ev of batch.discoverEvents) trace.push(ev);
        trace.push(batch.applyEvent);
        seamCounter += batch.found;
        cur = axis === 'x' ? batch.image : transpose(batch.image);
        applied[axis] += batch.found;
        remaining -= batch.found;
        batchIndex++;
        if (batch.found < requested) { stopReason = batch.stopReason || 'no-legal-path'; break; }
      }
    }
  }

  return {
    image: cur,
    trace,
    applied,
    requested: {
      x: targetWidth - sourceImg.width,
      y: targetHeight - sourceImg.height,
    },
    stopReason,
  };
}

/**
 * 供逐步查看使用：按指定轴计算当前图的能量图，返回原方向坐标的 Float64Array。
 * 水平轴先转置计算再映回。
 */
export function energyForAxis(img, axis) {
  if (axis === 'x') return { energy: computeEnergy(img), width: img.width, height: img.height };
  const t = transpose(img);
  const et = computeEnergy(t); // t 的尺寸为 h(原) 宽 × w(原) 高
  const { width: w, height: h } = img;
  const e = new Float64Array(w * h);
  // 转置图坐标 (xT,yT) 对应原图 (x=yT, y=xT)，即 et[yT*t.width+xT] -> e[xT*w+yT]
  for (let xT = 0; xT < t.height; xT++) {
    for (let yT = 0; yT < t.width; yT++) {
      e[xT * w + yT] = et[yT * t.width + xT];
    }
  }
  return { energy: e, width: w, height: h };
}
