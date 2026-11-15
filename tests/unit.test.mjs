// Node 单元测试：node --test tests/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
for (const f of ['geometry.js', 'color.js', 'png-encoder.js']) {
  const src = readFileSync(join(root, 'app', 'js', f), 'utf8');
  (0, eval)(src);
}
const Geo = globalThis.Geo;
const ColorUtil = globalThis.ColorUtil;
const PngEncoder = globalThis.PngEncoder;

test('validateQuad: 合法矩形与透视凸四边形通过', () => {
  assert.equal(Geo.validateQuad([[0, 0], [10, 0], [10, 8], [0, 8]]).ok, true);
  assert.equal(Geo.validateQuad([[4, 5], [170, 12], [158, 123], [12, 116]]).ok, true);
});

test('validateQuad: 拒绝自交（蝴蝶结，面积为零亦须拒绝）', () => {
  const v = Geo.validateQuad([[0, 0], [160, 128], [160, 0], [0, 128]]);
  assert.equal(v.ok, false);
  assert.match(v.reason, /凹|自交|退化/);
});

test('validateQuad: 拒绝退化（共线/重合）', () => {
  assert.equal(Geo.validateQuad([[0, 0], [50, 0], [100, 0], [150, 0]]).ok, false);
  assert.equal(Geo.validateQuad([[0, 0], [0, 0], [10, 0], [10, 10]]).ok, false);
  assert.equal(Geo.validateQuad([[0, 0], [10, 0], [5, 0], [0, 10]]).ok, false);
});

test('validateQuad: 拒绝凹四边形', () => {
  // 凹：第四点向内凹
  const v = Geo.validateQuad([[0, 0], [10, 0], [10, 10], [5, 5]]);
  assert.equal(v.ok, false);
});

test('homography 角点残差 < 1e-6（oracle 阈值）', () => {
  const src = Geo.frameCorners(160, 128);
  const dst = [[4, 5], [170, 12], [158, 123], [12, 116]];
  const H = Geo.homography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = Geo.applyH(H, src[i][0], src[i][1]);
    assert.ok(Math.hypot(x - dst[i][0], y - dst[i][1]) < 1e-6);
  }
  // 正反互逆
  const inv = Geo.invert3(H);
  const back = Geo.applyH(inv, dst[0][0], dst[0][1]);
  assert.ok(Math.hypot(back[0] - src[0][0], back[1] - src[0][1]) < 1e-8);
});

test('融合规则与 oracle 探针一致', () => {
  const quads = [
    [[0, 0], [160, 0], [160, 128], [0, 128]],
    [[96, 0], [256, 0], [256, 128], [96, 128]]
  ];
  const feather = 32;
  function wAt(x, y) {
    const cover = [], raw = [];
    for (const q of quads) {
      const info = Geo.pointInsideQuad(q, x, y);
      cover.push(info.inside);
      raw.push(info.minDistance);
    }
    return Geo.blendWeights(cover, raw, feather);
  }
  assert.deepEqual(wAt(128, 64).map((v) => Math.round(v * 1000) / 1000), [0.5, 0.5]);
  assert.deepEqual(wAt(104, 64).map((v) => Math.round(v * 1000) / 1000), [0.8, 0.2]);
  assert.deepEqual(wAt(16, 64), [1, 0]);
  assert.deepEqual(wAt(260, 64), [0, 0]);
  // 单覆盖：即便靠近边缘权重也是 1
  const nearEdge = wAt(80, 2);
  assert.equal(nearEdge[0], 1);
  assert.equal(nearEdge[1], 0);
});

test('零和均分：边界线上两台都覆盖、原始权重均为 0', () => {
  const quads = [
    [[0, 0], [160, 0], [160, 128], [0, 128]],
    [[96, 0], [256, 0], [256, 128], [96, 128]]
  ];
  const info0 = Geo.pointInsideQuad(quads[0], 128, 0);
  const info1 = Geo.pointInsideQuad(quads[1], 128, 0);
  assert.equal(info0.inside, true);
  assert.equal(info1.inside, true);
  const w = Geo.blendWeights([true, true], [info0.minDistance, info1.minDistance], 32);
  assert.deepEqual(w, [0.5, 0.5]);
});

test('sRGB 传输函数与 oracle 数值一致', () => {
  const lin = ColorUtil.srgbChannelToLinear(128);
  assert.ok(Math.abs(lin - 0.21586050011389926) < 1e-15);
  assert.equal(ColorUtil.linearToSrgbChannel(0.5 * lin), 92);
  assert.equal(ColorUtil.linearToSrgbChannel(0), 0);
  assert.equal(ColorUtil.linearToSrgbChannel(1), 255);
});

test('PNG 编码可被 zlib 与 PNG 头解析回原始 RGBA', async () => {
  const w = 4, h = 3;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 37) % 256;
    rgba[i * 4 + 1] = (i * 71) % 256;
    rgba[i * 4 + 2] = (i * 113) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const png = await PngEncoder.encodePng(w, h, rgba);
  // PNG 签名
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // 解析块（pos 指向长度字段；块总长 = 4 长度 + 4 类型 + len 数据 + 4 CRC）
  let pos = 8, idat = [];
  const chunks = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos < png.length) {
    const len = dv.getUint32(pos);
    const type = new TextDecoder().decode(png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    chunks.push(type);
    if (type === 'IDAT') idat.push(data);
    pos += len + 12;
  }
  assert.deepEqual(chunks.slice(0, 2), ['IHDR', 'sRGB']);
  assert.ok(chunks.includes('IEND'));
  const raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    assert.equal(raw[rowStart], 0); // filter 0
    for (let i = 0; i < w * 4; i++) {
      assert.equal(raw[rowStart + 1 + i], rgba[y * w * 4 + i]);
    }
  }
});
