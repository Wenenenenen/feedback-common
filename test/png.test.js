// PNG 编解码与导出格式测试：与样例包逐像素一致、滤波行/CRC、
// 非灰度拒绝、NPY 头部与数值、ZIP 结构、报告字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { decodePNG, encodeGrayPNG, grayToImageData } from '../lib/png.js';
import { crc32 } from '../lib/crc32.js';
import { runDenoise } from '../lib/engine.js';
import { buildFloatNpy, buildZip, buildReport, buildPilotPNG, buildFinalPNG } from '../app/js/export.js';
import { SAMPLES } from '../app/js/samples.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, '..', 'samples', 'extracted');

async function sample(name) {
  try {
    return await readFile(join(SAMPLE_DIR, name));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const s = SAMPLES[name.replace(/\.png$/, '')];
    if (!s) throw err;
    return Buffer.from(s.pngBase64, 'base64');
  }
}

test('CRC-32 与标准向量一致', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('IEND')), 0xae426082);
});

test('解码样例并核对关键像素', async () => {
  const clean = await decodePNG(await sample('clean.png'));
  assert.equal(clean.width, 48);
  assert.equal(clean.height, 40);
  assert.deepEqual(Array.from(clean.data.slice(0, 8)), [82, 95, 100, 95, 82, 69, 64, 69]);
  const thin = await decodePNG(await sample('thin.png'));
  assert.equal(thin.width, 1);
  assert.equal(thin.height, 9);
  assert.deepEqual(Array.from(thin.data), [30, 60, 90, 120, 150, 120, 90, 60, 30]);
  const single = await decodePNG(await sample('single.png'));
  assert.equal(single.data[0], 128);
});

test('编码 → 解码往返：覆盖所有行滤波、全 0/255 与渐变', async () => {
  const W = 37;
  const H = 21;
  const cases = [
    new Uint8Array(W * H),
    new Uint8Array(W * H).fill(255),
    Float64Array.from({ length: W * H }, (_, i) => (i % W) * 6 + ((i / W) | 0)),
    Float64Array.from({ length: W * H }, (_, i) => (i * 37) % 256),
    Float64Array.from({ length: W * H }, () => Math.random() * 255),
  ];
  for (const values of cases) {
    const png = await encodeGrayPNG(W, H, values, { round: true });
    const back = await decodePNG(png);
    assert.equal(back.width, W);
    assert.equal(back.height, H);
    for (let i = 0; i < W * H; i++) {
      const want = Math.max(0, Math.min(255, Math.round(values[i])));
      assert.equal(back.data[i], want, `pixel ${i}`);
    }
  }
});

test('编码会做 0–255 截断与四舍五入', async () => {
  const png = await encodeGrayPNG(3, 1, Float64Array.from([-10, 128.5, 300]));
  const back = await decodePNG(png);
  assert.deepEqual(Array.from(back.data), [0, 129, 255]);
});

test('拒绝非 8 位灰度、隔行与损坏数据', async () => {
  const original = new Uint8Array(await sample('clean.png'));
  const rgb = Uint8Array.from(original);
  // IHDR colorType 在偏移 8+8+9 处
  rgb[8 + 8 + 9] = 2;
  // 修正 IHDR CRC 以便走到格式检查
  const crcOff = 8 + 8 + 13;
  const crc = crc32(rgb, 12, crcOff);
  rgb[crcOff] = (crc >>> 24) & 0xff;
  rgb[crcOff + 1] = (crc >>> 16) & 0xff;
  rgb[crcOff + 2] = (crc >>> 8) & 0xff;
  rgb[crcOff + 3] = crc & 0xff;
  await assert.rejects(() => decodePNG(rgb), /8 位灰度/);

  const inter = Uint8Array.from(original);
  inter[8 + 8 + 12] = 1;
  const crc2 = crc32(inter, 12, crcOff);
  inter[crcOff] = (crc2 >>> 24) & 0xff;
  inter[crcOff + 1] = (crc2 >>> 16) & 0xff;
  inter[crcOff + 2] = (crc2 >>> 8) & 0xff;
  inter[crcOff + 3] = crc2 & 0xff;
  await assert.rejects(() => decodePNG(inter), /隔行/);

  const corrupt = Uint8Array.from(original);
  corrupt[30] ^= 0xff;
  await assert.rejects(() => decodePNG(corrupt), /CRC|不足|PNG/);

  await assert.rejects(() => decodePNG(new Uint8Array([1, 2, 3])), /签名/);
  await assert.rejects(() => decodePNG(new TextEncoder().encode('not a png at all')), /签名|PNG/);
});

test('grayToImageData 输出 RGBA', () => {
  const { rgba, width, height } = grayToImageData(new Uint8Array([10, 200]), 2, 1);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual(Array.from(rgba), [10, 10, 10, 255, 200, 200, 200, 255]);
});

test('导出 PNG 与引擎浮点结果一致（0–255 四舍五入）', async () => {
  const img = await decodePNG(await sample('noisy.png'));
  const res = await runDenoise(img, {});
  const pilot = await decodePNG(await buildPilotPNG(res));
  const final = await decodePNG(await buildFinalPNG(res));
  assert.equal(pilot.width, 48);
  assert.equal(pilot.height, 40);
  for (let i = 0; i < res.final.length; i++) {
    assert.equal(pilot.data[i], Math.max(0, Math.min(255, Math.round(res.pilot[i]))));
    assert.equal(final.data[i], Math.max(0, Math.min(255, Math.round(res.final[i]))));
  }
});

test('浮点结果 NPY：标准头部、形状 (4,H,W)、可被 Python 读取', async () => {
  const img = await decodePNG(await sample('noisy.png'));
  const res = await runDenoise(img, { sigma: 12.5 });
  const npy = buildFloatNpy(res);
  assert.deepEqual(Array.from(npy.slice(0, 6)), [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x59].slice(0, 6));
  assert.equal(npy[6], 1);
  assert.equal(npy[7], 0);
  const headerLen = npy[8] | (npy[9] << 8);
  assert.equal((10 + headerLen) % 16, 0, 'NPY 头部按 64 字节对齐');
  const header = new TextDecoder().decode(npy.slice(10, 10 + headerLen));
  assert.match(header, /'descr': '<f8'/);
  assert.match(header, /'fortran_order': False/);
  assert.match(header, /'shape': \(4, 40, 48\)/);
  assert.equal(npy.length, 10 + headerLen + 4 * 40 * 48 * 8);

  const view = new DataView(npy.buffer, npy.byteOffset + 10 + headerLen);
  const n = 40 * 48;
  for (let i = 0; i < n; i += 97) {
    assert.ok(Math.abs(view.getFloat64(i * 8, true) - res.pilot[i]) < 1e-12);
    assert.ok(Math.abs(view.getFloat64((n + i) * 8, true) - res.final[i]) < 1e-12);
    assert.ok(Math.abs(view.getFloat64((2 * n + i) * 8, true) - res.weight1[i]) < 1e-12);
    assert.ok(Math.abs(view.getFloat64((3 * n + i) * 8, true) - res.weight2[i]) < 1e-12);
  }

  // 若环境有 Python，再用 zipfile/struct 独立验证一遍容器
  try {
    const dir = mkdtempSync(join(tmpdir(), 'gtd-npy-'));
    const file = join(dir, 'r.npy');
    writeFileSync(file, npy);
    const out = execFileSync('python3', ['-I', '-c', `
import struct
b=open(${JSON.stringify(file)},'rb').read()
assert b[:6]==b'\\x93NUMPY'
hl=struct.unpack('<H',b[8:10])[0]
print(hl, b[10:10+hl].decode())
`], { encoding: 'utf8' });
    assert.match(out, /<f8/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

test('ZIP 结果包：文件齐全、CRC 正确、可由 unzip 读取', async () => {
  const png = await encodeGrayPNG(2, 2, new Uint8Array([1, 2, 3, 4]));
  const zip = buildZip([
    { name: 'pilot.png', data: png },
    { name: 'note.txt', data: new TextEncoder().encode('hello 世界') },
  ]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const dir = mkdtempSync(join(tmpdir(), 'gtd-zip-'));
  const file = join(dir, 'x.zip');
  writeFileSync(file, zip);
  try {
    const out = execFileSync('python3', ['-I', '-c', `
import zipfile
z=zipfile.ZipFile(${JSON.stringify(file)})
print(z.testzip())
print(','.join(z.namelist()))
print(z.read('note.txt').decode())
`], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(out[0], 'None');
    assert.equal(out[1], 'pilot.png,note.txt');
    assert.equal(out[2], 'hello 世界');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

test('报告：参数、派生量、组统计、权重分布与说明齐全', async () => {
  const img = await decodePNG(await sample('noisy.png'));
  const res = await runDenoise(img, { patch: 8, radius: 6, stride: 4, capacity: 8, sigma: 21, threshold: 3.1 });
  const report = buildReport(res, { sourceName: 'noisy.png', referenceGroupCount: 12 });
  assert.equal(report.image.width, 48);
  assert.equal(report.image.height, 40);
  assert.deepEqual(report.params, { patch: 8, radius: 6, stride: 4, capacity: 8, sigma: 21, threshold: 3.1 });
  assert.ok(Math.abs(report.derived.hardThreshold - 21 * 3.1) < 1e-12);
  // 参考中心：Y 方向 11 个，X 方向 13 个
  assert.equal(report.stages.stage1.groups, 11 * 13);
  assert.equal(report.stages.stage2.groups, 11 * 13);
  assert.ok(report.stages.stage1.groupSizeHistogram[8] > 0);
  assert.equal(report.derived.referenceGroupCount, 12);
  assert.ok(report.stages.stage2.weightStats.max > 0);
  assert.equal(report.zeroNoise, false);
  assert.ok(report.notes.length >= 5);
  assert.ok(report.weights.aggregation.includes('镜像'));
  assert.equal(JSON.parse(JSON.stringify(report)).params.stride, 4);
});

test('零噪声报告与 σ=0 行为', async () => {
  const img = await decodePNG(await sample('thin.png'));
  const res = await runDenoise(img, { sigma: 0 });
  const report = buildReport(res);
  assert.equal(report.zeroNoise, true);
  assert.equal(report.derived.hardThreshold, 0);
  const decoded = await decodePNG(await buildFinalPNG(res));
  assert.deepEqual(Array.from(decoded.data), Array.from(img.data));
});
