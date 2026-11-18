// 用样例 PNG 验证核心流水线（不依赖任何图像库，自带最小 PNG 解码器）。
// 用法：node test/run-samples.mjs <样例目录>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { runPipeline } from '../js/skeleton.js';

function decodePngGray8(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 0) throw new Error(`need 8-bit gray, got bd=${bitDepth} ct=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w + 1;
  const gray = new Uint8Array(w * h);
  let prev = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const row = Uint8Array.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    for (let x = 0; x < w; x++) {
      const a = x > 0 ? row[x - 1] : 0, b = prev[x], c = x > 0 ? prev[x - 1] : 0;
      if (f === 1) row[x] = (row[x] + a) & 255;
      else if (f === 2) row[x] = (row[x] + b) & 255;
      else if (f === 3) row[x] = (row[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    gray.set(row, y * w);
    prev = row;
  }
  return { gray, w, h };
}

const dir = process.argv[2] || '/tmp/bmg-cases';
const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
const opts = { threshold: settings.threshold, invert: settings.invert, spacing: settings.pixel_spacing };

for (const name of ['straight', 'branch', 'ring', 'border', 'single', 'empty']) {
  const { gray, w, h } = decodePngGray8(readFileSync(join(dir, name + '.png')));
  const r = runPipeline(gray, w, h, opts);
  let skelCount = 0;
  for (const v of r.skeleton) skelCount += v;
  console.log(`\n=== ${name}.png ${w}x${h}  骨架像素=${skelCount}  节点=${r.nodes.length}  边=${r.edges.length}`);
  for (const nd of r.nodes) {
    console.log(`  节点#${nd.id} ${nd.type} 位置=[${nd.position.map(v => v.toFixed(2))}] 成员=${nd.pixels.length}`);
  }
  for (const e of r.edges) {
    console.log(`  边#${e.id} 节点[${e.nodes}] 像素=${e.pixel_count} 长度=${e.length.toFixed(3)}${settings.unit} ` +
      `宽 mean=${e.width.mean.toFixed(3)} min=${e.width.min.toFixed(3)} max=${e.width.max.toFixed(3)}`);
  }
}
