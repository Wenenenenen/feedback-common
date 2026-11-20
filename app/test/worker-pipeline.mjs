// test/worker-pipeline.mjs — 复刻 worker.mjs 的分批管线（不含 postMessage），
// 验证逐像素分片 + 帧间递推的结果与全量 reprojectSequence 完全一致。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateSequence, clampParams, computePixelDebug, reprojectSequence, Reason,
} from '../src/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'sample-data');

function pipeline(seq, params) {
  const check = validateSequence(seq);
  seq._meta = check;
  const n = check.pixelCount;
  const F = seq.frames.length;
  const CHUNK = 1024;
  let prevColor = new Float64Array(n * 3);
  let prevCount = new Int32Array(n);
  const results = [];
  for (let fi = 0; fi < F; fi++) {
    const frame = seq.frames[fi];
    const color = new Float64Array(n * 3);
    const count = new Int32Array(n);
    const reason = new Uint8Array(n);
    if (fi === 0) {
      for (let p = 0; p < n; p++) {
        const c = frame.color[p];
        color[p * 3] = c[0]; color[p * 3 + 1] = c[1]; color[p * 3 + 2] = c[2];
        count[p] = 1;
        reason[p] = (frame.depth[p] === null || frame.depth[p] === undefined)
          ? Reason.DEPTH_NULL : Reason.FIRST_FRAME;
      }
    } else {
      // 显式分片循环（与 worker doChunk 同构）
      let p = 0;
      while (p < n) {
        const end = Math.min(n, p + CHUNK);
        for (; p < end; p++) {
          const x = p % seq.width;
          const y = (p - x) / seq.width;
          const dbg = computePixelDebug(seq, fi, x, y, prevColor, prevCount, params);
          color[p * 3] = dbg.outputColor[0];
          color[p * 3 + 1] = dbg.outputColor[1];
          color[p * 3 + 2] = dbg.outputColor[2];
          count[p] = dbg.count;
          reason[p] = dbg.reason;
        }
      }
    }
    results.push({ color, count, reason });
    prevColor = new Float64Array(color);
    prevCount = new Int32Array(count);
  }
  return results;
}

let fails = 0;
for (const [file, params] of [
  ['three-pixels.json', { tau: 0.05, historyWeight: 0.9, cap: 8 }],
  ['moving.json', { tau: 0.05, historyWeight: 0.9, cap: 8 }],
  ['capacity.json', { tau: 0.2, historyWeight: 0.5, cap: 3 }],
]) {
  const seq = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
  const p = clampParams(params);
  const full = reprojectSequence(structuredClone(seq), p);
  const chunked = pipeline(structuredClone(seq), p);
  let diff = 0;
  for (let fi = 0; fi < full.frames.length; fi++) {
    const a = full.frames[fi], b = chunked[fi];
    for (let i = 0; i < a.color.length; i++) {
      if (a.color[i] !== b.color[i]) { if (diff < 5) console.error(`color diff ${file} f${fi} i${i}: ${a.color[i]} vs ${b.color[i]}`); diff++; }
    }
    for (let i = 0; i < a.count.length; i++) {
      if (a.count[i] !== b.count[i]) { if (diff < 5) console.error(`count diff ${file} f${fi} i${i}`); diff++; }
      if (a.reason[i] !== b.reason[i]) { if (diff < 5) console.error(`reason diff ${file} f${fi} i${i}`); diff++; }
    }
  }
  if (diff) { console.error(`✗ ${file}: ${diff} 处不符`); fails++; }
  else console.log(`✓ ${file}: 分批管线与全量计算一致（${full.frames.length} 帧）`);
}
process.exit(fails ? 1 : 0);
