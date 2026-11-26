#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const QG01 = require('../src/qg01-core.js');

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blockSSE(pixels, mask, n, x, y, s, v) {
  let d = 0;
  for (let yy = y; yy < y + s; yy++) {
    for (let xx = x; xx < x + s; xx++) {
      const i = yy * n + xx;
      if (!mask || mask[i]) {
        const e = pixels[i] - v;
        d += e * e;
      }
    }
  }
  return d;
}

function bestConstant(pixels, mask, n, x, y, s) {
  let best = { value: 0, dist: Infinity };
  for (let v = 0; v < 256; v++) {
    const dist = blockSSE(pixels, mask, n, x, y, s, v);
    if (dist < best.dist || (dist === best.dist && v < best.value)) best = { value: v, dist };
  }
  return best;
}

function rawPayload(pixels, n, x, y, s) {
  let body = 0n;
  for (let yy = 0; yy < s; yy++) {
    for (let xx = 0; xx < s; xx++) {
      body = (body << 8n) | BigInt(pixels[(y + yy) * n + x + xx]);
    }
  }
  // 前缀 01：最高两位为 0,1；整数本身不含前导 0。
  const code = (1n << BigInt(8 * s * s)) | body;
  return { bits: 2 + 8 * s * s, code };
}

function enumerateNode(pixels, mask, n, x, y, s) {
  const c = bestConstant(pixels, mask, n, x, y, s);
  const options = [{ kind: 'constant', bits: 10, dist: c.dist, code: BigInt(c.value) }];

  const raw = rawPayload(pixels, n, x, y, s);
  options.push({ kind: 'raw', bits: raw.bits, dist: 0, code: raw.code });

  if (s > 1) {
    const h = s / 2;
    const kids = [
      enumerateNode(pixels, mask, n, x, y, h),
      enumerateNode(pixels, mask, n, x + h, y, h),
      enumerateNode(pixels, mask, n, x, y + h, h),
      enumerateNode(pixels, mask, n, x + h, y + h, h),
    ];
    for (const a of kids[0]) for (const b of kids[1]) for (const cOpt of kids[2]) for (const d of kids[3]) {
      const ks = [a, b, cOpt, d];
      let bits = 1;
      let dist = 0;
      let body = 0n;
      for (const k of ks) {
        body = (body << BigInt(k.bits)) | k.code;
        bits += k.bits;
        dist += k.dist;
      }
      options.push({ kind: 'split', bits, dist, code: (1n << BigInt(bits - 1)) | body });
    }
  }
  return options;
}

function bruteBest(pixels, mask, n, budget) {
  const all = enumerateNode(pixels, mask, n, 0, 0, n);
  let best = null;
  for (const op of all) {
    if (op.bits > budget) continue;
    if (!best || op.dist < best.dist ||
        (op.dist === best.dist && op.bits < best.bits) ||
        (op.dist === best.dist && op.bits === best.bits && op.code < best.code)) {
      best = op;
    }
  }
  return best;
}

function randomImage(seed, n, maskMode) {
  const rand = mulberry32(seed);
  const pixels = new Uint8Array(n * n);
  const mask = new Uint8Array(n * n);
  for (let i = 0; i < pixels.length; i++) {
    const mode = seed % 3;
    if (mode === 0) pixels[i] = Math.floor(rand() * 256);
    else if (mode === 1) pixels[i] = [40, 120, 220][i % 3] + Math.floor(rand() * 7) - 3;
    else pixels[i] = rand() < 0.2 ? 20 : 230;
    pixels[i] = Math.max(0, Math.min(255, pixels[i] | 0));

    if (maskMode === 'none') mask[i] = 1;
    else if (maskMode === 'sparse') mask[i] = rand() < 0.85 ? 1 : 0;
    else if (maskMode === 'empty-blocks') {
      const x = i % n, y = (i / n) | 0;
      mask[i] = ((x < 2 && y < 2) || rand() < 0.9) ? 1 : 0;
    }
  }
  return { pixels, mask: maskMode === 'none' ? null : mask };
}

let checks = 0;
for (let seed = 1; seed <= 80; seed++) {
  const n = 4;
  const maskMode = ['none', 'sparse', 'empty-blocks'][seed % 3];
  const { pixels, mask } = randomImage(seed * 9173 + 13, n, maskMode);
  const analysis = QG01.analyzeQuadtree({ width: n, data: pixels, mask, allowNonstandard: true });
  const allOptions = enumerateNode(pixels, mask, n, 0, 0, n);
  for (let budget = 10; budget <= 165; budget++) {
    const plan = QG01.encodeOptimal({ ...analysis, budget });
    let expected = null;
    for (const op of allOptions) {
      if (op.bits > budget) continue;
      if (!expected || op.dist < expected.dist ||
          (op.dist === expected.dist && op.bits < expected.bits) ||
          (op.dist === expected.dist && op.bits === expected.bits && op.code < expected.code)) {
        expected = op;
      }
    }
    assert.ok(expected, `seed ${seed} budget ${budget}: brute solution`);
    assert.equal(plan.distortion, expected.dist, `seed ${seed} budget ${budget}: distortion`);
    assert.equal(plan.usedBits, expected.bits, `seed ${seed} budget ${budget}: bits`);
    assert.equal(plan.code, expected.code, `seed ${seed} budget ${budget}: lex payload`);
    checks++;
  }
}
console.log(`fuzz-optimizer: ${checks} budget/image cases matched exhaustive oracle`);
