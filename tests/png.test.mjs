// png.test.mjs — PNG encoder/decoder round trips and rejection paths.
// Run with: node --test tests/png.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, crc32, countNonOpaque } from '../app/js/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, '.cases');

function sampleBytes() {
  return new Uint8Array(readFileSync(join(casesDir, 'color.png')));
}

test('png: decodes the sample 8-bit RGB image', async () => {
  const img = await decodePng(sampleBytes());
  assert.equal(img.width, 160);
  assert.equal(img.height, 96);
  assert.equal(img.colorType, 2);
  assert.equal(img.bitDepth, 8);
  assert.deepEqual([...img.rgba.subarray(0, 4)], [30, 0, 0, 255]);
  // Pixel (79, 48) is on the foreground block; (80, 48) is background.
  assert.ok(img.rgba[(48 * 160 + 79) * 4] > 200);
  assert.ok(img.rgba[(48 * 160 + 80) * 4] < 60);
});

test('png: RGBA round trip is byte exact', async () => {
  const w = 33, h = 17;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 255;
  // include transparent pixels
  for (let i = 3; i < data.length; i += 40) data[i] = 0;
  const bytes = await encodePng({ width: w, height: h, kind: 'rgba', data });
  const back = await decodePng(bytes);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual([...back.rgba], [...data]);
  assert.ok(countNonOpaque(back.rgba) > 0);
});

test('png: grayscale round trip preserves 0 and 255 only', async () => {
  const w = 40, h = 9;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = i % 3 === 0 ? 255 : 0;
  const bytes = await encodePng({ width: w, height: h, kind: 'gray', data });
  const back = await decodePng(bytes);
  assert.equal(back.colorType, 0);
  for (let i = 0; i < data.length; i++) {
    assert.equal(back.rgba[i * 4], data[i]);
    assert.equal(back.rgba[i * 4 + 3], 255);
  }
});

test('png: crc32 matches the standard test value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('png: truncated and corrupted files are rejected', async () => {
  const good = sampleBytes();
  const cut = good.subarray(0, good.length - 200);
  await assert.rejects(() => decodePng(cut), /截断|长度|IEND/);
  const corrupt = good.slice();
  corrupt[60] ^= 0xff; // inside IHDR/IDAT area
  await assert.rejects(() => decodePng(corrupt), /CRC|解压|截断/);
  await assert.rejects(() => decodePng(new Uint8Array([1, 2, 3])), /太短|PNG/);
  await assert.rejects(() => decodePng(new TextEncoder().encode('not a png at all')), /不是 PNG/);
});

test('png: encoder validates its arguments', async () => {
  await assert.rejects(() => encodePng({ width: 0, height: 4, kind: 'gray', data: new Uint8Array(4) }), /尺寸/);
  await assert.rejects(() => encodePng({ width: 2, height: 2, kind: 'gray', data: new Uint8Array(3) }), /长度/);
});

test('png: 16-bit RGB input is down-converted through the high byte', async () => {
  // Build a 2x1 16-bit RGB PNG by hand.
  // filter byte, then 2 pixels x 3 channels x 2 bytes
  const raw = new Uint8Array([
    0,
    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const { deflateSync } = await import('node:zlib');
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 16; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const img = await decodePng(png);
  assert.deepEqual([...img.rgba.subarray(0, 4)], [0x12, 0x56, 0x9a, 255]);
  assert.deepEqual([...img.rgba.subarray(4, 8)], [0x00, 0x00, 0x00, 255]);
});
