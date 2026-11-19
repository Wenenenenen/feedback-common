#!/usr/bin/env node
/*
 * 用样例自带的 reference.json 校验核心算法。
 * 只做校验，不参与页面运行。
 *
 * 用法：node tools/validate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PCR = require('../js/core.js');


/* 直接从样例 ZIP 读 truth/*.png，避免把二进制缓存放进仓库 */
function readTruthZip(zipPath) {
  if (!fs.existsSync(zipPath)) return null;
  const d = fs.readFileSync(zipPath);
  const eocd = d.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = d.readUInt16LE(eocd + 10);
  const cdOff = d.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (d.readUInt32LE(p) !== 0x02014b50) break;
    const method = d.readUInt16LE(p + 10);
    const compSize = d.readUInt32LE(p + 20);
    const nameLen = d.readUInt16LE(p + 28);
    const extraLen = d.readUInt16LE(p + 30);
    const commentLen = d.readUInt16LE(p + 32);
    const localOff = d.readUInt32LE(p + 42);
    const name = d.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return function (id) {
    const name = 'truth/' + String(id).padStart(4, '0') + '.png';
    const e = entries.get(name);
    if (!e) return null;
    const lp = e.localOff;
    const start = lp + 30 + d.readUInt16LE(lp + 26) + d.readUInt16LE(lp + 28);
    const raw = d.subarray(start, start + e.compSize);
    return e.method === 0 ? raw : zlib.inflateRawSync(raw);
  };
}

/* 8 位灰度 PNG → 像素（样例里的 truth 都是无滤波灰度） */
function decodePngGray(buf) {
  let p = 8, ihdr = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const s = p + 8;
    if (type === 'IHDR') {
      ihdr = { w: buf.readUInt32BE(s), h: buf.readUInt32BE(s + 4), bitDepth: buf[s + 8], color: buf[s + 9] };
    } else if (type === 'IDAT') idat.push(buf.subarray(s, s + len));
    else if (type === 'IEND') break;
    p = s + len + 4;
  }
  if (!ihdr || ihdr.bitDepth !== 8) throw new Error('truth PNG 格式不符');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const w = ihdr.w, h = ihdr.h, stride = w * ch;
  const out = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), src = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    const cur = new Uint8Array(raw.subarray(src, src + stride));
    src += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) cur[x] = (cur[x] + a) & 255;
      else if (f === 2) cur[x] = (cur[x] + b) & 255;
      else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        cur[x] = (cur[x] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      out[y * w + x] = ch === 1 ? cur[x] : Math.round(0.299 * cur[x * ch] + 0.587 * cur[x * ch + 1] + 0.114 * cur[x * ch + 2]);
    }
    prev = cur;
  }
  return out;
}

const root = path.join(__dirname, '..');
const sampleJs = fs.readFileSync(path.join(root, 'data', 'sample.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', sampleJs)(sandbox.window);
const payload = sandbox.window.PCR_SAMPLE;
const raw = zlib.inflateSync(Buffer.from(payload.data, 'base64'));
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expected.json'), 'utf8'));

const W = payload.width, H = payload.height, N = payload.frameCount;
if (raw.length !== W * H * N) throw new Error(`payload size ${raw.length} != ${W * H * N}`);

const frames = [];
for (let i = 0; i < N; i++) {
  frames.push(new Uint8Array(raw.buffer, raw.byteOffset + i * W * H, W * H));
}

const t0 = Date.now();
const result = PCR.analyze({ frames, width: W, height: H });
const elapsed = Date.now() - t0;
console.log(`分析完成：${N} 帧，用时 ${elapsed} ms`);

let failures = 0;
function check(name, actual, expectedVal) {
  const ok = JSON.stringify(actual) === JSON.stringify(expectedVal);
  if (!ok) {
    failures++;
    console.log(`  ✗ ${name}: 期望 ${JSON.stringify(expectedVal)}，实际 ${JSON.stringify(actual)}`);
  }
  return ok;
}

/* ---- 每帧的场判定 ---- */
const exp = expected.fieldTruth;
const ref = expected.reference;
console.log('\n[1] 每帧上下场的来源与场序');
const cellsById = {};
result.cells.forEach(c => { cellsById[c.id] = c; });
let frameBad = 0;
for (let i = 0; i < N; i++) {
  const st = result.frameStates[i];
  const r = ref.frames[i];
  if (st === 'interlaced') {
    if (!r.interlaced) { frameBad++; console.log(`  ✗ 帧 ${i}: 判为隔行，参考为非隔行`); }
    continue;
  }
  const rep = result.fieldReports[i];
  const topCell = cellsById[rep.top.cellId];
  const botCell = cellsById[rep.bottom.cellId];
  const topTruth = r.top;
  const botTruth = r.bottom;
  const topHas = topTruth !== null && topCell.topFrames.some(f => exp.top[f] === topTruth);
  const botHas = botTruth !== null && botCell.botFrames.some(f => exp.bottom[f] === botTruth);
  const wantOrder = r.order;
  const gotOrder = result.orders[i] === 0 ? 'tff' : 'bff';
  const ok = topHas && botHas && wantOrder === gotOrder;
  if (!ok) {
    frameBad++;
    console.log(`  ✗ 帧 ${i}: 期望 ${JSON.stringify([topTruth, botTruth, wantOrder])}，还原 ${JSON.stringify([topCell.topFrames, botCell.botFrames, gotOrder])}`);
  }
}
console.log(frameBad === 0 ? '  全部通过' : `  ${frameBad} 帧不一致`);
failures += frameBad;

/* ---- 输出序列 ---- */
console.log('\n[2] 输出画面序列');
const outs = result.outputs;
if (outs.length !== ref.outputs.length) {
  console.log(`  ✗ 输出数量：期望 ${ref.outputs.length}，实际 ${outs.length}`);
  failures++;
}
let outBad = 0;
for (let i = 0; i < Math.min(outs.length, ref.outputs.length); i++) {
  const o = outs[i], r = ref.outputs[i];
  if (o.type === 'interlaced') {
    if (r.type !== 'interlaced' || r.frame !== o.sourceFrame) {
      outBad++; console.log(`  ✗ 输出 ${i}: 期望隔行帧 ${r.frame}，实际 ${o.sourceFrame}`);
    }
  } else {
    if (r.type !== 'film') { outBad++; console.log(`  ✗ 输出 ${i}: 期望 ${r.type}，实际 film`); continue; }
    const srcTop = o.topFrame !== null ? exp.top[o.topFrame] : null;
    const srcBot = o.bottomFrame !== null ? exp.bottom[o.bottomFrame] : null;
    const src = srcTop !== null ? srcTop : srcBot;
    if (src !== r.src) { outBad++; console.log(`  ✗ 输出 ${i}: 期望来源 ${r.src}，实际 ${src}`); }
    if (o.exact !== r.exact) { outBad++; console.log(`  ✗ 输出 ${i}: 期望 exact=${r.exact}，实际 ${o.exact}`); }
  }
}
console.log(outBad === 0 ? '  全部通过' : `  ${outBad} 处不一致`);
failures += outBad;

/* ---- 孤场 ---- */
console.log('\n[3] 孤场');
const detectedOrphans = result.orphans.map(o => exp.top[o.topFrame] ?? exp.bottom[o.bottomFrame]);
console.log('  检测到', JSON.stringify(detectedOrphans), '参考', JSON.stringify(ref.orphans));
if (JSON.stringify(detectedOrphans) !== JSON.stringify(ref.orphans)) failures++;

/* ---- 场序分段 ---- */
console.log('\n[4] 场序分段');
const orderRunsRef = [];
ref.frames.forEach((f, i) => {
  const o = f.order;
  if (orderRunsRef.length && orderRunsRef[orderRunsRef.length - 1].order === o) orderRunsRef[orderRunsRef.length - 1].end = i;
  else orderRunsRef.push({ start: i, end: i, order: o });
});
console.log('  实际', JSON.stringify(result.orderRuns));
console.log('  参考', JSON.stringify(orderRunsRef));
if (JSON.stringify(result.orderRuns) !== JSON.stringify(orderRunsRef)) failures++;

/* ---- 结构断点 / 节奏重锁 ---- */
console.log('\n[5] 节奏重新锁定点与结构断点');
const reLockFrames = result.reLock.map(r => `${r.frame}(${r.reason})`);
console.log('  ' + reLockFrames.join(', '));
const required = [89, 126];  // 换场序、进入隔行段
const got = new Set(result.reLock.map(r => r.frame));
const missing = required.filter(f => !got.has(f));
if (missing.length) { console.log(`  ✗ 缺少重锁点 ${missing.join(',')}`); failures += missing.length; }
else console.log('  换场序/隔行起点均已重锁');
const cadenceRuns = result.cadence.runs;
console.log('  3:2 节奏分段：' + cadenceRuns.map(r => `帧${r.startFrame}-${r.endFrame}(${r.firstSize}起,${r.mismatches}处不符)`).join(', '));

/* ---- 像素一致性 ---- */
console.log('\n[6] 精确输出像素与 truth 对比');
const truthFrames = {};
const truthZip = readTruthZip(path.join(root, 'samples', 'pulldown-cadence-restorer-cases.zip'));
function loadTruth(id) {
  if (truthFrames[id]) return truthFrames[id];
  if (!truthZip) return null;
  const buf = truthZip(id);
  if (!buf) return null;
  truthFrames[id] = decodePngGray(buf);
  return truthFrames[id];
}
let pixelChecked = 0, pixelBad = 0;
for (let i = 0; i < outs.length; i++) {
  const o = outs[i], r = ref.outputs[i];
  if (!o.exact || o.type !== 'film') continue;
  const truth = loadTruth(r.src);
  if (!truth) continue;
  const rendered = PCR.renderOutput({ frames, width: W, height: H }, result, o);
  let same = true;
  for (let k = 0; k < rendered.pixels.length; k++) {
    if (rendered.pixels[k] !== truth[k]) { same = false; break; }
  }
  pixelChecked++;
  if (!same) { pixelBad++; console.log(`  ✗ 输出 ${i}（来源 ${r.src}）像素不一致`); }
}
if (pixelChecked === 0) console.log('  （未找到 truth 缓存，跳过；运行 tools/build-truth-cache.sh 生成）');
else console.log(`  检查 ${pixelChecked} 个画面，${pixelBad} 个不一致`);
failures += pixelBad;

console.log('\n' + (failures === 0 ? '✓ 全部校验通过' : `✗ 共 ${failures} 处失败`));
process.exit(failures === 0 ? 0 : 1);
