// png.test.mjs — the built-in PNG encoder must be byte-exact and zlib-decodable.
// Run with: node --test tests/png.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { encodePng, deflateZlib } from '../app/js/png.js';

function decodePngPass(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) assert.equal(bytes[i], sig[i], 'PNG signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let hasSrgb = false;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'sRGB') {
      hasSrgb = true;
    }
    // CRC check over type + payload
    const crc = dv.getUint32(pos + 8 + len);
    assert.equal(crc, crc32(bytes.subarray(pos + 4, pos + 8 + len)), `CRC for ${type}`);
    pos += 12 + len;
  }
  assert.equal(pos, bytes.length, 'chunk lengths must be consistent');
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const stride = width * 4 + 1;
  assert.equal(raw.length, stride * height, 'scanline count');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'row filter must be None');
    rgba.set(raw.subarray(y * stride + 1, y * stride + 1 + width * 4), y * width * 4);
  }
  return { width, height, depth, colorType, hasSrgb, rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeRgba(w, h, fn) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      const i = (y * w + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = c[3];
    }
  }
  return out;
}

test('PNG round-trip: small gradient keeps straight alpha and sRGB chunk', () => {
  const w = 64;
  const h = 32;
  const rgba = makeRgba(w, h, (x, y) => [x * 4, y * 8, 128, (x + y * 3) % 256]);
  const png = encodePng(w, h, rgba);
  const out = decodePngPass(png);
  assert.equal(out.width, w);
  assert.equal(out.height, h);
  assert.equal(out.depth, 8);
  assert.equal(out.colorType, 6);
  assert.equal(out.hasSrgb, true);
  assert.deepEqual(Buffer.from(out.rgba), Buffer.from(rgba), 'pixels must be exact');
});

test('PNG round-trip: fully transparent and fully opaque corners', () => {
  const w = 16;
  const h = 16;
  const rgba = makeRgba(w, h, (x, y) => (x < w / 2 ? [0, 0, 0, 0] : [255, 0, 0, 255]));
  const out = decodePngPass(encodePng(w, h, rgba));
  assert.equal(out.rgba[3], 0, 'left half alpha');
  assert.equal(out.rgba[(w / 2) * 4 + 3], 255, 'right half alpha');
  assert.equal(out.rgba[(w / 2) * 4], 255, 'right half red');
});

test('PNG round-trip: large image exercises 32 KB back-references', () => {
  // Repeated content far apart forces matches near the DEFLATE window limit.
  const w = 384;
  const h = 512;
  const rgba = makeRgba(w, h, (x, y) => {
    const band = Math.floor(y / 37);
    return [(band * 31) & 255, (x * 2) & 255, ((x + y) * 3) & 255, x < 40 ? 0 : 200];
  });
  const png = encodePng(w, h, rgba);
  const out = decodePngPass(png);
  assert.deepEqual(Buffer.from(out.rgba), Buffer.from(rgba));
  assert.equal(out.hasSrgb, true);
});

test('deflateZlib output is a valid zlib stream (Node inflate agrees)', () => {
  for (const n of [0, 1, 7, 100, 4096, 50000, 400000]) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = (i * 7 + (i >> 9)) & 255;
    const z = deflateZlib(data);
    assert.equal(z[0], 0x78, 'zlib CMF');
    const out = inflateSync(Buffer.from(z));
    assert.deepEqual(Buffer.from(out), Buffer.from(data), `round-trip n=${n}`);
  }
});

test('PNG rejects inconsistent input sizes', () => {
  assert.throws(() => encodePng(4, 4, new Uint8Array(4 * 4 * 4 - 1)), /像素长度不符/);
  assert.throws(() => encodePng(0, 4, new Uint8Array(0)), /尺寸无效/);
});

test('MZ-style CRC matches a known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  void execFileSync;
});
