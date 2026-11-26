/* compute.js — 主线程计算编排：worker 池并行、单线程回退、P5 导出 */
'use strict';

function makeCoordMap(seedGrid, width) {
  // seedGrid: Uint8Array(WH)，每格 0 或标签 1..32；width 为每行格数
  const map = new Map();
  const n = seedGrid.length;
  for (let p = 0; p < n; p++) {
    const lab = seedGrid[p];
    if (lab === 0) continue;
    if (!map.has(lab)) map.set(lab, []);
    map.get(lab).push(p % width, (p / width) | 0);
  }
  const out = new Map();
  for (const [lab, arr] of map) out.set(lab, Int32Array.from(arr));
  return out;
}

function chunkLabels(labels, nChunks) {
  const chunks = Array.from({ length: nChunks }, () => []);
  labels.forEach((lab, i) => { chunks[i % nChunks].push(lab); });
  return chunks.filter(c => c.length > 0);
}

// 单线程回退（file:// 或 worker 不可用时）
function computeSingle(W, H, coordMap, sx, sy, wrap, onProgress) {
  const ids = [...coordMap.keys()];
  return SDTCore.runLabels(W, H, coordMap, ids, sx, sy, wrap, onProgress);
}

function computeParallel(W, H, coordMap, sx, sy, wrap, nWorkers, onProgress) {
  return new Promise((resolve, reject) => {
    const labels = [...coordMap.keys()].sort((a, b) => a - b);
    const chunks = chunkLabels(labels, nWorkers);
    const partials = new Array(chunks.length);
    let doneChunks = 0;
    let totalLabels = labels.length;
    let doneLabels = 0;
    let finished = false;

    // 可转移给 worker 的坐标（Map 结构化克隆即可，TypedArray 自动拷贝）
    const workers = [];
    const fail = (err) => {
      if (finished) return;
      finished = true;
      workers.forEach(w => w.terminate());
      reject(err);
    };

    chunks.forEach((labelIds, ci) => {
      const w = new Worker('./js/worker-sdt.js');
      workers.push(w);
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') {
          doneLabels++;
          onProgress && onProgress(doneLabels, totalLabels);
        } else if (m.type === 'done') {
          partials[ci] = m.partial;
          w.terminate();
          doneChunks++;
          if (doneChunks === chunks.length && !finished) {
            finished = true;
            const top = partials.length === 1
              ? partials[0]
              : SDTCore.mergePartials(W, H, partials);
            resolve(top);
          }
        }
      };
      w.onerror = (e) => fail(e.message || 'worker error');
      // 只传本批标签的坐标，减少克隆量
      const sub = new Map();
      for (const id of labelIds) sub.set(id, coordMap.get(id));
      w.postMessage({
        W, H, labelIds, coordsByLabel: sub, sx, sy, wrap, jobId: ci,
      });
    });
  });
}

// 统一入口：优先 worker，失败回退单线程
async function runCompute(W, H, seedGrid, params, onProgress) {
  const { sx, sy, wrap } = params;
  const coordMap = makeCoordMap(seedGrid, W);
  if (coordMap.size === 0) {
    const n = W * H;
    return {
      d1: new Uint32Array(n).fill(SDTCore.INF),
      d2: new Uint32Array(n).fill(SDTCore.INF),
      l1: new Uint8Array(n), l2: new Uint8Array(n),
      r1: new Int32Array(n).fill(-1), c1: new Int32Array(n).fill(-1),
      r2: new Int32Array(n).fill(-1), c2: new Int32Array(n).fill(-1),
    };
  }
  const nWorkers = Math.min(
    (navigator.hardwareConcurrency || 4),
    coordMap.size,
    8
  );
  let workersSupported = typeof Worker !== 'undefined';
  if (workersSupported && nWorkers > 1) {
    try {
      return await computeParallel(W, H, coordMap, sx, sy, wrap, nWorkers, onProgress);
    } catch (e) {
      console.warn('Worker 并行失败，回退单线程：', e);
    }
  }
  return computeSingle(W, H, coordMap, sx, sy, wrap, onProgress);
}

// P5 二进制 PGM 导出：magic "P5\n"，宽 高，最大样值 32，每像素一个原始标签字节
function buildP5(W, H, labels) {
  const header = new TextEncoder().encode(`P5\n${W} ${H}\n32\n`);
  const out = new Uint8Array(header.length + labels.length);
  out.set(header, 0);
  out.set(labels, header.length);
  return out;
}

window.LMarginCompute = { runCompute, buildP5, makeCoordMap };
