#!/usr/bin/env node
/* 用 Node worker_threads 模拟浏览器 Web Worker，验证 worker-sdt.js 的消息路径。
 * worker-sdt.js 依赖 importScripts/self/postMessage，这里用 shim 注入。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Core = require(path.join(__dirname, '..', 'js', 'sdt-core.js'));

const ROOT = path.join(__dirname, '..');

if (!isMainThread) {
  // ---- worker 内：构造浏览器全局 shim，再求值 worker-sdt.js ----
  globalThis.self = globalThis; // worker-sdt.js 用 self.postMessage / self.onmessage
  globalThis.postMessage = (msg, _transfer) => parentPort.postMessage(msg);
  globalThis.importScripts = (rel) => {
    // 浏览器中 worker-sdt.js 位于 js/，importScripts('./sdt-core.js') 相对 js/ 解析
    const target = rel.startsWith('./') ? path.join(ROOT, 'js', rel) : path.join(ROOT, rel);
    const code = fs.readFileSync(target, 'utf8');
    (0, eval)(code); // 注入 SDTCore 到 worker 全局
  };
  parentPort.on('message', (m) => globalThis.onmessage({ data: m }));
  const workerCode = fs.readFileSync(path.join(ROOT, 'js', 'worker-sdt.js'), 'utf8');
  (0, eval)(workerCode);
  return;
}

// ---- 主线程 ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const W = 64, H = 48, sx = 2, sy = 3, wrap = true;
  const rng = mulberry32(777);
  const seeds = [];
  const occ = new Set();
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (rng() < 0.12) {
      const lab = 1 + Math.floor(rng() * 5);
      const key = r * W + c;
      if (!occ.has(key)) { occ.add(key); seeds.push([c, r, lab]); }
    }
  }
  const coordMap = new Map();
  for (const [c, r, l] of seeds) {
    if (!coordMap.has(l)) coordMap.set(l, []);
    coordMap.get(l).push(c, r);
  }
  const typed = new Map([...coordMap].map(([l, a]) => [l, Int32Array.from(a)]));
  const labels = [...typed.keys()].sort((a, b) => a - b);

  // 参考：单线程全量
  const ref = Core.runLabels(W, H, typed, labels, sx, sy, wrap, null);

  // 分成 3 个 worker
  const chunks = [[], [], []];
  labels.forEach((l, i) => chunks[i % 3].push(l));
  const partials = await Promise.all(chunks.map((labelIds, ci) => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { ci } });
    const sub = new Map();
    for (const id of labelIds) sub.set(id, typed.get(id));
    w.on('message', (m) => {
      if (m.type === 'done') { w.terminate(); resolve(m.partial); }
    });
    w.on('error', reject);
    w.postMessage({ W, H, labelIds, coordsByLabel: sub, sx, sy, wrap, jobId: ci });
  })));

  const merged = Core.mergePartials(W, H, partials);
  let fails = 0;
  for (let p = 0; p < W * H; p++) {
    for (const f of ['d1', 'd2', 'l1', 'l2', 'r1', 'c1', 'r2', 'c2']) {
      if (merged[f][p] !== ref[f][p]) { if (fails < 5) console.log('MISMATCH', f, p, merged[f][p], ref[f][p]); fails++; }
    }
  }
  if (fails) { console.log(`FAIL worker 路径 ${fails}`); process.exit(1); }
  console.log(`OK worker_threads 并行（3 worker × ${labels.length} 标签）合并结果与单线程完全一致`);
}

main().catch(e => { console.error(e); process.exit(1); });
